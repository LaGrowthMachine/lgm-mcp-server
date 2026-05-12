import { convert } from "html-to-text";

type RawMessage = Record<string, unknown>;

const stripHtml = (s: string): string =>
  convert(s, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const pickText = (m: RawMessage): string => {
  const candidates = [m.text, m.content, m.body, m.message, m.html];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return stripHtml(c);
  }
  return "";
};

const isFromLead = (m: RawMessage): boolean | null => {
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

export interface FormattedConversation {
  text: string;
  messageCount: number;
  lastIsLead: boolean;
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
  let lastIsLead = false;
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
    const indented = text.replace(/\n/g, "\n  ");
    lines.push(`${fromLead ? "LEAD" : "SENDER"}: ${indented}`);
    lastIsLead = fromLead;
  }

  return {
    text: lines.join("\n\n"),
    messageCount: lines.length,
    lastIsLead,
  };
};
