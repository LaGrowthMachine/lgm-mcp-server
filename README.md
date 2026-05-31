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

The MCP gives your AI access to your LGM data. **LGM Skills** add expert GTM playbooks on top — turn-key prompts that pair with the MCP to run full workflows (sourcing, copy, benchmarking, revenue attribution), not just data fetching.

All skills live at **[github.com/LaGrowthMachine/gtm-system](https://github.com/LaGrowthMachine/gtm-system)** — the open-source GTM toolkit by La Growth Machine.

### Catalog

**Fuel my pipeline** — sourcing, list building, ICP

| Skill | What it does |
|---|---|
| [`sales-nav-search-builder`](https://github.com/LaGrowthMachine/gtm-system/blob/main/skills/fuel-my-pipeline/sales-nav-search-builder/SKILL.md) | Turn a natural-language ICP into a precise Sales Navigator search URL — ready to import as an LGM audience via `create_audience_from_linkedin_url`. |
| [`won-deal-icp-finder`](https://github.com/LaGrowthMachine/gtm-system/blob/main/skills/fuel-my-pipeline/won-deal-icp-finder/SKILL.md) | Audit your biggest closed-won deals to find your proven ICP and a look-alike target list. |

**Get qualified meetings** — campaigns, copy, sequences

| Skill | What it does |
|---|---|
| [`multichannel-campaign-builder`](https://github.com/LaGrowthMachine/gtm-system/blob/main/skills/get-qualified-meetings/multichannel-campaign-builder/SKILL.md) | Generate a complete LinkedIn + email sequence from a natural-language brief. |
| [`campaign-challenger`](https://github.com/LaGrowthMachine/gtm-system/blob/main/skills/get-qualified-meetings/campaign-challenger/SKILL.md) | Benchmark a campaign's copy against your real history (via `get_campaign_messages` + `get_campaign_stats`) and return prioritized fixes before launch. |
| [`campaign-impact-analyzer`](https://github.com/LaGrowthMachine/gtm-system/blob/main/skills/get-qualified-meetings/campaign-impact-analyzer/SKILL.md) | Rank campaigns by real revenue impact — cross-references LGM campaigns with HubSpot deals. |

**Catch opportunities** — reply handling, intent detection · *Coming soon.*

**Secure my channels** — channel health, deliverability, identities · *Coming soon.*

### Install (one line)

```bash
npx skills add LaGrowthMachine/gtm-system/skills/fuel-my-pipeline/sales-nav-search-builder
```

Replace the path with any skill from the catalog. Add `-g` for global install. Full instructions and the "without vs with the LGM MCP" value comparison: [gtm-system README](https://github.com/LaGrowthMachine/gtm-system).

### Example flow — Sales Nav search → audience → enrichment

> *"Build me a Sales Nav search for RevOps leaders at EMEA SaaS companies (50–500 employees), import it as a 'RevOps EMEA Q2' audience, and enrich every lead's pro email."*

With `sales-nav-search-builder` + the MCP installed, Claude can chain: build the URL → call `create_audience_from_linkedin_url` → call `bulk_enrich_audience` — end-to-end from a single prompt.

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
| `bulk_enrich_audience` | Enrich N pages of leads in an audience (1/2/5/10/20/all). Two-step confirm + lockstep cost check |
| `get_all_audience_leads` | Auto-paginated fetch of N pages of audience leads in one call |
| `get_enrich_result` | Resolve an enrichment request once status is `completed` |
| `get_credits` | Check your credit balance (total + expiring soon) |
| `discover_lgm_skills` | Browse the LGM Skills catalog (gtm-system) and get install commands — Claude calls this when a turn-key playbook would help |

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
