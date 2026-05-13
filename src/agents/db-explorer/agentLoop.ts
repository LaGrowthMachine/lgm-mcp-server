import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { EJSON } from "bson";
import {
  buildDbExplorerSystemPrompt,
  RUN_QUERY_TOOL_DESCRIPTION,
  RUN_QUERY_TOOL_NAME,
  RUN_QUERY_TOOL_SCHEMA,
} from "./prompt";
import { validate, ValidationError } from "./validator";
import { runValidatedQuery, type RunQueryError, type RunQueryResult } from "./interpreter";
import { getDb } from "./mongoClient";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4_096;
const MAX_ITERATIONS = 12;
const MAX_TOOL_USES_PER_ITERATION = 8;
const CONTEXT_TOKEN_CAP = 150_000;
const RETRY_BACKOFF_MS = 2_000;
const QUERY_PREVIEW_MAX = 80;
const AGENT_WALL_CLOCK_MS = 180_000;

interface QueryRecord {
  expr: string;
  ok: boolean;
  resultPreview?: string;
  error?: string;
  durationMs: number;
}

export interface ExploreDbTelemetry {
  queryCount: number;
  failedQueries: number;
  tokensUsed: number;
  loopIterations: number;
}

export interface ExploreDbResult {
  answer: string;
  telemetry: ExploreDbTelemetry;
}

const newReqId = (): string => crypto.randomBytes(4).toString("hex");

const escapeLogValue = (v: string): string =>
  v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");

