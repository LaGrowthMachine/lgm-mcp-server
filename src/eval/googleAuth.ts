// Google OAuth login layer for the /eval interface.
//
// Stacks on top of the existing Heroku Basic Auth (dual-gate): Basic Auth
// is the outer network gate (shared password, Heroku-only), Google OAuth
// identifies individual @lagrowthmachine.com users with traceability.
//
// Stateless: cookie carries the signed session payload. Heroku multi-dyno
// safe (no in-memory session store, cf. the note in src/oauth.ts).
//
// Activation mirrors `evalBasicAuth`: on by default on Heroku (DYNO env),
// opt-in locally with EVAL_GOOGLE_AUTH=1.

import crypto from "node:crypto";
import express from "express";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ALLOWED_HD = "lagrowthmachine.com";

// LGM-wide convention (cf. lgm-admin-retool, lgm-data, lgm-apis):
// every internal Google OAuth flow uses webhook.site as the registered
// redirect URI on the shared Google Client, and embeds the *real* per-app
// callback URL in `state.r` (base64). webhook.site's Custom Action 302s
// the browser to state.r so each app gets its own callback without the
// OAuth Client owner having to register N redirect URIs.
const LGM_DISPATCHER_URL = "https://webhook.site/browser-redirect";

const SESSION_COOKIE = "__eval_session";
const STATE_COOKIE = "__eval_state";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const SESSION_SLIDING_MS = 24 * 3600 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

const AUTH_LOGIN_PATH = "/auth/login";
const AUTH_CALLBACK_PATH = "/auth/callback";
const AUTH_LOGOUT_PATH = "/auth/logout";

type SessionPayload = {
  email: string;
  name: string;
  iat: number;
  exp: number;
};

type EnvKey =
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "EVAL_SESSION_SECRET";

const readEnv = (key: EnvKey): string => {
  const v = process.env[key];
  if (!v) throw new Error(`missing env ${key}`);
  return v;
};

const isAuthEnabled = (): boolean =>
  !!process.env.DYNO || process.env.EVAL_GOOGLE_AUTH === "1";

const isSecureReq = (req: express.Request): boolean => {
  if (req.secure) return true;
  const xfp = req.headers["x-forwarded-proto"];
  if (typeof xfp === "string") return xfp.split(",")[0]?.trim() === "https";
  return false;
};

// What we send to Google as `redirect_uri`. MUST match an Authorized URI on
// the OAuth Client. Default = LGM convention (webhook.site dispatcher),
// overridable via env for a self-hosted setup.
const getGoogleRedirectUri = (): string =>
  process.env.EVAL_GOOGLE_REDIRECT_URI || LGM_DISPATCHER_URL;

// The per-app callback URL we want webhook.site to dispatch to. Embedded
// in `state.r` so the LGM dispatcher knows where to send the browser
// after Google. Prod = MCP_BASE_URL; dev = derived from the request so
// localhost just works without extra config.
const getRealCallbackUrl = (req: express.Request): string => {
  const envBase = process.env.MCP_BASE_URL;
  if (envBase) return `${envBase.replace(/\/$/, "")}/eval${AUTH_CALLBACK_PATH}`;
  const proto = isSecureReq(req) ? "https" : "http";
  const host = req.get("host") ?? "localhost";
  return `${proto}://${host}/eval${AUTH_CALLBACK_PATH}`;
};

// ---------------- HMAC sign / verify ----------------

const hmac = (data: string, secret: string): string =>
  crypto.createHmac("sha256", secret).update(data).digest("base64url");

const sign = (value: string, secret: string): string => {
  const payload = Buffer.from(value, "utf8").toString("base64url");
  return `${payload}.${hmac(payload, secret)}`;
};

const verify = (signed: string, secret: string): string | null => {
  const idx = signed.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = hmac(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return Buffer.from(payload, "base64url").toString("utf8");
};

// ---------------- Session ----------------

const buildSession = (email: string, name: string): SessionPayload => {
  const now = Date.now();
  return { email, name, iat: now, exp: now + SESSION_TTL_MS };
};

const signSession = (s: SessionPayload, secret: string): string =>
  sign(JSON.stringify(s), secret);

const verifySession = (
  signed: string,
  secret: string,
): SessionPayload | null => {
  const raw = verify(signed, secret);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as SessionPayload;
    if (typeof p.email !== "string" || typeof p.name !== "string") return null;
    if (typeof p.iat !== "number" || typeof p.exp !== "number") return null;
    if (Date.now() > p.exp) return null;
    return p;
  } catch {
    return null;
  }
};

// ---------------- State (CSRF nonce) ----------------

type StatePayload = { n: string; r: string; e: number };

