import { formatConversationForClassifier } from "./conversationFormatter";

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
