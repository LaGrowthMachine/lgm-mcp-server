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

async function getApiKeyOwnerEmail(apiKey: string): Promise<string | null> {
  try {
    const response = await axios.get(`${getApiUrl()}/usersv1/`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 5_000,
      validateStatus: () => true,
    });
    const email = response.data?.user?.email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

const getBase = () =>
  process.env.MCP_BASE_URL || "https://mcpapp.lagrowthmachine.com";

// OAuth 2.0 Protected Resource Metadata (RFC 9728)
// Claude.ai discovers this from the WWW-Authenticate header on 401 responses
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
// client_id = user email, stores PKCE challenge if provided
// Immediately redirects with a one-time code (60s TTL)
router.get("/authorize", (req, res) => {
  const {
    redirect_uri,
    state,
    client_id,
    code_challenge,
    code_challenge_method,
  } = req.query as Record<string, string>;

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
  res.redirect(url.toString());
});

// POST /token
// client_id     = user email (must match the one used in /authorize)
// client_secret = LGM API key → validated against LGM API
// code_verifier = PKCE verifier (required if code_challenge was sent)
// Returns access_token = API key (Bearer token reused as-is in /mcp)
router.post("/token", async (req, res) => {
  const { client_id, client_secret, code, grant_type, code_verifier } =
    req.body as Record<string, string>;

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
  authCodes.delete(code); // single-use

  if (!stored || stored.expiresAt < Date.now() || stored.clientId !== client_id) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  // Verify PKCE if a challenge was stored during /authorize
  if (stored.codeChallenge) {
    if (!code_verifier) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "code_verifier is required",
      });
      return;
    }
    if (!verifyPkce(code_verifier, stored.codeChallenge, stored.codeChallengeMethod || "S256")) {
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch" });
      return;
    }
  }

  if (!client_secret) {
    res.status(401).json({
      error: "invalid_client",
      error_description: "client_secret (LGM API key) is required",
    });
    return;
  }

  const ownerEmail = await getApiKeyOwnerEmail(client_secret);
  if (!ownerEmail) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (ownerEmail.toLowerCase() !== client_id.toLowerCase()) {
    res.status(401).json({
      error: "invalid_client",
      error_description: "client_id does not match the API key owner",
    });
    return;
  }

  res.json({
    access_token: client_secret, // API key used directly as Bearer token in /mcp
    token_type: "Bearer",
    expires_in: 31_536_000,
  });
});

export default router;
