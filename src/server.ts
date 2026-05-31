import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools';

export const createMcpServer = (): McpServer => {
    const server = new McpServer(
        {
            name: 'lgm',
            version: '1.0.0',
        },
        {
            instructions: `You are connected to LaGrowthMachine (LGM), a multichannel B2B sales outreach platform. Use these tools whenever the user mentions: campaigns, sequences, cadences, leads, contacts, prospects, audiences, lead lists, segments, outreach, prospecting, conversations, replies, message threads, LinkedIn / email messages, enrichment, email finder, credits, solde, identities, mailboxes — even without explicitly saying "LGM".

WHAT THIS MCP CAN DO:
- Read campaign performance (list_campaigns, get_campaign_stats, get_campaign_messages).
- Read audiences and the leads in them (list_audiences, get_audience, get_audience_leads for a single page, get_all_audience_leads for N auto-paginated pages).
- Find a specific lead (search_lead by leadId / LinkedIn / email / CRM ID / name+company).
- Create or update a lead and attach it to an audience (create_or_update_lead — supports all profile fields plus 10 long-text custom attributes).
- Build new audiences from LinkedIn / Sales Navigator search URLs or LinkedIn post URLs (create_audience_from_linkedin_url).
- Read full activity history and conversations for a lead (get_lead_logs, get_lead_conversations → get_conversation_messages).
- List connected LinkedIn / email identities (list_identities).
- Enrich leads with pro email and/or LinkedIn data — single lead (enrich_lead) or in bulk on an audience (bulk_enrich_audience).
- Poll asynchronous enrichment results (get_enrich_result).
- Check the credit balance (get_credits).
- Save per-identity preferences for personalising AI-generated content (save_identity_preference).

CRITICAL RULE #1 — credit-spending tools (enrich_lead, bulk_enrich_audience):
Two-step lockstep is enforced by the tools themselves.
  1. Call with confirm=false (or omit) to get a cost-vs-balance preview.
  2. Surface the cost to the user and get their explicit approval.
  3. Re-call with BOTH confirm=true AND acknowledgedCostCredits set to the exact preview value.
The tools REFUSE to spend without this lockstep — you cannot bypass it by guessing.

CRITICAL RULE #2 — audience-wide tools (get_all_audience_leads, bulk_enrich_audience):
Before calling, ALWAYS ASK the user how many pages to process: 1, 2, 5, 10, 20, or 'all'? Never assume. Each page = 100 leads by default. 'all' is capped at 20 pages (2000 leads) as a safety ceiling.

ROUTING HINTS (FR / EN):
- "Mes campagnes" / "list campaigns" → list_campaigns
- "Stats / KPIs / performance de campagne" → get_campaign_stats
- "Séquence / messages de campagne" → get_campaign_messages
- "Mes audiences" / "list audiences" → list_audiences
- "Détail d'audience" → get_audience
- "Crée une audience depuis cette URL" / "import this LinkedIn search" → create_audience_from_linkedin_url (needs identityId — call list_identities first if missing)
- "Tous les leads de l'audience X" / "all leads of this audience" → get_all_audience_leads (ASK PAGES FIRST)
- "Une page de leads" → get_audience_leads
- "Cherche le lead X" / "find this lead" → search_lead
- "Crée / mets à jour ce lead" / "create or update lead" / "add this contact" → create_or_update_lead (audience name required — ask user or call list_audiences if missing)
- "Logs / historique du lead" → get_lead_logs
- "Conversations avec X" → get_lead_conversations then get_conversation_messages
- "Mes identités" / "connected accounts" → list_identities
- "Combien de crédits" / "credit balance" / "solde" → get_credits
- "Enrichis ce lead" / "find his email" → enrich_lead (Rule #1)
- "Enrichis tous les leads de cette audience" / "bulk enrich" → bulk_enrich_audience (Rule #1 + #2)
- "Statut de l'enrichissement" / "is the email ready" → get_enrich_result
- "Sauvegarde une préférence pour l'identité X" → save_identity_preference`,
        },
    );

    registerTools(server);

    return server;
};
