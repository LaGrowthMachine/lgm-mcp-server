import {
  __resetClientForTests,
  maskSensitive,
  runDbExplorerAgent,
} from "./agentLoop";
import {
  callConverse,
  type ConverseResponse,
} from "../../inference/client";

// On mock `callConverse` (façade Converse de notre wrapper Bedrock). Les
// tests dérouent la boucle sans appel réseau et inspectent le format Converse
// passé au modèle (modelId + messages + toolConfig).
jest.mock("../../inference/client", () => ({
  __esModule: true,
  ...jest.requireActual("../../inference/client"),
  callConverse: jest.fn(),
  __resetForTests: jest.fn(),
}));

const mockedCallConverse = callConverse as jest.MockedFunction<
  typeof callConverse
>;

// Bypass Postgres resolution dans les tests : on injecte un model fictif au
// début de la boucle au lieu d'aller chercher en DB le default settings.
jest.mock("../../eval/db", () => ({
  resolveEffectiveModelId: jest.fn().mockResolvedValue({
    uuid: "00000000-0000-0000-0000-000000000001",
    awsModelId: "anthropic.claude-haiku-4-5",
  }),
}));

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
  stopReason: string,
  content: object[],
  inputTokens = 100,
  outputTokens = 50,
): ConverseResponse =>
  ({
    output: { message: { role: "assistant", content } },
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  }) as unknown as ConverseResponse;

const text = (s: string) => ({ text: s });
const toolUse = (toolUseId: string, expr: string) => ({
  toolUse: { toolUseId, name: "run_query", input: { expr } },
});

