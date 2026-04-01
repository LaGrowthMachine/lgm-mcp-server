# LaGrowthMachine — MCP Server

Connect [LaGrowthMachine](https://lagrowthmachine.com) to any AI assistant that supports the [Model Context Protocol](https://modelcontextprotocol.io). Manage your multichannel outreach campaigns, analyze performance, explore leads, and read conversations — all through natural language.

**Works with:** Claude Desktop, Claude Code, Claude.ai, VS Code / GitHub Copilot, Cursor, Windsurf, Cline, JetBrains IDEs, Continue, OpenAI Agents SDK, OpenAI Codex, Amazon Q, and any MCP-compatible client.

## Features

- **Campaign management** — List, filter, and search your outreach campaigns
- **Performance analytics** — Get detailed stats: acceptance rate, reply rate, conversions
- **Lead exploration** — Browse leads with full details (name, company, job title, email, LinkedIn)
- **Activity tracking** — View engagement history: emails sent, LinkedIn messages, connection requests
- **Conversation reader** — Read full message threads across all channels
- **AI preferences** — Save identity preferences to personalize AI-generated content

## Prerequisites

- **LGM API Key** (required) — get yours in [Settings > API](https://app.lagrowthmachine.com/settings/api)

## Installation

### Claude Desktop

1. Download the `lgm-mcp.mcpb` file
2. Double-click to open with Claude Desktop
3. Click **Install**
4. Enter your LGM API key
5. Start chatting — ask Claude about your campaigns

Or install from the extension directory: **Settings > Extensions > Browse > "LaGrowthMachine"**.

### Claude Code

```bash
claude mcp add --transport http --scope user LaGrowthMachine https://mcpapp.lagrowthmachine.com/mcp --header "X-LGM-API-KEY: <your-api-key>"
```

### VS Code / GitHub Copilot

Add to `.vscode/mcp.json` (project) or your user-level `mcp.json`:

```json
{
  "servers": {
    "lgm": {
      "type": "http",
      "url": "https://mcpapp.lagrowthmachine.com/mcp",
      "headers": {
        "X-LGM-API-KEY": "${input:lgm-api-key}"
      }
    }
  },
  "inputs": [
    {
      "id": "lgm-api-key",
      "type": "promptString",
      "description": "Your LaGrowthMachine API key",
      "password": true
    }
  ]
}
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "lgm": {
      "url": "https://mcpapp.lagrowthmachine.com/mcp",
      "headers": {
        "X-LGM-API-KEY": "<your-api-key>"
      }
    }
  }
}
```

### Windsurf

Add to your Windsurf MCP config (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "lgm": {
      "serverUrl": "https://mcpapp.lagrowthmachine.com/mcp",
      "headers": {
        "X-LGM-API-KEY": "<your-api-key>"
      }
    }
  }
}
```

### Cline (VS Code)

Open the Cline MCP settings panel and add:

```json
{
  "mcpServers": {
    "lgm": {
      "url": "https://mcpapp.lagrowthmachine.com/mcp",
      "headers": {
        "X-LGM-API-KEY": "<your-api-key>"
      }
    }
  }
}
```

### JetBrains IDEs

Go to **Settings > Tools > AI Assistant > MCP Servers**, click **Add (+) > As JSON** and paste:

```json
{
  "lgm": {
    "url": "https://mcpapp.lagrowthmachine.com/mcp",
    "headers": {
      "X-LGM-API-KEY": "<your-api-key>"
    }
  }
}
```

### Continue

Add to your Continue config (`~/.continue/config.yaml`):

```yaml
mcpServers:
  - name: lgm
    url: https://mcpapp.lagrowthmachine.com/mcp
    headers:
      X-LGM-API-KEY: <your-api-key>
```

### OpenAI Agents SDK (Python)

```python
from agents.mcp import MCPServerStreamableHttp

lgm_server = MCPServerStreamableHttp(
    name="lgm",
    params={
        "url": "https://mcpapp.lagrowthmachine.com/mcp",
        "headers": {"X-LGM-API-KEY": "<your-api-key>"},
    },
)
```

### OpenAI Codex

```bash
codex mcp add -- --transport http --url https://mcpapp.lagrowthmachine.com/mcp --header "X-LGM-API-KEY: <your-api-key>" lgm
```

### Amazon Q CLI

Add to your Amazon Q MCP config:

```json
{
  "mcpServers": {
    "lgm": {
      "url": "https://mcpapp.lagrowthmachine.com/mcp",
      "headers": {
        "X-LGM-API-KEY": "<your-api-key>"
      }
    }
  }
}
```

### Any MCP-compatible client

The server exposes a standard Streamable HTTP endpoint:

```
URL:    https://mcpapp.lagrowthmachine.com/mcp
Auth:   X-LGM-API-KEY: <your-api-key>
        (or Authorization: Bearer <your-api-key>)
```

## Usage Examples

### Example 1: Campaign overview

**Prompt:** "Show me my running campaigns"

**What happens:** Claude calls `list_campaigns` with status filter "running" and presents a summary table with campaign names, statuses, and key metrics.

**Expected output:** A formatted table of your active campaigns with their names, creation dates, and current statuses.

### Example 2: Campaign performance deep-dive

**Prompt:** "What are the stats for my campaign 'VP Sales Outreach' and show me the messages in the sequence"

**What happens:** Claude calls `get_campaign_stats` to fetch KPIs (acceptance rate, reply rate, conversion rate) and `get_campaign_messages` to retrieve the message sequence. It then presents an analysis combining both.

**Expected output:** A performance report with key metrics followed by the full message sequence (emails, LinkedIn messages) with their content and order in the flow.

### Example 3: Lead engagement analysis

**Prompt:** "Show me the conversation history with John Smith and what actions were taken"

**What happens:** Claude calls `get_lead_conversations` to find conversations, `get_conversation_messages` to read the full thread, and `get_lead_logs` to show all activities. It combines everything into a chronological engagement timeline.

**Expected output:** A complete engagement profile showing sent messages, received replies, connection requests, and their outcomes — with timestamps and channel information.

## Available Tools

| Tool                        | Type  | Description                                                               |
| --------------------------- | ----- | ------------------------------------------------------------------------- |
| `list_campaigns`            | Read  | List campaigns with filters (status, search) and pagination               |
| `get_campaign_stats`        | Read  | Detailed campaign statistics (acceptance rate, reply rate, conversions)   |
| `get_campaign_messages`     | Read  | Message templates for a campaign with content and sequence order          |
| `get_audience`              | Read  | Audience details (name, description, size, type, import status)           |
| `get_audience_leads`        | Read  | Leads in an audience (name, company, job title, email, LinkedIn)          |
| `get_lead_logs`             | Read  | Activity logs for a lead (emails, LinkedIn messages, connection requests) |
| `get_lead_conversations`    | Read  | All conversations with a lead across channels                             |
| `get_conversation_messages` | Read  | Full message thread in a conversation                                     |
| `save_identity_preference`  | Write | Save a preference for an identity (tone, language, style)                 |

## Developer Setup

For LGM internal development, you can connect a local MCP server instance to Claude Code or any client.

### Claude Code — Local API

```bash
claude mcp add --transport http --scope project LaGrowthMachineLocal http://localhost:3001/mcp --header "X-LGM-API-KEY: <api-key>" --header "X-LGM-API-URL: http://localhost:8081"
```

### Claude Code — Feature branch

```bash
claude mcp add --transport http --scope project LaGrowthMachineFeature http://localhost:3001/mcp --header "X-LGM-API-KEY: <api-key>" --header "X-LGM-API-URL: https://<branch>-api.preview.lgmfeatureenv7.com"
```

### Claude Code — Stdio (without Docker)

```bash
claude mcp add --transport stdio --scope project LaGrowthMachineLocal node /path/to/lgm-mcp-server/dist/index.js --env LGM_MCP_TRANSPORT=stdio --env LGM_API_URL=http://localhost:8081 --env LGM_API_KEY=<api-key>
```

### Environment variables

| Variable            | Default                             | Description                   |
| ------------------- | ----------------------------------- | ----------------------------- |
| `PORT`              | `3001`                              | HTTP server port              |
| `LGM_MCP_TRANSPORT` | `http`                              | Transport: `http` or `stdio`  |
| `LGM_API_URL`       | `https://apiv2.lagrowthmachine.com` | LGM Flow API URL              |
| `LGM_API_KEY`       | -                                   | API key (stdio mode only)     |

### HTTP endpoints

| Method            | Path            | Description             |
| ----------------- | --------------- | ----------------------- |
| `GET`             | `/health`       | Health check            |
| `GET`             | `/health/ready` | Readiness probe         |
| `POST/GET/DELETE` | `/mcp`          | MCP endpoint            |

## Privacy Policy

This extension connects to the LaGrowthMachine API to access your campaign and lead data.

- **Data collected:** The extension reads campaign, audience, lead, and conversation data from your LGM account via your API key. No data is stored locally beyond the API key (secured in the OS keychain).
- **Data usage:** Data is fetched on-demand when Claude calls a tool and is used only within your Claude conversation. It is not sent to any third party beyond Anthropic (as part of the Claude conversation).
- **Data sharing:** Your LGM data is not shared with any third party. The extension communicates only with the LaGrowthMachine API (`apiv2.lagrowthmachine.com`).
- **Data retention:** No LGM data is persisted by the extension. Conversation data follows Anthropic's standard data retention policies.
- **API key storage:** Your API key is stored securely in the operating system's keychain (macOS Keychain / Windows Credential Manager), not in plain text.

Full privacy policy: [https://lagrowthmachine.com/privacy-policy/](https://lagrowthmachine.com/privacy-policy/)

## Support

- **Help Center:** [https://help.lagrowthmachine.com](https://help.lagrowthmachine.com)
- **Issues:** [https://github.com/lagrowthmachine/lgm-mcp-server/issues](https://github.com/lagrowthmachine/lgm-mcp-server/issues)
