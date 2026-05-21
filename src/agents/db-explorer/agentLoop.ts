import crypto from "node:crypto";
import { EJSON } from "bson";
import {
  buildDbExplorerSystemPrompt,
  RUN_QUERY_TOOL_DESCRIPTION,
  RUN_QUERY_TOOL_NAME,
  RUN_QUERY_TOOL_SCHEMA,
} from "./prompt";
import { validate, ValidationError } from "./validator";
import { runValidatedQuery, type RunQueryError, type RunQueryResult } from "./interpreter";
import { getDb } from "./mongoClient";
import {
  callConverse,
  isTextBlock,
  isToolUseBlock,
  __resetForTests as __resetInferenceClient,
  type ConverseMessage,
  type ConverseResponse,
  type ConverseToolResultBlock,
} from "../../inference/client";
import { resolveEffectiveModelId } from "../../eval/db";

const MAX_TOKENS = 4_096;
const MAX_ITERATIONS = 12;
const MAX_TOOL_USES_PER_ITERATION = 8;
const CONTEXT_TOKEN_CAP = 150_000;
const QUERY_PREVIEW_MAX = 80;
const AGENT_WALL_CLOCK_MS = 180_000;

interface QueryRecord {
  expr: string;
  ok: boolean;
  resultPreview?: string;
  error?: string;
  durationMs: number;
}

export interface ExploreDbTelemetry {
  queryCount: number;
  failedQueries: number;
  tokensUsed: number;
  loopIterations: number;
}

export interface ExploreDbResult {
  answer: string;
  telemetry: ExploreDbTelemetry;
}

const newReqId = (): string => crypto.randomBytes(4).toString("hex");

const escapeLogValue = (v: string): string =>
  v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");

