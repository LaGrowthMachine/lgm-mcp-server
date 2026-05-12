import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = process.env.LGM_INFERENCE_MODEL || "claude-sonnet-4-6";

let client: Anthropic | null = null;

const getClient = (): Anthropic => {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set");
    client = new Anthropic({ apiKey });
  }
  return client;
};

export interface ClassifyJsonArgs {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}

export const classifyToJson = async <T>(args: ClassifyJsonArgs): Promise<T> => {
  const response = await getClient().messages.create({
    model: DEFAULT_MODEL,
    max_tokens: args.maxTokens ?? 2000,
    system: args.systemPrompt,
    messages: [
      { role: "user", content: args.userMessage },
      { role: "assistant", content: "{" },
    ],
  });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Inference returned no text content");
  }
  const jsonText = "{" + block.text;
  try {
    return JSON.parse(jsonText) as T;
  } catch (err) {
    const preview = jsonText.slice(0, 500);
    throw new Error(
      `Inference output is not valid JSON: ${(err as Error).message}. Preview: ${preview}`,
    );
  }
};
