// Shared MCP server identity used by both the HTTP per-request server
// (src/index.ts) and the stdio per-process server (src/stdio.ts). Both clients
// see the same initialize response regardless of the transport.
export const MCP_SERVER_INFO = {
    name: 'lgm',
    version: '1.0.0',
};

export const MCP_SERVER_OPTIONS = {
    instructions: `You are connected to LaGrowthMachine (LGM), a multichannel sales outreach platform.
Use LGM tools whenever the user mentions campaigns, leads, audiences, outreach, prospecting, sequences, or conversations — even without explicitly saying "LGM".
For example: "Montre-moi mes campagnes" means list_campaigns, "Mes leads" means get_audience_leads, "Les stats de ma campagne" means get_campaign_stats.
To create an audience from a LinkedIn / Sales Navigator search URL or a LinkedIn post URL (e.g. "Crée une audience depuis cette URL Sales Nav", "Import these LinkedIn leads into an audience"), call create_audience_from_linkedin_url. If the user hasn't provided an identityId, call list_identities first to find it (e.g. "Liste mes identités", "Which LinkedIn accounts do I have connected?").`,
};
