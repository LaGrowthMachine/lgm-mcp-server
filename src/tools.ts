import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callFlow, McpFlowError } from "./callFlow";
import { trackMcpEvent } from "./tracking";
import { getApiKey } from "./requestContext";

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
        "List, browse, audit, or analyze all outreach campaigns (sequences, cadences, workflows) for the authenticated La Growth Machine user. Use to get an overview of campaigns and their current status (RUNNING / PAUSED / READY / CANCELED), to find a campaign by name, or as a first step before drilling into a specific campaign's stats or messages. Supports filtering by status, search by name, and pagination. Synonyms: list, browse, audit, analyze, show, get campaigns, outreach sequences, cadences, workflows, prospecting campaigns, sales sequences, status, running, paused, ready, canceled.",
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
        "Get detailed statistics, performance metrics, KPIs, analytics, or results for a specific outreach campaign — total leads, acceptance rate, reply rate, open rate, click rate, conversion rate, and conversion data. Use after list_campaigns to drill into a single campaign's results, audit its performance, benchmark it, or report on its outcomes. Synonyms: statistics, stats, performance, metrics, KPIs, analytics, results, outcomes, reply rate, acceptance rate, conversion rate, open rate, click rate, campaign report.",
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
        "Get the list of leads, contacts, or prospects inside a specific audience (lead list, prospect list, segment). Returns full lead details — name, company, job title, email, LinkedIn URL — with pagination support. Use to export, analyze, or inspect the people inside an audience, or to qualify a list before launching a campaign. Synonyms: leads, contacts, prospects, people, audience members, list members, list contents, who is in this audience, get leads in audience.",
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
        "Get the full activity log, history, or audit trail of every action taken on a specific lead — emails sent, LinkedIn messages, connection requests, profile visits, follow-ups — with their statuses (sent, delivered, failed, accepted, replied). Use to debug why a lead hasn't progressed, audit engagement history, build a timeline of every touchpoint with a prospect, or troubleshoot a stuck lead. Synonyms: activity logs, actions, events, lead history, audit trail, touchpoints, engagement history, lead timeline, what happened to this lead, debug lead.",
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
        "Get all conversations, message threads, or exchanges with a specific lead across all channels (LinkedIn, email). Returns each conversation's status, last message preview, channel, and whether the lead has replied. Use to find conversation IDs to pass into get_conversation_messages, to audit who replied, or to inspect the engagement state of a prospect. Synonyms: conversations, threads, message threads, exchanges, dialog, chats, lead conversations, replies from lead, who replied.",
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
        "Get the full message history of a specific conversation — a timeline / thread of every sent and received message, with content, sender, channel (LinkedIn, email), and timestamps. Use after get_lead_conversations to read the actual exchange with a prospect, extract their replies, or analyze the dialog. Synonyms: conversation history, messages timeline, message thread, full exchange, dialog, conversation transcript, chat history, read conversation, what did they say.",
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
        "Get all message templates, sequence steps, or campaign copy for a specific outreach campaign. Returns each step (emails, LinkedIn messages, connection notes, voice messages) with HTML content, type, channel, and order in the sequence. Use to review, audit, or extract the messaging of a cadence — for example to copy a working template, debug a sequence, or analyze the copy of a campaign. Synonyms: messages, sequence steps, cadence steps, templates, copy, content, scripts, message templates, campaign messages, campaign copy, review messaging.",
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
        "Get detailed information, details, or metadata about a specific audience — name, description, size (leads count), type, and import / scraping status. Use to inspect an audience's metadata, to check how many leads it contains, or to poll its import progress after `create_audience_from_linkedin_url`. Synonyms: audience details, info, metadata, size, leads count, import status, scraping progress, audience summary, inspect audience.",
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
        'Save a preference, setting, or configuration value for a specific identity (LinkedIn / email sender). Preferences are key-value pairs organized by category (e.g., "tone", "language", "signature", "style") and used to personalize AI-generated content (messages, replies, copy) for that identity. Optionally scope a preference to a channel ("linkedin" / "email"). Max 50 preferences per identity, 500 chars per value. Synonyms: preferences, settings, configuration, identity config, sender settings, persona settings, tone, language, signature, style, customize identity.',
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

  // Tool 10: create_audience_from_linkedin_url
  server.registerTool(
    "create_audience_from_linkedin_url",
    {
      description:
        "Create a new audience (or populate an existing one) by importing leads from a LinkedIn Regular search URL, a Sales Navigator search URL, or a LinkedIn post URL. The `audience` parameter is a NAME, not an ID — if no audience with that name exists, LGM creates one; if it does, leads are added to it. Requires an `identityId` from list_identities; the underlying LinkedIn account must be connected and the LGM widget open during the import. Import runs asynchronously — poll get_audience to check status.",
      inputSchema: {
        audience: z
          .string()
          .min(1)
          .max(100)
          .describe(
            "Name (not ID) of the audience to populate. Creates it if it doesn't exist.",
          ),
        linkedinUrl: z
          .string()
          .url()
          .regex(
            /^https:\/\/(www\.)?linkedin\.com\//,
            "A valid LinkedIn URL is required (must start with https://www.linkedin.com/)",
          )
          .describe(
            "LinkedIn Regular search URL, Sales Navigator search URL, or LinkedIn post URL",
          ),
        identityId: z
          .string()
          .describe(
            "Identity to impersonate for the scrape (24-character hex ObjectId). Use list_identities to find it.",
          ),
        linkedinPostCategory: z
          .enum(["like", "comment"])
          .optional()
          .describe(
            "When linkedinUrl is a LinkedIn post, scrape leads by engagement type: 'like' or 'comment'",
          ),
        excludeContactedLeads: z
          .boolean()
          .optional()
          .describe("Exclude leads who have already been contacted"),
        autoImport: z
          .boolean()
          .optional()
          .describe("Auto-import new matching leads going forward"),
      },
      annotations: {
        title: "Create Audience from LinkedIn URL",
        destructiveHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          "/audiences",
          {
            audience: params.audience,
            linkedinUrl: params.linkedinUrl,
            identityId: params.identityId,
            linkedinPostCategory: params.linkedinPostCategory,
            excludeContactedLeads: params.excludeContactedLeads,
            autoImport: params.autoImport,
          },
          { method: "POST" },
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "create_audience_from_linkedin_url",
        });
        return formatTextContent("Audience Created", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 11: list_identities
  server.registerTool(
    "list_identities",
    {
      description:
        "List all connected identities — LinkedIn accounts, email accounts, senders, mailboxes — for the authenticated La Growth Machine user. Returns each identity's ID, name, channel, and connection status. Use to discover which accounts are connected, to audit available senders, or to grab an identity ID before calling tools that require an `identityId` (e.g., create_audience_from_linkedin_url, save_identity_preference). Synonyms: identities, connected accounts, LinkedIn accounts, email accounts, senders, mailboxes, profiles, my accounts, connected profiles, available senders.",
      inputSchema: {},
      annotations: {
        title: "List Identities",
        readOnlyHint: true,
      },
    },
    async (_params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/identities");
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "list_identities",
        });
        return formatTextContent("Identities", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
};
