import {
  formatConversationForClassifier,
  renderConversationForInference,
} from "./conversationFormatter";

describe("formatConversationForClassifier — DB shape", () => {
  it("treats status RECEIVED as lead and SENT as sender", () => {
    const messages = [
      {
        status: "SENT",
        createdAt: 1000,
        content: { message: "Bonjour" },
      },
      {
        status: "RECEIVED",
        createdAt: 2000,
        content: { message: "Salut, qui êtes-vous ?" },
      },
    ];

    const result = formatConversationForClassifier(messages);

    expect(result.messageCount).toBe(2);
    expect(result.lastIsLead).toBe(true);
    expect(result.hasLead).toBe(true);
    expect(result.lines).toEqual([
      "SENDER: Bonjour",
      "LEAD: Salut, qui êtes-vous ?",
    ]);
  });

  it("treats SEND_FAILED as sender", () => {
    const messages = [
      {
        status: "SEND_FAILED",
        createdAt: 1000,
        content: { message: "Echec d'envoi" },
      },
    ];
    const result = formatConversationForClassifier(messages);
    expect(result.lastIsLead).toBe(false);
    expect(result.hasLead).toBe(false);
  });

  it("flags hasLead=true when a LEAD message exists earlier in the thread", () => {
    const messages = [
      { status: "SENT", createdAt: 1000, content: { message: "Bonjour" } },
      { status: "RECEIVED", createdAt: 2000, content: { message: "Pas intéressé" } },
      { status: "SEND_FAILED", createdAt: 3000, content: { message: "réponse ratée" } },
    ];
    const result = formatConversationForClassifier(messages);
    expect(result.messageCount).toBe(3);
    expect(result.lastIsLead).toBe(false);
    expect(result.hasLead).toBe(true);
  });

  it("skips messages with status INFO (system events)", () => {
    const messages = [
      {
        status: "INFO",
        createdAt: 500,
        content: { message: "out of office detected" },
      },
      {
        status: "RECEIVED",
        createdAt: 1000,
        content: { message: "Pas dispo cette semaine." },
      },
    ];
    const result = formatConversationForClassifier(messages);
    expect(result.messageCount).toBe(1);
    expect(result.lines).toEqual(["LEAD: Pas dispo cette semaine."]);
  });

  it("extracts text from content.message for the DB shape", () => {
    const messages = [
      {
        status: "RECEIVED",
        createdAt: 1000,
        content: { message: "Hello world" },
      },
    ];
    const result = formatConversationForClassifier(messages);
    expect(result.lines).toEqual(["LEAD: Hello world"]);
  });

  it("strips HTML from content.message (email case)", () => {
    const messages = [
      {
        status: "RECEIVED",
        createdAt: 1000,
        content: {
          message: "<p>Hello <strong>world</strong></p><p>Bye</p>",
        },
      },
    ];
    const result = formatConversationForClassifier(messages);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("LEAD:");
    expect(result.lines[0]).toContain("Hello world");
    expect(result.lines[0]).toContain("Bye");
    expect(result.lines[0]).not.toContain("<");
  });

  it("preserves plaintext containing `<` (not HTML)", () => {
    const messages = [
      {
        status: "RECEIVED",
        createdAt: 1000,
        content: { message: "I think price < 50€ is fair" },
      },
    ];
    const result = formatConversationForClassifier(messages);
    expect(result.lines).toEqual(["LEAD: I think price < 50€ is fair"]);
  });

  it("sorts messages by createdAt ascending regardless of input order", () => {
    const messages = [
      {
        status: "RECEIVED",
        createdAt: 3000,
        content: { message: "third" },
      },
      {
        status: "SENT",
        createdAt: 1000,
        content: { message: "first" },
      },
      {
        status: "RECEIVED",
        createdAt: 2000,
        content: { message: "second" },
      },
    ];
    const result = formatConversationForClassifier(messages);
    expect(result.lines).toEqual([
      "SENDER: first",
      "LEAD: second",
      "LEAD: third",
    ]);
    expect(result.lastIsLead).toBe(true);
  });

  it("preserves backwards compatibility with API-shape messages", () => {
    const messages = [
      { direction: "out", createdAt: 1000, body: "outbound" },
      { direction: "in", createdAt: 2000, body: "inbound" },
    ];
    const result = formatConversationForClassifier(messages);
    expect(result.messageCount).toBe(2);
    expect(result.lastIsLead).toBe(true);
    expect(result.lines).toEqual(["SENDER: outbound", "LEAD: inbound"]);
  });
});

describe("formatConversationForClassifier — structured messages", () => {
  it("emits a structured ConvMsg[] with role, timestamp, channel", () => {
    const messages = [
      {
        status: "SENT",
        type: "LINKEDIN",
        createdAt: 1684927576437,
        content: { message: "Bonjour Fabrice" },
      },
      {
        status: "RECEIVED",
        type: "EMAIL",
        createdAt: 1684936639820,
        content: { subject: "RE: GMAO", message: "Oui, intéressé" },
      },
    ];
    const r = formatConversationForClassifier(messages);
    expect(r.messages).toEqual([
      {
        role: "SENDER",
        at: 1684927576437,
        channel: "LINKEDIN",
        text: "Bonjour Fabrice",
      },
      {
        role: "LEAD",
        at: 1684936639820,
        channel: "EMAIL",
        subject: "RE: GMAO",
        text: "Oui, intéressé",
      },
    ]);
  });

  it("falls back to channel OTHER and at=0 when unknown", () => {
    const r = formatConversationForClassifier([
      { direction: "out", body: "no type, no createdAt" },
    ]);
    expect(r.messages[0]).toMatchObject({
      role: "SENDER",
      at: 0,
      channel: "OTHER",
      text: "no type, no createdAt",
    });
    expect(r.messages[0]).not.toHaveProperty("subject");
  });

  it("keeps messages and lines in the same order", () => {
    const r = formatConversationForClassifier([
      { status: "RECEIVED", createdAt: 3000, content: { message: "third" } },
      { status: "SENT", createdAt: 1000, content: { message: "first" } },
      { status: "RECEIVED", createdAt: 2000, content: { message: "second" } },
    ]);
    expect(r.messages.map((m) => m.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(r.messages.map((m) => m.role)).toEqual([
      "SENDER",
      "LEAD",
      "LEAD",
    ]);
  });
});

describe("renderConversationForInference", () => {
  it("anchors each block on the LEAD/SENDER role token with date+channel", () => {
    const out = renderConversationForInference([
      {
        role: "SENDER",
        at: 1684927576437,
        channel: "LINKEDIN",
        text: "Bonjour",
      },
      {
        role: "LEAD",
        at: 1684936639820,
        channel: "EMAIL",
        subject: "RE: GMAO",
        text: "Oui",
      },
    ]);
    const blocks = out.split("\n\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(
      "SENDER · 2023-05-24 11:26 · LINKEDIN\n  Bonjour",
    );
    expect(blocks[1]).toBe(
      'LEAD · 2023-05-24 13:57 · EMAIL · Suj: "RE: GMAO"\n  Oui',
    );
  });

  it("omits date when timestamp is unknown (at=0)", () => {
    const out = renderConversationForInference([
      { role: "LEAD", at: 0, channel: "OTHER", text: "hi" },
    ]);
    expect(out).toBe("LEAD\n  hi");
  });

  it("indents multi-line message bodies", () => {
    const out = renderConversationForInference([
      { role: "LEAD", at: 0, channel: "OTHER", text: "line1\nline2" },
    ]);
    expect(out).toBe("LEAD\n  line1\n  line2");
  });
});
