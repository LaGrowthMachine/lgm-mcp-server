# La Growth Machine — B2B Outreach & Pipeline Analytics

Analyze LinkedIn & email outreach campaigns, track pipeline performance, and review lead conversations in Claude — for RevOps, Sales Managers, and SDR teams.

---

La Growth Machine connects Claude to your outbound revenue stack — giving RevOps engineers, Sales Managers, and SDR teams instant access to campaign performance, lead engagement data, and message sequences across LinkedIn and email. Stop switching between dashboards to answer "what's working?". Ask Claude instead.

---

## Why connect La Growth Machine to Claude?

Your outreach data is only useful if you can act on it. With this extension, Claude becomes your outbound analyst — surfacing what's working, what's stalling, and where to focus next.

**Built for:**
- **RevOps & GTM Engineers** who orchestrate the revenue stack and need fast, flexible access to campaign performance
- **Sales Managers & Team Leads** who need visibility on team activity and pipeline contribution without digging through dashboards
- **Sales Reps** managing live conversations and follow-ups across channels

---

## What you can do

**Analyze campaign performance**
Ask Claude to compare reply rates, acceptance rates, and conversion metrics across campaigns — and get a diagnosis, not just a table.

**Audit your message sequences**
Pull the full message flow for any campaign. Ask Claude to identify weak touchpoints or suggest improvements based on sequence structure.

**Explore leads and audiences**
Browse leads by audience, filter by status, or deep-dive into a specific lead's profile: company, role, email, LinkedIn URL.

**Read full conversation threads**
Get the complete message history for any lead across all channels (email + LinkedIn) — with context, not just raw logs.

**Track engagement activity**
View all actions taken on a lead: connection requests sent, messages delivered, replies received, follow-ups triggered.

**Personalize AI-generated outreach**
Save tone and style preferences per La Growth Machine identity, so Claude generates on-brand messages that match your voice.

---

## Usage Examples

### Diagnose a campaign that's underperforming

**You:** "My 'VP Sales Q2' campaign has a low reply rate. Show me the message sequence and stats."

**Claude:** Fetches campaign KPIs (acceptance rate, reply rate, conversion) and the full message sequence. Analyzes which steps have drop-offs and flags messages that may be too generic or too long.

---

### Get a full picture of a lead before calling them

**You:** "Show me everything about John Smith at Acme Corp — conversation history, activity log, and their LinkedIn profile."

**Claude:** Pulls the full engagement timeline: messages sent and received, connection status, reply content — giving you a complete pre-call brief in seconds.

---

### Weekly team pipeline review

**You:** "List all running campaigns, their reply rates, and flag anything below 10% acceptance."

**Claude:** Generates a structured overview of active campaigns with key metrics, highlights underperformers, and surfaces which campaigns need attention.

---

### Audit your outreach sequence before launch

**You:** "Show me the message flow for my 'DACH Enterprise' campaign — I want to check the timing and content before it goes live."

**Claude:** Displays the full sequence with message content, channel (email vs LinkedIn), and step order — ready for a final review.

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

---

## Setup

1. Download `lgm-mcp.mcpb`
2. Double-click to open with Claude Desktop
3. Click **Install**
4. Enter your LGM API key — find it in [Settings > API](https://app.lagrowthmachine.com/settings/api?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store)
5. Start asking Claude about your campaigns

> Your API key is stored securely in the OS keychain (macOS Keychain / Windows Credential Manager). No La Growth Machine data is stored locally or shared with third parties.

---

## Privacy

This extension connects to the [La Growth Machine](https://lagrowthmachine.com?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store) API using your API key. Data is fetched on-demand and used only within your Claude conversation. Nothing is stored beyond your API key (in the OS keychain). Your data is not shared with any third party.

Full policy: [lagrowthmachine.com/privacy-policy](https://lagrowthmachine.com/privacy-policy?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store)

---

## Support

- Help Center: [help.lagrowthmachine.com](https://help.lagrowthmachine.com?utm_source=claude&utm_medium=mcp&utm_campaign=claude-store)
- Issues: [github.com/lagrowthmachine/lgm-mcp-server/issues](https://github.com/lagrowthmachine/lgm-mcp-server/issues)
