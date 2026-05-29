import crypto from "node:crypto";
import { ZodTypeAny } from "zod";
import { McpFlowError } from "../callFlow";
import { trackMcpEvent } from "../tracking";
import { analyzeConversationWithDbPrompt } from "../eval/analyzer";
import { resolveEffectiveModelId } from "../eval/db";
import { assertLgmStaff } from "../agents/db-explorer/acl";
import { runDbExplorerAgent } from "../agents/db-explorer/agentLoop";
import { DB_EXPLORER_PROMPT_VERSION } from "../agents/db-explorer/prompt";
import {
  BuiltinConfig,
  BuiltinHandler,
  builtinConfigSchema,
} from "./types";
import {
  formatTextContent,
  handleToolError,
  resolveApiKey,
} from "./util";
import { buildInputSchemaShape } from "./proxy";
import type { EndpointRow } from "../eval/db";

// Map of available builtin handlers. The shape mirrors `BuiltProxyTool.handler`
// — registry.ts calls these by name based on `config.handler`.
type Handler = (
  config: BuiltinConfig,
  params: Record<string, unknown>,
  extra: { authInfo?: { token?: string } },
) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}>;

const analyzeConversation: Handler = async (config, params, extra) => {
  const apiKey = resolveApiKey(extra);
  const conversationId = String(params.conversationId);
  try {
    const resolved = await resolveEffectiveModelId();
    const result = await analyzeConversationWithDbPrompt(conversationId, {
      model: resolved.awsModelId,
    });
    if (result.analysis.status === "ok") {
      await trackMcpEvent(
        apiKey,
        config.tracking_event ?? "mcp_tool_called",
        { toolName: "analyze_conversation", promptVersion: result.promptName },
      );
    }
    return formatTextContent(config.title ?? "Conversation Analysis", result);
  } catch (error) {
    return handleToolError(error);
  }
};

const exploreDb: Handler = async (config, params, extra) => {
  const apiKey = resolveApiKey(extra);
  const brief = String(params.brief);
  const briefHash = crypto
    .createHash("sha256")
    .update(brief)
    .digest("hex")
    .slice(0, 16);
  try {
    await assertLgmStaff(apiKey);
    const result = await runDbExplorerAgent(brief);
    await trackMcpEvent(apiKey, config.tracking_event ?? "mcp_tool_called", {
      toolName: "explore_db",
      promptVersion: DB_EXPLORER_PROMPT_VERSION,
      briefHash,
      briefLength: String(brief.length),
      queryCount: String(result.telemetry.queryCount),
      failedQueries: String(result.telemetry.failedQueries),
      loopIterations: String(result.telemetry.loopIterations),
      tokensUsed: String(result.telemetry.tokensUsed),
    });
    return { content: [{ type: "text" as const, text: result.answer }] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    trackMcpEvent(apiKey, "mcp_tool_failed", {
      toolName: "explore_db",
      briefHash,
      reason,
    }).catch(() => undefined);
    // Mongo connect failures get a stable user-facing message rather than
    // leaking the driver-specific error name.
    if (
      error instanceof Error &&
      (error.name === "MongoServerSelectionError" ||
        error.name === "MongoNetworkError" ||
        /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(error.message))
    ) {
      return handleToolError(new McpFlowError("Database unreachable.", 503));
    }
    return handleToolError(error);
  }
};

const HANDLERS: Record<BuiltinHandler, Handler> = {
  analyze_conversation: analyzeConversation,
  explore_db: exploreDb,
};

export interface BuiltBuiltinTool {
  meta: {
    description: string;
    inputSchema: Record<string, ZodTypeAny>;
    annotations: { title: string; readOnlyHint: true };
  };
  handler: (
    params: Record<string, unknown>,
    extra: { authInfo?: { token?: string } },
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: true;
  }>;
}

// Build a builtin tool from its DB row. Assumes `row.config` was already
// validated by `builtinConfigSchema` upstream (registry.ts); re-parses
// defensively.
export const buildBuiltinTool = (
  row: Pick<EndpointRow, "name" | "description" | "config">,
): BuiltBuiltinTool => {
  const config = builtinConfigSchema.parse(row.config);
  const description = row.description ?? "";
  const inputSchema = buildInputSchemaShape(config.inputs);
  const fn = HANDLERS[config.handler];
  // All builtin handlers are server-side inference / read-only agents, so
  // readOnlyHint:true is the safe baseline. Add a destructive variant here
  // when a write-capable handler is introduced.
  const annotations = {
    title: config.label ?? description,
    readOnlyHint: true as const,
  };
  return {
    meta: { description, inputSchema, annotations },
    handler: (params, extra) => fn(config, params, extra),
  };
};
