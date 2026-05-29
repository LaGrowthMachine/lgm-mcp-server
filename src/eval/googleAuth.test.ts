import { __test } from "./googleAuth";

const {
  signSession,
  verifySession,
  signState,
  verifyState,
  decodeIdToken,
  isLgmDomain,
  safeReturnTo,
  buildSession,
  parseCookies,
} = __test;

const SECRET = "unit-test-secret-do-not-leak";

describe("session sign/verify", () => {
  it("round-trips a valid session", () => {
    const s = buildSession("alexis@lagrowthmachine.com", "Alexis");
    const cookie = signSession(s, SECRET);
    expect(verifySession(cookie, SECRET)).toEqual(s);
  });

  it("rejects a tampered payload", () => {
    const s = buildSession("alexis@lagrowthmachine.com", "Alexis");
    const cookie = signSession(s, SECRET);
    const [payload, sig] = cookie.split(".");
    // Re-encode a different email with the original signature.
    const evil = Buffer.from(
      JSON.stringify({ ...s, email: "evil@lagrowthmachine.com" }),
      "utf8",
    ).toString("base64url");
    expect(verifySession(`${evil}.${sig}`, SECRET)).toBeNull();
    expect(payload).toBeDefined();
  });

  it("rejects a flipped bit in the signature", () => {
    const s = buildSession("alexis@lagrowthmachine.com", "Alexis");
    const cookie = signSession(s, SECRET);
    const last = cookie.slice(-1);
    const flipped = cookie.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(verifySession(flipped, SECRET)).toBeNull();
  });

  it("rejects when secret differs", () => {
    const s = buildSession("alexis@lagrowthmachine.com", "Alexis");
    const cookie = signSession(s, SECRET);
    expect(verifySession(cookie, "other-secret")).toBeNull();
  });

  it("rejects an already-expired session", () => {
    const expired = {
      email: "alexis@lagrowthmachine.com",
      name: "Alexis",
      iat: 1,
      exp: 2,
    };
    const cookie = signSession(expired, SECRET);
    expect(verifySession(cookie, SECRET)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifySession("garbage", SECRET)).toBeNull();
    expect(verifySession("nodot", SECRET)).toBeNull();
    expect(verifySession(".onlysig", SECRET)).toBeNull();
  });
});

describe("state sign/verify (CSRF nonce)", () => {
  it("round-trips when nonce matches", () => {
    const cookie = signState("nonce-abc", "/eval/foo", SECRET);
    expect(verifyState(cookie, "nonce-abc", SECRET)).toEqual({
      returnTo: "/eval/foo",
    });
  });

  it("rejects when nonce differs", () => {
    const cookie = signState("nonce-abc", "/eval/foo", SECRET);
    expect(verifyState(cookie, "nonce-zzz", SECRET)).toBeNull();
  });

  it("rejects after TTL expiry", () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const cookie = signState("nonce-abc", "/eval/foo", SECRET);
      jest.setSystemTime(new Date("2026-01-01T00:11:00Z")); // > 10 min
      expect(verifyState(cookie, "nonce-abc", SECRET)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects under a different secret", () => {
    const cookie = signState("nonce-abc", "/eval/foo", SECRET);
    expect(verifyState(cookie, "nonce-abc", "other")).toBeNull();
  });
});

describe("isLgmDomain", () => {
  it("accepts @lagrowthmachine.com with matching hd", () => {
    expect(
      isLgmDomain("alexis@lagrowthmachine.com", "lagrowthmachine.com"),
    ).toBe(true);
  });
  it("accepts @lagrowthmachine.com when hd is undefined", () => {
    expect(isLgmDomain("alexis@lagrowthmachine.com", undefined)).toBe(true);
  });
  it("rejects @gmail.com regardless of hd", () => {
    expect(isLgmDomain("alex@gmail.com", undefined)).toBe(false);
    expect(isLgmDomain("alex@gmail.com", "lagrowthmachine.com")).toBe(false);
  });
  it("rejects when hd is a different workspace", () => {
    expect(isLgmDomain("alexis@lagrowthmachine.com", "evil.com")).toBe(false);
  });
  it("normalizes case and whitespace", () => {
    expect(
      isLgmDomain(" ALEXIS@LAGROWTHMACHINE.COM ", "lagrowthmachine.com"),
    ).toBe(true);
  });
  it("rejects emails without an @", () => {
    expect(isLgmDomain("noatsign", "lagrowthmachine.com")).toBe(false);
  });
});

