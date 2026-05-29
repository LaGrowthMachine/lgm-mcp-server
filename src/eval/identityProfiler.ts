import crypto from "node:crypto";
import { fetchConversationMessages } from "../agents/conversation-analyzer/messageFetcher";
import {
  formatConversationForClassifier,
  ConvMsg,
} from "../agents/conversation-analyzer/conversationFormatter";
import {
  inferStructured,
  type InferenceUsage,
} from "../agents/conversation-analyzer/inference";
import { getActivePrompt, getPrompt, upsertConversation } from "./db";
import {
  CODE_DEFAULT_IDENTITY_PROFILE_PROMPT_BODY,
  CODE_DEFAULT_IDENTITY_PROFILE_PROMPT_NAME,
} from "./identityProfilePromptDefault";
import {
  enumerateIdentityConvs,
  IdentityConvSlice,
} from "./identityConvFetcher";
import { computeMetrics, StyleMetrics } from "./stylometry";

// Description = prose + listes ; tout est injectable tel quel dans un prompt
// reply. Pas de noms propres, pas d'exemples bruts — on agrège des patterns.
export interface IdentityProfileDescription {
  register: string;
  cadence: string;
  punctuation_style: string;
  openers: string[];
  closers: string[];
  signature: string;
  recurring_expressions: string[];
  summary: string;
}

export interface IdentityProfilePayload {
  description: IdentityProfileDescription;
  metrics: StyleMetrics;
  corpus: {
    conv_count: number;
    msg_count_sender: number;
    sampled_at: string; // ISO
    token_cap: number;
    conversation_ids: string[];
  };
}

export type IdentityChannel = "LINKEDIN" | "EMAIL";

export interface AnalyzeIdentityArgs {
  identityId: string;
  channel: IdentityChannel;
  model: string;
  tokenCap: number;
  // Si fourni → ce prompt précis (kind=identity_profile, draft inclus,
  // pour tester avant validation). Sinon → prompt actif (dernier validé)
  // avec fallback playbook code si DB KO. Même contrat que generateReply.
  promptName?: string;
}

export interface AnalyzeIdentityResult {
  payload: IdentityProfilePayload;
  usage?: InferenceUsage;
  // Nom du prompt effectivement utilisé pour l'inférence (DB ou fallback
  // code). Permet aux callers de tracer la version utilisée par run.
  promptName: string;
  // Ensemble des convs visitées pour ce profil (utile aux callers qui
  // souhaitent persister `upsertConversation` côté harness éval).
  conversations: IdentityConvSlice[];
}

// Tool schema forcé pour `inferStructured` — la sortie est exactement la
// shape de `IdentityProfileDescription`. Listes bornées pour limiter la
// taille du payload (et garder l'injection au reply prompt raisonnable).
const DESCRIPTION_TOOL_SCHEMA = {
  type: "object",
  properties: {
    register: {
      type: "string",
      description:
        "Registre général (formel/informel/B2B/etc.) en 1 phrase courte.",
    },
    cadence: {
      type: "string",
      description:
        "Cadence : longueur typique des messages et phrasés, en 1 phrase.",
    },
    punctuation_style: {
      type: "string",
      description:
        "Style de ponctuation observé (concision, usage des !/?/…, etc.), en 1 phrase.",
    },
    openers: {
      type: "array",
      items: { type: "string" },
      description:
        "Tournures d'ouverture récurrentes (3-6 entrées max), pas d'exemples bruts.",
    },
    closers: {
      type: "array",
      items: { type: "string" },
      description:
        "Tournures de clôture récurrentes (3-6 entrées max), pas d'exemples bruts.",
    },
    signature: {
      type: "string",
      description:
        "Forme de signature observée (prénom seul, prénom+poste, vide, etc.).",
    },
    recurring_expressions: {
      type: "array",
      items: { type: "string" },
      description:
        "Expressions/locutions récurrentes (3-8 entrées max), génériques.",
    },
    summary: {
      type: "string",
      description: "Synthèse 2-3 phrases du style — injectable dans un prompt.",
    },
  },
  required: [
    "register",
    "cadence",
    "punctuation_style",
    "openers",
    "closers",
    "signature",
    "recurring_expressions",
    "summary",
  ],
} as const;

const DESCRIPTION_TOOL_NAME = "describe_identity_style";
const DESCRIPTION_TOOL_DESCRIPTION =
  "Décrit le style d'écriture observé d'une identité LGM à partir d'un corpus de messages SENDER (=cette identité). Génère uniquement des patterns agrégés ; ne reproduis JAMAIS de phrase brute du corpus.";

// Marqueur déterministe pour corpus vide — aucune inférence n'est appelée
// (pas de tokens facturés). Permet aux KPIs UI de signaler "corpus vide"
// sans confusion avec une vraie description.
export const EMPTY_CORPUS_DESCRIPTION: IdentityProfileDescription = {
  register: "Corpus vide",
  cadence: "",
  punctuation_style: "",
  openers: [],
  closers: [],
  signature: "",
  recurring_expressions: [],
  summary: "Aucun message SENDER sur ce canal.",
};

