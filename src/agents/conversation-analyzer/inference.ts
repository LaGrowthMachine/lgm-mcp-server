import type Anthropic from "@anthropic-ai/sdk";
import { callWithRetry } from "../../inference/client";

export interface InferStructuredArgs {
  model: string;
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
    response = await callWithRetry({
      model: args.model,
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
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Inference call failed: ${msg}`);
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

export interface InferTextArgs {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}

// Complétion texte libre (pas de tool forcé) — utilisée par le harness
// d'éval pour la génération de réponse. temperature:0 comme inferStructured :
// le texte est alors reproductible, ce qui rend la détection de régression
// vs réponse favoritée (diff texte) significative.
export const inferText = async (args: InferTextArgs): Promise<string> => {
  let response: Anthropic.Message;
  try {
    response = await callWithRetry({
      model: args.model,
      max_tokens: args.maxTokens ?? 1500,
      temperature: 0,
      system: args.systemPrompt,
      messages: [{ role: "user", content: args.userMessage }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Inference call failed: ${msg}`);
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) {
    throw new Error(
      `Inference returned no text (stop_reason=${response.stop_reason}).`,
    );
  }
  return text;
};
