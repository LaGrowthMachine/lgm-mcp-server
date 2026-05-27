import crypto from "node:crypto";
import { fetchConversationMessages } from "../agents/conversation-analyzer/messageFetcher";
import {
  formatConversationForClassifier,
  renderConversationForInference,
  ConvMsg,
} from "../agents/conversation-analyzer/conversationFormatter";
import {
  inferText,
  type InferenceUsage,
} from "../agents/conversation-analyzer/inference";
import { getActivePrompt, getPrompt, getCurrentIdentityProfile } from "./db";
import {
  CODE_DEFAULT_REPLY_PROMPT_BODY,
  CODE_DEFAULT_REPLY_PROMPT_NAME,
} from "./replyPromptDefault";
import {
  buildReplyContext,
  renderReplyContext,
  ReplyContext,
} from "./replyContext";
import {
  computeMetrics,
  compareMetrics,
  StyleMetrics,
  CompareResult,
} from "./stylometry";
import type {
  IdentityProfileDescription,
  IdentityProfilePayload,
} from "./identityProfiler";

// Génère UNE réponse avec le prompt 'reply' actif (fallback playbook DG).
// Réutilise messageFetcher / formatter / inference du serveur MCP, comme
// l'analyzer. AUCUN tool MCP n'est exposé : la génération vit côté eval.

export interface ReplyValidation {
  score: number | null;
  breakdown: CompareResult["breakdown"];
  reply_metrics: StyleMetrics;
}

export type GenerateReplyResult = {
  conversation: ConvMsg[];
  promptName: string;
  usage?: InferenceUsage;
  result:
    | { status: "skipped"; reason: string; messageCount: number }
    | {
        status: "ok";
        replyText: string;
        context: ReplyContext;
        // null si conv sans (identityId, channel) résolus en DB → badge UI
        // explicite côté ConversationDetail.
        validation: ReplyValidation | null;
      };
};

// P4: guard contre des payloads JSONB legacy / corrompus. On vérifie le
// minimum vital (les champs réellement accédés en aval) avant de caster.
const isValidIdentityProfilePayload = (
  p: unknown,
): p is IdentityProfilePayload => {
  if (!p || typeof p !== "object") return false;
  const obj = p as Record<string, unknown>;
  const desc = obj.description as Record<string, unknown> | undefined;
  if (!desc || typeof desc !== "object") return false;
  if (typeof desc.summary !== "string") return false;
  if (typeof desc.register !== "string") return false;
  if (typeof desc.cadence !== "string") return false;
  if (typeof desc.punctuation_style !== "string") return false;
  if (typeof desc.signature !== "string") return false;
  if (!Array.isArray(desc.openers)) return false;
  if (!Array.isArray(desc.closers)) return false;
  if (!Array.isArray(desc.recurring_expressions)) return false;
  return true;
};

// P15: les champs description viennent d'un LLM en amont. S'il a généré
// par hasard la séquence délimiteur de notre prompt système, le bloc
// `<IDENTITY_PROFILE_xx>…</…>` peut être cassé. On strip défensivement
// toute occurrence du token hex avant interpolation.
const stripDelimiterFromString = (s: string, delimiter: string): string =>
  s.split(delimiter).join("");

const sanitizeDescription = (
  desc: IdentityProfileDescription,
  delimiter: string,
): IdentityProfileDescription => ({
  register: stripDelimiterFromString(desc.register, delimiter),
  cadence: stripDelimiterFromString(desc.cadence, delimiter),
  punctuation_style: stripDelimiterFromString(desc.punctuation_style, delimiter),
  openers: desc.openers.map((s) => stripDelimiterFromString(s, delimiter)),
  closers: desc.closers.map((s) => stripDelimiterFromString(s, delimiter)),
  signature: stripDelimiterFromString(desc.signature, delimiter),
  recurring_expressions: desc.recurring_expressions.map((s) =>
    stripDelimiterFromString(s, delimiter),
  ),
  summary: stripDelimiterFromString(desc.summary, delimiter),
});

const renderIdentityProfile = (desc: IdentityProfileDescription): string => {
  const lines = [
    desc.register ? `- Registre : ${desc.register}` : null,
    desc.cadence ? `- Cadence : ${desc.cadence}` : null,
    desc.punctuation_style
      ? `- Style de ponctuation : ${desc.punctuation_style}`
      : null,
    desc.openers.length ? `- Ouvertures : ${desc.openers.join(" / ")}` : null,
    desc.closers.length ? `- Clôtures : ${desc.closers.join(" / ")}` : null,
    desc.signature ? `- Signature : ${desc.signature}` : null,
    desc.recurring_expressions.length
      ? `- Expressions récurrentes : ${desc.recurring_expressions.join(" / ")}`
      : null,
    desc.summary ? `- Synthèse : ${desc.summary}` : null,
  ].filter(Boolean);
  return lines.join("\n");
};

