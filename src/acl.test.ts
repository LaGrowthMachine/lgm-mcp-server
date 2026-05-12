import { assertLgmStaff } from "./acl";
import { callFlow, McpFlowError } from "./callFlow";

jest.mock("./callFlow", () => {
  const actual = jest.requireActual("./callFlow");
  return {
    ...actual,
    callFlow: jest.fn(),
  };
});

const mockedCallFlow = callFlow as jest.MockedFunction<typeof callFlow>;

describe("assertLgmStaff", () => {
  beforeEach(() => {
    mockedCallFlow.mockReset();
  });

  it("accepts a valid lgm staff email", async () => {
    mockedCallFlow.mockResolvedValue({ email: "alexis@lagrowthmachine.com" });
    const result = await assertLgmStaff("apikey");
    expect(result.email).toBe("alexis@lagrowthmachine.com");
  });

  it("normalizes uppercase + whitespace", async () => {
    mockedCallFlow.mockResolvedValue({ email: "  Alexis@LaGrowthMachine.com  " });
    const result = await assertLgmStaff("apikey");
    expect(result.email).toBe("alexis@lagrowthmachine.com");
  });

  it("accepts emails with dots, plus, hyphen, underscore", async () => {
    mockedCallFlow.mockResolvedValue({ email: "first.last+tag-2_x@lagrowthmachine.com" });
    const result = await assertLgmStaff("apikey");
    expect(result.email).toBe("first.last+tag-2_x@lagrowthmachine.com");
  });

  it("rejects non-LGM domain", async () => {
    mockedCallFlow.mockResolvedValue({ email: "user@gmail.com" });
    await expect(assertLgmStaff("apikey")).rejects.toMatchObject({
      statusCode: 403,
      message: "explore_db is restricted to LGM staff accounts.",
    });
  });

  it("rejects homograph attack via cyrillic 'а' (looks like latin a)", async () => {
    // The cyrillic 'а' U+0430 looks like 'a' but is not in [a-z]
    mockedCallFlow.mockResolvedValue({ email: "аdmin@lagrowthmachine.com" });
    await expect(assertLgmStaff("apikey")).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("rejects lagrowthmachine.co (typo squat)", async () => {
    mockedCallFlow.mockResolvedValue({ email: "user@lagrowthmachine.co" });
    await expect(assertLgmStaff("apikey")).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("rejects suffix-only match (foo.lagrowthmachine.com)", async () => {
    mockedCallFlow.mockResolvedValue({ email: "user@evil.lagrowthmachine.com.fake.com" });
    await expect(assertLgmStaff("apikey")).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("503 when /members throws non-Mcp error", async () => {
    mockedCallFlow.mockRejectedValue(new Error("network blew up"));
    await expect(assertLgmStaff("apikey")).rejects.toMatchObject({
      statusCode: 503,
      message: "ACL check failed, try again shortly.",
    });
  });

  it("normalizes any /members McpFlowError (e.g. 401) to 503", async () => {
    // Per spec §5.5: every /members failure → 503, never leak underlying cause.
    mockedCallFlow.mockRejectedValue(new McpFlowError("Authentication failed.", 401));
    await expect(assertLgmStaff("apikey")).rejects.toMatchObject({
      statusCode: 503,
      message: "ACL check failed, try again shortly.",
    });
  });

  it("403 when /members returns no email", async () => {
    mockedCallFlow.mockResolvedValue({});
    await expect(assertLgmStaff("apikey")).rejects.toMatchObject({
      statusCode: 403,
      message: "ACL check returned no valid email.",
    });
  });

  it("403 when /members returns email as non-string", async () => {
    mockedCallFlow.mockResolvedValue({ email: 42 });
    await expect(assertLgmStaff("apikey")).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("403 when /members returns null", async () => {
    mockedCallFlow.mockResolvedValue(null);
    await expect(assertLgmStaff("apikey")).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
