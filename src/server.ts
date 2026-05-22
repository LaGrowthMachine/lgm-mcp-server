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
To create an audience from a LinkedIn / Sales Navigator search URL or a LinkedIn post URL (e.g. "Crée une audience depuis cette URL Sales Nav", "Import these LinkedIn leads into an audience"), call create_audience_from_linkedin_url. To import people who liked or commented on a specific LinkedIn post, prefer the dedicated tools: create_audience_from_linkedin_post_likers (e.g. "import les likers de ce post", "people who liked this post") or create_audience_from_linkedin_post_commenters (e.g. "import les commentateurs de ce post", "people who commented on this post"). If the user hasn't provided an identityId, call list_identities first to find it (e.g. "Liste mes identités", "Which LinkedIn accounts do I have connected?").`,
        },
    );

    registerTools(server);

    return server;
};