const logLine = (parts: Record<string, unknown>): void => {
  const payload = Object.entries(parts)
    .map(([k, v]) => {
      if (typeof v === "string") {
        const needsQuote = v.length === 0 || /[\s"=\\]/.test(v);
        return needsQuote ? `${k}="${escapeLogValue(v)}"` : `${k}=${v}`;
      }
      return `${k}=${v}`;
    })
    .join(" ");
  console.error(`[explore_db] ${payload}`);
};

// Mask hex ObjectIds, email-like patterns, and bare digit runs (phones, ids).
export const maskSensitive = (s: string): string =>
  s
    .replace(/'[a-f0-9]{24}'/gi, "'***'")
    .replace(/"[a-f0-9]{24}"/gi, '"***"')
    .replace(/'[^'\s@]+@[^'\s]+'/g, "'***@***'")
    .replace(/"[^"\s@]+@[^"\s]+"/g, '"***@***"')
    .replace(/\b\d{7,}\b/g, "***");

const toQueryRecord = (
  expr: string,
  result: RunQueryResult | RunQueryError,
): QueryRecord => {
  const masked = maskSensitive(expr);
  if (result.ok) {
    const preview = EJSON.stringify(result.output, { relaxed: true });
    return {
      expr: masked.slice(0, QUERY_PREVIEW_MAX),
      ok: true,
      resultPreview:
        preview.length > 200 ? `${preview.slice(0, 200)}…` : preview,
      durationMs: result.durationMs,
    };
  }
  return {
    expr: masked.slice(0, QUERY_PREVIEW_MAX),
    ok: false,
    error: maskSensitive(result.error),
    durationMs: result.durationMs,
  };
};

const executeRunQuery = async (
  expr: string,
): Promise<RunQueryResult | RunQueryError> => {
  let validation;
  try {
    validation = validate(expr);
  } catch (e) {
    if (e instanceof ValidationError) {
      return {
        ok: false,
        error: e.message,
        hint: e.hint,
        durationMs: 0,
      };
    }
    return {
      ok: false,
      error: (e as Error).message,
      durationMs: 0,
    };
  }
  const db = await getDb();
  return runValidatedQuery(db, validation);
};

const extractText = (msg: ConverseResponse): string =>
  msg.output.message.content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join("\n")
    .trim();

const firstTextBlock = (msg: ConverseResponse): string => {
  const block = msg.output.message.content.find(isTextBlock);
  return block ? block.text.trim() : "";
};

const runAgentLoop = async (
  reqId: string,
  t0: number,
  brief: string,
  model: string,
): Promise<ExploreDbResult> => {
  const system = buildDbExplorerSystemPrompt();
  const queries: QueryRecord[] = [];
  let tokensUsed = 0;
  let cumulativeInput = 0;
  let loopIterations = 0;

  const messages: ConverseMessage[] = [
    { role: "user", content: [{ text: brief }] },
  ];

  logLine({ reqId, event: "start", "brief.len": brief.length });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    loopIterations++;
    const resp = await callConverse({
      modelId: model,
      system: [{ text: system }],
      inferenceConfig: { maxTokens: MAX_TOKENS },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: RUN_QUERY_TOOL_NAME,
              description: RUN_QUERY_TOOL_DESCRIPTION,
              inputSchema: { json: RUN_QUERY_TOOL_SCHEMA },
            },
          },
        ],
      },
      messages,
    });

    cumulativeInput += resp.usage.inputTokens ?? 0;
    tokensUsed +=
      (resp.usage.inputTokens ?? 0) +
      (resp.usage.outputTokens ?? 0) +
      (resp.usage.cacheReadInputTokens ?? 0);

    if (cumulativeInput > CONTEXT_TOKEN_CAP) {
      throw new Error("Brief produced too much context.");
    }

    const narration = firstTextBlock(resp);
    logLine({ reqId, iter: loopIterations, narration });

    if (resp.stopReason === "end_turn") {
      const rawAnswer = extractText(resp);
      if (queries.length === 0 && !rawAnswer.trim()) {
        throw new Error("Agent refused to act.");
      }
      if (!rawAnswer.trim()) {
        throw new Error("Agent returned no narrative.");
      }
      const telemetry: ExploreDbTelemetry = {
        queryCount: queries.length,
        failedQueries: queries.filter((q) => !q.ok).length,
        tokensUsed,
        loopIterations,
      };
      logLine({
        reqId,
        event: "done",
        queries: telemetry.queryCount,
        failed: telemetry.failedQueries,
        tokens: telemetry.tokensUsed,
        iters: telemetry.loopIterations,
        durationMs: Date.now() - t0,
      });
      return { answer: rawAnswer, telemetry };
    }

    if (resp.stopReason === "max_tokens") {
      throw new Error("Inference truncated — narrow the brief.");
    }

    if (resp.stopReason !== "tool_use") {
      throw new Error(`Unsupported stop_reason: ${resp.stopReason}`);
    }

    const toolUses = resp.output.message.content.filter(isToolUseBlock);
    if (toolUses.length === 0) {
      throw new Error(
        "Inconsistent response: stop_reason=tool_use but no tool_use blocks.",
      );
    }
    if (toolUses.length > MAX_TOOL_USES_PER_ITERATION) {
      throw new Error(
        `Agent emitted ${toolUses.length} tool_use blocks in one iteration (cap=${MAX_TOOL_USES_PER_ITERATION}).`,
      );
    }

    // Push the assistant turn verbatim (preserves text + toolUse ordering).
    messages.push({ role: "assistant", content: resp.output.message.content });

    const toolResultBlocks: { toolResult: ConverseToolResultBlock }[] = [];
    for (const block of toolUses) {
      const { toolUseId, input } = block.toolUse;
      const expr = (input as { expr?: unknown }).expr;
      if (typeof expr !== "string") {
        toolResultBlocks.push({
          toolResult: {
            toolUseId,
            content: [
              { text: JSON.stringify({ ok: false, error: "expr must be a string" }) },
            ],
            status: "error",
          },
        });
        queries.push({
          expr: "[malformed]",
          ok: false,
          error: "expr must be a string",
          durationMs: 0,
        });
        logLine({
          reqId,
          iter: loopIterations,
          query: "ok=false",
          error: "expr must be a string",
          durationMs: 0,
        });
        continue;
      }
      const result = await executeRunQuery(expr);
      toolResultBlocks.push({
        toolResult: {
          toolUseId,
          content: [{ text: EJSON.stringify(result, { relaxed: true }) }],
          status: result.ok ? "success" : "error",
        },
      });
      const record = toQueryRecord(expr, result);
      queries.push(record);
      logLine({
        reqId,
        iter: loopIterations,
        query: record.ok ? "ok=true" : "ok=false",
        expr: record.expr,
        ...(record.error ? { error: record.error } : {}),
        durationMs: record.durationMs,
      });
    }

    // All tool_results regrouped in a single user message — Converse expects
    // tool results in a user-role message immediately following the assistant
    // turn that produced the matching toolUse blocks.
    messages.push({ role: "user", content: toolResultBlocks });
  }

  throw new Error("Agent exceeded max iterations.");
};

export const runDbExplorerAgent = async (
  brief: string,
): Promise<ExploreDbResult> => {
  const reqId = newReqId();
  const t0 = Date.now();
  const { awsModelId: model } = await resolveEffectiveModelId();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Agent exceeded 90s wall-clock budget")),
      AGENT_WALL_CLOCK_MS,
    );
  });
  try {
    return await Promise.race([runAgentLoop(reqId, t0, brief, model), timeout]);
  } catch (err) {
    logLine({
      reqId,
      event: "error",
      message: err instanceof Error ? err.message : "unknown",
      durationMs: Date.now() - t0,
    });
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const __resetClientForTests = (): void => {
  __resetInferenceClient();
};