// Résolution du prompt identity_profile, même contrat que `resolveReplyPrompt`
// dans replyGenerator.ts : param explicite → ce prompt précis (draft inclus,
// pour tester avant validation) ; sinon prompt actif (dernier validé) ; sinon
// fallback playbook code (résilient si DB KO).
const resolveIdentityProfilePrompt = async (
  promptName?: string,
): Promise<{ name: string; body: string }> => {
  if (promptName) {
    const p = await getPrompt(promptName, "identity_profile");
    if (!p)
      throw new Error(
        `prompt identity_profile "${promptName}" introuvable`,
      );
    return { name: p.name, body: p.body };
  }
  try {
    const active = await getActivePrompt("identity_profile");
    if (active) return { name: active.name, body: active.body };
  } catch (e) {
    console.error(
      "[identity] getActivePrompt KO → fallback code:",
      e instanceof Error ? e.message : e,
    );
  }
  return {
    name: CODE_DEFAULT_IDENTITY_PROFILE_PROMPT_NAME,
    body: CODE_DEFAULT_IDENTITY_PROFILE_PROMPT_BODY,
  };
};

const renderCorpus = (corpus: string[], delimiter: string): string => {
  const joined = corpus.map((s) => s.trim()).join("\n---\n");
  return `<CORPUS_${delimiter}>\n${joined}\n</CORPUS_${delimiter}>`;
};

// Extrait les messages SENDER d'une liste de conversations LGM. Pour chaque
// conv on appelle `fetchConversationMessages` + `formatConversationForClassifier`,
// puis on filtre role==='SENDER'. `upsertConversation` est aussi déclenchée
// pour chaque conv (cache transcript pour la vue détail eval).
const collectSenderCorpus = async (
  convs: IdentityConvSlice[],
): Promise<{ corpus: string[]; visited: { id: string; msgs: ConvMsg[] }[] }> => {
  const corpus: string[] = [];
  const visited: { id: string; msgs: ConvMsg[] }[] = [];
  for (const c of convs) {
    const raw = await fetchConversationMessages(c.conversationId);
    const formatted = formatConversationForClassifier(raw);
    visited.push({ id: c.conversationId, msgs: formatted.messages });
    for (const m of formatted.messages) {
      if (m.role === "SENDER" && m.text.trim()) {
        corpus.push(m.text);
      }
    }
  }
  return { corpus, visited };
};

export const analyzeIdentity = async (
  args: AnalyzeIdentityArgs,
): Promise<AnalyzeIdentityResult> => {
  const { identityId, channel, model, tokenCap, promptName } = args;
  const prompt = await resolveIdentityProfilePrompt(promptName);
  const convs = await enumerateIdentityConvs(identityId, channel, { tokenCap });
  const { corpus, visited } = await collectSenderCorpus(convs);

  // Side-effect utile : cache les transcripts visités dans la DB éval (même
  // pattern que l'analyzer/replyGenerator). Permet le lien depuis ProfileDetail
  // vers ConversationDetail sans refetch Mongo.
  for (const v of visited) {
    try {
      await upsertConversation(v.id, v.msgs);
    } catch (e) {
      // Non-bloquant : si l'upsert échoue, le profil reste valide.
      console.error(
        `[identity] upsertConversation failed for ${v.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  const metrics = computeMetrics(corpus);
  const sampledAt = new Date().toISOString();
  const senderCount = corpus.length;

  if (senderCount === 0) {
    return {
      conversations: convs,
      promptName: prompt.name,
      payload: {
        description: EMPTY_CORPUS_DESCRIPTION,
        metrics,
        corpus: {
          conv_count: convs.length,
          msg_count_sender: 0,
          sampled_at: sampledAt,
          token_cap: tokenCap,
          conversation_ids: convs.map((c) => c.conversationId),
        },
      },
    };
  }

  const delimiter = crypto.randomBytes(8).toString("hex");
  const systemPrompt = prompt.body.split("{{DELIMITER}}").join(delimiter);
  const userMessage = [
    `## CHANNEL\n${channel}`,
    `## METRICS (grounding, déterministes)\n\`\`\`json\n${JSON.stringify(
      metrics,
      null,
      2,
    )}\n\`\`\``,
    renderCorpus(corpus, delimiter),
  ].join("\n\n");

  const { data, usage } = await inferStructured<IdentityProfileDescription>({
    model,
    systemPrompt,
    userMessage,
    toolName: DESCRIPTION_TOOL_NAME,
    toolDescription: DESCRIPTION_TOOL_DESCRIPTION,
    toolSchema: DESCRIPTION_TOOL_SCHEMA as unknown as Record<string, unknown>,
  });

  return {
    conversations: convs,
    promptName: prompt.name,
    usage,
    payload: {
      description: data,
      metrics,
      corpus: {
        conv_count: convs.length,
        msg_count_sender: senderCount,
        sampled_at: sampledAt,
        token_cap: tokenCap,
        conversation_ids: convs.map((c) => c.conversationId),
      },
    },
  };
};
