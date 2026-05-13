import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callFlow, McpFlowError } from "./callFlow";
import { trackMcpEvent } from "./tracking";
import { getApiKey } from "./requestContext";
import {
  buildClassifierSystemPrompt,
  CONVERSATION_CLASSIFIER_VERSION,
  CLASSIFIER_TOOL_NAME,
  CLASSIFIER_TOOL_DESCRIPTION,
  CLASSIFIER_TOOL_SCHEMA,
} from "./agents/conversationAnalyzer/conversationClassifier";
import { inferStructured } from "./agents/conversationAnalyzer/inference";
import { formatConversationForClassifier } from "./agents/conversationAnalyzer/conversationFormatter";
import { assertLgmStaff } from "./agents/db-explorer/acl";
import { runDbExplorerAgent } from "./agents/db-explorer/agentLoop";
import { DB_EXPLORER_PROMPT_VERSION } from "./agents/db-explorer/prompt";

const resolveApiKey = (extra: { authInfo?: { token?: string } }): string => {
  return getApiKey() || extra?.authInfo?.token || "";
};

const formatTextContent = (
  title: string,
  data: unknown,
): { content: Array<{ type: "text"; text: string }> } => {
  return {
    content: [
      {
        type: "text" as const,
        text: `## ${title}\n\n${JSON.stringify(data, null, 2)}`,
      },
    ],
  };
};

