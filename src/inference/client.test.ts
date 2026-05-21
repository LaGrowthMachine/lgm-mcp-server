import { callWithRetry, getInferenceClient, __resetForTests } from "./client";

const messagesCreate = jest.fn();
const ctor = jest.fn();

jest.mock("@anthropic-ai/bedrock-sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((opts: unknown) => {
    ctor(opts);
    return { messages: { create: messagesCreate } };
  }),
}));

const setEnv = () => {
  process.env.REPLY_MANAGER_BEDROCK_TOKEN = "test-token";
  process.env.REPLY_MANAGER_BEDROCK_BASE_URL = "https://example/v1";
  process.env.REPLY_MANAGER_BEDROCK_REGION = "eu-north-1";
};

beforeEach(() => {
  __resetForTests();
  messagesCreate.mockReset();
  ctor.mockReset();
  delete process.env.REPLY_MANAGER_BEDROCK_TOKEN;
  delete process.env.REPLY_MANAGER_BEDROCK_BASE_URL;
  delete process.env.REPLY_MANAGER_BEDROCK_REGION;
});

const fakeMessage = { stop_reason: "end_turn", content: [], usage: { input_tokens: 1, output_tokens: 1 } };
const sampleReq = {
  model: "anthropic.claude-sonnet-4-6",
  max_tokens: 100,
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("inference client", () => {
  it("instantiates AnthropicBedrock with the prefixed env vars", () => {
    setEnv();
    getInferenceClient();
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor.mock.calls[0][0]).toEqual({
      apiKey: "test-token",
      baseURL: "https://example/v1",
      awsRegion: "eu-north-1",
    });
  });

  it("is singleton — second call reuses the same client", () => {
    setEnv();
    getInferenceClient();
    getInferenceClient();
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["REPLY_MANAGER_BEDROCK_TOKEN", { url: "u", region: "eu" }],
    ["REPLY_MANAGER_BEDROCK_BASE_URL", { token: "t", region: "eu" }],
    ["REPLY_MANAGER_BEDROCK_REGION", { token: "t", url: "u" }],
  ])("throws when %s is missing", (envName, partial: { token?: string; url?: string; region?: string }) => {
    if (partial.token) process.env.REPLY_MANAGER_BEDROCK_TOKEN = partial.token;
    if (partial.url) process.env.REPLY_MANAGER_BEDROCK_BASE_URL = partial.url;
    if (partial.region) process.env.REPLY_MANAGER_BEDROCK_REGION = partial.region;
    expect(() => getInferenceClient()).toThrow(new RegExp(envName));
  });

  it("callWithRetry: success on first try → no retry", async () => {
    setEnv();
    messagesCreate.mockResolvedValueOnce(fakeMessage);
    const result = await callWithRetry(sampleReq);
    expect(result).toBe(fakeMessage);
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(messagesCreate.mock.calls[0][1]).toEqual({ timeout: 30_000 });
  });

  it("callWithRetry: retries on 429", async () => {
    setEnv();
    const err = Object.assign(new Error("rate"), { status: 429 });
    messagesCreate.mockRejectedValueOnce(err).mockResolvedValueOnce(fakeMessage);
    const result = await callWithRetry(sampleReq);
    expect(result).toBe(fakeMessage);
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });

  it("callWithRetry: retries on ThrottlingException name", async () => {
    setEnv();
    const err = Object.assign(new Error("throttled"), { name: "ThrottlingException" });
    messagesCreate.mockRejectedValueOnce(err).mockResolvedValueOnce(fakeMessage);
    const result = await callWithRetry(sampleReq);
    expect(result).toBe(fakeMessage);
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });

  it("callWithRetry: second failure throws rate-limited message", async () => {
    setEnv();
    const err = Object.assign(new Error("rate"), { status: 503 });
    messagesCreate.mockRejectedValueOnce(err).mockRejectedValueOnce(err);
    await expect(callWithRetry(sampleReq)).rejects.toThrow("Inference rate-limited, retry shortly.");
  });

  it("callWithRetry: non-retryable error is propagated as-is", async () => {
    setEnv();
    const err = Object.assign(new Error("bad request"), { status: 400 });
    messagesCreate.mockRejectedValueOnce(err);
    await expect(callWithRetry(sampleReq)).rejects.toBe(err);
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("callWithRetry: honors custom timeoutMs", async () => {
    setEnv();
    messagesCreate.mockResolvedValueOnce(fakeMessage);
    await callWithRetry(sampleReq, { timeoutMs: 5000 });
    expect(messagesCreate.mock.calls[0][1]).toEqual({ timeout: 5000 });
  });
});
