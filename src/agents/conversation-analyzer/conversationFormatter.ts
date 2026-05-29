import { convert } from "html-to-text";

type RawMessage = Record<string, unknown>;

const HTML_TAG_RE = /<[a-z!\/][^>]*>/i;

const stripHtml = (s: string): string => {
  if (!HTML_TAG_RE.test(s)) return s.replace(/\n{3,}/g, "\n\n").trim();
  return convert(s, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const pickText = (m: RawMessage): string => {
  const nested =
    typeof m.content === "object" && m.content !== null
      ? (m.content as Record<string, unknown>)
      : undefined;
  const candidates = [
    m.text,
    nested?.message,
    nested?.text,
    m.content,
    m.body,
    m.message,
    m.html,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return stripHtml(c);
  }
  return "";
};

const isFromLead = (m: RawMessage): boolean | null => {
  if (typeof m.status === "string") {
    const s = m.status.toUpperCase();
    if (s === "RECEIVED") return true;
    if (s === "SENT" || s === "SEND_FAILED") return false;
  }
  if (typeof m.isFromLead === "boolean") return m.isFromLead;
  if (typeof m.fromLead === "boolean") return m.fromLead;
  if (typeof m.direction === "string") {
    const d = m.direction.toLowerCase();
    if (d === "in" || d === "received" || d === "inbound") return true;
    if (d === "out" || d === "sent" || d === "outbound") return false;
  }
  if (typeof m.type === "string") {
    const t = m.type.toLowerCase();
    if (t === "received" || t === "in") return true;
    if (t === "sent" || t === "out") return false;
  }
  if (typeof m.senderType === "string") {
    return m.senderType.toLowerCase() === "lead";
  }
  if (typeof m.sender === "string") {
    return m.sender.toLowerCase() === "lead";
  }
  return null;
};

const pickTimestamp = (m: RawMessage): number => {
  const candidates = [m.createdAt, m.sentAt, m.timestamp, m.date];
  for (const c of candidates) {
    if (typeof c === "number") return c;
    if (typeof c === "string") {
      const n = Date.parse(c);
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};

export type Channel = "LINKEDIN" | "EMAIL" | "OTHER";

const pickChannel = (m: RawMessage): Channel => {
  const nested =
    typeof m.content === "object" && m.content !== null
      ? (m.content as Record<string, unknown>)
      : undefined;
  const raw =
    (typeof m.type === "string" && m.type) ||
    (typeof nested?.channel === "string" && (nested.channel as string)) ||
    (typeof m.channel === "string" && m.channel) ||
    "";
  const c = raw.toUpperCase();
  if (c === "LINKEDIN") return "LINKEDIN";
  if (c === "EMAIL") return "EMAIL";
  return "OTHER";
};

const pickSubject = (m: RawMessage): string | undefined => {
  const nested =
    typeof m.content === "object" && m.content !== null
      ? (m.content as Record<string, unknown>)
      : undefined;
  const s = nested?.subject ?? m.subject;
  return typeof s === "string" && s.trim() ? s.trim() : undefined;
};

// Message structuré : source de vérité unique. L'inférence en dérive un
// rendu texte (renderConversationForInference), l'UI en dérive des bulles.
export interface ConvMsg {
  role: "LEAD" | "SENDER";
  at: number; // epoch ms (0 si inconnu)
  channel: Channel;
  subject?: string; // emails seulement
  text: string;
}

export interface FormattedConversation {
  messages: ConvMsg[];
  lines: string[];
  messageCount: number;
  lastIsLead: boolean;
  hasLead: boolean;
}

const extractMessagesArray = (raw: unknown): RawMessage[] => {
  if (Array.isArray(raw)) return raw as RawMessage[];
  const r = raw as Record<string, unknown> | undefined;
  if (Array.isArray(r?.data)) return r.data as RawMessage[];
  if (Array.isArray(r?.messages)) return r.messages as RawMessage[];
  if (Array.isArray(r?.items)) return r.items as RawMessage[];
  return [];
};

const isSystemMessage = (m: RawMessage): boolean => {
  if (typeof m.status === "string" && m.status.toUpperCase() === "INFO") return true;
  if (typeof m.channel === "string") {
    const c = m.channel.toUpperCase();
    if (c === "LGM" || c === "AUTO_QUALIFY") return true;
  }
  return false;
};

export const formatConversationForClassifier = (
  raw: unknown,
): FormattedConversation => {
  const messages = extractMessagesArray(raw).filter((m) => !isSystemMessage(m));

  const sorted = messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => pickTimestamp(a.m) - pickTimestamp(b.m) || a.i - b.i)
    .map(({ m }) => m);

  const lines: string[] = [];
  const structured: ConvMsg[] = [];
  let lastIsLead = false;
  let hasLead = false;
  for (const m of sorted) {
    const text = pickText(m);
    if (!text) continue;
    const fromLead = isFromLead(m);
    if (fromLead === null) {
      console.warn(
        `[analyze_conversation] skipping message with unknown direction: id=${typeof m.id === "string" ? m.id : "?"}`,
      );
      continue;
    }
    const role: ConvMsg["role"] = fromLead ? "LEAD" : "SENDER";
    const indented = text.replace(/\n/g, "\n  ");
    lines.push(`${role}: ${indented}`);
    const subject = pickSubject(m);
    structured.push({
      role,
      at: pickTimestamp(m),
      channel: pickChannel(m),
      ...(subject ? { subject } : {}),
      text,
    });
    lastIsLead = fromLead;
    if (fromLead) hasLead = true;
  }

  return {
    messages: structured,
    lines,
    messageCount: lines.length,
    lastIsLead,
    hasLead,
  };
};

// epoch ms → "2023-05-24 14:32" (UTC, déterministe). "" si inconnu.
const fmtAt = (at: number): string =>
  at > 0 ? new Date(at).toISOString().slice(0, 16).replace("T", " ") : "";

// Rendu texte injecté dans l'inférence (analyzer + reply). On conserve la
// nomenclature LEAD/SENDER en tête de ligne — le classifieur clé dessus —
// en ajoutant date + canal (+ sujet email) comme contexte.
export const renderConversationForInference = (
  messages: ConvMsg[],
): string => {
  return messages
    .map((m) => {
      const meta = [fmtAt(m.at), m.channel === "OTHER" ? "" : m.channel]
        .filter(Boolean)
        .concat(m.subject ? [`Suj: "${m.subject}"`] : []);
      const header = `${m.role}${meta.length ? ` · ${meta.join(" · ")}` : ""}`;
      const body = m.text.replace(/\n/g, "\n  ");
      return `${header}\n  ${body}`;
    })
    .join("\n\n");
};
