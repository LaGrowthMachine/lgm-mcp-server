import { __resetClientForTests, maskSensitive, runDbExplorerAgent } from "./agentLoop";

const messagesCreate = jest.fn();

jest.mock("@anthropic-ai/sdk", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create: messagesCreate },
    })),
  };
});

jest.mock("./mongoClient", () => ({
  getDb: jest.fn().mockResolvedValue({
    collection: () => ({
      find: () => ({
        limit: () => ({
          toArray: jest.fn().mockResolvedValue([{ _id: "a" }]),
        }),
      }),
      countDocuments: jest.fn().mockResolvedValue(42),
    }),
  }),
}));

jest.mock("./prompt", () => {
  const actual = jest.requireActual("./prompt");
  return {
    ...actual,
    buildDbExplorerSystemPrompt: () => "FAKE-SYSTEM-PROMPT",
  };
});

const mkResp = (
  stop_reason: string,
  content: object[],
  input_tokens = 100,
  output_tokens = 50,
) => ({
  stop_reason,
  content,
  usage: { input_tokens, output_tokens },
});

const text = (s: string) => ({ type: "text", text: s });
const toolUse = (id: string, expr: string) => ({
  type: "tool_use",
  id,
  name: "run_query",
  input: { expr },
});

beforeEach(() => {
  __resetClientForTests();
  messagesCreate.mockReset();
  process.env.REPLY_MANAGER_API_KEY = "test-key";
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("agentLoop", () => {
  it("happy path: 1 tool_use → end_turn", async () => {
    messagesCreate
      .mockResolvedValueOnce(
        mkResp("tool_use", [toolUse("t1", "db.users.countDocuments({})")]),
      )
      .mockResolvedValueOnce(
        mkResp("end_turn", [text("There are 42 users.")]),
      );

    const result = await runDbExplorerAgent("how many users?");
    expect(result.answer).toBe("There are 42 users.");
    expect(result).not.toHaveProperty("queries");
    expect(result).not.toHaveProperty("stats");
    expect(result.telemetry.queryCount).toBe(1);
    expect(result.telemetry.failedQueries).toBe(0);
    expect(result.telemetry.loopIterations).toBe(2);
  });

  it("invalid query → reformulated → success", async () => {
    messagesCreate
      .mockResolvedValueOnce(
        mkResp("tool_use", [toolUse("t1", "db.users.insertOne({})")]),
      )
      .mockResolvedValueOnce(
        mkResp("tool_use", [toolUse("t2", "db.users.countDocuments({})")]),
      )
      .mockResolvedValueOnce(mkResp("end_turn", [text("Got it: 42.")]));

    const result = await runDbExplorerAgent("count please");
    expect(result.telemetry.queryCount).toBe(2);
    expect(result.telemetry.failedQueries).toBe(1);
    // First tool_result (after invalid insertOne) carries is_error=true.
    const secondCall = messagesCreate.mock.calls[1][0];
    expect(secondCall.messages[2].content[0].is_error).toBe(true);
    // Second tool_result (after valid countDocuments) carries is_error=false.
    const thirdCall = messagesCreate.mock.calls[2][0];
    expect(thirdCall.messages[4].content[0].is_error).toBe(false);
  });

  it("MAX_ITERATIONS exceeded", async () => {
    for (let i = 0; i < 12; i++) {
      messagesCreate.mockResolvedValueOnce(
        mkResp("tool_use", [toolUse(`t${i}`, "db.users.countDocuments({})")]),
      );
    }
    await expect(runDbExplorerAgent("loop forever")).rejects.toThrow(
      /max iterations/,
    );
  });

  it("stop_reason=max_tokens → truncated error", async () => {
    messagesCreate.mockResolvedValueOnce(mkResp("max_tokens", [text("partial")]));
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(/truncated/);
  });

  it("stop_reason=refusal → Unsupported stop_reason", async () => {
    messagesCreate.mockResolvedValueOnce(mkResp("refusal", []));
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(/Unsupported stop_reason: refusal/);
  });

  it("stop_reason=pause_turn → Unsupported", async () => {
    messagesCreate.mockResolvedValueOnce(mkResp("pause_turn", []));
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(/pause_turn/);
  });

  it("multi tool_use: 2 blocks → 1 assistant push, 1 user push with 2 tool_results", async () => {
    messagesCreate
      .mockResolvedValueOnce(
        mkResp("tool_use", [
          toolUse("t1", "db.users.countDocuments({})"),
          toolUse("t2", "db.users.countDocuments({a:1})"),
        ]),
      )
      .mockResolvedValueOnce(mkResp("end_turn", [text("Both ran.")]));

    const result = await runDbExplorerAgent("two counts");
    expect(result.telemetry.queryCount).toBe(2);

    // Inspect the messages passed to the 2nd call to confirm shape.
    const secondCallArgs = messagesCreate.mock.calls[1][0];
    const msgs = secondCallArgs.messages;
    // Initial user brief + 1 assistant push + 1 user push (2 tool_results).
    expect(msgs).toHaveLength(3);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("user");
    expect(Array.isArray(msgs[2].content)).toBe(true);
    expect(msgs[2].content.length).toBe(2);
    expect(msgs[2].content[0].type).toBe("tool_result");
  });

  it("stop_reason=tool_use with 0 tool_use blocks → error", async () => {
    messagesCreate.mockResolvedValueOnce(mkResp("tool_use", [text("nothing")]));
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(
      /Inconsistent response/,
    );
  });

  it("input.expr non-string → tool_result is_error, loop continues", async () => {
    messagesCreate
      .mockResolvedValueOnce(
        mkResp("tool_use", [{
          type: "tool_use",
          id: "t1",
          name: "run_query",
          input: { expr: 42 },
        }]),
      )
      .mockResolvedValueOnce(mkResp("end_turn", [text("Adjusted.")]));

    const result = await runDbExplorerAgent("brief");
    expect(result.answer).toBe("Adjusted.");
    // Malformed input counts as a failed query in telemetry (else operators
    // can't see the model fumbling).
    expect(result.telemetry.queryCount).toBe(1);
    expect(result.telemetry.failedQueries).toBe(1);
    const secondCall = messagesCreate.mock.calls[1][0];
    const toolResult = secondCall.messages[2].content[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/expr must be a string/);
  });

  it("429 → 1 retry, success on 2nd call", async () => {
    const error: Error & { status?: number } = new Error("rate limit");
    error.status = 429;

    messagesCreate
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(mkResp("end_turn", [text("OK after retry.")]));

    const result = await runDbExplorerAgent("brief");
    expect(result.answer).toBe("OK after retry.");
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });

  it("429 twice → error 'Inference rate-limited'", async () => {
    const error: Error & { status?: number } = new Error("rate limit");
    error.status = 429;
    messagesCreate.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(/rate-limited/);
  });

  it("context cumulé > 150_000 → 'too much context'", async () => {
    messagesCreate.mockResolvedValueOnce(
      mkResp("tool_use", [toolUse("t1", "db.users.countDocuments({})")], 200_000),
    );
    await expect(runDbExplorerAgent("huge")).rejects.toThrow(/too much context/);
  });

  it("end_turn with empty answer + no queries → 'refused to act'", async () => {
    messagesCreate.mockResolvedValueOnce(mkResp("end_turn", [text("")]));
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(/refused to act/);
  });

  it("end_turn with queries>0 but empty answer → throws 'no narrative'", async () => {
    messagesCreate
      .mockResolvedValueOnce(
        mkResp("tool_use", [toolUse("t1", "db.users.countDocuments({})")]),
      )
      .mockResolvedValueOnce(mkResp("end_turn", [text("")]));
    await expect(runDbExplorerAgent("count")).rejects.toThrow(
      /Agent returned no narrative\./,
    );
  });

  it("caps tool_use blocks per iteration", async () => {
    messagesCreate.mockResolvedValueOnce(
      mkResp("tool_use", [
        toolUse("t1", "db.x.countDocuments({})"),
        toolUse("t2", "db.x.countDocuments({})"),
        toolUse("t3", "db.x.countDocuments({})"),
        toolUse("t4", "db.x.countDocuments({})"),
        toolUse("t5", "db.x.countDocuments({})"),
        toolUse("t6", "db.x.countDocuments({})"),
        toolUse("t7", "db.x.countDocuments({})"),
        toolUse("t8", "db.x.countDocuments({})"),
        toolUse("t9", "db.x.countDocuments({})"),
      ]),
    );
    await expect(runDbExplorerAgent("storm")).rejects.toThrow(/9 tool_use blocks/);
  });
});

describe("maskSensitive", () => {
  it("masks 24-char hex in single quotes", () => {
    expect(maskSensitive("db.x.findOne({_id: ObjectId('507f1f77bcf86cd799439011')})")).toMatch(/\*\*\*/);
  });

  it("masks email-like strings", () => {
    expect(maskSensitive("db.users.findOne({email: 'alex@foo.com'})")).toMatch(/\*\*\*@\*\*\*/);
    expect(maskSensitive('db.users.findOne({email: "alex@foo.com"})')).toMatch(/\*\*\*@\*\*\*/);
  });

  it("masks bare digit runs (phone numbers)", () => {
    expect(maskSensitive("phone:33612345678")).toMatch(/\*\*\*/);
    expect(maskSensitive("short:12345")).not.toMatch(/\*\*\*/); // <7 digits, kept
  });
});
