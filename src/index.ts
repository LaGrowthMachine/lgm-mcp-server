import "./eval/loadEnv";
import express from "express";
import axios from "axios";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { MCP_SERVER_INFO, MCP_SERVER_OPTIONS } from "./server";
import { registerFromRow } from "./endpoints/registry";
import { requestContext, isAllowedApiUrl, getApiUrl } from "./requestContext";
import oauthRouter from "./oauth";
import { evalRouter } from "./eval/routes";
import { ensureSchema, listEndpoints } from "./eval/db";
import { googleAuth } from "./eval/googleAuth";

const PORT = parseInt(process.env.PORT || "3001", 10);

// Basic Auth scoped to the eval web app (/eval + /api/eval) only — /mcp,
// /health, /oauth, /.well-known stay open so MCP clients and Heroku probes
// aren't broken. Active on Heroku (DYNO env var) only, never in local dev.
// EVAL_BASIC_AUTH=1 forces it on for local testing.
const EVAL_AUTH_ENABLED =
  !!process.env.DYNO || process.env.EVAL_BASIC_AUTH === "1";
const EVAL_AUTH_USER = process.env.EVAL_BASIC_AUTH_USER || "lgm";
const EVAL_AUTH_PASS = process.env.EVAL_BASIC_AUTH_PASS || "";
if (EVAL_AUTH_ENABLED && !EVAL_AUTH_PASS) {
  // Fail-fast: a missing password would otherwise default to "" and accept
  // any client sending the `lgm:` Basic header. Refuse to boot instead.
  console.error(
    "[boot] EVAL_BASIC_AUTH_PASS is required when eval auth is enabled (DYNO set or EVAL_BASIC_AUTH=1)",
  );
  process.exit(1);
}

const safeEq = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

const evalBasicAuth = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void => {
  if (!EVAL_AUTH_ENABLED) {
    next();
    return;
  }
  const h = req.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const [user, ...rest] = Buffer.from(h.slice(6), "base64")
      .toString("utf8")
      .split(":");
    if (safeEq(user, EVAL_AUTH_USER) && safeEq(rest.join(":"), EVAL_AUTH_PASS)) {
      next();
      return;
    }
  }
  res
    .set("WWW-Authenticate", 'Basic realm="LGM eval", charset="UTF-8"')
    .status(401)
    .send("Authentication required");
};

// Hard timeout for the DB bootstrap. A Postgres in a network black hole
// (vs. cleanly refused) could otherwise hang `ensureSchema` indefinitely and
// block dyno boot. The HTTP boot is not dependent on the registry — it only
// seeds the schema; tool listings are per-request DB reads.
const BOOTSTRAP_DB_TIMEOUT_MS = 15000;

const bootstrapHttpSchema = async (): Promise<void> => {
  try {
    await Promise.race([
      ensureSchema(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `ensureSchema timed out after ${BOOTSTRAP_DB_TIMEOUT_MS}ms`,
              ),
            ),
          BOOTSTRAP_DB_TIMEOUT_MS,
        ),
      ),
    ]);
    console.error("[boot] ensureSchema ok");
  } catch (e) {
    console.error(
      "[boot] ensureSchema failed/timed out — /mcp will retry per-request:",
      e,
    );
  }
};

// Build a fresh McpServer per HTTP request: read endpoints from the DB
// (no cache — explicit tradeoff against complexity) and register the valid
// rows. If the DB is unreachable, no tools are served — fail-loud rather
// than diverging from the DB source of truth.
//
// SDK constraint: `McpServer.connect(transport)` doesn't support re-binding
// the same server to a new transport ("Already connected to a transport"),
// so 1 request = 1 server = 1 transport.
const buildPerRequestServer = async (): Promise<McpServer> => {
  const server = new McpServer(MCP_SERVER_INFO, MCP_SERVER_OPTIONS);
  try {
    const rows = await listEndpoints();
    for (const row of rows) {
      registerFromRow(server, row);
    }
  } catch (err) {
    console.error(
      "[endpoints] DB unavailable, no tools will be served:",
      err,
    );
  }
  return server;
};

