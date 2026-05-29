import { z } from "zod";

// Endpoint types served by the registry. `proxy` thinly wraps an LGM HTTP
// route (`callFlow`); `builtin` is a code-defined handler (Bedrock inference,
// agent loops) — DB owns the description/inputs/flags, code owns the logic.
export type EndpointType = "proxy" | "builtin";

// Schema for one declared input of a proxy/builtin endpoint. `kind` selects
// the base Zod type; `describe` is the only prompt the calling agent sees, so
// it's mandatory. Optional refinements (enum/pattern/format/min/max) are kept
// even when the UI doesn't expose a control, so round-trip edits don't lose
// them.
export const endpointInputSchema = z
  .object({
    name: z.string(),
    kind: z.enum(["string", "number", "boolean"]),
    optional: z.boolean().optional(),
    default: z.unknown().optional(),
    describe: z.string(),
    enum: z.array(z.string()).optional(),
    pattern: z.string().optional(),
    pattern_message: z.string().optional(),
    format: z.enum(["url"]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.kind !== "string") {
      if (input.enum !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["enum"],
          message: "enum only valid with kind:string",
        });
      }
      if (input.pattern !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pattern"],
          message: "pattern only valid with kind:string",
        });
      }
      if (input.format !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["format"],
          message: "format only valid with kind:string",
        });
      }
    }
    if (input.kind === "boolean") {
      if (input.min !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["min"],
          message: "min only valid with kind:string or kind:number",
        });
      }
      if (input.max !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["max"],
          message: "max only valid with kind:string or kind:number",
        });
      }
    }
  });

export type EndpointInput = z.infer<typeof endpointInputSchema>;

// Extracts `{placeholder}` tokens from a path. Duplicated in the front-end
// (web/pages/EndpointForm.tsx) — keep both regexes in sync.
export const PATH_PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

// Config for a `proxy` endpoint. `path` is forwarded to
// `callFlow(apiKey, path, params, {method})` (the `/flow` prefix is added by
// callFlow); `{name}` placeholders are substituted from inputs at call time.
// `method` drives the MCP annotation (GET → readOnlyHint, POST →
// destructiveHint, overridable via `destructive_hint`).
// `label` overrides annotations.title, `title` overrides the markdown header
// in the formatted response. `tracking_event` defaults to `mcp_tool_called`.
export const proxyConfigSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    path: z.string().startsWith("/"),
    title: z.string().optional(),
    label: z.string().optional(),
    tracking_event: z.string().optional(),
    destructive_hint: z.boolean().optional(),
    inputs: z.array(endpointInputSchema),
  })
  .superRefine((cfg, ctx) => {
    const inputNames = new Set(cfg.inputs.map((i) => i.name));
    const matches = cfg.path.matchAll(PATH_PLACEHOLDER_RE);
    for (const m of matches) {
      const placeholder = m[1];
      if (!inputNames.has(placeholder)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inputs"],
          message: `missing input declaration for path placeholder {${placeholder}}`,
        });
      }
    }
  });

export type ProxyConfig = z.infer<typeof proxyConfigSchema>;

// Catalogue of `builtin` handlers callable from a DB row. Adding a handler =
// add the key here AND register the implementation in `src/endpoints/builtin.ts`.
export const BUILTIN_HANDLERS = [
  "analyze_conversation",
  "explore_db",
] as const;
export type BuiltinHandler = (typeof BUILTIN_HANDLERS)[number];

// Config for a `builtin` endpoint. `handler` picks the implementation in
// `src/endpoints/builtin.ts`. The handler validates its own params against
// `inputs` (same Zod shape as proxy). `label` / `title` / `tracking_event`
// follow the same conventions as proxy.
export const builtinConfigSchema = z.object({
  handler: z.enum(BUILTIN_HANDLERS),
  title: z.string().optional(),
  label: z.string().optional(),
  tracking_event: z.string().optional(),
  inputs: z.array(endpointInputSchema),
});

export type BuiltinConfig = z.infer<typeof builtinConfigSchema>;

// Endpoint name rule: snake_case, ≤64 chars, starts with a letter. Reused
// server-side (POST/PUT) and front-side (in-form validation). Returns `null`
// on success, otherwise the error message — surfaced as-is in API responses.
// Mirrored in web/pages/EndpointForm.tsx (`NAME_RE`): keep both in sync.
export const ENDPOINT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const validateEndpointName = (s: string): string | null =>
  ENDPOINT_NAME_RE.test(s)
    ? null
    : "name must be snake_case, start with a letter, ≤64 chars";
