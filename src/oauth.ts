import crypto from "crypto";
import express from "express";
import axios from "axios";
import { getApiUrl } from "./requestContext";

const router = express.Router();

interface AuthCodeEntry {
  clientId: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

// In-memory store: code → { clientId (email), PKCE data, expiresAt }
const authCodes = new Map<string, AuthCodeEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes.entries()) {
    if (data.expiresAt < now) authCodes.delete(code);
  }
}, 60_000);

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === "S256") {
    const hash = crypto.createHash("sha256").update(verifier).digest("base64url");
    return hash === challenge;
  }
  return verifier === challenge; // plain
}

async function validateApiKey(apiKey: string): Promise<boolean> {
  const url = `${getApiUrl()}/flow/members`;
  try {
    const response = await axios.head(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 5_000,
      validateStatus: () => true,
    });
    console.error(`[OAuth] HEAD ${url} → ${response.status}`);
    return response.status < 400;
  } catch (err) {
    console.error(`[OAuth] /flow/members request failed:`, err);
    return false;
  }
}

const getBase = () =>
  process.env.MCP_BASE_URL || "https://mcpapp.lagrowthmachine.com";

// OAuth 2.0 Protected Resource Metadata (RFC 9728)
router.get("/.well-known/oauth-protected-resource", (_req, res) => {
  const base = getBase();
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
  });
});

// OAuth 2.0 Authorization Server Metadata (RFC 8414)
router.get("/.well-known/oauth-authorization-server", (_req, res) => {
  const base = getBase();
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"],
  });
});

// GET /authorize
router.get("/authorize", (req, res) => {
  const {
    redirect_uri,
    state,
    client_id,
    code_challenge,
    code_challenge_method,
  } = req.query as Record<string, string>;

  console.error(`[OAuth] /authorize client_id=${client_id} code_challenge_method=${code_challenge_method}`);

  if (!redirect_uri || !client_id) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "redirect_uri and client_id are required",
    });
    return;
  }

  const code = crypto.randomBytes(32).toString("hex");
  authCodes.set(code, {
    clientId: client_id,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method || "S256",
    expiresAt: Date.now() + 60_000,
  });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  console.error(`[OAuth] /authorize → redirect to ${url.origin}${url.pathname}`);
  res.redirect(url.toString());
});

// POST /token
router.post("/token", async (req, res) => {
  const { client_id, client_secret, code, grant_type, code_verifier } =
    req.body as Record<string, string>;

  console.error(`[OAuth] /token grant_type=${grant_type} client_id=${client_id} has_secret=${!!client_secret} has_verifier=${!!code_verifier} has_code=${!!code}`);

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  if (!code || !client_id) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "code and client_id are required",
    });
    return;
  }

  const stored = authCodes.get(code);
  authCodes.delete(code);

  if (!stored) {
    console.error(`[OAuth] /token invalid_grant: code not found`);
    res.status(400).json({ error: "invalid_grant", error_description: "code not found or already used" });
    return;
  }
  if (stored.expiresAt < Date.now()) {
    console.error(`[OAuth] /token invalid_grant: code expired`);
    res.status(400).json({ error: "invalid_grant", error_description: "code expired" });
    return;
  }
  if (stored.clientId !== client_id) {
    console.error(`[OAuth] /token invalid_grant: client_id mismatch stored=${stored.clientId} received=${client_id}`);
    res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
    return;
  }

  if (stored.codeChallenge) {
    if (!code_verifier) {
      console.error(`[OAuth] /token missing code_verifier`);
      res.status(400).json({ error: "invalid_request", error_description: "code_verifier is required" });
      return;
    }
    if (!verifyPkce(code_verifier, stored.codeChallenge, stored.codeChallengeMethod || "S256")) {
      console.error(`[OAuth] /token PKCE mismatch`);
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch" });
      return;
    }
    console.error(`[OAuth] /token PKCE ok`);
  }

  if (!client_secret) {
    console.error(`[OAuth] /token missing client_secret`);
    res.status(401).json({ error: "invalid_client", error_description: "client_secret (LGM API key) is required" });
    return;
  }

  const valid = await validateApiKey(client_secret);
  if (!valid) {
    console.error(`[OAuth] /token invalid API key for client_id=${client_id}`);
    res.status(401).json({ error: "invalid_client", error_description: "invalid API key" });
    return;
  }

  console.error(`[OAuth] /token success for ${client_id}`);
  res.json({
    access_token: client_secret,
    token_type: "Bearer",
    expires_in: 31_536_000,
  });
});

export default router;
