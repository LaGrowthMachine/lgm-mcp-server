import { z, ZodTypeAny } from "zod";
import { callFlow } from "../callFlow";
import { trackMcpEvent } from "../tracking";
import {
  ProxyConfig,
  EndpointInput,
  proxyConfigSchema,
} from "./types";
import {
  formatTextContent,
  handleToolError,
  resolveApiKey,
} from "./util";
import type { EndpointRow } from "../eval/db";

// Map kind → base Zod constructor.
const baseZodOf = (kind: EndpointInput["kind"]): ZodTypeAny => {
  switch (kind) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
  }
};

// Convert an `EndpointInput` to a `ZodTypeAny`, applying kind-specific
// refinements (enum/pattern/format/min/max), then `describe` + `optional` +
// `default`. The result is consumed directly as the tool's inputSchema entry.
const buildInputZod = (input: EndpointInput): ZodTypeAny => {
  let s: ZodTypeAny;
  if (input.kind === "string") {
    if (input.enum !== undefined && input.enum.length > 0) {
      s = z.enum(input.enum as [string, ...string[]]);
    } else {
      let str = z.string();
      if (input.format === "url") str = str.url();
      if (input.min !== undefined) str = str.min(input.min);
      if (input.max !== undefined) str = str.max(input.max);
      if (input.pattern !== undefined) {
        const re = new RegExp(input.pattern);
        str = input.pattern_message
          ? str.regex(re, input.pattern_message)
          : str.regex(re);
      }
      s = str;
    }
  } else if (input.kind === "number") {
    let num = z.number();
    if (input.min !== undefined) num = num.min(input.min);
    if (input.max !== undefined) num = num.max(input.max);
    s = num;
  } else {
    s = baseZodOf(input.kind);
  }
  if (input.optional) s = s.optional();
  if (input.default !== undefined) {
    s = (s as z.ZodOptional<ZodTypeAny>).default(input.default);
  }
  s = s.describe(input.describe);
  return s;
};

// Flat Zod shape consumed by `server.registerTool`. One entry per input name.
export const buildInputSchemaShape = (
  inputs: EndpointInput[],
): Record<string, ZodTypeAny> => {
  const shape: Record<string, ZodTypeAny> = {};
  for (const input of inputs) {
    shape[input.name] = buildInputZod(input);
  }
  return shape;
};

// Substitute `{name}` placeholders in the path from params. Inputs consumed
// by the path are dropped from the remainder (so they don't also end up in
// query/body — a same name can't be in both).
export const renderPathAndParams = (
  path: string,
  params: Record<string, unknown>,
): { path: string; params: Record<string, unknown> } => {
  const used = new Set<string>();
  const rendered = path.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name) => {
    used.add(name);
    const v = params[name];
    // A path placeholder is implicitly required. A missing value would yield
    // a malformed URL (e.g. `/campaigns//stats`) and a silent 404 — throw
    // instead so the caller surfaces a clear error.
    if (v === undefined || v === null) {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    // Encode the segment — a value with `/`, `?`, `..` or unicode would
    // otherwise break out of its segment (path traversal / injection).
    return encodeURIComponent(String(v));
  });
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (used.has(k)) continue;
    rest[k] = v;
  }
  return { path: rendered, params: rest };
};

export interface BuiltProxyTool {
  meta: {
    description: string;
    inputSchema: Record<string, ZodTypeAny>;
    annotations:
      | { title: string; readOnlyHint: true }
      | { title: string; destructiveHint: boolean };
  };
  handler: (
    params: Record<string, unknown>,
    extra: { authInfo?: { token?: string } },
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: true;
  }>;
}

// Build a proxy tool (GET or POST) from a DB row. Assumes `row.config` was
// already validated by `proxyConfigSchema` upstream (registry.ts); re-parses
// defensively.
export const buildProxyTool = (
  row: Pick<EndpointRow, "name" | "description" | "config">,
): BuiltProxyTool => {
  const config: ProxyConfig = proxyConfigSchema.parse(row.config);
  const description = row.description ?? "";
  const inputSchema = buildInputSchemaShape(config.inputs);
  const trackingEvent = config.tracking_event ?? "mcp_tool_called";

  const handler: BuiltProxyTool["handler"] = async (params, extra) => {
    const apiKey = resolveApiKey(extra);
    try {
      const { path, params: restParams } = renderPathAndParams(
        config.path,
        params,
      );
      let data: unknown;
      if (config.method === "GET") {
        data = await callFlow(
          apiKey,
          path,
          Object.keys(restParams).length > 0 ? restParams : undefined,
        );
      } else {
        data = await callFlow(apiKey, path, restParams, { method: "POST" });
      }
      await trackMcpEvent(apiKey, trackingEvent, { toolName: row.name });
      return formatTextContent(config.title ?? description, data);
    } catch (error) {
      return handleToolError(error);
    }
  };

  const titleStr = config.label ?? description;
  const annotations =
    config.method === "GET"
      ? { title: titleStr, readOnlyHint: true as const }
      : {
          title: titleStr,
          destructiveHint: config.destructive_hint ?? true,
        };

  return { meta: { description, inputSchema, annotations }, handler };
};
