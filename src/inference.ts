import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = process.env.LGM_INFERENCE_MODEL || "claude-sonnet-4-6";

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
  const response = await getClient().messages.create({
    model: DEFAULT_MODEL,
    max_tokens: args.maxTokens ?? 2000,
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
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error("Inference returned no tool_use content");
  }
  return toolUse.input as T;
};
