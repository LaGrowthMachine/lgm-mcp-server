import crypto from "crypto";
import express from "express";
import axios from "axios";
import { getApiUrl } from "./requestContext";

const router = express.Router();

// In-memory store: code → { clientId (email), expiresAt }
const authCodes = new Map<string, { clientId: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes.entries()) {
    if (data.expiresAt < now) authCodes.delete(code);
  }
}, 60_000);

async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await axios.head(`${getApiUrl()}/flow/members`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 5_000,
      validateStatus: () => true,
    });
    return response.status < 400;
  } catch {
    return false;
  }
}

// OAuth 2.0 Authorization Server Metadata (RFC 8414)
router.get("/.well-known/oauth-authorization-server", (_req, res) => {
  const base =
    process.env.MCP_BASE_URL || "https://mcp.lagrowthmachine.com";
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  });
});

// GET /oauth/authorize
// client_id = user email (identifier only, no validation here)
// Immediately redirects with a one-time code (60s TTL)
router.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state, client_id } = req.query as Record<
    string,
    string
  >;

  if (!redirect_uri || !client_id) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "redirect_uri and client_id are required",
    });
    return;
  }

  const code = crypto.randomBytes(32).toString("hex");
  authCodes.set(code, { clientId: client_id, expiresAt: Date.now() + 60_000 });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

// POST /oauth/token
// client_id    = user email (must match the one used in /authorize)
// client_secret = LGM API key → validated against LGM API
// Returns access_token = API key (Bearer token reused as-is in /mcp)
router.post("/oauth/token", async (req, res) => {
  const { client_id, client_secret, code, grant_type } = req.body as Record<
    string,
    string
  >;

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  if (!code || !client_id || !client_secret) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "code, client_id, and client_secret are required",
    });
    return;
  }

  const stored = authCodes.get(code);
  authCodes.delete(code); // single-use

  if (
    !stored ||
    stored.expiresAt < Date.now() ||
    stored.clientId !== client_id
  ) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  const valid = await validateApiKey(client_secret);
  if (!valid) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  res.json({
    access_token: client_secret, // API key used directly as Bearer token
    token_type: "Bearer",
    expires_in: 31_536_000,
  });
});

export default router;
