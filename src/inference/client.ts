import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_TIMEOUT_MS = 30_000;
// 1 seul retry (backoff fixe 2s, pas de jitter) : Bedrock EU est sous charge
// modérée, le but est de couvrir un throttle ponctuel sans bloquer l'UI. À
// faire évoluer (backoff exponentiel + jitter) si on voit des 503 récurrents.
const RETRY_BACKOFF_MS = 2_000;
const RETRYABLE_STATUSES = new Set<number>([429, 503, 529]);
const RETRYABLE_ERROR_NAMES = new Set<string>([
  "ThrottlingException",
  "ServiceUnavailableException",
]);

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} env var is not set`);
  return v;
};

let client: AnthropicBedrock | null = null;

export const getInferenceClient = (): AnthropicBedrock => {
  if (!client) {
    client = new AnthropicBedrock({
      apiKey: requireEnv("REPLY_MANAGER_BEDROCK_TOKEN"),
      baseURL: requireEnv("REPLY_MANAGER_BEDROCK_BASE_URL"),
      awsRegion: requireEnv("REPLY_MANAGER_BEDROCK_REGION"),
    });
  }
  return client;
};

const isRetryable = (err: unknown): boolean => {
  const e = err as { status?: number; name?: string } | null;
  if (!e) return false;
  if (typeof e.status === "number" && RETRYABLE_STATUSES.has(e.status)) return true;
  if (typeof e.name === "string" && RETRYABLE_ERROR_NAMES.has(e.name)) return true;
  return false;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CallWithRetryOptions {
  timeoutMs?: number;
}

export const callWithRetry = async (
  req: Anthropic.MessageCreateParamsNonStreaming,
  opts: CallWithRetryOptions = {},
): Promise<Anthropic.Message> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await getInferenceClient().messages.create(req, { timeout: timeoutMs });
  } catch (err) {
    if (!isRetryable(err)) throw err;
    await sleep(RETRY_BACKOFF_MS);
    try {
      return await getInferenceClient().messages.create(req, { timeout: timeoutMs });
    } catch {
      throw new Error("Inference rate-limited, retry shortly.");
    }
  }
};

export const __resetForTests = (): void => {
  client = null;
};
