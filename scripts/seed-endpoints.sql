-- Initial endpoints for the LGM MCP registry.
-- Run ONCE on a fresh environment AFTER the app has booted (ensureSchema
-- creates the `endpoints` table).
--
-- Convenience: npm run seed:endpoints
-- Manual:     psql $EVAL_DATABASE_URL -f scripts/seed-endpoints.sql
--
-- Idempotent: ON CONFLICT (name) DO NOTHING — re-running is a no-op.
-- Wrapped in BEGIN/COMMIT so partial failures don't leave the table half-seeded.

BEGIN;

INSERT INTO endpoints (name, type, description, config) VALUES
  ('list_campaigns', 'proxy',
   'List all campaigns for the authenticated user. Use this to get an overview of outreach campaigns, their statuses, and key metrics. Supports filtering by status and pagination.',
   '{"method":"GET","path":"/campaigns","title":"Campaigns","label":"List Campaigns","inputs":[{"name":"status","kind":"string","optional":true,"describe":"Filter by campaign status (e.g., \"RUNNING\", \"PAUSED\", \"READY\", \"CANCELED\")"},{"name":"skip","kind":"number","optional":true,"default":0,"describe":"Number of campaigns to skip for pagination"},{"name":"limit","kind":"number","optional":true,"default":25,"describe":"Maximum number of campaigns to return (max 25)"},{"name":"search","kind":"string","optional":true,"describe":"Search campaigns by name"}]}'::jsonb),
  ('get_campaign_stats', 'proxy',
   'Get detailed statistics for a specific campaign. Returns metrics like total leads, acceptance rate, reply rate, and conversion data. Use campaign ID from list_campaigns.',
   '{"method":"GET","path":"/campaigns/{campaignId}/stats","title":"Campaign Stats","label":"Get Campaign Statistics","inputs":[{"name":"campaignId","kind":"string","describe":"The campaign ID (24-character hex string)"}]}'::jsonb),
  ('get_audience_leads', 'proxy',
   'Get the list of leads in a specific audience. Returns lead details including name, company, job title, email, and LinkedIn URL. Supports pagination.',
   '{"method":"GET","path":"/audiences/{audienceId}/leads","title":"Audience Leads","label":"Get Audience Leads","inputs":[{"name":"audienceId","kind":"string","describe":"The audience ID (24-character hex string)"},{"name":"skip","kind":"number","optional":true,"default":0,"describe":"Number of leads to skip for pagination"},{"name":"limit","kind":"number","optional":true,"default":25,"describe":"Maximum number of leads to return (max 100)"}]}'::jsonb),
  ('get_lead_logs', 'proxy',
   'Get activity logs for a specific lead. Shows all actions taken on the lead: emails sent, LinkedIn messages, connection requests, and their statuses. Useful for understanding engagement history.',
   '{"method":"GET","path":"/leads/{leadId}/logs","title":"Lead Logs","label":"Get Lead Activity Logs","inputs":[{"name":"leadId","kind":"string","describe":"The lead ID (24-character hex string)"},{"name":"identityId","kind":"string","optional":true,"describe":"Filter logs by identity ID"},{"name":"skip","kind":"number","optional":true,"default":0,"describe":"Number of logs to skip for pagination"},{"name":"limit","kind":"number","optional":true,"default":25,"describe":"Maximum number of logs to return (max 100)"}]}'::jsonb),
  ('get_lead_conversations', 'proxy',
   'Get all conversations with a specific lead across all channels (LinkedIn, email). Shows conversation status, last message preview, and whether the lead has replied. Use this to find conversation IDs for get_conversation_messages.',
   '{"method":"GET","path":"/leads/{leadId}/conversations","title":"Lead Conversations","label":"Get Lead Conversations","inputs":[{"name":"leadId","kind":"string","describe":"The lead ID (24-character hex string)"},{"name":"identityId","kind":"string","optional":true,"describe":"Filter conversations by identity ID"}]}'::jsonb),
  ('get_conversation_messages', 'proxy',
   'Get all messages in a specific conversation. Returns a timeline of sent and received messages with content, sender, channel, and timestamps. Use conversation ID from get_lead_conversations.',
   '{"method":"GET","path":"/conversations/{conversationId}/messages","title":"Conversation Messages","label":"Get Conversation Messages","inputs":[{"name":"conversationId","kind":"string","describe":"The conversation ID (24-character hex string)"}]}'::jsonb),
  ('get_campaign_messages', 'proxy',
   'Get all message templates for a specific campaign. Returns the sequence of messages (emails, LinkedIn messages) with their HTML content, type, channel, and order. Useful for reviewing or modifying campaign messaging.',
   '{"method":"GET","path":"/campaigns/{campaignId}/messages","title":"Campaign Messages","label":"Get Campaign Messages","inputs":[{"name":"campaignId","kind":"string","describe":"The campaign ID (24-character hex string)"}]}'::jsonb),
  ('get_audience', 'proxy',
   'Get detailed information about a specific audience. Returns name, description, size, type, and import status. Use audience IDs from list_campaigns results.',
   '{"method":"GET","path":"/audiences/{audienceId}/detail","title":"Audience Detail","label":"Get Audience Details","inputs":[{"name":"audienceId","kind":"string","describe":"The audience ID (24-character hex string)"}]}'::jsonb),
  ('list_identities', 'proxy',
   'List all connected identities (LinkedIn / email accounts) for the authenticated user. Use the returned identity IDs to call tools that require an `identityId`, like create_audience_from_linkedin_url.',
   '{"method":"GET","path":"/identities","title":"Identities","label":"List Identities","inputs":[]}'::jsonb),
  ('save_identity_preference', 'proxy',
   'Save a preference for a specific identity. Preferences are key-value pairs organized by category (e.g., "tone", "language", "signature"). Used to personalize AI-generated content for this identity. Max 50 preferences per identity, 500 chars per value.',
   '{"method":"POST","path":"/identities/{identityId}/preferences","title":"Preference Saved","label":"Save Identity Preference","tracking_event":"mcp_preference_saved","inputs":[{"name":"identityId","kind":"string","describe":"The identity ID (24-character hex string)"},{"name":"category","kind":"string","describe":"Preference category (e.g., \"tone\", \"language\", \"style\")"},{"name":"key","kind":"string","describe":"Preference key within the category"},{"name":"value","kind":"string","describe":"Preference value (max 500 characters)"},{"name":"channel","kind":"string","optional":true,"describe":"Optional channel scope (e.g., \"linkedin\", \"email\")"}]}'::jsonb),
  ('create_audience_from_linkedin_url', 'proxy',
   'Create a new audience (or populate an existing one) by importing leads from a LinkedIn Regular search URL, a Sales Navigator search URL, or a LinkedIn post URL. The `audience` parameter is a NAME, not an ID — if no audience with that name exists, LGM creates one; if it does, leads are added to it. Requires an `identityId` from list_identities; the underlying LinkedIn account must be connected and the LGM widget open during the import. Import runs asynchronously — poll get_audience to check status.',
   '{"method":"POST","path":"/audiences","title":"Audience Created","label":"Create Audience from LinkedIn URL","destructive_hint":false,"inputs":[{"name":"audience","kind":"string","min":1,"max":100,"describe":"Name (not ID) of the audience to populate. Creates it if it doesn''t exist."},{"name":"linkedinUrl","kind":"string","format":"url","pattern":"^https://(www\\.)?linkedin\\.com/","pattern_message":"A valid LinkedIn URL is required (must start with https://www.linkedin.com/)","describe":"LinkedIn Regular search URL, Sales Navigator search URL, or LinkedIn post URL"},{"name":"identityId","kind":"string","describe":"Identity to impersonate for the scrape (24-character hex ObjectId). Use list_identities to find it."},{"name":"linkedinPostCategory","kind":"string","optional":true,"enum":["like","comment"],"describe":"When linkedinUrl is a LinkedIn post, scrape leads by engagement type: ''like'' or ''comment''"},{"name":"excludeContactedLeads","kind":"boolean","optional":true,"describe":"Exclude leads who have already been contacted"},{"name":"autoImport","kind":"boolean","optional":true,"describe":"Auto-import new matching leads going forward"}]}'::jsonb),
  ('analyze_conversation', 'builtin',
   'Classify the last lead message in a conversation. Always returns JSON `{ conversation, analysis }` where `conversation` is an array of formatted message lines (each `"SENDER: ..."` or `"LEAD: ..."`) and `analysis.status` is `ok` (with `classification`: 5-label certainty evaluations, suggested label + sub-label, 8 binary signals) or `skipped` (with `reason`, e.g. no lead reply). Useful for detecting recoverable B2B prospect conversations. Server-side inference — billed to LGM.',
   '{"handler":"analyze_conversation","title":"Conversation Analysis","label":"Analyze Conversation","inputs":[{"name":"conversationId","kind":"string","describe":"The conversation ID (24-character hex string) — get it from get_lead_conversations."}]}'::jsonb),
  ('explore_db', 'builtin',
   'Explore the LGM MongoDB with a natural-language brief. Admin only (@lagrowthmachine.com). Server-side Anthropic agent runs read-only queries via a validated AST proxy and returns a natural-language answer (semantic only — no schema or query dumps unless the brief asks).',
   '{"handler":"explore_db","label":"Explore Database (admin)","inputs":[{"name":"brief","kind":"string","min":10,"max":5000,"describe":"Question or exploration task in natural language (10–5000 chars)."}]}'::jsonb)
ON CONFLICT (name) DO NOTHING;

COMMIT;
