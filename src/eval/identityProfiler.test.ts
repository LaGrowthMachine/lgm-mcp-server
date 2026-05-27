// Tests unitaires identityProfiler — on mocke :
// - enumerateIdentityConvs (pas de Mongo)
// - fetchConversationMessages + formatConversationForClassifier (pas de Mongo non plus)
// - inferStructured (pas de Bedrock)
// - upsertConversation (pas de Postgres)
// Pour valider le happy path + le bypass d'inférence sur corpus vide.

jest.mock("./identityConvFetcher", () => ({
  enumerateIdentityConvs: jest.fn(),
}));
jest.mock("../agents/conversation-analyzer/messageFetcher", () => ({
  fetchConversationMessages: jest.fn(),
}));
jest.mock("../agents/conversation-analyzer/conversationFormatter", () => ({
  formatConversationForClassifier: jest.fn(),
}));
jest.mock("../agents/conversation-analyzer/inference", () => ({
  inferStructured: jest.fn(),
}));
jest.mock("./db", () => ({
  upsertConversation: jest.fn(async () => undefined),
}));

import { analyzeIdentity, EMPTY_CORPUS_DESCRIPTION } from "./identityProfiler";
import { enumerateIdentityConvs } from "./identityConvFetcher";
import { fetchConversationMessages } from "../agents/conversation-analyzer/messageFetcher";
import { formatConversationForClassifier } from "../agents/conversation-analyzer/conversationFormatter";
import { inferStructured } from "../agents/conversation-analyzer/inference";
import { upsertConversation } from "./db";

const enumerateMock = enumerateIdentityConvs as jest.MockedFunction<
  typeof enumerateIdentityConvs
>;
const fetchMock = fetchConversationMessages as jest.MockedFunction<
  typeof fetchConversationMessages
>;
const formatMock = formatConversationForClassifier as jest.MockedFunction<
  typeof formatConversationForClassifier
>;
const inferMock = inferStructured as jest.MockedFunction<typeof inferStructured>;
const upsertMock = upsertConversation as jest.MockedFunction<
  typeof upsertConversation
>;

beforeEach(() => {
  enumerateMock.mockReset();
  fetchMock.mockReset();
  formatMock.mockReset();
  inferMock.mockReset();
  upsertMock.mockReset();
});

describe("analyzeIdentity", () => {
  it("happy path — appelle inferStructured et retourne payload + usage", async () => {
    enumerateMock.mockResolvedValue([
      { conversationId: "a".repeat(24), lastMessageAt: 1_700_000_000_000 },
    ]);
    fetchMock.mockResolvedValue([]);
    formatMock.mockReturnValue({
      messages: [
        { role: "SENDER", at: 1, channel: "LINKEDIN", text: "Bonjour Sophie, j'ai bien noté votre message. À bientôt." },
        { role: "LEAD", at: 2, channel: "LINKEDIN", text: "Merci pour votre retour rapide." },
        { role: "SENDER", at: 3, channel: "LINKEDIN", text: "Avec plaisir, n'hésitez pas." },
      ],
      lines: [],
      messageCount: 3,
      lastIsLead: false,
      hasLead: true,
    });
    inferMock.mockResolvedValue({
      data: {
        register: "Professionnel, cordial",
        cadence: "Phrases courtes",
        punctuation_style: "Sobre",
        openers: ["Bonjour"],
        closers: ["À bientôt"],
        signature: "Prénom seul",
        recurring_expressions: ["Avec plaisir"],
        summary: "Style direct B2B.",
      },
      usage: { inputTokens: 1000, outputTokens: 200 },
    });

    const result = await analyzeIdentity({
      identityId: "b".repeat(24),
      channel: "LINKEDIN",
      model: "claude-sonnet-4-6",
      tokenCap: 10_000,
    });

    expect(inferMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(result.payload.description.register).toBe("Professionnel, cordial");
    expect(result.payload.corpus.conv_count).toBe(1);
    expect(result.payload.corpus.msg_count_sender).toBe(2);
    expect(result.payload.metrics.length.msg_words_avg).not.toBeNull();
    expect(result.usage?.inputTokens).toBe(1000);
  });

  it("corpus vide — bypass de l'inférence + description marqueur", async () => {
    enumerateMock.mockResolvedValue([]);
    const result = await analyzeIdentity({
      identityId: "c".repeat(24),
      channel: "EMAIL",
      model: "claude-sonnet-4-6",
      tokenCap: 10_000,
    });

    expect(inferMock).not.toHaveBeenCalled();
    expect(result.payload.description).toEqual(EMPTY_CORPUS_DESCRIPTION);
    expect(result.payload.corpus.msg_count_sender).toBe(0);
    expect(result.usage).toBeUndefined();
  });

  it("corpus avec convs mais 0 message SENDER — bypass inférence + marqueur", async () => {
    enumerateMock.mockResolvedValue([
      { conversationId: "d".repeat(24), lastMessageAt: 1 },
    ]);
    fetchMock.mockResolvedValue([]);
    formatMock.mockReturnValue({
      messages: [
        { role: "LEAD", at: 1, channel: "EMAIL", text: "Bonjour, je suis intéressé." },
      ],
      lines: [],
      messageCount: 1,
      lastIsLead: true,
      hasLead: true,
    });

    const result = await analyzeIdentity({
      identityId: "e".repeat(24),
      channel: "EMAIL",
      model: "claude-sonnet-4-6",
      tokenCap: 10_000,
    });

    expect(inferMock).not.toHaveBeenCalled();
    expect(result.payload.description).toEqual(EMPTY_CORPUS_DESCRIPTION);
    expect(result.payload.corpus.conv_count).toBe(1);
    expect(result.payload.corpus.msg_count_sender).toBe(0);
  });
});
