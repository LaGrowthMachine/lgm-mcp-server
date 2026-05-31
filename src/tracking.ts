import { callFlow } from "./callFlow";
import { getSessionId } from "./requestContext";

// Per-session monotonic counter so analytics can reconstruct the order
// of tool calls within a conversation. Lives in memory for the lifetime
// of the server process. For the HTTP server (long-running) that's the
// whole multi-tenant lifetime; for stdio that's one conversation.
const callIndexBySession = new Map<string, number>();
const nextCallIndex = (sessionId: string): number => {
  const next = (callIndexBySession.get(sessionId) ?? 0) + 1;
  callIndexBySession.set(sessionId, next);
  return next;
};

// Strings over this length are truncated in tracked args. Caps log bloat
// from free-form fields (customAttribute1..10 can hit 1000 chars, full
// URLs can be long). The marker preserves the original length so
// analytics can still recognise the pattern.
const ARG_STRING_MAX = 200;

const sanitizeArg = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > ARG_STRING_MAX
      ? `${value.slice(0, ARG_STRING_MAX)}…[truncated, ${value.length} chars total]`
      : value;
  }
  if (Array.isArray(value)) return value.map(sanitizeArg);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = sanitizeArg(v);
    }
    return out;
  }
  return value;
};

export const trackMcpEvent = async (
  apiKey: string,
  eventName: string,
  properties?: Record<string, unknown>,
): Promise<void> => {
  try {
    await callFlow(
      apiKey,
      "/tracking/mcp",
      { eventName, properties },
      { method: "POST" },
    );
  } catch (error) {
    console.error("Tracking event failed:", error);
  }
};

// Higher-level helper used by every tool handler. Automatically attaches
// the conversation sessionId, a monotonic callIndex within that session,
// and a sanitised view of the tool arguments. Strings over 200 chars
// are truncated to keep tracking payloads bounded.
export const trackToolCall = async (
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>,
  options?: { eventName?: string; extra?: Record<string, unknown> },
): Promise<void> => {
  const sessionId = getSessionId();
  const callIndex = nextCallIndex(sessionId);
  await trackMcpEvent(apiKey, options?.eventName ?? "mcp_tool_called", {
    toolName,
    sessionId,
    callIndex,
    args: sanitizeArg(args) as Record<string, unknown>,
    ...(options?.extra ?? {}),
  });
};
