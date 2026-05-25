import { z } from "zod";

jest.mock("../callFlow", () => {
  class McpFlowError extends Error {
    public statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "McpFlowError";
      this.statusCode = statusCode;
    }
  }
  return { __esModule: true, McpFlowError };
});

jest.mock("../tracking", () => ({
  __esModule: true,
  trackMcpEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../requestContext", () => ({
  __esModule: true,
  getApiKey: jest.fn(() => ""),
}));

jest.mock("../eval/analyzer", () => ({
  __esModule: true,
  analyzeConversationWithDbPrompt: jest.fn(),
}));

jest.mock("../eval/db", () => ({
  __esModule: true,
  resolveEffectiveModelId: jest
    .fn()
    .mockResolvedValue({ awsModelId: "claude-sonnet-4-6" }),
}));

jest.mock("../agents/db-explorer/acl", () => ({
  __esModule: true,
  assertLgmStaff: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../agents/db-explorer/agentLoop", () => ({
  __esModule: true,
  runDbExplorerAgent: jest.fn(),
}));

jest.mock("../agents/db-explorer/prompt", () => ({
  __esModule: true,
  DB_EXPLORER_PROMPT_VERSION: "test-v1",
}));

import { analyzeConversationWithDbPrompt } from "../eval/analyzer";
import { runDbExplorerAgent } from "../agents/db-explorer/agentLoop";
import { trackMcpEvent } from "../tracking";
import { buildBuiltinTool } from "./builtin";
import type { EndpointRow } from "../eval/db";

const mockedAnalyze =
  analyzeConversationWithDbPrompt as jest.MockedFunction<
    typeof analyzeConversationWithDbPrompt
  >;
const mockedExplore = runDbExplorerAgent as jest.MockedFunction<
  typeof runDbExplorerAgent
>;
const mockedTrack = trackMcpEvent as jest.MockedFunction<typeof trackMcpEvent>;

const analyzeRow: Pick<EndpointRow, "name" | "description" | "config"> = {
  name: "analyze_conversation",
  description: "Classify the last lead message in a conversation.",
  config: {
    handler: "analyze_conversation",
    title: "Conversation Analysis",
    label: "Analyze Conversation",
    inputs: [
      { name: "conversationId", kind: "string", describe: "conv id" },
    ],
  },
};

const exploreRow: Pick<EndpointRow, "name" | "description" | "config"> = {
  name: "explore_db",
  description: "Explore the LGM MongoDB.",
  config: {
    handler: "explore_db",
    label: "Explore Database (admin)",
    inputs: [
      { name: "brief", kind: "string", min: 10, max: 5000, describe: "brief" },
    ],
  },
};

beforeEach(() => {
  mockedAnalyze.mockReset();
  mockedExplore.mockReset();
  mockedTrack.mockReset();
  mockedTrack.mockResolvedValue(undefined);
});

describe("buildBuiltinTool", () => {
  it("registers readOnlyHint annotation and label-derived title", () => {
    const built = buildBuiltinTool(analyzeRow);
    expect(built.meta.annotations.readOnlyHint).toBe(true);
    expect(built.meta.annotations.title).toBe("Analyze Conversation");
    expect(Object.keys(built.meta.inputSchema)).toEqual(["conversationId"]);
  });

  it("inputSchema rejects missing required input", () => {
    const built = buildBuiltinTool(analyzeRow);
    const schema = z.object(built.meta.inputSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("analyze_conversation handler delegates + tracks on ok status", async () => {
    mockedAnalyze.mockResolvedValueOnce({
      analysis: { status: "ok" },
      promptName: "v1",
    } as unknown as Awaited<ReturnType<typeof analyzeConversationWithDbPrompt>>);

    const built = buildBuiltinTool(analyzeRow);
    const res = await built.handler(
      { conversationId: "abc123" },
      { authInfo: { token: "key-a" } },
    );

    expect(mockedAnalyze).toHaveBeenCalledWith("abc123", {
      model: "claude-sonnet-4-6",
    });
    expect(mockedTrack).toHaveBeenCalledWith("key-a", "mcp_tool_called", {
      toolName: "analyze_conversation",
      promptVersion: "v1",
    });
    expect("isError" in res).toBe(false);
    expect(res.content[0].text).toContain("## Conversation Analysis");
  });

  it("explore_db handler returns answer + tracks telemetry", async () => {
    mockedExplore.mockResolvedValueOnce({
      answer: "The lead replied positively.",
      telemetry: {
        queryCount: 2,
        failedQueries: 0,
        loopIterations: 1,
        tokensUsed: 1234,
      },
    } as unknown as Awaited<ReturnType<typeof runDbExplorerAgent>>);

    const built = buildBuiltinTool(exploreRow);
    const res = await built.handler(
      { brief: "Show me top campaigns." },
      { authInfo: { token: "key-x" } },
    );

    expect(mockedExplore).toHaveBeenCalledWith("Show me top campaigns.");
    expect(res.content[0].text).toBe("The lead replied positively.");
    expect(mockedTrack).toHaveBeenCalledWith(
      "key-x",
      "mcp_tool_called",
      expect.objectContaining({ toolName: "explore_db" }),
    );
  });

  it("explore_db handler maps Mongo network errors to a stable user-facing message", async () => {
    const err = new Error("ECONNREFUSED 127.0.0.1:27017");
    mockedExplore.mockRejectedValueOnce(err);

    const built = buildBuiltinTool(exploreRow);
    const res = await built.handler(
      { brief: "Show me top campaigns." },
      { authInfo: { token: "k" } },
    );

    expect("isError" in res && res.isError).toBe(true);
    expect(res.content[0].text).toBe("Error (503): Database unreachable.");
  });
});
