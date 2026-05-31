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
        "Create, build, import, or populate a new audience (lead list, prospect list, segment) by scraping leads from a LinkedIn Regular search URL, a Sales Navigator search URL, or a LinkedIn post URL (likers / commenters). If no audience with the given name exists, LGM creates one; if it does, new leads are appended to it. The `audience` parameter is a NAME, not an ID. Requires an `identityId` from list_identities; the underlying LinkedIn account must be connected and the LGM widget open during the import. Import runs asynchronously — poll get_audience (by ID, found via list_audiences) to check progress. Synonyms: create audience, build audience, import LinkedIn, import Sales Nav, scrape LinkedIn, scrape Sales Navigator, build lead list, build prospect list, populate audience, LinkedIn search to audience, Sales Nav search to audience, audience from search URL, audience from post URL, post engagement audience, likers, commenters.",
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
        "List, browse, show, or discover all connected identities — LinkedIn accounts, email accounts, senders, mailboxes, personas — for the authenticated La Growth Machine user. Returns each identity's ID, name, channel, and connection status. Use to audit which accounts are connected, to grab an identity ID before calling tools that require an `identityId` (e.g. create_audience_from_linkedin_url, save_identity_preference, get_lead_logs / get_lead_conversations filters), or to confirm which sender the user has linked. Synonyms: identities, connected accounts, LinkedIn accounts, email accounts, senders, mailboxes, profiles, personas, connected profiles, my accounts, available senders, who am I sending from.",
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

  const THROTTLE_MS = 200; // 5 req/s, well under LGM's 50/10s ceiling

  // Pagination model shared by get_all_audience_leads and
  // bulk_enrich_audience: `pages` × `leadsPerPage` (default 100 = API max).
  // Two distinct caps:
  // - PAGES_NUMERIC_CAP: when the user picks a number, we accept 1-20.
  //   This bounds explicit user choices to a sane range.
  // - PAGES_ALL_CAP: when the user picks "all", we loop up to 100 pages.
  //   Higher ceiling because "all" is intentionally exhaustive. At 200 ms
  //   throttle this is ~20 s of API work in the worst case. For audiences
  //   larger than this, fall back to get_audience_leads with manual skip.
  // The lockstep acknowledgedCostCredits guard on bulk_enrich_audience is
  // the real safety against accidental over-spend — the page caps just
  // bound API call volume per tool invocation.
  const PAGE_SIZE_DEFAULT = 100;
  const PAGES_NUMERIC_CAP = 20;
  const PAGES_ALL_CAP = 100;
  const PagesSchema = z
    .union([
      z.number().int().min(1).max(PAGES_NUMERIC_CAP),
      z.literal("all"),
    ])
    .describe(
      `How many pages of audience leads to process (each page = leadsPerPage leads, default ${PAGE_SIZE_DEFAULT}). ALWAYS ASK THE USER WHICH VALUE TO USE before calling — options: 1, 2, 5, 10, 20, or 'all'. Never assume. Numeric values are capped at ${PAGES_NUMERIC_CAP} pages (${PAGES_NUMERIC_CAP * PAGE_SIZE_DEFAULT} leads). 'all' iterates up to ${PAGES_ALL_CAP} pages (${PAGES_ALL_CAP * PAGE_SIZE_DEFAULT} leads) as a hard safety ceiling — for audiences larger than that, fall back to get_audience_leads with manual skip pagination.`,
    );

  const fetchAudienceLeadsPaginated = async (
    apiKey: string,
    audienceId: string,
    pages: number | "all",
    leadsPerPage: number,
  ): Promise<{
    leads: Array<Record<string, unknown> & { id?: string }>;
    pagesFetched: number;
    totalInAudience: number | undefined;
    truncated: boolean;
  }> => {
    const maxPages =
      pages === "all"
        ? PAGES_ALL_CAP
        : Math.min(pages, PAGES_NUMERIC_CAP);
    const collected: Array<Record<string, unknown> & { id?: string }> = [];
    let pagesFetched = 0;
    let totalInAudience: number | undefined;

    for (let i = 0; i < maxPages; i++) {
      const skip = i * leadsPerPage;
      const page = (await callFlow(
        apiKey,
        `/audiences/${audienceId}/leads`,
        { skip, limit: leadsPerPage },
      )) as Record<string, unknown>;
      const arr = Array.isArray(page.data)
        ? (page.data as Array<Record<string, unknown> & { id?: string }>)
        : [];
      if (typeof page.total === "number") totalInAudience = page.total;
      if (arr.length === 0) break;
      collected.push(...arr);
      pagesFetched = i + 1;
      if (arr.length < leadsPerPage) break; // exhausted
      if (i < maxPages - 1) await sleep(THROTTLE_MS);
    }
    const truncated =
      typeof totalInAudience === "number" &&
      collected.length < totalInAudience;
    return { leads: collected, pagesFetched, totalInAudience, truncated };
  };

  // Tool 12: search_lead
  server.registerTool(
    "search_lead",
    {
      description:
        "Search, find, look up, locate, or identify one or more leads (contacts, prospects, people) in the authenticated La Growth Machine account by any combination of identifiers. At least ONE criterion is REQUIRED — leadId, LinkedIn URL / ID / publicId, email (pro or perso), CRM ID, or firstname+lastname (plus company name or URL to disambiguate). Matching priority: leadId > crmId > LinkedIn (linkedinId > linkedinPublicId > linkedinUrl) > email > firstname+lastname+company. Use the returned `id` field as the `leadId` for downstream tools that need it (enrich_lead, create_or_update_lead, get_lead_logs, get_lead_conversations). If the response includes `tooManyResults: true`, narrow the search by adding more criteria. Synonyms: search lead, find lead, lookup lead, locate lead, identify lead, find contact, find prospect, who is this person, lead by email, lead by LinkedIn, lead by CRM ID, retrieve lead, get lead by name, find by URL.",
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
        "Create, update, upsert, add, register, save, or modify a lead (contact, prospect) and attach it to a specific audience. Idempotent: existing leads are updated in place; new ones are created. The `audience` parameter is the audience NAME (not ID) and is REQUIRED — if you don't have one, call list_audiences to pick one or create_audience_from_linkedin_url to create one. Identify the lead by AT LEAST ONE of: leadId, proEmail, persoEmail, linkedinUrl, twitter, OR firstname+lastname (plus companyName or companyUrl to disambiguate). All other profile fields are optional. The 10 custom attribute slots (customAttribute1…customAttribute10, max 1000 chars each) accept long free-form text — suitable for personalized AI-generated messages, internal notes, context blobs, or any per-lead metadata your workflow needs. Synonyms: create lead, update lead, upsert lead, add lead, add contact, add prospect, save lead, register lead, push lead, attach lead to audience, sync lead, modify lead, edit lead, ensure lead exists, store custom attributes on lead.",
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
        "Enrich, find, append, complete, refresh, or look up a single lead's missing data — pro email and/or LinkedIn profile fields (job title, company, location, bio, etc.). Three enrichTypes drive what's looked up and how much it costs: EMAIL_ENRICH (default, up to 5 credits, finds pro email + email status valid/risky/etc.) — works WITHOUT leadId, can match by firstname+lastname+company; LINKEDIN_ENRICH (up to 1 credit, refreshes LinkedIn profile fields on the lead) — REQUIRES leadId; FULL_ENRICH (up to 5 credits, both at once) — REQUIRES leadId. Costs shown are upper bounds — LGM may not charge when no enrichment data is found (status `not_found`). Always uses polling mode: returns an enrichRequestId you resolve later via get_enrich_result. CONFIRMATION REQUIRED — two-step lockstep: (1) call with `confirm: false` (or omit) to get a cost-vs-balance preview. (2) present the cost to the user and get explicit approval. (3) re-call with BOTH `confirm: true` AND `acknowledgedCostCredits` set to the exact cost from the preview. The tool refuses to spend otherwise. Identify the lead by leadId (preferred — use search_lead to find it) or firstname+lastname (plus companyName / companyUrl / linkedinUrl to improve matching). Synonyms: enrich lead, find email, find pro email, get email, lookup email, email finder, refresh LinkedIn, refresh profile, complete profile, append data, fill missing fields, lead enrichment, data enrichment, B2B enrichment, find contact info, email lookup.",
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
        acknowledgedCostCredits: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "REQUIRED when confirm=true. Must exactly match the `estimatedCostCredits` value from the dry-run preview. Used as a lockstep guard to prove the cost was surfaced to the user before spending. The tool rejects confirm=true without this field, and rejects mismatched values.",
          ),
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

      // Lockstep guard — confirm=true requires acknowledgedCostCredits to
      // exactly match the per-type cost. This proves the model surfaced the
      // cost to the user before spending. It cannot be bypassed by passing
      // confirm=true alone.
      if (params.acknowledgedCostCredits === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: `enrich_lead refused to spend: when confirm=true, you must also pass acknowledgedCostCredits exactly matching the estimatedCostCredits from the dry-run preview (${cost} for ${enrichType}). Run with confirm=false first to surface the cost to the user, get their explicit OK, then re-call with confirm=true AND acknowledgedCostCredits=${cost}.`,
            },
          ],
          isError: true as const,
        };
      }
      if (params.acknowledgedCostCredits !== cost) {
        return {
          content: [
            {
              type: "text" as const,
              text: `enrich_lead refused to spend: acknowledgedCostCredits (${params.acknowledgedCostCredits}) does not match the actual cost (${cost} for ${enrichType}). Re-run the dry-run (confirm=false) to get the current cost and re-confirm with the user.`,
            },
          ],
          isError: true as const,
        };
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
        "Bulk enrich, mass enrich, batch enrich, or run an enrichment campaign on ALL leads (or N pages worth of leads) in an audience at once. Fetches the leads with auto-pagination, then loops POST /leads/enrich (polling mode) for each, throttled to respect LGM's 50-calls/10s rate limit, with graceful 429 recovery (partial-results + resume hint). TWO USER QUESTIONS REQUIRED before calling: (1) ASK HOW MANY PAGES: 1, 2, 5, 10, 20, or 'all' (capped at 20 pages = 2000 leads)? Never assume. Each page = leadsPerPage leads, default 100. (2) ASK FOR CONFIRMATION ON COST: run with `confirm: false` first to get a cost-vs-balance preview, surface the cost (and the audience URL) to the user, get explicit approval, then re-call with BOTH `confirm: true` AND `acknowledgedCostCredits` exactly matching the preview's estimatedTotalCostCredits. The tool refuses to spend otherwise. Preview cost is an upper bound — LGM may not charge for leads where enrichment finds no data (status `not_found`). Returns the audience URL so the user can watch enrichments stream live into the LGM UI. Synonyms: bulk enrich, mass enrich, batch enrich, enrich audience, enrich all leads, enrich list, find emails for audience, refresh audience LinkedIn, complete audience data, enrich every lead, enrichment campaign, bulk email finder, audience-wide enrichment.",
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
            "EMAIL_ENRICH (up to 5 cr/lead) | LINKEDIN_ENRICH (up to 1 cr/lead) | FULL_ENRICH (up to 5 cr/lead). All audience leads have IDs so all three types work here.",
          ),
        pages: PagesSchema,
        leadsPerPage: z
          .number()
          .int()
          .min(1)
          .max(PAGE_SIZE_DEFAULT)
          .optional()
          .default(PAGE_SIZE_DEFAULT)
          .describe(
            `Leads per page (advanced — default ${PAGE_SIZE_DEFAULT}, the API max). Lower it to enrich smaller windows.`,
          ),
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Set to true to actually spend credits and run the enrich loop. When false (default), returns a preview only. When true, acknowledgedCostCredits is also required.",
          ),
        acknowledgedCostCredits: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "REQUIRED when confirm=true. Must exactly match the `estimatedTotalCostCredits` value from the dry-run preview. Used as a lockstep guard to prove the cost was surfaced to the user before spending. The tool rejects confirm=true without this field, and rejects mismatched values (which can happen if the lead count changed since the dry-run).",
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
      const leadsPerPage = params.leadsPerPage ?? PAGE_SIZE_DEFAULT;
      const url = audienceUrl(params.audienceId);

      // Fetch leads via shared paginator (used for both preview and execute)
      let pageResult: {
        leads: Array<Record<string, unknown> & { id?: string }>;
        pagesFetched: number;
        totalInAudience: number | undefined;
        truncated: boolean;
      };
      try {
        pageResult = await fetchAudienceLeadsPaginated(
          apiKey,
          params.audienceId,
          params.pages,
          leadsPerPage,
        );
      } catch (error) {
        return handleToolError(error);
      }

      const leadIds = pageResult.leads
        .map((l) => l.id)
        .filter((id): id is string => Boolean(id));
      const n = leadIds.length;
      const perLeadCost = ENRICH_COSTS[enrichType];
      const totalCost = n * perLeadCost;

      // Confirm-gate (dry-run)
      if (!params.confirm) {
        const balance = await fetchCreditsBalance(apiKey);
        const sufficient =
          balance?.total !== undefined ? balance.total >= totalCost : null;
        const verdict =
          n === 0
            ? "Status: nothing to enrich (audience has no leads on the requested pages)."
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
            audienceTotalLeads: pageResult.totalInAudience,
            pagesRequested: params.pages,
            pagesFetched: pageResult.pagesFetched,
            leadsPerPage,
            leadsToEnrich: n,
            ...(pageResult.truncated
              ? {
                  truncationNote: `Fetched ${pageResult.pagesFetched} page${pageResult.pagesFetched > 1 ? "s" : ""} (${n} leads) out of an audience of ${pageResult.totalInAudience}. The remaining ${(pageResult.totalInAudience ?? 0) - n} leads are not in this run — to enrich them, re-call later with skip advanced via get_audience_leads, or filter the audience first.`,
                }
              : {}),
            enrichType,
            estimatedPerLeadCostCredits: perLeadCost,
            estimatedTotalCostCredits: totalCost,
            costNote:
              "Total is an upper bound. LGM typically doesn't charge for leads where enrichment finds no data (status `not_found`), so actual spend may be lower.",
            balance: formatBalanceLine(balance),
            verdict,
            nextStep:
              n === 0
                ? "Pick a different audience or different pages count."
                : `Surface the cost to the user, get explicit approval, then re-call with confirm=true AND acknowledgedCostCredits=${totalCost}.`,
          },
        );
      }

      // Lockstep guard — confirm=true requires acknowledgedCostCredits to
      // exactly match the just-computed totalCost. This proves the model
      // surfaced the cost to the user. It cannot be bypassed by passing
      // confirm=true alone, nor by passing a wrong number.
      if (params.acknowledgedCostCredits === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: `bulk_enrich_audience refused to spend: when confirm=true, you must also pass acknowledgedCostCredits exactly matching the estimatedTotalCostCredits from the dry-run preview (${totalCost} for ${n} leads × ${enrichType}). Run with confirm=false first to surface the cost to the user, get their explicit OK, then re-call with confirm=true AND acknowledgedCostCredits=${totalCost}.`,
            },
          ],
          isError: true as const,
        };
      }
      if (params.acknowledgedCostCredits !== totalCost) {
        return {
          content: [
            {
              type: "text" as const,
              text: `bulk_enrich_audience refused to spend: acknowledgedCostCredits (${params.acknowledgedCostCredits}) does not match the current cost (${totalCost} = ${n} leads × ${perLeadCost}). The lead count may have changed since the last dry-run. Re-run the dry-run to get the current cost and re-confirm with the user.`,
            },
          ],
          isError: true as const,
        };
      }

      if (n === 0) {
        return formatTextContent("Bulk Enrich — Nothing to do", {
          audienceId: params.audienceId,
          audienceUrl: url,
          pagesRequested: params.pages,
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
        pagesRequested: params.pages,
        pagesFetched: pageResult.pagesFetched,
        leadsRequested: n,
        successes: successes.length,
        failures: failures.length,
        ...(rateLimitedAt !== null
          ? {
              stoppedAfter: rateLimitedAt,
              rateLimitRetryAfterSeconds: retryAfter,
              nextStep: `Wait ${retryAfter ?? 60}s, then re-run bulk_enrich_audience to resume on the remaining leads.`,
            }
          : pageResult.truncated
            ? {
                moreLeadsRemaining:
                  (pageResult.totalInAudience ?? 0) - n,
                nextStep: `Audience has more leads beyond the safety ceiling reached on this run. To enrich the rest, re-run later with skip advanced via get_audience_leads, or filter the audience first.`,
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
        "Retrieve, poll, check, fetch, or look up the result of an enrichment request previously started by enrich_lead or bulk_enrich_audience (polling mode). Returns `status` (one of: pending / enriched / completed / failed / not_found) and, when finished, the enriched data — pro email, perso email, phone, refreshed LinkedIn profile fields, email validity status (valid / risky / unknown / etc.). Polling tip: enrichments usually complete within seconds to a minute — wait a beat before polling, and avoid tight loops to respect the 50-calls/10s rate limit. Synonyms: get enrichment result, check enrichment, poll enrich, enrichment status, enrich result, fetch enrich, retrieve enrich, is the email ready, did the enrichment work, enrichment outcome.",
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

  // Tool 17: get_all_audience_leads (auto-paginated)
  server.registerTool(
    "get_all_audience_leads",
    {
      description:
        "Fetch, retrieve, list, export, enumerate, or paginate through N pages worth of leads (contacts, prospects) from a specific audience in one auto-paginated call. Unlike get_audience_leads (one page at a time, max 100 leads), this tool loops the API for you, throttled to respect the 50-calls/10s rate limit. ALWAYS ASK THE USER WHICH VALUE TO USE for `pages` before calling — options: 1, 2, 5, 10, 20, or 'all'. Never assume. 'all' is capped at 20 pages (2000 leads with default leadsPerPage=100) as a safety ceiling — for larger audiences, fall back to get_audience_leads with manual skip pagination. Use to operate on multiple pages at once (e.g. before bulk_enrich_audience), to export the whole audience, or to enumerate leads for downstream processing or analysis. Synonyms: get all leads, list audience leads, export audience leads, all contacts in audience, enumerate audience, fetch all leads, paginate audience, full audience contents, dump audience, audience export.",
      inputSchema: {
        audienceId: z
          .string()
          .describe(
            "Audience ID (24-char hex). Use list_audiences to find it.",
          ),
        pages: PagesSchema,
        leadsPerPage: z
          .number()
          .int()
          .min(1)
          .max(PAGE_SIZE_DEFAULT)
          .optional()
          .default(PAGE_SIZE_DEFAULT)
          .describe(
            `Leads per page (advanced — default ${PAGE_SIZE_DEFAULT}, the API max).`,
          ),
      },
      annotations: {
        title: "Get All Audience Leads (paginated)",
        readOnlyHint: true,
      },
    },
    async (params, extra) => {
      const apiKey = resolveApiKey(extra);
      const leadsPerPage = params.leadsPerPage ?? PAGE_SIZE_DEFAULT;
      try {
        const result = await fetchAudienceLeadsPaginated(
          apiKey,
          params.audienceId,
          params.pages,
          leadsPerPage,
        );
        await trackMcpEvent(apiKey, "mcp_tool_called", {
          toolName: "get_all_audience_leads",
        });
        return formatTextContent("Audience Leads (paginated)", {
          audienceId: params.audienceId,
          audienceUrl: audienceUrl(params.audienceId),
          pagesRequested: params.pages,
          pagesFetched: result.pagesFetched,
          leadsPerPage,
          leadsFetched: result.leads.length,
          totalInAudience: result.totalInAudience,
          ...(result.truncated
            ? {
                truncationNote: `Fetched ${result.pagesFetched} page${result.pagesFetched > 1 ? "s" : ""} (${result.leads.length} leads) out of an audience of ${result.totalInAudience}. The remaining ${(result.totalInAudience ?? 0) - result.leads.length} leads are not in this response — use get_audience_leads with skip advanced to retrieve them.`,
              }
            : {}),
          data: result.leads,
        });
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // Tool 18: get_credits
  server.registerTool(
    "get_credits",
    {
      description:
        "Get, check, view, display, or report the current credit balance, wallet, account credits, or solde for the authenticated La Growth Machine account. Returns `total` (all credits available) and `perishable` (credits that expire soon — already included in total). Use to check the wallet before running credit-spending tools (enrich_lead, bulk_enrich_audience), to surface the balance to the user when they ask, or to plan upcoming enrichment workloads against the budget. Synonyms: credits, credit balance, solde, mon solde, wallet, account balance, available credits, remaining credits, credits left, how many credits, enrichment budget, credit budget, account credits.",
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
