import fs from "node:fs";
import path from "node:path";

export const DB_EXPLORER_PROMPT_VERSION = "v4";

const stripFrontmatter = (md: string): string => {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\s*\n/, "");
};

const loadDoctrineFile = (name: string): string => {
  // SKILL.md and reference.md sit next to this file. In production, package.json's
  // heroku-postbuild copies them alongside the compiled JS so __dirname resolves
  // identically in dev (ts) and prod (dist).
  const full = path.join(__dirname, name);
  try {
    return fs.readFileSync(full, "utf8");
  } catch (e) {
    throw new Error(
      `db-explorer doctrine: required file not found: ${full} (${(e as Error).message})`,
    );
  }
};

export const buildDbExplorerSystemPrompt = (): string => {
  const skill = stripFrontmatter(loadDoctrineFile("SKILL.md"));
  const reference = loadDoctrineFile("reference.md");
  return `${skill}\n\n---\n\n# Reference\n\n${reference}`;
};

// Tool definition consumed by agentLoop.ts to expose `run_query` to the
// Anthropic API inside the server-side agent. This is internal — no MCP tool
// surface, only used by the Heroku-side agent loop.
export const RUN_QUERY_TOOL_NAME = "run_query";
export const RUN_QUERY_TOOL_DESCRIPTION =
  "Execute a single read-only MongoDB expression (mongosh syntax). Returns EJSON-serialized output trimmed to 100KB, or an error with a hint.";
export const RUN_QUERY_TOOL_SCHEMA = {
  type: "object",
  properties: {
    expr: {
      type: "string",
      description:
        "Mongo expression rooted at db.<collection>.<op>(...). Single statement, no semicolons.",
    },
  },
  required: ["expr"],
};
