# La Growth Machine — B2B Outreach & Pipeline Analytics

Analyze LinkedIn & email outreach campaigns, track pipeline performance, and review lead conversations — for RevOps, Sales Managers, and SDR teams.

---

La Growth Machine connects your AI assistant to your outbound revenue stack — giving RevOps engineers, Sales Managers, and SDR teams instant access to campaign performance, lead engagement data, and message sequences across LinkedIn and email. Stop switching between dashboards to answer "what's working?". Ask your AI instead.

---

## Compatibility

This MCP server works with any MCP-compatible AI client:

- **Claude Desktop** (Anthropic)
- **Claude Code** (CLI & IDE extensions)
- **Cursor**, **Windsurf**, and other MCP-enabled editors
- Any client that supports the [Model Context Protocol](https://modelcontextprotocol.io)

---

## Why connect La Growth Machine to your AI?

Your outreach data is only useful if you can act on it. With this extension, your AI becomes your outbound analyst — surfacing what's working, what's stalling, and where to focus next.

**Built for:**
- **RevOps & GTM Engineers** who orchestrate the revenue stack and need fast, flexible access to campaign performance
- **Sales Managers & Team Leads** who need visibility on team activity and pipeline contribution without digging through dashboards
- **Sales Reps** managing live conversations and follow-ups across channels

---

## What you can do

**Analyze campaign performance**
Compare reply rates, acceptance rates, and conversion metrics across campaigns — and get a diagnosis, not just a table.

**Audit your message sequences**
Pull the full message flow for any campaign. Identify weak touchpoints or flag messages that may be dragging down your reply rate.

**Explore leads and audiences**
Browse leads by audience, filter by status, or deep-dive into a specific lead's profile: company, role, email, LinkedIn URL.

**Read full conversation threads**
Get the complete message history for any lead across all channels (email + LinkedIn) — with context, not just raw logs.

**Track engagement activity**
View all actions taken on a lead: connection requests sent, messages delivered, replies received, follow-ups triggered.

**Build audiences from a LinkedIn URL**
Drop in a LinkedIn search, Sales Navigator search, or LinkedIn post URL — your AI creates the audience and triggers the lead import in one shot.

**Create or update leads — and attach them to an audience**
Upsert a single lead with all the fields you have (profile, company, custom long-text attributes for personalized messages) and drop it into any audience for tracking.

**Enrich leads with email or LinkedIn data — without surprise spend**
Find a missing pro email or fill out a LinkedIn profile. Costs are previewed against your live credit balance and every enrichment requires your explicit confirmation — single lead or whole audience.

**Stay on top of your credits**
Check your credit balance any time, and never enrich without seeing the cost first.

**Personalize AI-generated outreach**
Save tone and style preferences per La Growth Machine identity, so your AI generates on-brand messages that match your voice.

---

## Go deeper with LGM Skills

The MCP gives your AI access to your data. **LGM Skills** give it the expertise to act on it.

Skills are specialized AI instructions that work hand-in-hand with this MCP — the MCP surfaces your campaign data, the skill knows how to analyze it and turn it into actionable recommendations.

### Available now

**Campaign Analyzer**
Pulls your campaign stats and sequences via the MCP, then runs a structured analysis to identify what's hurting your reply rate — weak subject lines, poor sequencing, missing follow-ups — and gives you prioritized recommendations to fix it.

> *"Analyze my 'VP Sales Q2' campaign and tell me what to improve."*

### Coming soon

- **Segmentation Advisor** — Audit your audience targeting and flag ICP mismatches before they hurt performance
- **Copywriting Coach** — Review your message sequences against outreach best practices and rewrite underperforming steps

All LGM Skills are available at:
[lagrowthmachine.com/.well-known/skills/index.json](https://lagrowthmachine.com/.well-known/skills/index.json?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store)

---

## Usage Examples

### Diagnose a campaign that's underperforming

**You:** "My 'VP Sales Q2' campaign has a low reply rate. Show me the message sequence and stats."

**AI:** Fetches campaign KPIs (acceptance rate, reply rate, conversion) and the full message sequence. Identifies which steps have drop-offs and flags messages that may be too generic or too long.

> **Want deeper recommendations?** Install the [Campaign Analyzer skill](https://lagrowthmachine.com/.well-known/skills/index.json?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store) to get structured, actionable improvements — not just data.

---

### Get a full picture of a lead before calling them

**You:** "Show me everything about John Smith at Acme Corp — conversation history, activity log, and their LinkedIn profile."

**AI:** Pulls the full engagement timeline: messages sent and received, connection status, reply content — giving you a complete pre-call brief in seconds.

---

### Weekly team pipeline review

**You:** "List all running campaigns, their reply rates, and flag anything below 10% acceptance."

**AI:** Generates a structured overview of active campaigns with key metrics, highlights underperformers, and surfaces which campaigns need attention.

> **Want to fix the underperformers?** Install the [Campaign Analyzer skill](https://lagrowthmachine.com/.well-known/skills/index.json?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store) for ICP and copy recommendations.

---

### Build an audience straight from a Sales Nav URL

**You:** "Create a new audience called 'DACH VPs of Sales' from this Sales Nav search — use my main LinkedIn identity. Here's the URL: https://www.linkedin.com/sales/search/people?..."

**AI:** Calls `list_identities` to resolve your main identity, then `create_audience_from_linkedin_url` to kick off the import. The import runs asynchronously — list your audiences and check progress with `get_audience`.

---

### Enrich every lead in an audience — with one confirmation

**You:** "Enrich every lead in my 'DACH VPs' audience with full enrichment (LinkedIn + email)."

**AI:** Resolves the audience via `list_audiences`, runs `bulk_enrich_audience` in dry-run mode and reports back: *"Will enrich 25 leads with FULL_ENRICH = 125 credits. You have 1,500. ✅ Sufficient. Audience: app.lagrowthmachine.com/audiences/6a10… — confirm?"* On your **OK**, it re-runs with `confirm: true`, loops every lead under the rate limit, and returns the audience URL so you can watch enrichments stream into LGM live.

---

### Find a lead by company, attach it to an audience, then enrich it

**You:** "Find John Smith at Acme Corp, add him to my 'Acme prospects' audience, and grab his work email."

**AI:** `search_lead(firstname='John', lastname='Smith', companyName='Acme')` → finds the leadId → `create_or_update_lead(leadId, audience='Acme prospects')` to attach → `enrich_lead(leadId, EMAIL_ENRICH)` previews the 5-credit spend against your balance and asks you to confirm. On your **OK**, the enrichment kicks off and Claude reminds you to check the audience page in LGM to see the email populate.

---

### Check your credit balance before a big push

**You:** "How many credits do I have left?"

**AI:** Calls `get_credits` and reports back: *"1,500 total — 200 of those expire soon."*

---

### Audit your outreach sequence before launch

**You:** "Show me the message flow for my 'DACH Enterprise' campaign — I want to check the timing and content before it goes live."

**AI:** Displays the full sequence with message content, channel (email vs LinkedIn), and step order — ready for a final review.

> **Not sure if the copy is strong enough?** The Copywriting Coach skill (coming soon) will review each message against outreach best practices and suggest rewrites.

---

## Available Tools

| Tool | Description |
|------|-------------|
| `list_campaigns` | List and filter campaigns by status, name, or date |
| `get_campaign_stats` | Acceptance rate, reply rate, conversions, and more |
| `get_campaign_messages` | Full message sequence with content and channel order |
| `get_audience` | Audience name, size, type, and import status |
| `get_audience_leads` | Leads list with name, company, role, email, LinkedIn |
| `get_lead_logs` | Full activity history for a lead across all channels |
| `get_lead_conversations` | All conversation threads with a lead |
| `get_conversation_messages` | Complete message thread in a conversation |
| `save_identity_preference` | Save tone/language/style for AI-generated content |
| `create_audience_from_linkedin_url` | Create or populate an audience from a LinkedIn / Sales Nav search or post URL |
| `list_identities` | List your connected LinkedIn / email identities — needed to pick an `identityId` |
| `search_lead` | Find leads by leadId, LinkedIn URL/ID, email, CRM ID, or firstname + lastname + company |
| `create_or_update_lead` | Upsert a lead into an audience — all profile fields + 10 long-text custom attributes |
| `enrich_lead` | Enrich one lead's email and/or LinkedIn profile. Requires `confirm: true` to spend credits |
| `bulk_enrich_audience` | Enrich every lead in an audience with one global confirmation, throttled, returns audience URL |
| `get_enrich_result` | Resolve an enrichment request once status is `completed` |
| `get_credits` | Check your credit balance (total + expiring soon) |

---

## Setup

### Claude Desktop

1. Download `lgm-mcp.mcpb`
2. Double-click to open with Claude Desktop
3. Click **Install**
4. Enter your LGM API key — find it in [Settings > API](https://app.lagrowthmachine.com/settings/api?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store)
5. Start chatting with your campaigns

### Claude.ai (web connector)

1. Go to [claude.ai](https://claude.ai) → **Settings** → **Connectors** → **Add custom connector**
2. Enter the following URL:
   ```
   https://mcpapp.lagrowthmachine.com/mcp
   ```
3. Open **Advanced parameters** and fill in the OAuth credentials:

   | Field | Value |
   |-------|-------|
   | **OAuth Client ID** | Your LGM account email |
   | **OAuth Client Secret** | Your LGM API key — find it in [Settings > API](https://app.lagrowthmachine.com/settings/integrations/api) |

4. Click **Save**.
5. Back on the Connectors list, click **Connect** on the La Growth Machine line — Claude.ai will go through the authentication flow and the connector will be active.

### Other MCP clients (Claude Code, Cursor, etc.)

```bash
claude mcp add --transport http --scope user LaGrowthMachine \
  https://mcpapp.lagrowthmachine.com/mcp \
  --header "X-LGM-API-KEY: <your-api-key>"
```

Replace `claude mcp add` with your client's equivalent MCP configuration command.

> Your API key is stored securely in the OS keychain (macOS Keychain / Windows Credential Manager). No La Growth Machine data is stored locally or shared with third parties.

---

## Privacy

This extension connects to the [La Growth Machine](https://lagrowthmachine.com?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store) API using your API key. Data is fetched on-demand and used only within your AI conversation. Nothing is stored beyond your API key (in the OS keychain). Your data is not shared with any third party.

Full policy: [lagrowthmachine.com/privacy-policy](https://lagrowthmachine.com/privacy-policy?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store)

---

## Support

- Help Center: [help.lagrowthmachine.com](https://help.lagrowthmachine.com?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store)
- Issues: [github.com/lagrowthmachine/lgm-mcp-server/issues](https://github.com/lagrowthmachine/lgm-mcp-server/issues)
