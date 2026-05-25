import "./eval/loadEnv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCP_SERVER_INFO, MCP_SERVER_OPTIONS } from "./server";
import { loadAndRegisterEndpoints } from "./endpoints/registry";
import { ensureSchema } from "./eval/db";

// stdio entrypoint used by the MCPB bundle (cf. `manifest.json` →
// `dist/stdio.js`). Single process = single transport = single server, so
// endpoints are loaded once at boot. NO `console.log` here — it would corrupt
// the JSON-RPC stdio stream; all diagnostics go to stderr.

// Hard timeout for the DB bootstrap. A Postgres in a network black hole
// (vs. cleanly refused) could otherwise hang `ensureSchema` indefinitely and
// block boot.
const BOOTSTRAP_DB_TIMEOUT_MS = 15000;

const main = async () => {
  console.error("[LGM] Starting stdio server...");
  const server = new McpServer(MCP_SERVER_INFO, MCP_SERVER_OPTIONS);
  try {
    await Promise.race([
      ensureSchema(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `ensureSchema timed out after ${BOOTSTRAP_DB_TIMEOUT_MS}ms`,
              ),
            ),
          BOOTSTRAP_DB_TIMEOUT_MS,
        ),
      ),
    ]);
    const n = await loadAndRegisterEndpoints(server);
    console.error("[boot] endpoints loaded:", n);
  } catch (err) {
    console.error(
      "[endpoints] DB unavailable, no tools will be served:",
      err,
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[LGM] Stdio server connected successfully");
};

main().catch((error) => {
  console.error("[LGM] Fatal error:", error);
  process.exit(1);
});
