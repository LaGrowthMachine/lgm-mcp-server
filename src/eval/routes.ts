import express from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../agents/db-explorer/mongoClient";
import { analyzeConversationWithDbPrompt } from "./analyzer";
import { generateReply } from "./replyGenerator";
import { diffAnalyses, diffReplies } from "./diff";
import * as db from "./db";

const asKind = (v: unknown): db.PromptKind =>
  v === "reply" ? "reply" : "analysis";

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
    const promptName = req.body?.promptName
      ? String(req.body.promptName)
      : undefined;
    const result = await analyzeConversationWithDbPrompt(id, promptName);
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
    const q = req.query;
    const page = Math.max(1, parseInt(String(q.page ?? "1"), 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(q.pageSize ?? "20"), 10) || 20),
    );
    const favoriteOnly = String(q.favorite ?? "") === "1";
    const hasCanon =
      q.hasCanon === "1" ? true : q.hasCanon === "0" ? false : undefined;
    const minRaw = parseInt(String(q.minMessages ?? ""), 10);
    const minMessages =
      Number.isFinite(minRaw) && minRaw > 0 ? minRaw : undefined;
    const lastRole =
      q.lastRole === "LEAD" || q.lastRole === "SENDER"
        ? q.lastRole
        : undefined;
    const channel =
      typeof q.channel === "string" && q.channel
        ? q.channel.toUpperCase()
        : undefined;
    const sort = ["last_at", "first_at", "msg_count", "latest_at"].includes(
      String(q.sort),
    )
      ? String(q.sort)
      : undefined;
    const dir =
      q.dir === "asc" ? "asc" : q.dir === "desc" ? "desc" : undefined;
    res.json(
      await db.listConversations({
        page,
        pageSize,
        favoriteOnly,
        hasCanon,
        minMessages,
        lastRole,
        channel,
        sort,
        dir,
      }),
    );
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

// Édition manuelle de la classification. Aucun contrôle de schéma.
evalRouter.put(
  "/analyses/:id",
  wrap(async (req, res) => {
    const c = req.body?.classification;
    if (c == null || typeof c !== "object" || Array.isArray(c)) {
      res
        .status(400)
        .json({ error: "classification doit être un objet JSON" });
      return;
    }
    const ok = await db.updateAnalysisClassification(
      String(req.params.id),
      c,
    );
    if (!ok) {
      res.status(404).json({ error: "analyse inconnue" });
      return;
    }
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

// ---------- 4 · Réponses (génération 1 conv / requête, 30s-safe) ----------
// Pas de tool MCP : la génération de réponse vit uniquement ici (eval).
evalRouter.post(
  "/reply/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!HEX24.test(id)) {
      res.status(400).json({ error: "conversationId invalide" });
      return;
    }
    const promptName = req.body?.promptName
      ? String(req.body.promptName)
      : undefined;
    const gen = await generateReply(id, promptName);
    await db.upsertConversation(id, gen.conversation);

    if (gen.result.status === "skipped") {
      res.json({
        conversationId: id,
        replyId: null,
        promptName: gen.promptName,
        status: "skipped",
        reason: gen.result.reason,
        replyText: null,
        hasFavorite: false,
        vsFavorite: { verdict: "incomparable", changes: [gen.result.reason] },
      });
      return;
    }

    // Référence AVANT upsert : la favorite courante (baseline validée). Si
    // c'est le même slot (conv,prompt) on capture bien le texte pré-écrasement.
    const favBefore = await db.getFavoriteReply(id);
    const inserted = await db.upsertReply({
      conversationId: id,
      promptName: gen.promptName,
      replyText: gen.result.replyText,
      context: gen.result.context,
    });
    const vsFavorite = diffReplies(
      favBefore?.reply_text ?? null,
      gen.result.replyText,
    );

    res.json({
      conversationId: id,
      replyId: inserted.id,
      promptName: gen.promptName,
      status: "ok",
      replyText: gen.result.replyText,
      hasFavorite: !!favBefore,
      vsFavorite,
    });
  }),
);

// Input batch = favoris de conversation (parité avec /analyze/favorites/ids).
evalRouter.get(
  "/reply/favorites/ids",
  wrap(async (_req, res) => {
    res.json({ ids: await db.favoriteConversationIds() });
  }),
);

evalRouter.get(
  "/replies",
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.pageSize ?? "30"), 10) || 30),
    );
    res.json(await db.listReplies(page, pageSize));
  }),
);

