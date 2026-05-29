import { z } from "zod";

jest.mock("../callFlow", () => {
  // McpFlowError doit rester une vraie sous-classe d'Error pour que
  // `instanceof McpFlowError` fonctionne dans `handleToolError`.
  class McpFlowError extends Error {
    public statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "McpFlowError";
      this.statusCode = statusCode;
    }
  }
  return {
    __esModule: true,
    callFlow: jest.fn(),
    McpFlowError,
  };
});

jest.mock("../tracking", () => ({
  __esModule: true,
  trackMcpEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../requestContext", () => ({
  __esModule: true,
  getApiKey: jest.fn(() => ""),
}));

import { callFlow, McpFlowError } from "../callFlow";
import { trackMcpEvent } from "../tracking";
import {
  buildProxyTool,
  buildInputSchemaShape,
  renderPathAndParams,
} from "./proxy";
import type { EndpointRow } from "../eval/db";

const mockedCallFlow = callFlow as jest.MockedFunction<typeof callFlow>;
const mockedTrack = trackMcpEvent as jest.MockedFunction<typeof trackMcpEvent>;

// Sample row mimant un seed GET (`list_campaigns`) — inputs avec optional +
// default, kind variés.
const sampleRow: Pick<EndpointRow, "name" | "description" | "config"> = {
  name: "list_campaigns",
  description: "List all campaigns for the authenticated user.",
  config: {
    method: "GET",
    path: "/campaigns",
    title: "Campaigns",
    inputs: [
      {
        name: "status",
        kind: "string",
        optional: true,
        describe: "Filter by status",
      },
      {
        name: "skip",
        kind: "number",
        optional: true,
        default: 0,
        describe: "Skip count",
      },
      {
        name: "limit",
        kind: "number",
        optional: true,
        default: 25,
        describe: "Limit",
      },
    ],
  },
};

// Sample GET avec path templating (`get_campaign_stats`).
const sampleRowWithPath: Pick<
  EndpointRow,
  "name" | "description" | "config"
> = {
  name: "get_campaign_stats",
  description: "Get detailed stats for a campaign.",
  config: {
    method: "GET",
    path: "/campaigns/{campaignId}/stats",
    title: "Campaign Stats",
    inputs: [
      {
        name: "campaignId",
        kind: "string",
        describe: "The campaign ID",
      },
    ],
  },
};

// Sample POST mimant le seed `save_identity_preference` : path templating +
// tracking_event override, défaut destructive_hint:true.
const sampleRowPostPref: Pick<
  EndpointRow,
  "name" | "description" | "config"
> = {
  name: "save_identity_preference",
  description: "Save a preference for a specific identity.",
  config: {
    method: "POST",
    path: "/identities/{identityId}/preferences",
    title: "Preference Saved",
    label: "Save Identity Preference",
    tracking_event: "mcp_preference_saved",
    inputs: [
      { name: "identityId", kind: "string", describe: "identity id" },
      { name: "category", kind: "string", describe: "cat" },
      { name: "key", kind: "string", describe: "key" },
      { name: "value", kind: "string", describe: "val" },
      {
        name: "channel",
        kind: "string",
        optional: true,
        describe: "channel",
      },
    ],
  },
};

// Sample POST mimant `create_audience_from_linkedin_url` : extensions enum +
// pattern + min/max + format + destructive_hint:false override.
const sampleRowPostAudience: Pick<
  EndpointRow,
  "name" | "description" | "config"
> = {
  name: "create_audience_from_linkedin_url",
  description: "Create an audience from a LinkedIn URL.",
  config: {
    method: "POST",
    path: "/audiences",
    title: "Audience Created",
    label: "Create Audience from LinkedIn URL",
    destructive_hint: false,
    inputs: [
      {
        name: "audience",
        kind: "string",
        min: 1,
        max: 100,
        describe: "audience name",
      },
      {
        name: "linkedinUrl",
        kind: "string",
        format: "url",
        pattern: "^https://(www\\.)?linkedin\\.com/",
        pattern_message:
          "A valid LinkedIn URL is required (must start with https://www.linkedin.com/)",
        describe: "linkedin url",
      },
      { name: "identityId", kind: "string", describe: "identity id" },
      {
        name: "linkedinPostCategory",
        kind: "string",
        optional: true,
        enum: ["like", "comment"],
        describe: "post engagement type",
      },
      {
        name: "excludeContactedLeads",
        kind: "boolean",
        optional: true,
        describe: "exclude contacted",
      },
      {
        name: "autoImport",
        kind: "boolean",
        optional: true,
        describe: "auto import",
      },
    ],
  },
};

