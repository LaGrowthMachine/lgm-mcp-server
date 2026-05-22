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
To create an audience from a LinkedIn search or Sales Navigator search URL (e.g. "Crée une audience depuis cette URL Sales Nav"), call create_audience_from_linkedin_url. To import people who LIKED a LinkedIn post (e.g. "import les likers de ce post"), call create_audience_from_linkedin_post_likers. To import people who COMMENTED on a LinkedIn post (e.g. "import les commentateurs"), call create_audience_from_linkedin_post_commenters. If the user hasn't provided an identityId, call list_identities first (e.g. "Liste mes identités").`,
        },
    );

    registerTools(server);

    return server;
};