const startHttpServer = async () => {
  const app = express();

  // Heroku puts one proxy hop in front of the dyno (router → app). Without
  // this, `req.secure` is always false and `req.protocol` always "http",
  // breaking the Secure cookie attribute decision in googleAuth.
  app.set("trust proxy", 1);

  // Eval web app (validation harness) served by this same server — path-routed,
  // no second process. API under /api/eval (parser 4 MB, mounted BEFORE the
  // global 100 KB json parser); React build served statically under /eval.
  // /mcp, /health, /oauth are untouched.
  //
  // Dual-gate: evalBasicAuth (outer Heroku gate, shared password) then
  // googleAuth.middleware (inner per-user identification, @lagrowthmachine.com).
  // Both must pass. Google middleware bypasses /auth/{login,callback,logout}
  // so the OAuth flow can complete.
  app.use(["/api/eval", "/eval"], evalBasicAuth, googleAuth.middleware());
  app.get("/eval/auth/login", googleAuth.loginHandler);
  app.get("/eval/auth/callback", googleAuth.callbackHandler);
  app.get("/eval/auth/logout", googleAuth.logoutHandler);
  app.get("/api/eval/auth/me", googleAuth.meHandler);
  app.use("/api/eval", evalRouter);
  const webDist = path.resolve(__dirname, "../web-dist");
  if (fs.existsSync(webDist)) {
    app.use("/eval", express.static(webDist));
    app.get(/^\/eval(?:\/.*)?$/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use(oauthRouter);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "1.0.0" });
  });

  app.get("/health/ready", async (_req, res) => {
    try {
      await axios
        .head(`${getApiUrl()}/flow/members`, {
          timeout: 3000,
        })
        .catch(() => {
          // Ignore errors for readiness probe
        });
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not ready" });
    }
  });

  const extractApiKey = (req: express.Request): string | undefined => {
    const apiKeyHeader = req.headers["x-lgm-api-key"] as string | undefined;
    if (apiKeyHeader) return apiKeyHeader;

    const authHeader = req.headers["authorization"] as string | undefined;
    if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

    return undefined;
  };

  const withRequestContext = (
    handler: (req: express.Request, res: express.Response) => Promise<void>,
  ) => {
    return async (req: express.Request, res: express.Response) => {
      try {
        const customApiUrl = req.headers["x-lgm-api-url"] as string | undefined;
        const apiKey = extractApiKey(req);

        if (customApiUrl && !isAllowedApiUrl(customApiUrl)) {
          const message =
            "Invalid X-LGM-API-URL. Must be a *.lagrowthmachine.com, *.preview.lgmfeatureenv7.com, or localhost URL.";
          console.error(message);
          res.status(400).json({
            error: message,
          });
          return;
        }

        if (!apiKey) {
          const base =
            process.env.MCP_BASE_URL || "https://mcpapp.lagrowthmachine.com";
          res.set(
            "WWW-Authenticate",
            `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          );
          res.status(401).json({ error: "unauthorized" });
          return;
        }

        (req as IncomingMessage & { auth?: AuthInfo }).auth = {
          token: apiKey,
          clientId: "lgm-api-key",
          scopes: [],
        };

        await requestContext.run({ apiUrl: customApiUrl, apiKey }, async () => {
          await handler(req, res);
        });
      } catch (error) {
        console.error("Request context error:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error" });
        }
      }
    };
  };

  const handleMcp = withRequestContext(
    async (req: express.Request, res: express.Response) => {
      const server = await buildPerRequestServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
    },
  );

  app.post("/mcp", handleMcp);
  app.get("/mcp", handleMcp);
  app.delete("/mcp", handleMcp);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const httpServer = app.listen(PORT, () => {
    console.log(`LGM MCP Server running on port ${PORT}`);
    console.log(`endpoint: ${getApiUrl()}`);
  });

  // Schema seed runs after `listen()` so Heroku's health probe sees an open
  // port immediately. Per-request /mcp handlers don't depend on this — they
  // read endpoints from the DB at call time. This is best-effort: failures
  // are logged in `bootstrapHttpSchema` itself.
  void bootstrapHttpSchema();

  const shutdown = () => {
    httpServer.close(() => {
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(1);
    }, 5000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

startHttpServer().catch((error) => {
  console.error("Failed to start HTTP server:", error);
  process.exit(1);
});