// Run ad-hoc : `promptName` fourni → CE prompt réponse précis (brouillon
// inclus, pour tester avant validation) ; sinon le prompt réponse live
// (dernier validé) avec fallback playbook code (résilient si DB KO).
const resolveReplyPrompt = async (
  promptName?: string,
): Promise<{ name: string; body: string }> => {
  if (promptName) {
    const p = await getPrompt(promptName, "reply");
    if (!p) throw new Error(`prompt réponse "${promptName}" introuvable`);
    return { name: p.name, body: p.body };
  }
  try {
    const active = await getActivePrompt("reply");
    if (active) return { name: active.name, body: active.body };
  } catch (e) {
    console.error(
      "[reply] getActivePrompt KO → fallback playbook code:",
      e instanceof Error ? e.message : e,
    );
  }
  return {
    name: CODE_DEFAULT_REPLY_PROMPT_NAME,
    body: CODE_DEFAULT_REPLY_PROMPT_BODY,
  };
};

export const generateReply = async (
  conversationId: string,
  options: { model: string; promptName?: string },
): Promise<GenerateReplyResult> => {
  const { model, promptName } = options;
  if (!/^[a-f0-9]{24}$/i.test(conversationId)) {
    throw new Error(
      "conversationId invalide — 24 caractères hexadécimaux attendus.",
    );
  }

  const prompt = await resolveReplyPrompt(promptName);
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

  // Charge le profil stylométrique de l'identité côté SENDER s'il existe.
  // (identityId, channel) viennent de la conv elle-même (inboxConversations).
  // Si l'un manque, on bypass — validation:null + badge UI.
  // P10: normalisation défensive du canal (replyContext renvoie la valeur
  // brute de inboxConversations.lastMessageType — uppercase attendu mais on
  // ne fait pas confiance au seam).
  const channel = context.channel ? context.channel.toUpperCase() : null;
  let profilePayload: IdentityProfilePayload | null = null;
  if (
    context.identityId &&
    (channel === "LINKEDIN" || channel === "EMAIL")
  ) {
    try {
      const current = await getCurrentIdentityProfile(
        context.identityId,
        channel,
      );
      if (current) {
        // P4: validation runtime — un payload legacy / corrompu ne doit pas
        // crasher le rendu (`desc.openers.length` etc.). On bypass comme si
        // pas de profil.
        if (isValidIdentityProfilePayload(current.payload)) {
          profilePayload = current.payload;
        } else {
          console.error(
            "[reply] identity profile payload invalid for",
            context.identityId,
            channel,
          );
        }
      }
    } catch (e) {
      // Non-bloquant : un profil indisponible ne doit pas casser la génération.
      console.error(
        "[reply] getCurrentIdentityProfile KO:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  const delimiter = crypto.randomBytes(8).toString("hex");
  // Injection du profil entre délimiteurs hex (anti-injection, même contrat
  // que la conversation). Le prompt système reçoit la description du style ;
  // le user message reste structurellement identique.
  // P15: on sanitize la description avant interpolation pour empêcher un
  // contenu LLM de casser les délimiteurs.
  const profileBlock = profilePayload
    ? [
        `\n\n<IDENTITY_PROFILE_${delimiter}>`,
        renderIdentityProfile(
          sanitizeDescription(profilePayload.description, delimiter),
        ),
        `</IDENTITY_PROFILE_${delimiter}>`,
        `\nLe bloc <IDENTITY_PROFILE_${delimiter}>…</IDENTITY_PROFILE_${delimiter}> décrit le style d'écriture de l'identité côté SENDER. Calque ta réponse sur ce style (registre, cadence, ponctuation, expressions récurrentes). Ne reproduis pas littéralement les exemples.`,
      ].join("\n")
    : "";
  const systemPrompt =
    prompt.body.split("{{DELIMITER}}").join(delimiter) + profileBlock;
  const userMessage = [
    renderReplyContext(context),
    `<CONVERSATION_${delimiter}>`,
    renderConversationForInference(formatted.messages),
    `</CONVERSATION_${delimiter}>`,
  ].join("\n\n");

  const { text: replyText, usage } = await inferText({
    model,
    systemPrompt,
    userMessage,
  });

  // Validation stylométrique : mêmes métriques que le profil, comparées via
  // compareMetrics (seuils ±25 % par dim). null si pas de profil.
  // P7: un payload legacy peut manquer de `metrics` — on bypass plutôt que
  // crasher sur l'accès `profilePayload.metrics.length…`.
  let validation: ReplyValidation | null = null;
  if (profilePayload && profilePayload.metrics) {
    const replyMetrics = computeMetrics([replyText]);
    const cmp = compareMetrics(replyMetrics, profilePayload.metrics);
    validation = {
      score: cmp.score,
      breakdown: cmp.breakdown,
      reply_metrics: replyMetrics,
    };
  }

  return {
    conversation: formatted.messages,
    promptName: prompt.name,
    usage,
    result: { status: "ok", replyText, context, validation },
  };
};