describe("safeReturnTo (anti open-redirect)", () => {
  it("accepts /eval/* paths", () => {
    expect(safeReturnTo("/eval/")).toBe("/eval/");
    expect(safeReturnTo("/eval/batches/123")).toBe("/eval/batches/123");
    expect(safeReturnTo("/eval/conv?id=abc")).toBe("/eval/conv?id=abc");
  });
  it("rejects external absolute URLs", () => {
    expect(safeReturnTo("https://evil.com/phish")).toBe("/eval/");
  });
  it("rejects /eval-prefixed paths that aren't /eval/", () => {
    // /evaluation-evil starts with /eval but isn't under /eval/
    expect(safeReturnTo("/evaluation-evil")).toBe("/eval/");
    expect(safeReturnTo("/eval-other")).toBe("/eval/");
  });
  it("accepts /eval with a query string", () => {
    expect(safeReturnTo("/eval?ok=1")).toBe("/eval?ok=1");
  });
  it("rejects returnTo longer than 256 chars", () => {
    const long = "/eval/" + "x".repeat(300);
    expect(safeReturnTo(long)).toBe("/eval/");
  });
  it("rejects protocol-relative URLs", () => {
    expect(safeReturnTo("//evil.com")).toBe("/eval/");
  });
  it("rejects non-eval paths", () => {
    expect(safeReturnTo("/mcp")).toBe("/eval/");
    expect(safeReturnTo("/health")).toBe("/eval/");
  });
  it("rejects CRLF (header-injection guard)", () => {
    expect(safeReturnTo("/eval/foo\r\nSet-Cookie: x=y")).toBe("/eval/");
  });
  it("defaults to /eval/ on non-string", () => {
    expect(safeReturnTo(undefined)).toBe("/eval/");
    expect(safeReturnTo(42)).toBe("/eval/");
    expect(safeReturnTo(null)).toBe("/eval/");
  });
});

describe("decodeIdToken (no signature verification)", () => {
  const encodeJwt = (claims: Record<string, unknown>): string => {
    const h = Buffer.from(JSON.stringify({ alg: "RS256" })).toString(
      "base64url",
    );
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${h}.${p}.signature-placeholder`;
  };

  it("decodes the payload of a 3-segment JWT", () => {
    const jwt = encodeJwt({
      email: "alexis@lagrowthmachine.com",
      email_verified: true,
      hd: "lagrowthmachine.com",
      name: "Alexis",
    });
    expect(decodeIdToken(jwt)).toEqual({
      email: "alexis@lagrowthmachine.com",
      email_verified: true,
      hd: "lagrowthmachine.com",
      name: "Alexis",
    });
  });
  it("returns null on a malformed JWT", () => {
    expect(decodeIdToken("only.two")).toBeNull();
    expect(decodeIdToken("no.proper.encoding-here")).toBeNull();
  });
});

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    expect(parseCookies("__eval_session=abc")).toEqual({
      __eval_session: "abc",
    });
  });
  it("parses multiple cookies separated by '; '", () => {
    expect(parseCookies("a=1; b=2; c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });
  it("URL-decodes values", () => {
    expect(parseCookies("k=hello%20world")).toEqual({ k: "hello world" });
  });
  it("returns empty for undefined / empty header", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });
  it("preserves '=' inside values (only first '=' splits)", () => {
    expect(parseCookies("payload=a.b.c")).toEqual({ payload: "a.b.c" });
  });
});

describe("buildSession", () => {
  it("sets iat to now and exp to now + 7d", () => {
    jest.useFakeTimers();
    try {
      const now = new Date("2026-05-25T12:00:00Z").getTime();
      jest.setSystemTime(now);
      const s = buildSession("alexis@lagrowthmachine.com", "Alexis");
      expect(s.iat).toBe(now);
      expect(s.exp).toBe(now + 7 * 24 * 3600 * 1000);
    } finally {
      jest.useRealTimers();
    }
  });
});
