import {
  callConverse,
  ConverseHTTPError,
  __resetForTests,
  type ConverseRequest,
} from "./client";

const setEnv = () => {
  process.env.REPLY_MANAGER_BEDROCK_TOKEN = "test-token";
  process.env.REPLY_MANAGER_BEDROCK_BASE_URL = "https://example/v1";
  process.env.REPLY_MANAGER_BEDROCK_REGION = "eu-north-1";
};

const fakeResponseBody = {
  output: {
    message: { role: "assistant", content: [{ text: "hi" }] },
  },
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

const sampleReq: ConverseRequest = {
  modelId: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  messages: [{ role: "user", content: [{ text: "hi" }] }],
  inferenceConfig: { maxTokens: 100 },
};

let fetchSpy: jest.SpyInstance;

const mkFetchResponse = (
  status: number,
  body: object | string,
): Response => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(text),
  } as unknown as Response;
};

beforeEach(() => {
  __resetForTests();
  delete process.env.REPLY_MANAGER_BEDROCK_TOKEN;
  delete process.env.REPLY_MANAGER_BEDROCK_BASE_URL;
  delete process.env.REPLY_MANAGER_BEDROCK_REGION;
  fetchSpy = jest.spyOn(global, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("callConverse", () => {
  it("calls the right URL with Bearer auth and the JSON payload", async () => {
    setEnv();
    fetchSpy.mockResolvedValueOnce(mkFetchResponse(200, fakeResponseBody));

    const r = await callConverse(sampleReq);
    expect(r).toEqual(fakeResponseBody);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://example/v1/model/eu.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse",
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    // modelId is in the URL, not in the body.
    expect(body).not.toHaveProperty("modelId");
    expect(body.messages[0].content[0].text).toBe("hi");
  });

  it("strips trailing slash on baseURL", async () => {
    process.env.REPLY_MANAGER_BEDROCK_TOKEN = "t";
    process.env.REPLY_MANAGER_BEDROCK_BASE_URL = "https://example/v1/";
    process.env.REPLY_MANAGER_BEDROCK_REGION = "eu-north-1";
    fetchSpy.mockResolvedValueOnce(mkFetchResponse(200, fakeResponseBody));
    await callConverse(sampleReq);
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toMatch(/^https:\/\/example\/v1\/model\//);
    expect(url).not.toMatch(/v1\/\/model/);
  });

  it.each([
    "REPLY_MANAGER_BEDROCK_TOKEN",
    "REPLY_MANAGER_BEDROCK_BASE_URL",
    "REPLY_MANAGER_BEDROCK_REGION",
  ])("throws when %s is missing", async (envName) => {
    setEnv();
    delete process.env[envName];
    await expect(callConverse(sampleReq)).rejects.toThrow(new RegExp(envName));
  });

  it("retries once on 429", async () => {
    setEnv();
    fetchSpy
      .mockResolvedValueOnce(mkFetchResponse(429, "rate"))
      .mockResolvedValueOnce(mkFetchResponse(200, fakeResponseBody));
    const r = await callConverse(sampleReq);
    expect(r).toEqual(fakeResponseBody);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries once on 503", async () => {
    setEnv();
    fetchSpy
      .mockResolvedValueOnce(mkFetchResponse(503, "unavail"))
      .mockResolvedValueOnce(mkFetchResponse(200, fakeResponseBody));
    const r = await callConverse(sampleReq);
    expect(r).toEqual(fakeResponseBody);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("second 429 throws rate-limited message", async () => {
    setEnv();
    fetchSpy
      .mockResolvedValueOnce(mkFetchResponse(429, "rate"))
      .mockResolvedValueOnce(mkFetchResponse(429, "rate"));
    await expect(callConverse(sampleReq)).rejects.toThrow(
      "Inference rate-limited, retry shortly.",
    );
  });

  it("4xx non-retryable propagates as ConverseHTTPError", async () => {
    setEnv();
    fetchSpy.mockResolvedValueOnce(
      mkFetchResponse(400, { message: "bad request" }),
    );
    await expect(callConverse(sampleReq)).rejects.toThrow(ConverseHTTPError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("network error (TypeError) retries once", async () => {
    setEnv();
    fetchSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(mkFetchResponse(200, fakeResponseBody));
    const r = await callConverse(sampleReq);
    expect(r).toEqual(fakeResponseBody);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("plain Error (non-network) propagates as-is, no retry", async () => {
    setEnv();
    const boom = new Error("boom");
    fetchSpy.mockRejectedValueOnce(boom);
    await expect(callConverse(sampleReq)).rejects.toBe(boom);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
