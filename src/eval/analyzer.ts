import crypto from "node:crypto";
import { fetchConversationMessages } from "../agents/conversation-analyzer/messageFetcher";
import {
  formatConversationForClassifier,
  renderConversationForInference,
  ConvMsg,
} from "../agents/conversation-analyzer/conversationFormatter";
import {
  CLASSIFIER_TOOL_NAME,
  CLASSIFIER_TOOL_DESCRIPTION,
  CLASSIFIER_TOOL_SCHEMA,
} from "../agents/conversation-analyzer/conversationClassifier";
import {
  inferStructured,
  type InferenceUsage,
} from "../agents/conversation-analyzer/inference";
import {
  getActivePrompt,
  getPrompt,
  CODE_DEFAULT_PROMPT_BODY,
  CODE_DEFAULT_PROMPT_NAME,
} from "./db";

// Réutilise messageFetcher / formatter / inference / schéma du serveur MCP.
// Seule différence : le prompt vient de la DB (prompt actif) ; fallback sur
// la constante code si aucun prompt actif. Le schéma de sortie reste en code
// (contrat déterministe — ce n'est pas "le prompt" qu'on itère).

export type AnalyzeResult = {
  conversation: ConvMsg[];
  promptName: string;
  // `usage` n'existe que quand on a effectivement appelé l'inférence (status
  // "ok"). Pour un "skipped" (pas de message du lead, etc.) on n'a pas payé
  // de tokens → undefined ; les colonnes resteront NULL en DB.
  usage?: InferenceUsage;
  analysis:
    | { status: "skipped"; reason: string; messageCount: number }
    | {
        status: "ok";
        promptVersion: string;
        classification: Record<string, unknown>;
      };
};

export const resolveActivePrompt = async (): Promise<{
  name: string;
  body: string;
  source: "db" | "code-default";
}> => {
  // Source unique : prompt actif en DB pour le tool MCP ET l'app d'éval.
  // Fallback sur le prompt d'origine (code) si aucun prompt actif OU si la
  // DB est injoignable (dégradation gracieuse — le tool MCP reste debout).
  try {
    const active = await getActivePrompt();
    if (active) return { name: active.name, body: active.body, source: "db" };
  } catch (e) {
    console.error(
      "[analyzer] getActivePrompt KO → fallback prompt code:",
      e instanceof Error ? e.message : e,
    );
  }
  return {
    name: CODE_DEFAULT_PROMPT_NAME,
    body: CODE_DEFAULT_PROMPT_BODY,
    source: "code-default",
  };
};

// Run ad-hoc : si `promptName` est fourni on utilise CE prompt précis
// (brouillon inclus → permet de tester avant de valider) ; sinon le prompt
// live (dernier validé) avec fallback code. Le tool MCP n'envoie jamais de
// promptName → toujours le validé/prod.
const resolvePrompt = async (
  promptName?: string,
): Promise<{ name: string; body: string }> => {
  if (promptName) {
    const p = await getPrompt(promptName, "analysis");
    if (!p) throw new Error(`prompt analyse "${promptName}" introuvable`);
    return { name: p.name, body: p.body };
  }
  return resolveActivePrompt();
};

export const analyzeConversationWithDbPrompt = async (
  conversationId: string,
  options: { model: string; promptName?: string },
): Promise<AnalyzeResult> => {
  const { model, promptName } = options;
  if (!/^[a-f0-9]{24}$/i.test(conversationId)) {
    throw new Error(
      "conversationId invalide — 24 caractères hexadécimaux attendus.",
    );
  }

  const prompt = await resolvePrompt(promptName);
  const messages = await fetchConversationMessages(conversationId);
  const formatted = formatConversationForClassifier(messages);

  if (formatted.messageCount === 0) {
    return {
      conversation: formatted.messages,
      promptName: prompt.name,
      analysis: {
        status: "skipped",
        reason: "Conversation sans message lisible.",
        messageCount: 0,
      },
    };
  }
  if (!formatted.hasLead) {
    return {
      conversation: formatted.messages,
      promptName: prompt.name,
      analysis: {
        status: "skipped",
        reason: "Aucun message du lead — rien à classer.",
        messageCount: formatted.messageCount,
      },
    };
  }

  const delimiter = crypto.randomBytes(8).toString("hex");
  const systemPrompt = prompt.body.split("{{DELIMITER}}").join(delimiter);
  const userMessage = `<CONVERSATION_${delimiter}>\n${renderConversationForInference(
    formatted.messages,
  )}\n</CONVERSATION_${delimiter}>`;

  const { data: classification, usage } = await inferStructured<
    Record<string, unknown>
  >({
    model,
    systemPrompt,
    userMessage,
    toolName: CLASSIFIER_TOOL_NAME,
    toolDescription: CLASSIFIER_TOOL_DESCRIPTION,
    toolSchema: CLASSIFIER_TOOL_SCHEMA as unknown as Record<string, unknown>,
  });

  return {
    conversation: formatted.messages,
    promptName: prompt.name,
    usage,
    analysis: {
      status: "ok",
      promptVersion: prompt.name,
      classification,
    },
  };
};
