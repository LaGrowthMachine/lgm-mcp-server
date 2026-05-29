// Client unifié AWS Bedrock Converse API (Bearer auth via Bedrock API Key).
// Remplace l'ancien wrapper @anthropic-ai/bedrock-sdk : le format Converse est
// supporté nativement par Claude, Nova, Mistral, Cohere, Meta… donc un seul
// code path pour tous les providers Bedrock que l'on cible.
//
// Auth : Bedrock API Key envoyée en `Authorization: Bearer <token>`.
// Endpoint : `${baseURL}/model/{modelId}/converse`.
// Retry : 1 seul retry (backoff fixe 2s) sur 429/503/529 — couvre le throttle
// ponctuel sans bloquer l'UI. À faire évoluer (backoff exponentiel + jitter)
// si on voit des 503 récurrents.

export const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = 2_000;
const RETRYABLE_STATUSES = new Set<number>([429, 503, 529]);

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} env var is not set`);
  return v;
};

interface InferenceEnv {
  baseURL: string;
  token: string;
}

// On lit l'env paresseusement (pas à l'import) pour rester testable et pour
// que les routes qui n'invoquent jamais l'inférence ne se mettent pas en
// échec au boot quand l'env n'est pas configuré.
let cached: InferenceEnv | null = null;
const getEnv = (): InferenceEnv => {
  if (!cached) {
    cached = {
      baseURL: requireEnv("REPLY_MANAGER_BEDROCK_BASE_URL").replace(/\/$/, ""),
      token: requireEnv("REPLY_MANAGER_BEDROCK_TOKEN"),
    };
    // Validation côté env : on garde REPLY_MANAGER_BEDROCK_REGION exigé pour
    // ne pas casser les déploiements existants (Heroku config), même si la
    // région est déjà encodée dans le baseURL.
    requireEnv("REPLY_MANAGER_BEDROCK_REGION");
  }
  return cached;
};

// ---------- Types Converse (sous-ensemble que l'on utilise) ----------

export interface ConverseSystemBlock {
  text: string;
}

export interface ConverseToolUseBlock {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ConverseToolResultContent {
  text?: string;
  json?: Record<string, unknown>;
}

export interface ConverseToolResultBlock {
  toolUseId: string;
  content: ConverseToolResultContent[];
  status?: "success" | "error";
}

export type ConverseContentBlock =
  | { text: string }
  | { toolUse: ConverseToolUseBlock }
  | { toolResult: ConverseToolResultBlock };

export interface ConverseMessage {
  role: "user" | "assistant";
  content: ConverseContentBlock[];
}

export interface ConverseInferenceConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface ConverseToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export type ConverseToolChoice =
  | { auto: Record<string, never> }
  | { any: Record<string, never> }
  | { tool: { name: string } };

export interface ConverseToolConfig {
  tools: ConverseToolSpec[];
  toolChoice?: ConverseToolChoice;
}

export interface ConverseRequest {
  modelId: string;
  messages: ConverseMessage[];
  system?: ConverseSystemBlock[];
  inferenceConfig?: ConverseInferenceConfig;
  toolConfig?: ConverseToolConfig;
}

export type ConverseStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "guardrail_intervened"
  | "content_filtered";

export interface ConverseUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface ConverseResponse {
  output: { message: ConverseMessage };
  stopReason: ConverseStopReason;
  usage: ConverseUsage;
  metrics?: { latencyMs: number };
}

// ---------- Helpers de typage des blocks ----------

export const isTextBlock = (
  b: ConverseContentBlock,
): b is { text: string } => "text" in b && typeof b.text === "string";

export const isToolUseBlock = (
  b: ConverseContentBlock,
): b is { toolUse: ConverseToolUseBlock } => "toolUse" in b;

export const isToolResultBlock = (
  b: ConverseContentBlock,
): b is { toolResult: ConverseToolResultBlock } => "toolResult" in b;

// ---------- Erreur HTTP avec status pour la logique de retry ----------

export class ConverseHTTPError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Converse HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "ConverseHTTPError";
    this.status = status;
    this.body = body;
  }
}

const isRetryable = (err: unknown): boolean => {
  if (err instanceof ConverseHTTPError) {
    return RETRYABLE_STATUSES.has(err.status);
  }
  // `fetch` lève TypeError sur les pannes réseau (DNS, ECONNRESET, etc.).
  // On retry une fois ces erreurs transitoires. Tout autre Error (env
  // manquante, mauvais payload, AbortError volontaire) est non retryable.
  if (err instanceof TypeError) return true;
  return false;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface CallConverseOptions {
  timeoutMs?: number;
}

const doOneCall = async (
  req: ConverseRequest,
  timeoutMs: number,
): Promise<ConverseResponse> => {
  const { baseURL, token } = getEnv();
  const url = `${baseURL}/model/${encodeURIComponent(req.modelId)}/converse`;
  const { modelId: _unused, ...payload } = req;
  void _unused;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    if (!r.ok) throw new ConverseHTTPError(r.status, text);
    return JSON.parse(text) as ConverseResponse;
  } finally {
    clearTimeout(timer);
  }
};

export const callConverse = async (
  req: ConverseRequest,
  opts: CallConverseOptions = {},
): Promise<ConverseResponse> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await doOneCall(req, timeoutMs);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    await sleep(RETRY_BACKOFF_MS);
    try {
      return await doOneCall(req, timeoutMs);
    } catch {
      throw new Error("Inference rate-limited, retry shortly.");
    }
  }
};

export const __resetForTests = (): void => {
  cached = null;
};
