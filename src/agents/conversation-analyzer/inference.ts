import {
  callConverse,
  isTextBlock,
  isToolUseBlock,
  type ConverseRequest,
  type ConverseUsage,
} from "../../inference/client";

// Helpers d'inférence partagés par le harness d'éval (analyzer + reply
// generator). On parle à Bedrock via la Converse API uniforme — cf. client.ts.
// Le contrat exposé reste indépendant du provider : `inferStructured` force
// un tool_use et retourne son input, `inferText` retourne un texte libre.
//
// Les deux helpers exposent `usage` (tokens input/output + cache reads) pour
// que les appelants puissent les persister par analyse → agrégation au niveau
// batch + calcul du coût (prix par modèle, table `models`, USD/Mtok).

// Compteurs de tokens exposés aux appelants. Re-typé localement pour figer
// le contrat externe et éviter qu'un changement du sous-ensemble Converse
// utilisé ne casse les appelants en cascade.
export interface InferenceUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

const toInferenceUsage = (u: ConverseUsage): InferenceUsage => ({
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens,
  cacheReadInputTokens: u.cacheReadInputTokens,
});

export interface InferStructuredArgs {
  model: string;
  systemPrompt: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  toolSchema: Record<string, unknown>;
  maxTokens?: number;
}

export interface InferStructuredResult<T> {
  data: T;
  usage: InferenceUsage;
}

export const inferStructured = async <T>(
  args: InferStructuredArgs,
): Promise<InferStructuredResult<T>> => {
  const req: ConverseRequest = {
    modelId: args.model,
    system: [{ text: args.systemPrompt }],
    messages: [{ role: "user", content: [{ text: args.userMessage }] }],
    inferenceConfig: {
      maxTokens: args.maxTokens ?? 2000,
      // temperature:0 — déterminisme requis pour la détection de régression
      // du harness d'éval (cf. spec conv-eval-harness, défaut critique #1).
      // Impacte tous les appelants d'analyze_conversation (souhaité).
      temperature: 0,
    },
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: args.toolName,
            description: args.toolDescription,
            inputSchema: { json: args.toolSchema },
          },
        },
      ],
      // Force le modèle à appeler l'outil — clé pour la sortie structurée.
      // Pixtral Large et certains autres rejettent ce mode (400) : ces
      // modèles restent archivés tant qu'ils ne sont pas adressés via un
      // chemin alternatif (e.g. JSON mode dédié).
      toolChoice: { tool: { name: args.toolName } },
    },
  };

  let response;
  try {
    response = await callConverse(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Inference call failed: ${msg}`);
  }

  if (response.stopReason !== "tool_use") {
    throw new Error(
      `Inference did not complete via tool_use (stopReason=${response.stopReason}). Output may be truncated or refused.`,
    );
  }

  const toolUses = response.output.message.content.filter(isToolUseBlock);
  if (toolUses.length === 0) {
    throw new Error("Inference returned no tool_use content");
  }
  if (toolUses.length > 1) {
    console.warn(
      `[inference] multiple tool_use blocks (${toolUses.length}); using the last one`,
    );
  }
  return {
    data: toolUses[toolUses.length - 1].toolUse.input as T,
    usage: toInferenceUsage(response.usage),
  };
};

export interface InferTextArgs {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}

export interface InferTextResult {
  text: string;
  usage: InferenceUsage;
}

// Complétion texte libre (pas de tool forcé) — utilisée par le harness
// d'éval pour la génération de réponse. temperature:0 comme inferStructured :
// le texte est alors reproductible, ce qui rend la détection de régression
// vs réponse favoritée (diff texte) significative.
export const inferText = async (args: InferTextArgs): Promise<InferTextResult> => {
  let response;
  try {
    response = await callConverse({
      modelId: args.model,
      system: [{ text: args.systemPrompt }],
      messages: [{ role: "user", content: [{ text: args.userMessage }] }],
      inferenceConfig: {
        maxTokens: args.maxTokens ?? 1500,
        temperature: 0,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Inference call failed: ${msg}`);
  }

  const text = response.output.message.content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) {
    throw new Error(
      `Inference returned no text (stopReason=${response.stopReason}).`,
    );
  }
  return { text, usage: toInferenceUsage(response.usage) };
};