beforeEach(() => {
  __resetClientForTests();
  mockedCallConverse.mockReset();
  process.env.REPLY_MANAGER_BEDROCK_TOKEN = "test-token";
  process.env.REPLY_MANAGER_BEDROCK_BASE_URL = "https://example/v1";
  process.env.REPLY_MANAGER_BEDROCK_REGION = "eu-north-1";
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("agentLoop", () => {
  it("happy path: 1 tool_use → end_turn", async () => {
    mockedCallConverse
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
    // Garde la propagation effective du model résolu vers Bedrock : si demain
    // quelqu'un casse le chaînage resolveEffectiveModelId → callConverse,
    // les autres tests passent toujours.
    expect(mockedCallConverse.mock.calls[0][0].modelId).toBe(
      "anthropic.claude-haiku-4-5",
    );
  });

  it("invalid query → reformulated → success", async () => {
    mockedCallConverse
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
    // 1er toolResult (après insertOne invalide) → status=error
    const secondCall = mockedCallConverse.mock.calls[1][0];
    expect(secondCall.messages[2].content[0]).toMatchObject({
      toolResult: { status: "error" },
    });
    // 2e toolResult (après countDocuments valide) → status=success
    const thirdCall = mockedCallConverse.mock.calls[2][0];
    expect(thirdCall.messages[4].content[0]).toMatchObject({
      toolResult: { status: "success" },
    });
  });

  it("MAX_ITERATIONS exceeded", async () => {
    for (let i = 0; i < 12; i++) {
      mockedCallConverse.mockResolvedValueOnce(
        mkResp("tool_use", [toolUse(`t${i}`, "db.users.countDocuments({})")]),
      );
    }
    await expect(runDbExplorerAgent("loop forever")).rejects.toThrow(
      /max iterations/,
    );
  });

  it("stopReason=max_tokens → truncated error", async () => {
    mockedCallConverse.mockResolvedValueOnce(
      mkResp("max_tokens", [text("partial")]),
    );
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(/truncated/);
  });

  it("stopReason=guardrail_intervened → Unsupported stop_reason", async () => {
    mockedCallConverse.mockResolvedValueOnce(
      mkResp("guardrail_intervened", []),
    );
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(
      /Unsupported stop_reason: guardrail_intervened/,
    );
  });

  it("stopReason=content_filtered → Unsupported", async () => {
    mockedCallConverse.mockResolvedValueOnce(mkResp("content_filtered", []));
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(
      /content_filtered/,
    );
  });

  it("multi tool_use: 2 blocks → 1 assistant push, 1 user push with 2 toolResults", async () => {
    mockedCallConverse
      .mockResolvedValueOnce(
        mkResp("tool_use", [
          toolUse("t1", "db.users.countDocuments({})"),
          toolUse("t2", "db.users.countDocuments({a:1})"),
        ]),
      )
      .mockResolvedValueOnce(mkResp("end_turn", [text("Both ran.")]));

    const result = await runDbExplorerAgent("two counts");
    expect(result.telemetry.queryCount).toBe(2);

    const secondCallArgs = mockedCallConverse.mock.calls[1][0];
    const msgs = secondCallArgs.messages;
    // Initial user brief + 1 assistant push + 1 user push (2 toolResults).
    expect(msgs).toHaveLength(3);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("user");
    expect(Array.isArray(msgs[2].content)).toBe(true);
    expect(msgs[2].content).toHaveLength(2);
    expect(msgs[2].content[0]).toHaveProperty("toolResult");
  });

  it("stopReason=tool_use with 0 tool_use blocks → error", async () => {
    mockedCallConverse.mockResolvedValueOnce(
      mkResp("tool_use", [text("nothing")]),
    );
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(
      /Inconsistent response/,
    );
  });

  it("input.expr non-string → tool_result status=error, loop continues", async () => {
    mockedCallConverse
      .mockResolvedValueOnce(
        mkResp("tool_use", [
          {
            toolUse: {
              toolUseId: "t1",
              name: "run_query",
              input: { expr: 42 },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(mkResp("end_turn", [text("Adjusted.")]));

    const result = await runDbExplorerAgent("brief");
    expect(result.answer).toBe("Adjusted.");
    // Malformed input counts as a failed query in telemetry (else operators
    // can't see the model fumbling).
    expect(result.telemetry.queryCount).toBe(1);
    expect(result.telemetry.failedQueries).toBe(1);
    const secondCall = mockedCallConverse.mock.calls[1][0];
    const toolResult = (
      secondCall.messages[2].content[0] as {
        toolResult: { status: string; content: { text: string }[] };
      }
    ).toolResult;
    expect(toolResult.status).toBe("error");
    expect(toolResult.content[0].text).toMatch(/expr must be a string/);
  });

  it("context cumulé > 150_000 → 'too much context'", async () => {
    mockedCallConverse.mockResolvedValueOnce(
      mkResp(
        "tool_use",
        [toolUse("t1", "db.users.countDocuments({})")],
        200_000,
      ),
    );
    await expect(runDbExplorerAgent("huge")).rejects.toThrow(
      /too much context/,
    );
  });

  it("end_turn with empty answer + no queries → 'refused to act'", async () => {
    mockedCallConverse.mockResolvedValueOnce(
      mkResp("end_turn", [text("")]),
    );
    await expect(runDbExplorerAgent("brief")).rejects.toThrow(
      /refused to act/,
    );
  });

  it("end_turn with queries>0 but empty answer → throws 'no narrative'", async () => {
    mockedCallConverse
      .mockResolvedValueOnce(
        mkResp("tool_use", [toolUse("t1", "db.users.countDocuments({})")]),
      )
      .mockResolvedValueOnce(mkResp("end_turn", [text("")]));
    await expect(runDbExplorerAgent("count")).rejects.toThrow(
      /Agent returned no narrative\./,
    );
  });

  it("caps tool_use blocks per iteration", async () => {
    mockedCallConverse.mockResolvedValueOnce(
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
    await expect(runDbExplorerAgent("storm")).rejects.toThrow(
      /9 tool_use blocks/,
    );
  });
});

describe("maskSensitive", () => {
  it("masks 24-char hex in single quotes", () => {
    expect(
      maskSensitive(
        "db.x.findOne({_id: ObjectId('507f1f77bcf86cd799439011')})",
      ),
    ).toMatch(/\*\*\*/);
  });

  it("masks email-like strings", () => {
    expect(maskSensitive("db.users.findOne({email: 'alex@foo.com'})")).toMatch(
      /\*\*\*@\*\*\*/,
    );
    expect(maskSensitive('db.users.findOne({email: "alex@foo.com"})')).toMatch(
      /\*\*\*@\*\*\*/,
    );
  });

  it("masks bare digit runs (phone numbers)", () => {
    expect(maskSensitive("phone:33612345678")).toMatch(/\*\*\*/);
    expect(maskSensitive("short:12345")).not.toMatch(/\*\*\*/); // <7 digits, kept
  });
});
