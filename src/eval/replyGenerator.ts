import crypto from "node:crypto";
import { fetchConversationMessages } from "../agents/conversation-analyzer/messageFetcher";
import {
  formatConversationForClassifier,
  renderConversationForInference,
  ConvMsg,
} from "../agents/conversation-analyzer/conversationFormatter";
import { inferText } from "../agents/conversation-analyzer/inference";
import { getActivePrompt } from "./db";
import {
  CODE_DEFAULT_REPLY_PROMPT_BODY,
  CODE_DEFAULT_REPLY_PROMPT_NAME,
} from "./replyPromptDefault";
import {
  buildReplyContext,
  renderReplyContext,
  ReplyContext,
} from "./replyContext";

// Génère UNE réponse avec le prompt 'reply' actif (fallback playbook DG).
// Réutilise messageFetcher / formatter / inference du serveur MCP, comme
// l'analyzer. AUCUN tool MCP n'est exposé : la génération vit côté eval.

export type GenerateReplyResult = {
  conversation: ConvMsg[];
  promptName: string;
  result:
    | { status: "skipped"; reason: string; messageCount: number }
    | { status: "ok"; replyText: string; context: ReplyContext };
};

const resolveActiveReplyPrompt = async (): Promise<{
  name: string;
  body: string;
}> => {
  const active = await getActivePrompt("reply");
  if (active) return { name: active.name, body: active.body };
  return {
    name: CODE_DEFAULT_REPLY_PROMPT_NAME,
    body: CODE_DEFAULT_REPLY_PROMPT_BODY,
  };
};

export const generateReply = async (
  conversationId: string,
): Promise<GenerateReplyResult> => {
  if (!/^[a-f0-9]{24}$/i.test(conversationId)) {
    throw new Error(
      "conversationId invalide — 24 caractères hexadécimaux attendus.",
    );
  }

  const prompt = await resolveActiveReplyPrompt();
  const messages = await fetchConversationMessages(conversationId);
  const formatted = formatConversationForClassifier(messages);

  if (formatted.messageCount === 0) {
    return {
      conversation: formatted.messages,
      promptName: prompt.name,
      result: {
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
      result: {
        status: "skipped",
        reason: "Aucun message du lead — rien à quoi répondre.",
        messageCount: formatted.messageCount,
      },
    };
  }

  const context = await buildReplyContext(conversationId);

  const delimiter = crypto.randomBytes(8).toString("hex");
  const systemPrompt = prompt.body.split("{{DELIMITER}}").join(delimiter);
  const userMessage = [
    renderReplyContext(context),
    `<CONVERSATION_${delimiter}>`,
    renderConversationForInference(formatted.messages),
    `</CONVERSATION_${delimiter}>`,
  ].join("\n\n");

  const replyText = await inferText({ systemPrompt, userMessage });

  return {
    conversation: formatted.messages,
    promptName: prompt.name,
    result: { status: "ok", replyText, context },
  };
};