evalRouter.post(
  "/replies/:id/favorite",
  wrap(async (req, res) => {
    await db.setFavoriteReply(String(req.params.id), req.body?.value !== false);
    res.json({ ok: true });
  }),
);

evalRouter.delete(
  "/replies/:id",
  wrap(async (req, res) => {
    await db.deleteReply(String(req.params.id));
    res.json({ ok: true });
  }),
);

evalRouter.post(
  "/replies/favorite-batch",
  wrap(async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    for (const id of ids) await db.setFavoriteReply(String(id), true);
    res.json({ ok: true, n: ids.length });
  }),
);

evalRouter.post(
  "/replies/delete-batch",
  wrap(async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    for (const id of ids) await db.deleteReply(String(id));
    res.json({ ok: true, n: ids.length });
  }),
);

// ---------- 5 · Prompts (CRUD + version + actif, par famille `kind`) ----------
evalRouter.get(
  "/prompts",
  wrap(async (req, res) => {
    const kind = asKind(req.query.kind);
    const [list, active, next] = await Promise.all([
      db.listPrompts(kind),
      db.getActivePrompt(kind),
      db.nextPromptName(kind),
    ]);
    res.json({
      kind,
      prompts: list,
      active: active?.name ?? null,
      nextName: next,
    });
  }),
);

evalRouter.get(
  "/prompts/:name",
  wrap(async (req, res) => {
    const kind = asKind(req.query.kind);
    const p = await db.getPrompt(String(req.params.name), kind);
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
    const kind = asKind(req.body?.kind);
    const name = String(req.body?.name ?? "").trim();
    const body = String(req.body?.body ?? "");
    if (!name || !body) {
      res.status(400).json({ error: "name et body requis" });
      return;
    }
    if (await db.getPrompt(name, kind)) {
      res.status(409).json({ error: `le prompt "${name}" existe déjà` });
      return;
    }
    await db.createPrompt(name, body, kind);
    res.json({ ok: true, name });
  }),
);

evalRouter.put(
  "/prompts/:name",
  wrap(async (req, res) => {
    const kind = asKind(req.body?.kind ?? req.query.kind);
    const name = String(req.params.name);
    if (!(await db.getPrompt(name, kind))) {
      res.status(404).json({ error: "prompt inconnu" });
      return;
    }
    const ok = await db.updatePrompt(name, String(req.body?.body ?? ""), kind);
    if (!ok) {
      res
        .status(409)
        .json({ error: "prompt validé (figé) — non modifiable" });
      return;
    }
    res.json({ ok: true });
  }),
);

// Suppression interdite si live OU déjà utilisé (traçabilité).
evalRouter.delete(
  "/prompts/:name",
  wrap(async (req, res) => {
    const kind = asKind(req.query.kind);
    const name = String(req.params.name);
    const p = await db.getPrompt(name, kind);
    if (!p) {
      res.status(404).json({ error: "prompt inconnu" });
      return;
    }
    if (p.is_active) {
      res
        .status(409)
        .json({ error: "prompt live — non supprimable" });
      return;
    }
    if (await db.isPromptUsed(name, kind)) {
      res.status(409).json({
        error: "déjà utilisé (analyses/réponses) — non supprimable",
      });
      return;
    }
    await db.deletePrompt(name, kind);
    res.json({ ok: true });
  }),
);

// Valide un brouillon (sens unique) → contenu figé. NE met PAS live.
evalRouter.post(
  "/prompts/:name/validate",
  wrap(async (req, res) => {
    const kind = asKind(req.body?.kind ?? req.query.kind);
    const name = String(req.params.name);
    if (!(await db.getPrompt(name, kind))) {
      res.status(404).json({ error: "prompt inconnu" });
      return;
    }
    const ok = await db.validatePrompt(name, kind);
    if (!ok) {
      res.status(409).json({ error: "déjà validé" });
      return;
    }
    res.json({ ok: true });
  }),
);

// Met un prompt en live (1 seul/famille). Seul un validé peut l'être.
evalRouter.post(
  "/prompts/:name/live",
  wrap(async (req, res) => {
    const kind = asKind(req.body?.kind ?? req.query.kind);
    const name = String(req.params.name);
    if (!(await db.getPrompt(name, kind))) {
      res.status(404).json({ error: "prompt inconnu" });
      return;
    }
    const ok = await db.setLivePrompt(name, kind);
    if (!ok) {
      res
        .status(409)
        .json({ error: "seul un prompt validé peut être mis live" });
      return;
    }
    res.json({ ok: true });
  }),
);

// (Clone géré côté client : GET du body source + POST /prompts.)