const signState = (nonce: string, returnTo: string, secret: string): string => {
  const payload: StatePayload = {
    n: nonce,
    r: returnTo,
    e: Date.now() + STATE_TTL_MS,
  };
  return sign(JSON.stringify(payload), secret);
};

const verifyState = (
  signed: string,
  expectedNonce: string,
  secret: string,
): { returnTo: string } | null => {
  const raw = verify(signed, secret);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as StatePayload;
    if (p.n !== expectedNonce) return null;
    if (Date.now() > p.e) return null;
    return { returnTo: p.r };
  } catch {
    return null;
  }
};

// ---------------- Cookie helpers ----------------

const parseCookies = (header: string | undefined): Record<string, string> => {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
};

const buildCookie = (
  name: string,
  value: string,
  opts: { maxAgeSec: number; path: string; secure: boolean },
): string => {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${opts.maxAgeSec}`,
    `Path=${opts.path}`,
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
};

const clearCookie = (name: string, path: string, secure: boolean): string => {
  const parts = [
    `${name}=`,
    "Max-Age=0",
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
};

// ---------------- returnTo whitelist (anti open-redirect) ----------------

// Strict whitelist: must be exactly "/eval", or under "/eval/", or "/eval?…".
// "/eval" is the only acceptable prefix — "/evaluation-evil" must NOT pass.
// Length capped so an attacker can't blow past the 4 KB cookie limit by
// stuffing a giant returnTo into the signed state.
const MAX_RETURN_TO = 256;
const safeReturnTo = (raw: unknown): string => {
  if (typeof raw !== "string") return "/eval/";
  if (raw.length > MAX_RETURN_TO) return "/eval/";
  if (raw.startsWith("//")) return "/eval/";
  if (/[\r\n]/.test(raw)) return "/eval/";
  if (raw === "/eval") return "/eval";
  if (raw.startsWith("/eval/") || raw.startsWith("/eval?")) return raw;
  return "/eval/";
};

// ---------------- Email / hd check ----------------

const normalizeEmail = (e: string): string =>
  e.toLowerCase().trim().normalize("NFKC");

const isLgmDomain = (email: string, hd?: string): boolean => {
  if (hd !== undefined && hd !== ALLOWED_HD) return false;
  const e = normalizeEmail(email);
  const idx = e.lastIndexOf("@");
  if (idx < 0) return false;
  return e.slice(idx + 1) === ALLOWED_HD;
};

// ---------------- JWT decode (no signature verify — TLS direct to Google) ----------------

type IdTokenClaims = {
  email?: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;
};

const decodeIdToken = (jwt: string): IdTokenClaims | null => {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
    return JSON.parse(payload) as IdTokenClaims;
  } catch {
    return null;
  }
};

// ---------------- Google OAuth network calls ----------------

// LGM-convention state: JSON `{ r: b64(realCallback), n: nonce }`. The
// dispatcher (webhook.site) reads `r` to know where to forward. We read
// `n` and verify against our HMAC-signed __eval_state cookie for CSRF.
const buildStateParam = (realCallback: string, nonce: string): string =>
  JSON.stringify({
    r: Buffer.from(realCallback, "utf8").toString("base64url"),
    n: nonce,
  });

type ParsedState = { r: string; n: string };
const parseStateParam = (raw: string): ParsedState | null => {
  try {
    const obj = JSON.parse(raw) as { r?: unknown; n?: unknown };
    if (typeof obj.r !== "string" || typeof obj.n !== "string") return null;
    return { r: obj.r, n: obj.n };
  } catch {
    return null;
  }
};

const buildAuthUrl = (req: express.Request, nonce: string): string => {
  const params = new URLSearchParams({
    client_id: readEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: getGoogleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    hd: ALLOWED_HD,
    state: buildStateParam(getRealCallbackUrl(req), nonce),
    access_type: "online",
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
};

const exchangeCode = async (code: string): Promise<{ id_token: string }> => {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: readEnv("GOOGLE_CLIENT_ID"),
      client_secret: readEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: getGoogleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `token exchange failed status=${res.status} body=${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as { id_token: string };
};

// ---------------- HTML helpers (error pages) ----------------

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const escapeLog = (s: string): string => s.replace(/[\r\n"]/g, " ");

const baseStyle =
  "body{font-family:Inter,system-ui,sans-serif;background:#231932;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{max-width:480px;padding:32px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px}h1{margin:0 0 12px;font-size:20px}p{color:rgba(255,255,255,.7);line-height:1.5}a{color:#3CC878}code{background:rgba(255,255,255,.06);padding:1px 6px;border-radius:4px}";

const authErrorHtml = (title: string, detail: string): string =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${baseStyle}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${detail}</p></main></body></html>`;

const rejectedHtml = (email: string): string =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Accès refusé</title><style>${baseStyle}</style></head><body><main><h1>Accès réservé à l'équipe LGM</h1><p>Le compte <strong>${escapeHtml(email)}</strong> n'est pas autorisé.</p><p>Connectez-vous avec un compte <code>@lagrowthmachine.com</code>.</p><p><a href="/eval/auth/login">Réessayer avec un autre compte</a></p></main></body></html>`;

// ---------------- Express handlers ----------------

const isApiRequest = (req: express.Request): boolean =>
  req.baseUrl === "/api/eval";

type Authed = express.Request & { user?: SessionPayload };

const loginHandler: express.RequestHandler = (req, res) => {
  // Dev short-circuit: when auth is disabled there's nothing to log into.
  // Bounce back to the requested page rather than 500-ing on missing env.
  if (!isAuthEnabled()) {
    res.redirect(302, safeReturnTo(req.query.returnTo));
    return;
  }
  try {
    const secret = readEnv("EVAL_SESSION_SECRET");
    const returnTo = safeReturnTo(req.query.returnTo);
    const nonce = crypto.randomBytes(32).toString("hex");
    const stateValue = signState(nonce, returnTo, secret);
    const url = buildAuthUrl(req, nonce);

    res.append(
      "Set-Cookie",
      buildCookie(STATE_COOKIE, stateValue, {
        maxAgeSec: Math.floor(STATE_TTL_MS / 1000),
        path: "/eval/auth",
        secure: isSecureReq(req),
      }),
    );
    res.redirect(302, url);
  } catch (e) {
    console.error(
      `[EvalAuth] login_error msg=${escapeLog((e as Error).message)}`,
    );
    res
      .status(500)
      .type("html")
      .send(authErrorHtml("Auth non configurée", escapeHtml((e as Error).message)));
  }
};

const callbackHandler: express.RequestHandler = async (req, res) => {
  try {
    const secret = readEnv("EVAL_SESSION_SECRET");
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const stateRaw =
      typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !stateRaw) {
      res
        .status(400)
        .type("html")
        .send(authErrorHtml("Requête invalide", "code ou state manquant"));
      return;
    }

    // State arrives as JSON (LGM dispatcher convention). Extract the nonce
    // from it; the dispatcher already used the `r` field to route us here.
    const parsedState = parseStateParam(stateRaw);
    if (!parsedState) {
      console.error("[EvalAuth] state_parse_failed");
      res
        .status(400)
        .type("html")
        .send(authErrorHtml("État OAuth invalide", "state mal formé"));
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const stateCookie = cookies[STATE_COOKIE];
    if (!stateCookie) {
      console.error("[EvalAuth] state_missing");
      res
        .status(400)
        .type("html")
        .send(
          authErrorHtml(
            "Session de login expirée",
            `<a href="/eval/auth/login">Relancer le login</a>`,
          ),
        );
      return;
    }
    const checked = verifyState(stateCookie, parsedState.n, secret);
    if (!checked) {
      console.error("[EvalAuth] state_mismatch");
      res
        .append(
          "Set-Cookie",
          clearCookie(STATE_COOKIE, "/eval/auth", isSecureReq(req)),
        )
        .status(400)
        .type("html")
        .send(
          authErrorHtml(
            "Session de login expirée",
            `<a href="/eval/auth/login">Relancer le login</a>`,
          ),
        );
      return;
    }

    const tok = await exchangeCode(code);
    const claims = decodeIdToken(tok.id_token);
    if (!claims || !claims.email) {
      console.error("[EvalAuth] id_token_invalid");
      res
        .status(400)
        .type("html")
        .send(authErrorHtml("Token Google invalide", ""));
      return;
    }
    if (claims.email_verified !== true) {
      console.error("[EvalAuth] email_not_verified");
      res.status(403).type("html").send(rejectedHtml(claims.email));
      return;
    }
    if (!isLgmDomain(claims.email, claims.hd)) {
      const domain = claims.email.split("@")[1] ?? "?";
      console.error(`[EvalAuth] rejected domain=*@${escapeLog(domain)}`);
      res.status(403).type("html").send(rejectedHtml(claims.email));
      return;
    }

    const session = buildSession(
      normalizeEmail(claims.email),
      claims.name ?? "",
    );
    const sessionValue = signSession(session, secret);
    console.error(
      `[EvalAuth] login_ok email=${escapeLog(session.email)}`,
    );
    res
      .append(
        "Set-Cookie",
        clearCookie(STATE_COOKIE, "/eval/auth", isSecureReq(req)),
      )
      .append(
        "Set-Cookie",
        buildCookie(SESSION_COOKIE, sessionValue, {
          maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
          path: "/",
          secure: isSecureReq(req),
        }),
      )
      .redirect(302, checked.returnTo);
  } catch (e) {
    console.error(
      `[EvalAuth] callback_error msg=${escapeLog((e as Error).message)}`,
    );
    res
      .status(500)
      .type("html")
      .send(
        authErrorHtml(
          "Erreur d'authentification",
          escapeHtml((e as Error).message),
        ),
      );
  }
};

const logoutHandler: express.RequestHandler = (req, res) => {
  // Dev short-circuit: no session to clear, just bounce home.
  if (!isAuthEnabled()) {
    res.redirect(302, "/eval/");
    return;
  }
  const secure = isSecureReq(req);
  res
    .append("Set-Cookie", clearCookie(SESSION_COOKIE, "/", secure))
    .append("Set-Cookie", clearCookie(STATE_COOKIE, "/eval/auth", secure))
    .redirect(302, "/eval/auth/login");
};

const meHandler: express.RequestHandler = (req, res) => {
  // In dev (auth disabled), no real user is logged in — return 401 with a
  // dev-mode marker so the SPA can hide the user badge entirely rather than
  // showing a fake identity with a no-op logout link.
  if (!isAuthEnabled()) {
    res.status(401).json({ error: "auth_disabled" });
    return;
  }
  const u = (req as Authed).user;
  if (!u) {
    res
      .status(401)
      .json({ error: "auth_required", loginUrl: "/eval/auth/login" });
    return;
  }
  res.json({ email: u.email, name: u.name });
};

const middleware = (): express.RequestHandler => {
  return (req, res, next) => {
    if (!isAuthEnabled()) {
      next();
      return;
    }

    // Bypass the auth endpoints themselves. req.path is relative to the
    // mount point, so /eval/auth/login arrives as /auth/login here. We
    // restrict the bypass to the /eval mount (not /api/eval) so a future
    // route under /api/eval/auth/* doesn't silently inherit no-auth.
    // Normalize trailing slash because the webhook.site dispatcher 301s
    // with a trailing slash appended (`/eval/auth/callback/?code=...`).
    const p = req.path.endsWith("/") && req.path !== "/"
      ? req.path.slice(0, -1)
      : req.path;
    if (
      req.baseUrl === "/eval" &&
      (p === AUTH_LOGIN_PATH ||
        p === AUTH_CALLBACK_PATH ||
        p === AUTH_LOGOUT_PATH)
    ) {
      next();
      return;
    }

    let secret: string;
    try {
      secret = readEnv("EVAL_SESSION_SECRET");
    } catch (e) {
      console.error(
        `[EvalAuth] missing_env msg=${escapeLog((e as Error).message)}`,
      );
      if (isApiRequest(req)) {
        res.status(500).json({ error: "auth_misconfigured" });
        return;
      }
      res
        .status(500)
        .type("html")
        .send(
          authErrorHtml(
            "Auth non configurée",
            escapeHtml((e as Error).message),
          ),
        );
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[SESSION_COOKIE];
    const session = raw ? verifySession(raw, secret) : null;

    if (!session) {
      if (raw) {
        res.append(
          "Set-Cookie",
          clearCookie(SESSION_COOKIE, "/", isSecureReq(req)),
        );
        console.error("[EvalAuth] session_invalid clearing");
      }
      if (isApiRequest(req)) {
        res
          .status(401)
          .json({ error: "auth_required", loginUrl: "/eval/auth/login" });
        return;
      }
      const returnTo = encodeURIComponent(req.originalUrl);
      res.redirect(302, `/eval/auth/login?returnTo=${returnTo}`);
      return;
    }

    (req as Authed).user = session;

    // Sliding refresh — re-sign if older than SESSION_SLIDING_MS.
    if (Date.now() - session.iat > SESSION_SLIDING_MS) {
      const refreshed = buildSession(session.email, session.name);
      res.append(
        "Set-Cookie",
        buildCookie(SESSION_COOKIE, signSession(refreshed, secret), {
          maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
          path: "/",
          secure: isSecureReq(req),
        }),
      );
    }

    next();
  };
};

// ---------------- Public API ----------------

export const googleAuth = {
  middleware,
  loginHandler,
  callbackHandler,
  logoutHandler,
  meHandler,
};

// Test-only surface — internal helpers exposed for unit testing. Not part
// of the runtime contract; do not import from production code.
export const __test = {
  signSession,
  verifySession,
  signState,
  verifyState,
  decodeIdToken,
  isLgmDomain,
  safeReturnTo,
  buildSession,
  parseCookies,
};
