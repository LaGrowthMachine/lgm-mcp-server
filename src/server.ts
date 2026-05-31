import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools';

export const createMcpServer = (): McpServer => {
    const server = new McpServer(
        {
            name: 'lgm',
            version: '1.0.0',
        },
        {
            instructions: `You are connected to LaGrowthMachine (LGM), a multichannel sales outreach platform.
Use LGM tools whenever the user mentions campaigns, leads, audiences, outreach, prospecting, sequences, or conversations — even without explicitly saying "LGM".
For example: "Montre-moi mes campagnes" means list_campaigns, "Mes leads" means get_audience_leads, "Les stats de ma campagne" means get_campaign_stats.
To create an audience from a LinkedIn / Sales Navigator search URL or a LinkedIn post URL (e.g. "Crée une audience depuis cette URL Sales Nav", "Import these LinkedIn leads into an audience"), call create_audience_from_linkedin_url. If the user hasn't provided an identityId, call list_identities first to find it (e.g. "Liste mes identités", "Which LinkedIn accounts do I have connected?").
To find a specific lead (e.g. "Cherche le lead John Smith chez Acme", "Find this LinkedIn profile in my leads"), call search_lead. To create or update a lead (e.g. "Crée ce lead", "Ajoute ce contact à mon audience X", "Update Jean Dupont's job title"), call create_or_update_lead — it requires an audience name, so ask the user or call list_audiences if missing.
To enrich a lead's email or LinkedIn data (e.g. "Enrichis ce lead", "Find his pro email"), call enrich_lead with confirm=false first to preview the credit cost, then re-call with confirm=true after the user explicitly approves. For a whole audience (e.g. "Enrichis tous les leads de l'audience X", "Bulk enrich this audience"), call bulk_enrich_audience the same way — one global confirmation for the whole batch.
To check the credit balance (e.g. "Combien j'ai de crédits", "What's my credit balance?"), call get_credits. After starting an enrichment, you can poll the result with get_enrich_result using the returned enrichRequestId.`,
        },
    );

    registerTools(server);

    return server;
};
