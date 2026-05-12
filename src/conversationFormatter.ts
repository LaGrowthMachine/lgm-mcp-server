type RawMessage = Record<string, unknown>;

const stripHtml = (s: string): string =>
  s
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/?(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const pickText = (m: RawMessage): string => {
  const candidates = [m.text, m.content, m.body, m.message, m.html];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return stripHtml(c);
  }
  return "";
};

const isFromLead = (m: RawMessage): boolean => {
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
  return false;
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

export const formatConversationForClassifier = (
  raw: unknown,
): FormattedConversation => {
  const messages: RawMessage[] = Array.isArray(raw)
    ? (raw as RawMessage[])
    : Array.isArray((raw as { messages?: unknown })?.messages)
      ? ((raw as { messages: RawMessage[] }).messages)
      : [];

  const sorted = [...messages].sort(
    (a, b) => pickTimestamp(a) - pickTimestamp(b),
  );

  const lines: string[] = [];
  for (const m of sorted) {
    const text = pickText(m);
    if (!text) continue;
    const role = isFromLead(m) ? "LEAD" : "SENDER";
    lines.push(`${role}: ${text}`);
  }

  const lastIsLead =
    sorted.length > 0 ? isFromLead(sorted[sorted.length - 1]) : false;

  return {
    text: lines.join("\n\n"),
    messageCount: lines.length,
    lastIsLead,
  };
};