const logLine = (parts: Record<string, unknown>): void => {
  const payload = Object.entries(parts)
    .map(([k, v]) => {
      if (typeof v === "string") {
        const needsQuote = v.length === 0 || /[\s"=\\]/.test(v);
        return needsQuote ? `${k}="${escapeLogValue(v)}"` : `${k}=${v}`;
      }
      return `${k}=${v}`;
    })
    .join(" ");
  console.error(`[explore_db] ${payload}`);
};

let client: Anthropic | null = null;

const getClient = (): Anthropic => {
  if (!client) {
    const apiKey = process.env.REPLY_MANAGER_API_KEY;
    if (!apiKey) throw new Error("REPLY_MANAGER_API_KEY env var is not set");
    client = new Anthropic({ apiKey });
  }
  return client;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const callAnthropicWithRetry = async (
  req: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> => {
  try {
    return await getClient().messages.create(req);
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 429 || status === 529) {
      await sleep(RETRY_BACKOFF_MS);
      try {
        return await getClient().messages.create(req);
      } catch {
        throw new Error("Inference rate-limited, retry shortly.");
      }
    }
    throw err;
  }
};

// Mask hex ObjectIds, email-like patterns, and bare digit runs (phones, ids).
export const maskSensitive = (s: string): string =>
  s
    .replace(/'[a-f0-9]{24}'/gi, "'***'")
    .replace(/"[a-f0-9]{24}"/gi, '"***"')
    .replace(/'[^'\s@]+@[^'\s]+'/g, "'***@***'")
    .replace(/"[^"\s@]+@[^"\s]+"/g, '"***@***"')
    .replace(/\b\d{7,}\b/g, "***");

const toQueryRecord = (
  expr: string,
  result: RunQueryResult | RunQueryError,
): QueryRecord => {
  const masked = maskSensitive(expr);
  if (result.ok) {
    const preview = EJSON.stringify(result.output, { relaxed: true });
    return {
      expr: masked.slice(0, QUERY_PREVIEW_MAX),
      ok: true,
      resultPreview:
        preview.length > 200 ? `${preview.slice(0, 200)}…` : preview,
      durationMs: result.durationMs,
    };
  }
  return {
    expr: masked.slice(0, QUERY_PREVIEW_MAX),
    ok: false,
    error: maskSensitive(result.error),
    durationMs: result.durationMs,
  };
};

const executeRunQuery = async (
  expr: string,
): Promise<RunQueryResult | RunQueryError> => {
  let validation;
  try {
    validation = validate(expr);
  } catch (e) {
    if (e instanceof ValidationError) {
      return {
        ok: false,
        error: e.message,
        hint: e.hint,
        durationMs: 0,
      };
    }
    return {
      ok: false,
      error: (e as Error).message,
      durationMs: 0,
    };
  }
  const db = await getDb();
  return runValidatedQuery(db, validation);
};

const extractText = (msg: Anthropic.Message): string =>
  msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

const firstTextBlock = (msg: Anthropic.Message): string => {
  const block = msg.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  return block ? block.text.trim() : "";
};

const runAgentLoop = async (
  reqId: string,
  t0: number,
  brief: string,
): Promise<ExploreDbResult> => {
  const system = buildDbExplorerSystemPrompt();
  const queries: QueryRecord[] = [];
  let tokensUsed = 0;
  let cumulativeInput = 0;
  let loopIterations = 0;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: brief },
  ];

  logLine({ reqId, event: "start", "brief.len": brief.length });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    loopIterations++;
    const resp = await callAnthropicWithRetry({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: [
        {
          name: RUN_QUERY_TOOL_NAME,
          description: RUN_QUERY_TOOL_DESCRIPTION,
          input_schema: RUN_QUERY_TOOL_SCHEMA as Anthropic.Tool.InputSchema,
        },
      ],
      messages,
    });

    cumulativeInput += resp.usage.input_tokens ?? 0;
    tokensUsed +=
      (resp.usage.input_tokens ?? 0) +
      (resp.usage.output_tokens ?? 0) +
      // cache_read_input_tokens is not on the typed Usage in older SDKs;
      // read defensively via a cast.
      ((resp.usage as unknown as { cache_read_input_tokens?: number })
        .cache_read_input_tokens ?? 0);

    if (cumulativeInput > CONTEXT_TOKEN_CAP) {
      throw new Error("Brief produced too much context.");
    }

    const narration = firstTextBlock(resp);
    logLine({ reqId, iter: loopIterations, narration });

    if (resp.stop_reason === "end_turn") {
      const rawAnswer = extractText(resp);
      if (queries.length === 0 && !rawAnswer.trim()) {
        throw new Error("Agent refused to act.");
      }
      if (!rawAnswer.trim()) {
        throw new Error("Agent returned no narrative.");
      }
      const telemetry: ExploreDbTelemetry = {
        queryCount: queries.length,
        failedQueries: queries.filter((q) => !q.ok).length,
        tokensUsed,
        loopIterations,
      };
      logLine({
        reqId,
        event: "done",
        queries: telemetry.queryCount,
        failed: telemetry.failedQueries,
        tokens: telemetry.tokensUsed,
        iters: telemetry.loopIterations,
        durationMs: Date.now() - t0,
      });
      return { answer: rawAnswer, telemetry };
    }

    if (resp.stop_reason === "max_tokens") {
      throw new Error("Inference truncated — narrow the brief.");
    }

    if (resp.stop_reason !== "tool_use") {
      throw new Error(`Unsupported stop_reason: ${resp.stop_reason}`);
    }

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) {
      throw new Error(
        "Inconsistent response: stop_reason=tool_use but no tool_use blocks.",
      );
    }
    if (toolUses.length > MAX_TOOL_USES_PER_ITERATION) {
      throw new Error(
        `Agent emitted ${toolUses.length} tool_use blocks in one iteration (cap=${MAX_TOOL_USES_PER_ITERATION}).`,
      );
    }

    // Single push of the assistant response.
    messages.push({ role: "assistant", content: resp.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      const input = block.input as { expr?: unknown };
      if (typeof input?.expr !== "string") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({ ok: false, error: "expr must be a string" }),
          is_error: true,
        });
        queries.push({
          expr: "[malformed]",
          ok: false,
          error: "expr must be a string",
          durationMs: 0,
        });
        logLine({
          reqId,
          iter: loopIterations,
          query: "ok=false",
          error: "expr must be a string",
          durationMs: 0,
        });
        continue;
      }
      const result = await executeRunQuery(input.expr);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: EJSON.stringify(result, { relaxed: true }),
        is_error: !result.ok,
      });
      const record = toQueryRecord(input.expr, result);
      queries.push(record);
      logLine({
        reqId,
        iter: loopIterations,
        query: record.ok ? "ok=true" : "ok=false",
        expr: record.expr,
        ...(record.error ? { error: record.error } : {}),
        durationMs: record.durationMs,
      });
    }

    // Single push of all tool_results in one user message.
    messages.push({ role: "user", content: toolResults });
  }

  throw new Error("Agent exceeded max iterations.");
};

export const runDbExplorerAgent = async (
  brief: string,
): Promise<ExploreDbResult> => {
  const reqId = newReqId();
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Agent exceeded 90s wall-clock budget")),
      AGENT_WALL_CLOCK_MS,
    );
  });
  try {
    return await Promise.race([runAgentLoop(reqId, t0, brief), timeout]);
  } catch (err) {
    logLine({
      reqId,
      event: "error",
      message: err instanceof Error ? err.message : "unknown",
      durationMs: Date.now() - t0,
    });
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const __resetClientForTests = (): void => {
  client = null;
};
