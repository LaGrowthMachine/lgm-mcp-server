import express from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../agents/db-explorer/mongoClient";
import { analyzeConversationWithDbPrompt } from "./analyzer";
import { diffAnalyses } from "./diff";
import * as db from "./db";

const HEX24 = /^[a-f0-9]{24}$/i;

const parseUserIds = (raw: string): string[] => {
  let tokens: string[];
  if (/company_id/i.test(raw)) {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0]
      .split(",")
      .map((h) => h.trim().replace(/^"|"$/g, ""));
    const col = header.indexOf("company_id");
    tokens =
      col >= 0
        ? lines
            .slice(1)
            .map((l) => (l.split(",")[col] ?? "").trim().replace(/^"|"$/g, ""))
        : [];
  } else {
    tokens = raw.split(/[\s,;]+/);
  }
  return [...new Set(tokens.map((t) => t.trim()).filter((t) => HEX24.test(t)))];
};

// Monté sur /api/eval dans src/index.ts, AVANT le express.json() global
// (limite 100 Ko) — d'où son propre parser 4 Mo pour les gros collages CSV.
export const evalRouter = express.Router();
evalRouter.use(express.json({ limit: "4mb" }));

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response): void => {
    fn(req, res).catch((e) => {
      console.error("[api] error", e);
      res
        .status(500)
        .json({ error: e instanceof Error ? e.message : "erreur interne" });
    });
  };

// ---------- 1 · Découverte ----------
evalRouter.post(
  "/discover",
  wrap(async (req, res) => {
    const input = String(req.body?.input ?? "");
    const repliedOnly = req.body?.repliedOnly !== false;
    let limit = parseInt(String(req.body?.limit ?? "50"), 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    limit = Math.min(limit, 200);

    const userIds = parseUserIds(input);
    if (userIds.length === 0) {
      res
        .status(400)
        .json({ error: "Aucun userId 24-hex (CSV company_id ou liste d'ID)." });
      return;
    }

    const mdb = await getDb();
    const perUser: { userId: string; ids: string[] }[] = [];
    const all: string[] = [];
    for (const uid of userIds) {
      const filter: Record<string, unknown> = {
        userId: new ObjectId(uid),
        deleted: false,
      };
      if (repliedOnly) filter.leadReplied = true;
      const docs = await mdb
        .collection("inboxConversations")
        .find(filter, {
          projection: { _id: 1 },
          sort: { lastMessageAt: -1 },
          limit,
        })
        .toArray();
      const ids = docs.map((d) => String(d._id));
      perUser.push({ userId: uid, ids });
      all.push(...ids);
    }
    res.json({ users: userIds.length, count: all.length, ids: all, perUser });
  }),
);

// ---------- 2 · Analyse (1 conv / requête, séquencé côté front) ----------
evalRouter.post(
  "/analyze/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!HEX24.test(id)) {
      res.status(400).json({ error: "conversationId invalide" });
      return;
    }
    const result = await analyzeConversationWithDbPrompt(id);
    await db.upsertConversation(id, result.conversation);
    const payload = {
      conversation: result.conversation,
      analysis: result.analysis,
    };
    const inserted = await db.insertAnalysis({
      conversationId: id,
      promptName: result.promptName,
      status: result.analysis.status,
      payload,
    });

    // Comparaison déterministe au canon courant (si présent).
    const canon = await db.getCanonAnalysis(id);
    const vsCanon = canon
      ? diffAnalyses(canon.payload, payload)
      : { verdict: "incomparable" as const, changes: ["pas encore de canon"] };

    res.json({
      conversationId: id,
      analysisId: inserted.id,
      promptName: result.promptName,
      status: result.analysis.status,
      analysis: result.analysis,
      hasCanon: !!canon,
      vsCanon,
    });
  }),
);

evalRouter.get(
  "/analyze/favorites/ids",
  wrap(async (_req, res) => {
    res.json({ ids: await db.favoriteConversationIds() });
  }),
);

// ---------- 3 · Conversations ----------
evalRouter.get(
  "/conversations",
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20),
    );
    const favoriteOnly = String(req.query.favorite ?? "") === "1";
    res.json(await db.listConversations(page, pageSize, favoriteOnly));
  }),
);

evalRouter.get(
  "/conversations/:id",
  wrap(async (req, res) => {
    const detail = await db.getConversationDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: "conversation inconnue" });
      return;
    }
    res.json(detail);
  }),
);

evalRouter.post(
  "/conversations/:id/favorite",
  wrap(async (req, res) => {
    await db.setFavorite(String(req.params.id), req.body?.value !== false);
    res.json({ ok: true });
  }),
);

evalRouter.delete(
  "/conversations/:id",
  wrap(async (req, res) => {
    await db.deleteConversation(String(req.params.id));
    res.json({ ok: true });
  }),
);

// ---------- analyses : canon / suppression (avec variantes "all") ----------
evalRouter.post(
  "/analyses/:id/canon",
  wrap(async (req, res) => {
    await db.setCanon(String(req.params.id));
    res.json({ ok: true });
  }),
);

evalRouter.delete(
  "/analyses/:id",
  wrap(async (req, res) => {
    await db.deleteAnalysis(String(req.params.id));
    res.json({ ok: true });
  }),
);

evalRouter.post(
  "/analyses/canon-batch",
  wrap(async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    for (const id of ids) await db.setCanon(String(id));
    res.json({ ok: true, n: ids.length });
  }),
);

evalRouter.post(
  "/analyses/delete-batch",
  wrap(async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    for (const id of ids) await db.deleteAnalysis(String(id));
    res.json({ ok: true, n: ids.length });
  }),
);

// ---------- 4 · Prompts (CRUD + version + actif) ----------
evalRouter.get(
  "/prompts",
  wrap(async (_req, res) => {
    const [list, active, next] = await Promise.all([
      db.listPrompts(),
      db.getActivePrompt(),
      db.nextPromptName(),
    ]);
    res.json({ prompts: list, active: active?.name ?? null, nextName: next });
  }),
);

evalRouter.get(
  "/prompts/:name",
  wrap(async (req, res) => {
    const p = await db.getPrompt(String(req.params.name));
    if (!p) {
      res.status(404).json({ error: "prompt inconnu" });
      return;
    }
    res.json(p);
  }),
);

evalRouter.post(
  "/prompts",
  wrap(async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    const body = String(req.body?.body ?? "");
    if (!name || !body) {
      res.status(400).json({ error: "name et body requis" });
      return;
    }
    if (await db.getPrompt(name)) {
      res.status(409).json({ error: `le prompt "${name}" existe déjà` });
      return;
    }
    await db.createPrompt(name, body);
    res.json({ ok: true, name });
  }),
);

evalRouter.put(
  "/prompts/:name",
  wrap(async (req, res) => {
    const name = String(req.params.name);
    if (!(await db.getPrompt(name))) {
      res.status(404).json({ error: "prompt inconnu" });
      return;
    }
    await db.updatePrompt(name, String(req.body?.body ?? ""));
    res.json({ ok: true });
  }),
);

evalRouter.delete(
  "/prompts/:name",
  wrap(async (req, res) => {
    await db.deletePrompt(String(req.params.name));
    res.json({ ok: true });
  }),
);

evalRouter.post(
  "/prompts/:name/activate",
  wrap(async (req, res) => {
    const name = String(req.params.name);
    if (!(await db.getPrompt(name))) {
      res.status(404).json({ error: "prompt inconnu" });
      return;
    }
    await db.activatePrompt(name);
    res.json({ ok: true });
  }),
);
