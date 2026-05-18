import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = process.env.LGM_INFERENCE_MODEL || "claude-sonnet-4-6";
const REQUEST_TIMEOUT_MS = 30_000;

if (!process.env.REPLY_MANAGER_API_KEY) {
  console.warn(
    "[inference] REPLY_MANAGER_API_KEY is not set — analyze_conversation will fail at first call",
  );
}

let client: Anthropic | null = null;

const getClient = (): Anthropic => {
  if (!client) {
    const apiKey = process.env.REPLY_MANAGER_API_KEY;
    if (!apiKey) throw new Error("REPLY_MANAGER_API_KEY env var is not set");
    client = new Anthropic({ apiKey });
  }
  return client;
};

export interface InferStructuredArgs {
  systemPrompt: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  toolSchema: Record<string, unknown>;
  maxTokens?: number;
}

export const inferStructured = async <T>(args: InferStructuredArgs): Promise<T> => {
  let response: Anthropic.Message;
  try {
    response = await getClient().messages.create(
      {
        model: DEFAULT_MODEL,
        max_tokens: args.maxTokens ?? 2000,
        // temperature:0 — déterminisme requis pour la détection de régression
        // du harness d'éval (cf. spec conv-eval-harness, défaut critique #1).
        // Impacte tous les appelants d'analyze_conversation (souhaité).
        temperature: 0,
        system: args.systemPrompt,
        tools: [
          {
            name: args.toolName,
            description: args.toolDescription,
            input_schema: args.toolSchema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: args.toolName },
        messages: [{ role: "user", content: args.userMessage }],
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Anthropic call failed: ${msg}`);
  }

  if (response.stop_reason !== "tool_use") {
    throw new Error(
      `Inference did not complete via tool_use (stop_reason=${response.stop_reason}). Output may be truncated or refused.`,
    );
  }

  const toolUses = response.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (toolUses.length === 0) {
    throw new Error("Inference returned no tool_use content");
  }
  if (toolUses.length > 1) {
    console.warn(
      `[inference] multiple tool_use blocks (${toolUses.length}); using the last one`,
    );
  }
  return toolUses[toolUses.length - 1].input as T;
};
