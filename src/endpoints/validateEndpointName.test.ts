import {
  ENDPOINT_NAME_RE,
  proxyConfigSchema,
  validateEndpointName,
} from "./types";

// Spec V1c : règle de nommage `^[a-z][a-z0-9_]{0,63}$`. Garde identique
// côté serveur (POST/PUT) et côté front (form validator). Ce fichier
// verrouille les cas limites pour éviter une dérive silencieuse.

describe("validateEndpointName", () => {
  test("accepts simple snake_case", () => {
    expect(validateEndpointName("list_campaigns")).toBeNull();
    expect(validateEndpointName("a")).toBeNull();
    expect(validateEndpointName("a1")).toBeNull();
    expect(validateEndpointName("get_lead_logs")).toBeNull();
  });

  test("rejects empty string", () => {
    expect(validateEndpointName("")).not.toBeNull();
  });

  test("rejects names starting with digit / underscore", () => {
    expect(validateEndpointName("1invalid")).not.toBeNull();
    expect(validateEndpointName("_invalid")).not.toBeNull();
  });

  test("rejects uppercase letters", () => {
    expect(validateEndpointName("List_Campaigns")).not.toBeNull();
    expect(validateEndpointName("List Campaigns")).not.toBeNull();
  });

  test("rejects hyphens / spaces / special chars", () => {
    expect(validateEndpointName("list-campaigns")).not.toBeNull();
    expect(validateEndpointName("list campaigns")).not.toBeNull();
    expect(validateEndpointName("list.campaigns")).not.toBeNull();
    expect(validateEndpointName("list/campaigns")).not.toBeNull();
  });

  test("respects 64-character limit", () => {
    const exactly64 = "a" + "b".repeat(63);
    expect(exactly64.length).toBe(64);
    expect(validateEndpointName(exactly64)).toBeNull();
    const tooLong = "a" + "b".repeat(64);
    expect(tooLong.length).toBe(65);
    expect(validateEndpointName(tooLong)).not.toBeNull();
  });

  test("error message mentions snake_case and length", () => {
    const err = validateEndpointName("Bad Name");
    expect(err).toMatch(/snake_case/);
    expect(err).toMatch(/64/);
  });

  test("exported regex matches the validator", () => {
    expect(ENDPOINT_NAME_RE.test("list_campaigns")).toBe(true);
    expect(ENDPOINT_NAME_RE.test("BadName")).toBe(false);
  });
});

describe("proxyConfigSchema cross-validation (path ↔ inputs)", () => {
  test("accepts config when every {placeholder} matches an input name", () => {
    const result = proxyConfigSchema.safeParse({
      method: "GET",
      path: "/leads/{leadId}",
      inputs: [{ name: "leadId", kind: "string", describe: "id" }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects when a {placeholder} has no matching input", () => {
    const result = proxyConfigSchema.safeParse({
      method: "GET",
      path: "/leads/{leadId}",
      inputs: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0].message;
      expect(msg).toMatch(/leadId/);
      expect(result.error.issues[0].path).toEqual(["inputs"]);
    }
  });

  test("accepts a path with no placeholders even if inputs is empty", () => {
    const result = proxyConfigSchema.safeParse({
      method: "GET",
      path: "/campaigns",
      inputs: [],
    });
    expect(result.success).toBe(true);
  });

  test("rejects when `method` is missing", () => {
    const result = proxyConfigSchema.safeParse({
      path: "/campaigns",
      inputs: [],
    });
    expect(result.success).toBe(false);
  });
});
