import crypto from "node:crypto";
import { McpFlowError } from "../../callFlow";
import { fetchConversationMessages } from "./messageFetcher";
import {
  formatConversationForClassifier,
  renderConversationForInference,
  ConvMsg,
} from "./conversationFormatter";
import {
  buildClassifierSystemPrompt,
  CONVERSATION_CLASSIFIER_VERSION,
  CLASSIFIER_TOOL_NAME,
  CLASSIFIER_TOOL_DESCRIPTION,
  CLASSIFIER_TOOL_SCHEMA,
} from "./conversationClassifier";
import { inferStructured } from "./inference";

// Cœur d'analyse du tool MCP `analyze_conversation` (src/tools.ts).
// Contrat de sortie : { conversation, analysis }. Le tracking et la
// présentation restent chez l'appelant — ce module ne fait QUE l'analyse.
// (L'app d'éval, dans eval-app/, a son propre adaptateur DB-prompt.)

export type AnalyzeResult = {
  conversation: ConvMsg[];
  analysis:
    | { status: "skipped"; reason: string; messageCount: number }
    | {
        status: "ok";
        promptVersion: string;
        classification: Record<string, unknown>;
      };
};

export const analyzeConversation = async (
  conversationId: string,
): Promise<AnalyzeResult> => {
  if (!/^[a-f0-9]{24}$/i.test(conversationId)) {
    throw new McpFlowError(
      "Invalid conversationId. Expected a 24-character hex string.",
      400,
    );
  }

  const messages = await fetchConversationMessages(conversationId);
  const formatted = formatConversationForClassifier(messages);

  if (formatted.messageCount === 0) {
    return {
      conversation: formatted.messages,
      analysis: {
        status: "skipped",
        reason: "Conversation has no readable messages.",
        messageCount: 0,
      },
    };
  }

  if (!formatted.hasLead) {
    return {
      conversation: formatted.messages,
      analysis: {
        status: "skipped",
        reason: "Conversation has no lead messages. Nothing to classify.",
        messageCount: formatted.messageCount,
      },
    };
  }

  const delimiter = crypto.randomBytes(8).toString("hex");
  const systemPrompt = buildClassifierSystemPrompt(delimiter);
  const userMessage = `<CONVERSATION_${delimiter}>\n${renderConversationForInference(
    formatted.messages,
  )}\n</CONVERSATION_${delimiter}>`;

  const classification = await inferStructured<Record<string, unknown>>({
    systemPrompt,
    userMessage,
    toolName: CLASSIFIER_TOOL_NAME,
    toolDescription: CLASSIFIER_TOOL_DESCRIPTION,
    toolSchema: CLASSIFIER_TOOL_SCHEMA as unknown as Record<string, unknown>,
  });

  return {
    conversation: formatted.messages,
    analysis: {
      status: "ok",
      promptVersion: CONVERSATION_CLASSIFIER_VERSION,
      classification,
    },
  };
};