beforeEach(() => {
  mockedCallFlow.mockReset();
  mockedTrack.mockReset();
  mockedTrack.mockResolvedValue(undefined);
});

describe("buildInputSchemaShape", () => {
  it("produces a Zod shape with the right keys, accepts/rejects expected inputs", () => {
    const shape = buildInputSchemaShape([
      { name: "leadId", kind: "string", describe: "lead id" },
      {
        name: "limit",
        kind: "number",
        optional: true,
        default: 25,
        describe: "limit",
      },
      {
        name: "flag",
        kind: "boolean",
        optional: true,
        describe: "flag",
      },
    ]);
    expect(Object.keys(shape)).toEqual(["leadId", "limit", "flag"]);

    const schema = z.object(shape);

    // Required leadId: rejects when missing
    expect(schema.safeParse({}).success).toBe(false);
    // Default applies: when limit omitted, parsed value uses default
    const parsed = schema.parse({ leadId: "abc" });
    expect(parsed).toEqual({ leadId: "abc", limit: 25 });
    // Type rejection: number where string expected
    expect(schema.safeParse({ leadId: 123 }).success).toBe(false);
    // Optional accepted
    expect(schema.safeParse({ leadId: "x", flag: true }).success).toBe(true);
  });

  it("applies enum on kind:string inputs", () => {
    const shape = buildInputSchemaShape([
      {
        name: "post",
        kind: "string",
        enum: ["like", "comment"],
        describe: "type",
      },
    ]);
    const schema = z.object(shape);
    expect(schema.safeParse({ post: "like" }).success).toBe(true);
    expect(schema.safeParse({ post: "comment" }).success).toBe(true);
    expect(schema.safeParse({ post: "share" }).success).toBe(false);
  });

  it("applies pattern + pattern_message on kind:string inputs", () => {
    const shape = buildInputSchemaShape([
      {
        name: "url",
        kind: "string",
        pattern: "^https://(www\\.)?linkedin\\.com/",
        pattern_message:
          "A valid LinkedIn URL is required (must start with https://www.linkedin.com/)",
        describe: "url",
      },
    ]);
    const schema = z.object(shape);
    expect(
      schema.safeParse({ url: "https://www.linkedin.com/foo" }).success,
    ).toBe(true);
    const bad = schema.safeParse({ url: "https://example.com/" });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      // Custom pattern_message must be preserved (baseline contract).
      expect(bad.error.issues[0].message).toBe(
        "A valid LinkedIn URL is required (must start with https://www.linkedin.com/)",
      );
    }
  });

  it("applies format:'url' on kind:string inputs", () => {
    const shape = buildInputSchemaShape([
      { name: "url", kind: "string", format: "url", describe: "url" },
    ]);
    const schema = z.object(shape);
    expect(schema.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(schema.safeParse({ url: "not-a-url" }).success).toBe(false);
  });

  it("applies min/max as length bound on kind:string", () => {
    const shape = buildInputSchemaShape([
      { name: "audience", kind: "string", min: 1, max: 5, describe: "n" },
    ]);
    const schema = z.object(shape);
    expect(schema.safeParse({ audience: "abc" }).success).toBe(true);
    expect(schema.safeParse({ audience: "" }).success).toBe(false);
    expect(schema.safeParse({ audience: "abcdef" }).success).toBe(false);
  });

  it("applies min/max as numeric bound on kind:number", () => {
    const shape = buildInputSchemaShape([
      { name: "limit", kind: "number", min: 1, max: 100, describe: "n" },
    ]);
    const schema = z.object(shape);
    expect(schema.safeParse({ limit: 50 }).success).toBe(true);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("renderPathAndParams", () => {
  it("substitutes {name} placeholders and removes them from the query params", () => {
    const r = renderPathAndParams("/campaigns/{campaignId}/stats", {
      campaignId: "abc123",
      extra: "kept",
    });
    expect(r.path).toBe("/campaigns/abc123/stats");
    expect(r.params).toEqual({ extra: "kept" });
  });

  it("leaves path unchanged when no placeholder", () => {
    const r = renderPathAndParams("/campaigns", { skip: 0, limit: 25 });
    expect(r.path).toBe("/campaigns");
    expect(r.params).toEqual({ skip: 0, limit: 25 });
  });

  it("URL-encodes path placeholder values (P-Sec: prevents path traversal/injection)", () => {
    const r = renderPathAndParams("/things/{id}", { id: "a/b" });
    expect(r.path).toBe("/things/a%2Fb");
  });

  it("throws on undefined/null required placeholder (P-Req)", () => {
    expect(() =>
      renderPathAndParams("/campaigns/{campaignId}/stats", {
        campaignId: undefined,
      }),
    ).toThrow("Missing required path parameter: campaignId");
    expect(() =>
      renderPathAndParams("/things/{id}", { id: null }),
    ).toThrow("Missing required path parameter: id");
  });
});

describe("buildProxyTool (GET)", () => {
  it("returns meta with description, inputSchema shape, and readOnlyHint annotation", () => {
    const built = buildProxyTool(sampleRow);
    expect(built.meta.description).toBe(sampleRow.description);
    expect("readOnlyHint" in built.meta.annotations).toBe(true);
    if ("readOnlyHint" in built.meta.annotations) {
      expect(built.meta.annotations.readOnlyHint).toBe(true);
    }
    expect(Object.keys(built.meta.inputSchema).sort()).toEqual(
      ["status", "skip", "limit"].sort(),
    );
  });

  it("uses config.label as annotations.title when present (P-A)", () => {
    const rowWithLabel: Pick<EndpointRow, "name" | "description" | "config"> = {
      name: "list_campaigns",
      description: "Long description that should NOT appear as the title.",
      config: {
        method: "GET",
        path: "/campaigns",
        title: "Campaigns",
        label: "List Campaigns",
        inputs: [],
      },
    };
    const built = buildProxyTool(rowWithLabel);
    expect(built.meta.annotations.title).toBe("List Campaigns");
  });

  it("falls back to description when config.label is absent (backward-compat)", () => {
    const rowWithoutLabel: Pick<
      EndpointRow,
      "name" | "description" | "config"
    > = {
      name: "list_campaigns",
      description: "Fallback description used as title.",
      config: {
        method: "GET",
        path: "/campaigns",
        title: "Campaigns",
        inputs: [],
      },
    };
    const built = buildProxyTool(rowWithoutLabel);
    expect(built.meta.annotations.title).toBe(
      "Fallback description used as title.",
    );
  });

  it("returns handleToolError shape when a required path placeholder is missing (P-Req)", async () => {
    const built = buildProxyTool(sampleRowWithPath);
    // Pass empty params — campaignId placeholder will be undefined.
    const res = await built.handler({}, { authInfo: { token: "k" } });

    expect("isError" in res && res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      "Error: Missing required path parameter: campaignId",
    );
    // callFlow should NOT have been called.
    expect(mockedCallFlow).not.toHaveBeenCalled();
  });

  it("handler calls callFlow with (apiKey, path, queryParams) and tracks mcp_tool_called", async () => {
    mockedCallFlow.mockResolvedValueOnce({ items: [] });

    const built = buildProxyTool(sampleRow);
    const res = await built.handler(
      { status: "RUNNING", skip: 0, limit: 25 },
      { authInfo: { token: "key-abc" } },
    );

    expect(mockedCallFlow).toHaveBeenCalledTimes(1);
    expect(mockedCallFlow).toHaveBeenCalledWith("key-abc", "/campaigns", {
      status: "RUNNING",
      skip: 0,
      limit: 25,
    });
    expect(mockedTrack).toHaveBeenCalledWith("key-abc", "mcp_tool_called", {
      toolName: "list_campaigns",
    });
    // Success shape: content with markdown header from config.title
    expect("isError" in res).toBe(false);
    expect(res.content[0].text).toContain("## Campaigns");
  });

  it("interpolates {name} placeholders and drops them from query params", async () => {
    mockedCallFlow.mockResolvedValueOnce({ ok: true });

    const built = buildProxyTool(sampleRowWithPath);
    await built.handler(
      { campaignId: "abc123" },
      { authInfo: { token: "key-xyz" } },
    );

    // No extra query params → callFlow called with `undefined` as 3rd arg.
    expect(mockedCallFlow).toHaveBeenCalledWith(
      "key-xyz",
      "/campaigns/abc123/stats",
      undefined,
    );
  });

  it("returns handleToolError shape on McpFlowError, preserving status code in the message", async () => {
    mockedCallFlow.mockRejectedValueOnce(
      new McpFlowError("Resource not found.", 404),
    );

    const built = buildProxyTool(sampleRow);
    const res = await built.handler(
      { status: "RUNNING" },
      { authInfo: { token: "key-err" } },
    );

    expect("isError" in res && res.isError).toBe(true);
    expect(res.content[0].text).toBe("Error (404): Resource not found.");
    // Tracking should NOT fire on error path (handler awaited callFlow before
    // emitting the event).
    expect(mockedTrack).not.toHaveBeenCalled();
  });

  it("returns generic error shape on non-McpFlowError throws", async () => {
    mockedCallFlow.mockRejectedValueOnce(new Error("boom"));

    const built = buildProxyTool(sampleRow);
    const res = await built.handler(
      { status: "RUNNING" },
      { authInfo: { token: "k" } },
    );

    expect("isError" in res && res.isError).toBe(true);
    expect(res.content[0].text).toBe("Error: boom");
  });
});

describe("buildProxyTool (POST)", () => {
  it("annotates POST with destructiveHint:true by default", () => {
    const built = buildProxyTool(sampleRowPostPref);
    expect("destructiveHint" in built.meta.annotations).toBe(true);
    if ("destructiveHint" in built.meta.annotations) {
      expect(built.meta.annotations.destructiveHint).toBe(true);
    }
  });

  it("respects destructive_hint:false override (create_audience baseline)", () => {
    const built = buildProxyTool(sampleRowPostAudience);
    expect("destructiveHint" in built.meta.annotations).toBe(true);
    if ("destructiveHint" in built.meta.annotations) {
      expect(built.meta.annotations.destructiveHint).toBe(false);
    }
  });

  it("POST handler calls callFlow with body + method:POST + tracking override", async () => {
    mockedCallFlow.mockResolvedValueOnce({ ok: true });

    const built = buildProxyTool(sampleRowPostPref);
    await built.handler(
      {
        identityId: "id-123",
        category: "tone",
        key: "voice",
        value: "casual",
        channel: "linkedin",
      },
      { authInfo: { token: "key-post" } },
    );

    // identityId was the path placeholder → removed from body.
    expect(mockedCallFlow).toHaveBeenCalledTimes(1);
    expect(mockedCallFlow).toHaveBeenCalledWith(
      "key-post",
      "/identities/id-123/preferences",
      {
        category: "tone",
        key: "voice",
        value: "casual",
        channel: "linkedin",
      },
      { method: "POST" },
    );
    // tracking event override applied.
    expect(mockedTrack).toHaveBeenCalledWith(
      "key-post",
      "mcp_preference_saved",
      { toolName: "save_identity_preference" },
    );
  });

  it("POST handler routes body for non-templated path (create_audience)", async () => {
    mockedCallFlow.mockResolvedValueOnce({ audienceId: "aud-1" });

    const built = buildProxyTool(sampleRowPostAudience);
    await built.handler(
      {
        audience: "Q3 SDRs",
        linkedinUrl: "https://www.linkedin.com/search/results/people",
        identityId: "id-abc",
        linkedinPostCategory: "like",
        excludeContactedLeads: true,
        autoImport: false,
      },
      { authInfo: { token: "k" } },
    );

    expect(mockedCallFlow).toHaveBeenCalledWith(
      "k",
      "/audiences",
      {
        audience: "Q3 SDRs",
        linkedinUrl: "https://www.linkedin.com/search/results/people",
        identityId: "id-abc",
        linkedinPostCategory: "like",
        excludeContactedLeads: true,
        autoImport: false,
      },
      { method: "POST" },
    );
    // No tracking_event override on this row → default mcp_tool_called.
    expect(mockedTrack).toHaveBeenCalledWith("k", "mcp_tool_called", {
      toolName: "create_audience_from_linkedin_url",
    });
  });

  it("create_audience inputSchema enforces regex + enum + min/max", () => {
    const built = buildProxyTool(sampleRowPostAudience);
    const schema = z.object(built.meta.inputSchema);

    // Bad URL: regex fail → custom message preserved.
    const bad = schema.safeParse({
      audience: "ok",
      linkedinUrl: "https://example.com/",
      identityId: "id-1",
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const urlIssue = bad.error.issues.find((i) =>
        i.path.includes("linkedinUrl"),
      );
      expect(urlIssue?.message).toBe(
        "A valid LinkedIn URL is required (must start with https://www.linkedin.com/)",
      );
    }

    // Bad enum.
    const badEnum = schema.safeParse({
      audience: "ok",
      linkedinUrl: "https://www.linkedin.com/foo",
      identityId: "id-1",
      linkedinPostCategory: "share",
    });
    expect(badEnum.success).toBe(false);

    // audience too long.
    const badLen = schema.safeParse({
      audience: "a".repeat(101),
      linkedinUrl: "https://www.linkedin.com/foo",
      identityId: "id-1",
    });
    expect(badLen.success).toBe(false);

    // Happy path.
    const ok = schema.safeParse({
      audience: "Q3 SDRs",
      linkedinUrl: "https://www.linkedin.com/foo",
      identityId: "id-1",
      linkedinPostCategory: "comment",
    });
    expect(ok.success).toBe(true);
  });
});
