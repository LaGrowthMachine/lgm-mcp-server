import crypto from "node:crypto";
import { fetchConversationMessages } from "../agents/conversation-analyzer/messageFetcher";
import { formatConversationForClassifier } from "../agents/conversation-analyzer/conversationFormatter";
import {
  CLASSIFIER_TOOL_NAME,
  CLASSIFIER_TOOL_DESCRIPTION,
  CLASSIFIER_TOOL_SCHEMA,
} from "../agents/conversation-analyzer/conversationClassifier";
import { inferStructured } from "../agents/conversation-analyzer/inference";
import {
  getActivePrompt,
  CODE_DEFAULT_PROMPT_BODY,
  CODE_DEFAULT_PROMPT_NAME,
} from "./db";

// Réutilise messageFetcher / formatter / inference / schéma du serveur MCP.
// Seule différence : le prompt vient de la DB (prompt actif) ; fallback sur
// la constante code si aucun prompt actif. Le schéma de sortie reste en code
// (contrat déterministe — ce n'est pas "le prompt" qu'on itère).

export type AnalyzeResult = {
  conversation: string[];
  promptName: string;
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
  const active = await getActivePrompt();
  if (active) return { name: active.name, body: active.body, source: "db" };
  return {
    name: CODE_DEFAULT_PROMPT_NAME,
    body: CODE_DEFAULT_PROMPT_BODY,
    source: "code-default",
  };
};

export const analyzeConversationWithDbPrompt = async (
  conversationId: string,
): Promise<AnalyzeResult> => {
  if (!/^[a-f0-9]{24}$/i.test(conversationId)) {
    throw new Error(
      "conversationId invalide — 24 caractères hexadécimaux attendus.",
    );
  }

  const prompt = await resolveActivePrompt();
  const messages = await fetchConversationMessages(conversationId);
  const formatted = formatConversationForClassifier(messages);

  if (formatted.messageCount === 0) {
    return {
      conversation: formatted.lines,
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
      conversation: formatted.lines,
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
  const userMessage = `<CONVERSATION_${delimiter}>\n${formatted.lines.join(
    "\n\n",
  )}\n</CONVERSATION_${delimiter}>`;

  const classification = await inferStructured<Record<string, unknown>>({
    systemPrompt,
    userMessage,
    toolName: CLASSIFIER_TOOL_NAME,
    toolDescription: CLASSIFIER_TOOL_DESCRIPTION,
    toolSchema: CLASSIFIER_TOOL_SCHEMA as unknown as Record<string, unknown>,
  });

  return {
    conversation: formatted.lines,
    promptName: prompt.name,
    analysis: {
      status: "ok",
      promptVersion: prompt.name,
      classification,
    },
  };
};
