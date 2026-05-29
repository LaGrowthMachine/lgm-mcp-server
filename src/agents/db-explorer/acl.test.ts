import { ACL_MODE, assertLgmStaff, isLgmStaffEmail } from "./acl";

describe("acl — POC passthrough", () => {
  it("ACL_MODE flags the stub state", () => {
    expect(ACL_MODE).toBe("poc-passthrough");
  });

  it("assertLgmStaff lets any apiKey through and returns a placeholder identity", async () => {
    const r = await assertLgmStaff("any-apikey");
    expect(r.email).toMatch(/poc/);
  });

  it("assertLgmStaff does not throw on empty apiKey (passthrough)", async () => {
    await expect(assertLgmStaff("")).resolves.toBeDefined();
  });
});

describe("isLgmStaffEmail (kept for the eventual real ACL)", () => {
  it.each([
    "alexis@lagrowthmachine.com",
    "first.last+tag-2_x@lagrowthmachine.com",
    "  Alexis@LaGrowthMachine.com  ",
  ])("accepts %s", (email) => {
    expect(isLgmStaffEmail(email)).toBe(true);
  });

  it.each([
    "user@gmail.com",
    "user@lagrowthmachine.co",
    "user@evil.lagrowthmachine.com.fake.com",
    "аdmin@lagrowthmachine.com", // cyrillic а
  ])("rejects %s", (email) => {
    expect(isLgmStaffEmail(email)).toBe(false);
  });
});
