import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

interface RequestContext {
  apiUrl?: string;
  apiKey?: string;
  // Conversation correlation ID. In HTTP mode this is either the
  // Mcp-Session-Id header sent by the client, or a fallback derived from
  // (apiKey, IP, 30-min window) when the client doesn't send one. In
  // stdio mode we fall back to a process-lifetime ID so all tool calls
  // from one stdio session correlate. Used in tracking to reconstruct
  // tool chains per conversation.
  sessionId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// Process-lifetime fallback. Used in stdio mode (one process = one
// conversation) and as a last-resort when no request-level session ID is
// available (shouldn't happen in HTTP mode after withRequestContext runs).
const PROCESS_SESSION_ID = `proc:${randomBytes(8).toString("hex")}:${Date.now()}`;

const ALLOWED_API_URL_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)*lagrowthmachine\.com$/,
  /^https:\/\/([a-z0-9-]+\.)*lagrowthmachine\.xyz$/,
  /^https:\/\/[a-z0-9-]+\.preview\.lgmfeatureenv7\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

export const isAllowedApiUrl = (url: string): boolean => {
  return ALLOWED_API_URL_PATTERNS.some((pattern) => pattern.test(url));
};

const resolveEnvUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("${")) return undefined;
  return trimmed;
};

export const getApiUrl = (): string => {
  const context = requestContext.getStore();
  return (
    context?.apiUrl ||
    resolveEnvUrl(process.env.LGM_API_URL) ||
    "https://apiv2.lagrowthmachine.com"
  );
};

export const getApiKey = (): string => {
  const context = requestContext.getStore();
  return context?.apiKey || process.env.LGM_API_KEY || "";
};

export const getSessionId = (): string => {
  const context = requestContext.getStore();
  return context?.sessionId || PROCESS_SESSION_ID;
};
