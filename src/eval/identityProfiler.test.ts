// Tests unitaires identityProfiler — on mocke :
// - enumerateIdentityConvs (pas de Mongo)
// - fetchConversationMessages + formatConversationForClassifier (pas de Mongo non plus)
// - inferStructured (pas de Bedrock)
// - upsertConversation + getActivePrompt + getPrompt (pas de Postgres)
// Pour valider le happy path + le bypass d'inférence sur corpus vide +
// la résolution du prompt (actif DB / explicite / fallback code).

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
  getActivePrompt: jest.fn(),
  getPrompt: jest.fn(),
}));

import { analyzeIdentity, EMPTY_CORPUS_DESCRIPTION } from "./identityProfiler";
import { CODE_DEFAULT_IDENTITY_PROFILE_PROMPT_NAME } from "./identityProfilePromptDefault";
import { enumerateIdentityConvs } from "./identityConvFetcher";
import { fetchConversationMessages } from "../agents/conversation-analyzer/messageFetcher";
import { formatConversationForClassifier } from "../agents/conversation-analyzer/conversationFormatter";
import { inferStructured } from "../agents/conversation-analyzer/inference";
import { getActivePrompt, getPrompt, upsertConversation } from "./db";

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
const getActivePromptMock = getActivePrompt as jest.MockedFunction<
  typeof getActivePrompt
>;
const getPromptMock = getPrompt as jest.MockedFunction<typeof getPrompt>;

const corpusReady = (): void => {
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
};

beforeEach(() => {
  enumerateMock.mockReset();
  fetchMock.mockReset();
  formatMock.mockReset();
  inferMock.mockReset();
  upsertMock.mockReset();
  getActivePromptMock.mockReset();
  getPromptMock.mockReset();
});

const NOW_ISO = "2026-05-29T00:00:00.000Z";
const activeRow = (name: string, body: string) => ({
  kind: "identity_profile" as const,
  name,
  body,
  is_active: true,
  status: "validated" as const,
  validated_at: NOW_ISO,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
});

describe("analyzeIdentity", () => {
  it("happy path — appelle inferStructured et retourne payload + usage + promptName", async () => {
    getActivePromptMock.mockResolvedValue(
      activeRow("v1", "BODY_FROM_DB_{{DELIMITER}}"),
    );
    corpusReady();

    const result = await analyzeIdentity({
      identityId: "b".repeat(24),
      channel: "LINKEDIN",
      model: "claude-sonnet-4-6",
      tokenCap: 10_000,
    });

    expect(inferMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(result.promptName).toBe("v1");
    // Le body DB est bien injecté (avec {{DELIMITER}} substitué par un hex random)
    const systemPrompt = inferMock.mock.calls[0][0].systemPrompt;
    expect(systemPrompt).toMatch(/^BODY_FROM_DB_[0-9a-f]{16}$/);
    expect(result.payload.description.register).toBe("Professionnel, cordial");
    expect(result.payload.corpus.conv_count).toBe(1);
    expect(result.payload.corpus.msg_count_sender).toBe(2);
    expect(result.payload.metrics.length.msg_words_avg).not.toBeNull();
    expect(result.usage?.inputTokens).toBe(1000);
  });

  it("promptName explicite — utilise getPrompt et ce body précis (draft accepté)", async () => {
    getPromptMock.mockResolvedValue({
      ...activeRow("v2-draft", "BODY_DRAFT_{{DELIMITER}}"),
      is_active: false,
      status: "draft",
      validated_at: null,
    });
    corpusReady();

    const result = await analyzeIdentity({
      identityId: "b".repeat(24),
      channel: "LINKEDIN",
      model: "claude-sonnet-4-6",
      tokenCap: 10_000,
      promptName: "v2-draft",
    });

    expect(getPromptMock).toHaveBeenCalledWith("v2-draft", "identity_profile");
    expect(getActivePromptMock).not.toHaveBeenCalled();
    expect(result.promptName).toBe("v2-draft");
    const systemPrompt = inferMock.mock.calls[0][0].systemPrompt;
    expect(systemPrompt).toMatch(/^BODY_DRAFT_[0-9a-f]{16}$/);
  });

  it("promptName introuvable — throw avant inférence", async () => {
    getPromptMock.mockResolvedValue(null);
    enumerateMock.mockResolvedValue([]);

    await expect(
      analyzeIdentity({
        identityId: "b".repeat(24),
        channel: "LINKEDIN",
        model: "claude-sonnet-4-6",
        tokenCap: 10_000,
        promptName: "ghost",
      }),
    ).rejects.toThrow(/prompt identity_profile "ghost" introuvable/);
    expect(inferMock).not.toHaveBeenCalled();
  });

  it("getActivePrompt KO (DB down) — fallback code + log + promptName = v1", async () => {
    getActivePromptMock.mockRejectedValue(new Error("ECONNREFUSED"));
    corpusReady();
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await analyzeIdentity({
        identityId: "b".repeat(24),
        channel: "LINKEDIN",
        model: "claude-sonnet-4-6",
        tokenCap: 10_000,
      });

      expect(result.promptName).toBe(CODE_DEFAULT_IDENTITY_PROFILE_PROMPT_NAME);
      const systemPrompt = inferMock.mock.calls[0][0].systemPrompt;
      // Le body code default mentionne "describe_identity_style" textuellement
      expect(systemPrompt).toContain("describe_identity_style");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("getActivePrompt KO"),
        "ECONNREFUSED",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("corpus vide — bypass de l'inférence + description marqueur + promptName remonté", async () => {
    getActivePromptMock.mockResolvedValue(
      activeRow("v1", "BODY_FROM_DB_{{DELIMITER}}"),
    );
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
    expect(result.promptName).toBe("v1");
    expect(result.usage).toBeUndefined();
  });

  it("corpus avec convs mais 0 message SENDER — bypass inférence + marqueur", async () => {
    getActivePromptMock.mockResolvedValue(
      activeRow("v1", "BODY_FROM_DB_{{DELIMITER}}"),
    );
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
