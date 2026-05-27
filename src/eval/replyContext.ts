import { ObjectId } from "mongodb";
import { getDb } from "../agents/db-explorer/mongoClient";

// Contexte « research-first » exigé par le playbook DG : infos lead + cadre
// de campagne + canal. La conversation (transcript) est récupérée à part
// via le messageFetcher existant (cf. replyGenerator). Mongo en LECTURE
// SEULE — aucune écriture, aucune modification de données client.

export interface ReplyLead {
  name: string | null;
  jobTitle: string | null;
  shortBio: string | null;
  company: string | null;
  companyUrl: string | null;
  industry: string | null;
  location: string | null;
  linkedinUrl: string | null;
  note: string | null;
  tags: string[];
}

export interface ReplyCampaign {
  name: string | null;
  // TODO(but-campagne) : investigation db-explorer 2026-05-18 → AUCUN champ
  // "but" riche pré-généré sur `campaigns`. `objective` est un enum mince
  // (distinct: acquisition|activation|branding|basic + "Linkedin"/"Email"/…).
  // Le signal d'intention réel = name + audience.description + les messages
  // SENDER (déjà dans le transcript). À revisiter si un champ dédié existe
  // ailleurs (feature app/IA non présente dans ce Mongo).
  objective: string | null;
  language: string | null;
  audienceName: string | null;
  audienceDescription: string | null;
}

export interface ReplyContext {
  conversationId: string;
  channel: string | null; // LINKEDIN | EMAIL | …
  conversationStatus: string | null;
  // identityId LGM 24-hex de la conv : utilisé par le replyGenerator pour
  // charger l'éventuel profil stylométrique de l'identité côté SENDER.
  // null si la conv n'existe pas / pas d'identité résolue.
  identityId: string | null;
  lead: ReplyLead;
  campaign: ReplyCampaign;
}

const s = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export const buildReplyContext = async (
  conversationId: string,
): Promise<ReplyContext> => {
  if (!/^[a-f0-9]{24}$/i.test(conversationId)) {
    throw new Error("conversationId invalide (24 hex attendus).");
  }
  const db = await getDb();

  const conv = (await db.collection("inboxConversations").findOne(
    { _id: new ObjectId(conversationId) },
    {
      projection: {
        leadId: 1,
        identityId: 1,
        lastCampaignIdWithMessageSent: 1,
        lastMessageType: 1,
        status: 1,
        leadName: 1,
      },
    },
  )) as Record<string, unknown> | null;

  const emptyLead: ReplyLead = {
    name: null,
    jobTitle: null,
    shortBio: null,
    company: null,
    companyUrl: null,
    industry: null,
    location: null,
    linkedinUrl: null,
    note: null,
    tags: [],
  };
  const emptyCampaign: ReplyCampaign = {
    name: null,
    objective: null,
    language: null,
    audienceName: null,
    audienceDescription: null,
  };

  if (!conv) {
    return {
      conversationId,
      channel: null,
      conversationStatus: null,
      identityId: null,
      lead: emptyLead,
      campaign: emptyCampaign,
    };
  }

  const leadDoc = conv.leadId
    ? ((await db.collection("leads").findOne(
        { _id: conv.leadId as ObjectId },
        {
          projection: {
            firstname: 1,
            lastname: 1,
            jobTitle: 1,
            shortBio: 1,
            companyName: 1,
            companyUrl: 1,
            industry: 1,
            location: 1,
            linkedinUrl: 1,
            note: 1,
            tags: 1,
          },
        },
      )) as Record<string, unknown> | null)
    : null;

  const campDoc = conv.lastCampaignIdWithMessageSent
    ? ((await db.collection("campaigns").findOne(
        { _id: conv.lastCampaignIdWithMessageSent as ObjectId },
        { projection: { name: 1, objective: 1, language: 1, audience: 1 } },
      )) as Record<string, unknown> | null)
    : null;

  const lead: ReplyLead = leadDoc
    ? {
        name:
          [s(leadDoc.firstname), s(leadDoc.lastname)]
            .filter(Boolean)
            .join(" ") || s(conv.leadName),
        jobTitle: s(leadDoc.jobTitle),
        shortBio: s(leadDoc.shortBio),
        company: s(leadDoc.companyName),
        companyUrl: s(leadDoc.companyUrl),
        industry: s(leadDoc.industry),
        location: s(leadDoc.location),
        linkedinUrl: s(leadDoc.linkedinUrl),
        note: s(leadDoc.note),
        tags: Array.isArray(leadDoc.tags)
          ? (leadDoc.tags as unknown[]).map(String).slice(0, 20)
          : [],
      }
    : { ...emptyLead, name: s(conv.leadName) };

  const aud =
    campDoc && typeof campDoc.audience === "object" && campDoc.audience
      ? (campDoc.audience as Record<string, unknown>)
      : {};
  const campaign: ReplyCampaign = campDoc
    ? {
        name: s(campDoc.name),
        objective: s(campDoc.objective),
        language: s(campDoc.language),
        audienceName: s(aud.name),
        audienceDescription: s(aud.description),
      }
    : emptyCampaign;

  // P10: on uppercase le canal au seam Mongo — le reste du code (lookup
  // profil identité, comparaison) assume "LINKEDIN" / "EMAIL" en majuscules.
  const channelRaw = s(conv.lastMessageType);
  return {
    conversationId,
    channel: channelRaw ? channelRaw.toUpperCase() : null,
    conversationStatus: s(conv.status),
    identityId: conv.identityId ? String(conv.identityId) : null,
    lead,
    campaign,
  };
};

// Rendu lisible du contexte, injecté dans le user message d'inférence.
export const renderReplyContext = (ctx: ReplyContext): string => {
  const L = ctx.lead;
  const C = ctx.campaign;
  const line = (k: string, v: string | null) => (v ? `- ${k}: ${v}` : null);
  const lead = [
    line("Name", L.name),
    line("Job title", L.jobTitle),
    line("Short bio", L.shortBio),
    line("Company", L.company),
    line("Company URL", L.companyUrl),
    line("Industry", L.industry),
    line("Location", L.location),
    line("LinkedIn", L.linkedinUrl),
    line("Sales note", L.note),
    L.tags.length ? `- Tags: ${L.tags.join(", ")}` : null,
  ].filter(Boolean);
  const camp = [
    line("Campaign", C.name),
    line("Campaign objective", C.objective),
    line("Campaign language", C.language),
    line("Audience", C.audienceName),
    line("Audience description", C.audienceDescription),
  ].filter(Boolean);
  return [
    `## CHANNEL\n- ${ctx.channel ?? "unknown"}`,
    `## LEAD (research)\n${lead.join("\n") || "- (no lead data)"}`,
    `## CAMPAIGN CONTEXT\n${camp.join("\n") || "- (no campaign data)"}`,
  ].join("\n\n");
};