const handleToolError = (
  error: unknown,
): { content: Array<{ type: "text"; text: string }>; isError: true } => {
  if (error instanceof McpFlowError) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error (${error.statusCode}): ${error.message}`,
        },
      ],
      isError: true,
    };
  }
  const message =
    error instanceof Error ? error.message : "Unknown error occurred";
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
};

export const registerTools = (server: McpServer) => {
  // Tool 1: list_campaigns
  server.registerTool(
    "list_campaigns",
    {
      description:
        "List all campaigns for the authenticated user. Use this to get an overview of outreach campaigns, their statuses, and key metrics. Supports filtering by status and pagination.",
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe(
            'Filter by campaign status (e.g., "RUNNING", "PAUSED", "READY", "CANCELED")',
          ),
        skip: z
          .number()
          .optional()
          .default(0)
          .describe("Number of campaigns to skip for pagination"),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of campaigns to return (max 25)"),
        search: z.string().optional().describe("Search campaigns by name"),
      },
      annotations: {
        title: "List Campaigns",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/campaigns", params);
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "list_campaigns",
        });
        return formatTextContent("Campaigns", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 2: get_campaign_stats
  server.registerTool(
    "get_campaign_stats",
    {
      description:
        "Get detailed statistics for a specific campaign. Returns metrics like total leads, acceptance rate, reply rate, and conversion data. Use campaign ID from list_campaigns.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string)"),
      },
      annotations: {
        title: "Get Campaign Statistics",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/stats`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_campaign_stats",
        });
        return formatTextContent("Campaign Stats", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 3: get_audience_leads
  server.registerTool(
    "get_audience_leads",
    {
      description:
        "Get the list of leads in a specific audience. Returns lead details including name, company, job title, email, and LinkedIn URL. Supports pagination.",
      inputSchema: {
        audienceId: z
          .string()
          .describe("The audience ID (24-character hex string)"),
        skip: z
          .number()
          .optional()
          .default(0)
          .describe("Number of leads to skip for pagination"),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of leads to return (max 100)"),
      },
      annotations: {
        title: "Get Audience Leads",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/audiences/${params.audienceId}/leads`,
          {
            skip: params.skip,
            limit: params.limit,
          },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_audience_leads",
        });
        return formatTextContent("Audience Leads", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 4: get_lead_logs
  server.registerTool(
    "get_lead_logs",
    {
      description:
        "Get activity logs for a specific lead. Shows all actions taken on the lead: emails sent, LinkedIn messages, connection requests, and their statuses. Useful for understanding engagement history.",
      inputSchema: {
        leadId: z.string().describe("The lead ID (24-character hex string)"),
        identityId: z
          .string()
          .optional()
          .describe("Filter logs by identity ID"),
        skip: z
          .number()
          .optional()
          .default(0)
          .describe("Number of logs to skip for pagination"),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of logs to return (max 100)"),
      },
      annotations: {
        title: "Get Lead Activity Logs",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, `/leads/${params.leadId}/logs`, {
          identityId: params.identityId,
          skip: params.skip,
          limit: params.limit,
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_lead_logs",
        });
        return formatTextContent("Lead Logs", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 5: get_lead_conversations
  server.registerTool(
    "get_lead_conversations",
    {
      description:
        "Get all conversations with a specific lead across all channels (LinkedIn, email). Shows conversation status, last message preview, and whether the lead has replied. Use this to find conversation IDs for get_conversation_messages.",
      inputSchema: {
        leadId: z.string().describe("The lead ID (24-character hex string)"),
        identityId: z
          .string()
          .optional()
          .describe("Filter conversations by identity ID"),
      },
      annotations: {
        title: "Get Lead Conversations",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/leads/${params.leadId}/conversations`,
          {
            identityId: params.identityId,
          },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_lead_conversations",
        });
        return formatTextContent("Lead Conversations", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 6: get_conversation_messages
  server.registerTool(
    "get_conversation_messages",
    {
      description:
        "Get all messages in a specific conversation. Returns a timeline of sent and received messages with content, sender, channel, and timestamps. Use conversation ID from get_lead_conversations.",
      inputSchema: {
        conversationId: z
          .string()
          .describe("The conversation ID (24-character hex string)"),
      },
      annotations: {
        title: "Get Conversation Messages",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/conversations/${params.conversationId}/messages`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_conversation_messages",
        });
        return formatTextContent("Conversation Messages", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // === Phase 2 Tools ===

  // Tool 7: get_campaign_messages
  server.registerTool(
    "get_campaign_messages",
    {
      description:
        "Get all message templates for a specific campaign. Returns the sequence of messages (emails, LinkedIn messages) with their HTML content, type, channel, and order. Useful for reviewing or modifying campaign messaging.",
      inputSchema: {
        campaignId: z
          .string()
          .describe("The campaign ID (24-character hex string)"),
      },
      annotations: {
        title: "Get Campaign Messages",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/campaigns/${params.campaignId}/messages`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_campaign_messages",
        });
        return formatTextContent("Campaign Messages", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 8: get_audience
  server.registerTool(
    "get_audience",
    {
      description:
        "Get detailed information about a specific audience. Returns name, description, size, type, and import status. Use audience IDs from list_campaigns results.",
      inputSchema: {
        audienceId: z
          .string()
          .describe("The audience ID (24-character hex string)"),
      },
      annotations: {
        title: "Get Audience Details",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/audiences/${params.audienceId}/detail`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_audience",
        });
        return formatTextContent("Audience Detail", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 9: save_identity_preference
  server.registerTool(
    "save_identity_preference",
    {
      description:
        'Save a preference for a specific identity. Preferences are key-value pairs organized by category (e.g., "tone", "language", "signature"). Used to personalize AI-generated content for this identity. Max 50 preferences per identity, 500 chars per value.',
      inputSchema: {
        identityId: z
          .string()
          .describe("The identity ID (24-character hex string)"),
        category: z
          .string()
          .describe('Preference category (e.g., "tone", "language", "style")'),
        key: z.string().describe("Preference key within the category"),
        value: z.string().describe("Preference value (max 500 characters)"),
        channel: z
          .string()
          .optional()
          .describe('Optional channel scope (e.g., "linkedin", "email")'),
      },
      annotations: {
        title: "Save Identity Preference",
        destructiveHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/identities/${params.identityId}/preferences`,
          {
            category: params.category,
            key: params.key,
            value: params.value,
            channel: params.channel,
          },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_preference_saved", {
          toolName: "save_identity_preference",
        });
        return formatTextContent("Preference Saved", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 10: analyze_conversation (Tier 2 — server-side inference)
  server.registerTool(
    "analyze_conversation",
    {
      description:
        "Classify the last lead message in a conversation. Returns structured JSON with 5-label certainty evaluations, suggested label + sub-label, and 8 binary signals. Useful for detecting recoverable B2B prospect conversations. Server-side inference — billed to LGM.",
      inputSchema: {
        conversationId: z
          .string()
          .describe(
            "The conversation ID (24-character hex string) — get it from get_lead_conversations.",
          ),
      },
      annotations: {
        title: "Analyze Conversation",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        if (!/^[a-f0-9]{24}$/i.test(params.conversationId)) {
          throw new McpFlowError(
            "Invalid conversationId. Expected a 24-character hex string.",
            400,
          );
        }

        const messages = await callFlow(
          apiKey,
          `/conversations/${params.conversationId}/messages`,
        );

        const formatted = formatConversationForClassifier(messages);
        if (formatted.messageCount === 0) {
          throw new McpFlowError(
            "Conversation has no readable messages.",
            404,
          );
        }
        if (!formatted.lastIsLead) {
          return formatTextContent("Analysis Skipped", {
            reason:
              "Last message is from the sender, not the lead. Nothing to classify.",
            messageCount: formatted.messageCount,
          });
        }

        const delimiter = crypto.randomBytes(8).toString("hex");
        const systemPrompt = buildClassifierSystemPrompt(delimiter);
        const userMessage = `<CONVERSATION_${delimiter}>\n${formatted.text}\n</CONVERSATION_${delimiter}>`;

        const classification = await inferStructured<Record<string, unknown>>({
          systemPrompt,
          userMessage,
          toolName: CLASSIFIER_TOOL_NAME,
          toolDescription: CLASSIFIER_TOOL_DESCRIPTION,
          toolSchema: CLASSIFIER_TOOL_SCHEMA as unknown as Record<string, unknown>,
        });

        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "analyze_conversation",
          promptVersion: CONVERSATION_CLASSIFIER_VERSION,
        });

        return formatTextContent("Conversation Analysis", {
          conversationId: params.conversationId,
          promptVersion: CONVERSATION_CLASSIFIER_VERSION,
          messageCount: formatted.messageCount,
          classification,
        });
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 11: explore_db (admin-only — server-side Anthropic agent over MongoDB)
  server.registerTool(
    "explore_db",
    {
      description:
        "Explore the LGM MongoDB with a natural-language brief. Admin only (@lagrowthmachine.com). Server-side Anthropic agent runs read-only queries via a validated AST proxy and returns a natural-language answer (semantic only — no schema or query dumps unless the brief asks).",
      inputSchema: {
        brief: z
          .string()
          .min(10)
          .max(5_000)
          .refine((s) => s.trim().length >= 10, {
            message: "Brief is whitespace-only or too short.",
          })
          .describe(
            "Question or exploration task in natural language (10–5000 chars).",
          ),
      },
      annotations: {
        title: "Explore Database (admin)",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      const briefHash = crypto
        .createHash("sha256")
        .update(params.brief)
        .digest("hex")
        .slice(0, 16);
      // ACL gate — currently a POC passthrough (cf. acl.ts header).
      // Kept inline so swapping to a real check (e.g. domain enforcement)
      // is a one-symbol edit, not a refactor.
      try {
        await assertLgmStaff(apiKey);
        const result = await runDbExplorerAgent(params.brief);
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "explore_db",
          promptVersion: DB_EXPLORER_PROMPT_VERSION,
          briefHash,
          briefLength: String(params.brief.length),
          queryCount: String(result.telemetry.queryCount),
          failedQueries: String(result.telemetry.failedQueries),
          loopIterations: String(result.telemetry.loopIterations),
          tokensUsed: String(result.telemetry.tokensUsed),
        });
        return {
          content: [{ type: "text" as const, text: result.answer }],
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown";
        trackMcpEvent(apiKey, "mcp_tool_failed", {
          toolName: "explore_db",
          briefHash,
          reason,
        }).catch(() => undefined);
        // Translate Mongo connect failures into a stable user-facing message
        // (cf. spec §4.4 "Mongo unreachable → Database unreachable.").
        if (
          error instanceof Error &&
          (error.name === "MongoServerSelectionError" ||
            error.name === "MongoNetworkError" ||
            /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(error.message))
        ) {
          return handleToolError(
            new McpFlowError("Database unreachable.", 503),
          );
        }
        return handleToolError(error);
      }
    },
  );

};
