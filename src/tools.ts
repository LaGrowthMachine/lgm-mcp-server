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
        "List all connected identities (LinkedIn / email accounts) for the authenticated user. Use the returned identity IDs to call tools that require an `identityId`, like create_audience_from_linkedin_url.",
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

  // === Lead, enrich, and credits ===

  // Per-type credit costs for the enrich endpoint. Source: LGM API docs
  // (see GET /flow/credits for live balance). Hardcoded here so the
  // confirm-gates can show an estimated cost before spending; if LGM
  // changes pricing the source-of-truth shift will need a sync.
  const ENRICH_COSTS = {
    EMAIL_ENRICH: 5,
    LINKEDIN_ENRICH: 1,
    FULL_ENRICH: 5,
  } as const;
  type EnrichType = keyof typeof ENRICH_COSTS;

  const audienceUrl = (audienceId: string) =>
    `https://app.lagrowthmachine.com/audiences/${audienceId}`;

  const fetchCreditsBalance = async (
    apiKey: string,
  ): Promise<{ total?: number; perishable?: number } | null> => {
    try {
      const raw = (await callFlow(apiKey, "/credits")) as Record<
        string,
        unknown
      >;
      // Live API nests under `credits`; docs example shows top-level — accept both.
      const data =
        raw && typeof raw.credits === "object" && raw.credits !== null
          ? (raw.credits as Record<string, unknown>)
          : raw;
      return {
        total: typeof data?.total === "number" ? data.total : undefined,
        perishable:
          typeof data?.perishable === "number" ? data.perishable : undefined,
      };
    } catch {
      return null; // best-effort — preview should still render
    }
  };

  const formatBalanceLine = (
    balance: { total?: number; perishable?: number } | null,
  ): string => {
    if (!balance || balance.total === undefined) {
      return "Credits balance: unavailable (couldn't fetch /credits).";
    }
    const perish =
      balance.perishable !== undefined
        ? ` (${balance.perishable} expiring soon)`
        : "";
    return `Credits balance: ${balance.total} total${perish}`;
  };

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Tool 12: search_lead
  server.registerTool(
    "search_lead",
    {
      description:
        "Search for leads in the authenticated account by any combination of identifiers. At least one criterion is REQUIRED. Matching priority: leadId > crmId > LinkedIn (linkedinId > linkedinPublicId > linkedinUrl) > email > firstname+lastname+company. Use the returned `id` field as the `leadId` for tools like enrich_lead and create_or_update_lead. If the response includes `tooManyResults: true`, narrow the search by adding more criteria.",
      inputSchema: {
        leadId: z
          .string()
          .optional()
          .describe("Direct lookup by lead ID (24-char hex)"),
        linkedinUrl: z
          .string()
          .optional()
          .describe("Lead LinkedIn profile URL"),
        linkedinId: z.string().optional().describe("LinkedIn numeric ID"),
        linkedinPublicId: z
          .string()
          .optional()
          .describe("LinkedIn public identifier (vanity URL slug)"),
        email: z
          .string()
          .optional()
          .describe("Lookup by pro or perso email"),
        firstname: z.string().optional().describe("Lead first name"),
        lastname: z.string().optional().describe("Lead last name"),
        companyName: z
          .string()
          .optional()
          .describe("Lead's company name (narrows firstname+lastname matches)"),
        companyUrl: z
          .string()
          .optional()
          .describe("Lead's company URL (narrows firstname+lastname matches)"),
        location: z.string().optional().describe("Lead location filter"),
        industry: z.string().optional().describe("Lead industry filter"),
        crmId: z
          .string()
          .optional()
          .describe("Direct lookup by external CRM ID"),
      },
      annotations: {
        title: "Search Lead",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      const provided = Object.entries(params).filter(
        ([, v]) => v !== undefined && v !== null && v !== "",
      );
      if (provided.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "search_lead requires at least one search criterion (leadId, linkedinUrl, linkedinId, linkedinPublicId, email, crmId, or firstname+lastname).",
            },
          ],
          isError: true as const,
        };
      }
      try {
        const data = await callFlow(apiKey, "/leads/search", params);
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "search_lead",
        });
        return formatTextContent("Lead Search Results", data);
      } catch (error) {
        // The LGM API returns 404 "Lead not found" when no leads match.
        // That's an empty-result state, not a tool failure — surface it
        // as a normal response so the model can say "no matches" without
        // claiming the tool errored.
        if (error instanceof McpFlowError && error.statusCode === 404) {
          await trackMcpEvent(apiKey, "mcp_tool_called", {
            toolName: "search_lead",
          });
          return formatTextContent("Lead Search Results", {
            leads: [],
            matched: 0,
            note: "No leads matched the supplied criteria. Try different / additional fields.",
          });
        }
        return handleToolError(error);
      }
    },
  );

  // Tool 13: create_or_update_lead
  server.registerTool(
    "create_or_update_lead",
    {
      description:
        "Create a new lead or update an existing one (upsert), attached to the given audience. The `audience` parameter (name, not ID) is REQUIRED — if you don't have one, call list_audiences to pick one or create_audience_from_linkedin_url to create one. The lead must be identified by AT LEAST ONE of: leadId, proEmail, persoEmail, linkedinUrl, twitter, OR firstname+lastname (plus companyName or companyUrl to disambiguate). All other profile fields are optional. Custom attributes (customAttribute1…customAttribute10) accept up to 1000 characters each and are suitable for long free-form text such as personalized messages, AI-generated notes, or internal annotations.",
      inputSchema: {
        audience: z
          .string()
          .min(1)
          .max(100)
          .describe(
            "Name of the audience to attach the lead to. Use list_audiences to find existing names.",
          ),
        // Identifiers — at least one required (enforced in handler)
        leadId: z
          .string()
          .optional()
          .describe(
            "Existing lead ID — when provided, this is an update. Get via search_lead.",
          ),
        proEmail: z.string().optional().describe("Professional email"),
        persoEmail: z.string().optional().describe("Personal email"),
        linkedinUrl: z
          .string()
          .optional()
          .describe("LinkedIn profile URL"),
        twitter: z.string().optional().describe("Twitter / X handle or URL"),
        firstname: z.string().optional().describe("First name"),
        lastname: z.string().optional().describe("Last name"),
        companyName: z
          .string()
          .optional()
          .describe(
            "Company name (also helps disambiguate firstname+lastname matches)",
          ),
        companyUrl: z
          .string()
          .optional()
          .describe(
            "Company URL (also helps disambiguate firstname+lastname matches)",
          ),
        // Profile fields
        gender: z
          .enum(["man", "woman"])
          .optional()
          .describe("Lead gender"),
        bio: z.string().optional().describe("Short bio / about text"),
        jobTitle: z.string().optional().describe("Job title"),
        profilePicture: z
          .string()
          .optional()
          .describe("URL of the lead's profile picture"),
        industry: z.string().optional().describe("Industry"),
        phone: z.string().optional().describe("Phone number"),
        crm_id: z
          .string()
          .optional()
          .describe("External CRM ID for the lead"),
        location: z.string().optional().describe("Location / city"),
        relationsCount: z
          .number()
          .optional()
          .describe("Number of LinkedIn connections / followers"),
        // Custom attributes (10 long-text slots)
        customAttribute1: z.string().max(1000).optional(),
        customAttribute2: z.string().max(1000).optional(),
        customAttribute3: z.string().max(1000).optional(),
        customAttribute4: z.string().max(1000).optional(),
        customAttribute5: z.string().max(1000).optional(),
        customAttribute6: z.string().max(1000).optional(),
        customAttribute7: z.string().max(1000).optional(),
        customAttribute8: z.string().max(1000).optional(),
        customAttribute9: z.string().max(1000).optional(),
        customAttribute10: z.string().max(1000).optional(),
        // Options
        excludeContactedLeads: z
          .boolean()
          .optional()
          .describe("If true, skip leads who have already been contacted"),
      },
      annotations: {
        title: "Create or Update Lead",
        destructiveHint: false,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      const hasNameAndCompany = Boolean(
        params.firstname &&
          params.lastname &&
          (params.companyName || params.companyUrl),
      );
      const hasIdentifier =
        Boolean(
          params.leadId ||
            params.proEmail ||
            params.persoEmail ||
            params.linkedinUrl ||
            params.twitter,
        ) || hasNameAndCompany;
      if (!hasIdentifier) {
        return {
          content: [
            {
              type: "text" as const,
              text: "create_or_update_lead requires at least one identifier: leadId, proEmail, persoEmail, linkedinUrl, twitter, OR firstname+lastname together with companyName or companyUrl.",
            },
          ],
          isError: true as const,
        };
      }
      // Strip undefined keys so the body stays clean
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) body[k] = v;
      }
      try {
        const data = await callFlow(apiKey, "/leads", body, {
          method: "POST",
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "create_or_update_lead",
        });
        return formatTextContent(
          `Lead upserted in audience "${params.audience}" — find the audience ID via list_audiences to view at ${audienceUrl("{audienceId}")}`,
          data,
        );
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 14: enrich_lead
  server.registerTool(
    "enrich_lead",
    {
      description:
        "Enrich a single lead with pro email and/or LinkedIn profile fields. Three enrichTypes: EMAIL_ENRICH (default, up to 5 credits, finds pro email) — works without leadId; LINKEDIN_ENRICH (up to 1 credit, fills LinkedIn fields) — REQUIRES leadId; FULL_ENRICH (up to 5 credits, both) — REQUIRES leadId. Costs shown are upper bounds — LGM may not charge when no enrichment data is found (e.g. status `not_found`). Always uses polling mode: returns an enrichRequestId you resolve via get_enrich_result. CONFIRMATION REQUIRED: call with `confirm: false` (or omit) first to see a cost-vs-balance preview, then re-call with `confirm: true` to actually spend credits. Identify the lead by leadId (preferred) or firstname+lastname (+ companyName / companyUrl / linkedinUrl to improve matching).",
      inputSchema: {
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Set to true to actually spend credits. When false (default), returns a preview only.",
          ),
        enrichType: z
          .enum(["EMAIL_ENRICH", "LINKEDIN_ENRICH", "FULL_ENRICH"])
          .optional()
          .default("EMAIL_ENRICH")
          .describe(
            "EMAIL_ENRICH (5 cr) | LINKEDIN_ENRICH (1 cr, needs leadId) | FULL_ENRICH (5 cr, needs leadId)",
          ),
        leadId: z
          .string()
          .optional()
          .describe(
            "Existing lead ID (24-char hex). Required for LINKEDIN_ENRICH and FULL_ENRICH. Get via search_lead.",
          ),
        firstname: z
          .string()
          .optional()
          .describe("First name (when no leadId)"),
        lastname: z
          .string()
          .optional()
          .describe("Last name (when no leadId)"),
        companyName: z
          .string()
          .optional()
          .describe("Company name to improve matching"),
        companyUrl: z
          .string()
          .optional()
          .describe("Company URL to improve matching"),
        linkedinUrl: z
          .string()
          .max(500)
          .optional()
          .describe("LinkedIn profile URL to improve matching"),
      },
      annotations: {
        title: "Enrich Lead",
        destructiveHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      const enrichType = (params.enrichType ?? "EMAIL_ENRICH") as EnrichType;
      const hasLeadId = Boolean(params.leadId);
      const hasNameMatch = Boolean(params.firstname && params.lastname);

      // Cross-field validation
      if (!hasLeadId && !hasNameMatch) {
        return {
          content: [
            {
              type: "text" as const,
              text: "enrich_lead requires either a leadId (preferred, get via search_lead) or firstname+lastname (+ companyName / companyUrl / linkedinUrl to improve matching).",
            },
          ],
          isError: true as const,
        };
      }
      if (
        (enrichType === "LINKEDIN_ENRICH" || enrichType === "FULL_ENRICH") &&
        !hasLeadId
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${enrichType} requires a leadId. Use search_lead to find the lead first, then re-call enrich_lead with its id.`,
            },
          ],
          isError: true as const,
        };
      }

      const cost = ENRICH_COSTS[enrichType];

      // Confirm-gate — show preview and stop
      if (!params.confirm) {
        const balance = await fetchCreditsBalance(apiKey);
        const target = hasLeadId
          ? `leadId=${params.leadId}`
          : `${params.firstname} ${params.lastname}${params.companyName ? ` @ ${params.companyName}` : ""}`;
        const sufficient =
          balance?.total !== undefined ? balance.total >= cost : null;
        const verdict =
          sufficient === null
            ? "Status: balance unknown — proceed with caution."
            : sufficient
              ? "Status: ✅ Sufficient."
              : `Status: ❌ INSUFFICIENT (need ${cost}, have ${balance!.total}). Top up before proceeding.`;
        return formatTextContent(
          "Enrich Preview — confirmation required",
          {
            type: enrichType,
            estimatedCostCredits: cost,
            costNote:
              "Cost is an upper bound. LGM typically doesn't charge when enrichment finds no data (status `not_found`).",
            target,
            balance: formatBalanceLine(balance),
            verdict,
            nextStep:
              "Re-call enrich_lead with the same arguments plus `confirm: true` to actually spend credits.",
          },
        );
      }

      // Execute
      const body: Record<string, unknown> = {
        enrichType,
        mode: "polling",
      };
      if (params.leadId) body.leadId = params.leadId;
      if (params.firstname) body.firstname = params.firstname;
      if (params.lastname) body.lastname = params.lastname;
      if (params.companyName) body.companyName = params.companyName;
      if (params.companyUrl) body.companyUrl = params.companyUrl;
      if (params.linkedinUrl) body.linkedinUrl = params.linkedinUrl;

      try {
        const data = await callFlow(apiKey, "/leads/enrich", body, {
          method: "POST",
        });
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "enrich_lead",
        });
        return formatTextContent(
          `Enrich Started (${enrichType}, ~${cost} credits)`,
          {
            response: data,
            nextStep:
              "Poll get_enrich_result with the returned enrichRequestId to retrieve the enriched data once status=completed.",
          },
        );
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 15: bulk_enrich_audience
  server.registerTool(
    "bulk_enrich_audience",
    {
      description:
        "Enrich all leads in an audience in one batch. Fetches the audience leads, then loops POST /leads/enrich (polling mode) for each, throttled to respect LGM's 50-calls/10s rate limit. CONFIRMATION REQUIRED: call with `confirm: false` (or omit) first to see total leads × per-lead cost vs current credit balance, then re-call with `confirm: true` to actually run the loop. The preview cost is an upper bound — LGM may not charge for leads where enrichment finds no data (e.g. status `not_found`). Returns the audience URL so the user can watch enrichments stream in via the LGM UI. To process more than `limit` leads, re-run with `skip` advanced.",
      inputSchema: {
        audienceId: z
          .string()
          .describe(
            "Audience ID (24-char hex). Use list_audiences to find it.",
          ),
        enrichType: z
          .enum(["EMAIL_ENRICH", "LINKEDIN_ENRICH", "FULL_ENRICH"])
          .optional()
          .default("EMAIL_ENRICH")
          .describe(
            "EMAIL_ENRICH (5 cr/lead) | LINKEDIN_ENRICH (1 cr/lead) | FULL_ENRICH (5 cr/lead). All audience leads have IDs so all three types work here.",
          ),
        skip: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Pagination offset into the audience (default 0)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(25)
          .describe("Number of leads to enrich in this run (min 1, max 100)"),
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Set to true to actually spend credits and run the loop. When false (default), returns a preview only.",
          ),
      },
      annotations: {
        title: "Bulk Enrich Audience",
        destructiveHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      const enrichType = (params.enrichType ?? "EMAIL_ENRICH") as EnrichType;
      const limit = params.limit ?? 25;
      const skip = params.skip ?? 0;
      const url = audienceUrl(params.audienceId);

      // Fetch leads (used for both preview and execution)
      let leadsResponse: Record<string, unknown>;
      try {
        leadsResponse = (await callFlow(
          apiKey,
          `/audiences/${params.audienceId}/leads`,
          { skip, limit },
        )) as Record<string, unknown>;
      } catch (error) {
        return handleToolError(error);
      }

      const leadsArray = Array.isArray(leadsResponse.data)
        ? (leadsResponse.data as Array<{ id?: string }>)
        : [];
      const totalInAudience =
        typeof leadsResponse.total === "number"
          ? leadsResponse.total
          : undefined;
      const leadIds = leadsArray
        .map((l) => l.id)
        .filter((id): id is string => Boolean(id));
      const n = leadIds.length;
      const perLeadCost = ENRICH_COSTS[enrichType];
      const totalCost = n * perLeadCost;

      // Confirm-gate
      if (!params.confirm) {
        const balance = await fetchCreditsBalance(apiKey);
        const sufficient =
          balance?.total !== undefined ? balance.total >= totalCost : null;
        const verdict =
          n === 0
            ? "Status: nothing to enrich (no leads at this skip/limit)."
            : sufficient === null
              ? "Status: balance unknown — proceed with caution."
              : sufficient
                ? "Status: ✅ Sufficient."
                : `Status: ❌ INSUFFICIENT (need ${totalCost}, have ${balance!.total}).`;
        return formatTextContent(
          "Bulk Enrich Preview — confirmation required",
          {
            audienceId: params.audienceId,
            audienceUrl: url,
            audienceTotalLeads: totalInAudience,
            window: { skip, limit },
            leadsToEnrich: n,
            enrichType,
            estimatedPerLeadCostCredits: perLeadCost,
            estimatedTotalCostCredits: totalCost,
            costNote:
              "Total is an upper bound. LGM typically doesn't charge for leads where enrichment finds no data (status `not_found`), so actual spend may be lower.",
            balance: formatBalanceLine(balance),
            verdict,
            nextStep:
              n === 0
                ? "Advance `skip` or pick a different audience."
                : "Re-call bulk_enrich_audience with `confirm: true` to actually spend credits.",
          },
        );
      }

      if (n === 0) {
        return formatTextContent("Bulk Enrich — Nothing to do", {
          audienceId: params.audienceId,
          audienceUrl: url,
          window: { skip, limit },
          leadsToEnrich: 0,
        });
      }

      // Execute — throttled sequential loop
      const successes: Array<{ leadId: string; enrichRequestId?: string }> =
        [];
      const failures: Array<{
        leadId: string;
        statusCode?: number;
        message: string;
      }> = [];
      let rateLimitedAt: number | null = null;
      let retryAfter: number | undefined;
      const THROTTLE_MS = 200; // 5 req/s, well under LGM's 50/10s ceiling

      for (let i = 0; i < leadIds.length; i++) {
        const leadId = leadIds[i];
        try {
          const data = (await callFlow(
            apiKey,
            "/leads/enrich",
            { leadId, enrichType, mode: "polling" },
            { method: "POST" },
          )) as Record<string, unknown>;
          successes.push({
            leadId,
            enrichRequestId:
              typeof data.enrichRequestId === "string"
                ? data.enrichRequestId
                : undefined,
          });
        } catch (error) {
          if (error instanceof McpFlowError && error.statusCode === 429) {
            rateLimitedAt = i;
            retryAfter = error.retryAfter;
            break;
          }
          if (error instanceof McpFlowError) {
            failures.push({
              leadId,
              statusCode: error.statusCode,
              message: error.message,
            });
          } else {
            failures.push({
              leadId,
              message:
                error instanceof Error ? error.message : "Unknown error",
            });
          }
        }
        if (i < leadIds.length - 1) await sleep(THROTTLE_MS);
      }

      await trackMcpEvent(apiKey, "mcp_tool_called", {
        toolName: "bulk_enrich_audience",
      });

      const title =
        rateLimitedAt !== null
          ? "Bulk Enrich Stopped Early — rate limited"
          : "Bulk Enrich Completed";
      return formatTextContent(title, {
        audienceId: params.audienceId,
        audienceUrl: url,
        watchLive: "Open the audience URL in LGM to watch enrichments stream in.",
        enrichType,
        leadsRequested: n,
        successes: successes.length,
        failures: failures.length,
        ...(rateLimitedAt !== null
          ? {
              stoppedAfter: rateLimitedAt,
              rateLimitRetryAfterSeconds: retryAfter,
              nextStep: `Wait ${retryAfter ?? 60}s, then re-run bulk_enrich_audience with skip=${skip + rateLimitedAt} to resume.`,
            }
          : totalInAudience && skip + n < totalInAudience
            ? {
                moreLeadsRemaining: totalInAudience - (skip + n),
                nextStep: `Re-run with skip=${skip + n} to continue.`,
              }
            : {}),
        enrichRequestIds: successes,
        ...(failures.length > 0 ? { failureDetails: failures } : {}),
      });
    },
  );

  // Tool 16: get_enrich_result
  server.registerTool(
    "get_enrich_result",
    {
      description:
        "Retrieve the result of an enrichment request previously started by enrich_lead or bulk_enrich_audience (polling mode). Returns `status: pending | completed | failed` and, when completed, the enriched data (proEmail, persoEmail, phone, etc.). Polling tip: enrichments usually complete within seconds to a minute — wait a beat before polling, and avoid tight loops to respect the 50-calls/10s rate limit.",
      inputSchema: {
        enrichRequestId: z
          .string()
          .describe(
            "The enrichRequestId returned by enrich_lead or bulk_enrich_audience.",
          ),
      },
      annotations: {
        title: "Get Enrich Result",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(
          apiKey,
          `/leads/enrich/${params.enrichRequestId}`,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_enrich_result",
        });
        return formatTextContent("Enrich Result", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 17: get_credits
  server.registerTool(
    "get_credits",
    {
      description:
        "Get the current credit balance for the authenticated account. Returns `total` (all credits available) and `perishable` (credits that expire soon — already included in total). Use this to check before running enrich_lead or bulk_enrich_audience.",
      inputSchema: {},
      annotations: {
        title: "Get Credits",
        readOnlyHint: true,
      },
    },
    async (_params, extra) => {
      const apiKey = resolveApiKey(extra);
      try {
        const data = await callFlow(apiKey, "/credits");
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_credits",
        });
        return formatTextContent("Credits Balance", data);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
};
