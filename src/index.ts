import "./eval/loadEnv";
import express from "express";
import axios from "axios";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { createMcpServer } from "./server";
import { requestContext, isAllowedApiUrl, getApiUrl } from "./requestContext";
import oauthRouter from "./oauth";
import { evalRouter } from "./eval/routes";
import { ensureSchema } from "./eval/db";

const PORT = parseInt(process.env.PORT || "3001", 10);
const TRANSPORT = process.env.LGM_MCP_TRANSPORT || "http";

// Basic Auth navigateur SCOPPÉ à la web app d'éval (/eval + /api/eval)
// uniquement. /mcp, /health, /oauth, /.well-known restent OUVERTS — sinon
// on casse tous les clients MCP et les probes Heroku. Identifiants via
// config vars (défauts demandés : lgm / tech@env25).
// Actif uniquement sur Heroku (variable DYNO présente sur les dynos) — JAMAIS
// en dev local. Forçable via EVAL_BASIC_AUTH=1 si besoin de tester le gate.
const EVAL_AUTH_ENABLED =
  !!process.env.DYNO || process.env.EVAL_BASIC_AUTH === "1";
const EVAL_AUTH_USER = process.env.EVAL_BASIC_AUTH_USER || "lgm";
const EVAL_AUTH_PASS = process.env.EVAL_BASIC_AUTH_PASS || "tech@env25";

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

const startHttpServer = async () => {
  const app = express();

  // Outil d'éval (validation de prompt) servi par CE serveur — routing par
  // path, zéro 2e système. API sous /api/eval (parser 4 Mo propre, monté
  // AVANT le json global 100 Ko), UI React buildée servie en statique sous
  // /eval. Le MCP (/mcp), /health, /oauth restent inchangés.
  app.use(["/api/eval", "/eval"], evalBasicAuth);
  app.use("/api/eval", evalRouter);
  // Schéma + seed du prompt par défaut, non-bloquant : si Postgres est
  // indisponible le MCP démarre quand même, seules les routes /api/eval
  // répondront en erreur.
  ensureSchema().catch((e) =>
    console.error("[eval] ensureSchema KO (routes /api/eval dégradées):", e),
  );
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
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      const server = createMcpServer();
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

const startStdioServer = async () => {
  try {
    console.error("[LGM] Starting stdio server...");
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[LGM] Stdio server connected successfully");
  } catch (error) {
    console.error("[LGM] Stdio server error:", error);
    process.exit(1);
  }
};

if (TRANSPORT === "stdio") {
  startStdioServer().catch((error) => {
    console.error("Failed to start stdio server:", error);
    process.exit(1);
  });
} else {
  startHttpServer().catch((error) => {
    console.error("Failed to start HTTP server:", error);
    process.exit(1);
  });
}
