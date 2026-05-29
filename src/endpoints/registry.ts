import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listEndpoints, EndpointRow } from "../eval/db";
import { buildProxyTool } from "./proxy";
import { buildBuiltinTool } from "./builtin";
import {
  builtinConfigSchema,
  proxyConfigSchema,
} from "./types";

// Register one endpoints row on the given MCP server. Synchronous: no I/O,
// no await — `safeParse` + `server.registerTool` are sync. Never throws: the
// caller doesn't have to wrap each row in try/catch.
//   - unknown type / invalid config → skip + log + return false
//   - success                       → return true
export const registerFromRow = (
  server: McpServer,
  row: EndpointRow,
): boolean => {
  try {
    if (row.type === "proxy") {
      const parsed = proxyConfigSchema.safeParse(row.config);
      if (!parsed.success) {
        console.error(
          `[endpoints] skipping ${row.name}: ${parsed.error.message}`,
        );
        return false;
      }
      const built = buildProxyTool(row);
      server.registerTool(row.name, built.meta, built.handler);
      return true;
    }
    if (row.type === "builtin") {
      const parsed = builtinConfigSchema.safeParse(row.config);
      if (!parsed.success) {
        console.error(
          `[endpoints] skipping ${row.name}: ${parsed.error.message}`,
        );
        return false;
      }
      const built = buildBuiltinTool(row);
      server.registerTool(row.name, built.meta, built.handler);
      return true;
    }
    console.error(
      `[endpoints] skipping ${row.name}: unknown type "${row.type}"`,
    );
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[endpoints] skipping ${row.name}: ${msg}`);
    return false;
  }
};

// Load active+public endpoints from Postgres and register them on the MCP
// server. Returns the number actually registered (skipped rows excluded).
// Used by the stdio entrypoint (single process = single transport = single
// server, registered once at boot). The HTTP path inlines the equivalent in
// its per-request handler.
//
// Throws only if `listEndpoints` itself fails (DB unreachable). If the table
// is empty or every row is skipped, logs a warning and returns 0.
export const loadAndRegisterEndpoints = async (
  server: McpServer,
): Promise<number> => {
  const rows = await listEndpoints();
  let registered = 0;
  for (const row of rows) {
    if (registerFromRow(server, row)) registered++;
  }
  if (registered === 0) {
    console.error(
      "[endpoints] no endpoints registered (table empty or all skipped)",
    );
  }
  return registered;
};
