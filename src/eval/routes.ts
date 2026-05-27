import express from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../agents/db-explorer/mongoClient";
import { analyzeConversationWithDbPrompt } from "./analyzer";
import { generateReply } from "./replyGenerator";
import { analyzeIdentity } from "./identityProfiler";
import { computeMetrics, compareMetrics } from "./stylometry";
import type { IdentityProfilePayload } from "./identityProfiler";
import { fetchIdentityLabels } from "./identityLabels";
import { diffAnalyses, diffReplies } from "./diff";
import * as db from "./db";
import { CSV_BOM, toCsvRow } from "./csv";
import {
  builtinConfigSchema,
  proxyConfigSchema,
  validateEndpointName,
} from "../endpoints/types";

const asKind = (v: unknown): db.PromptKind =>
  v === "reply" ? "reply" : "analysis";

const HEX24 = /^[a-f0-9]{24}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Format ISO 8601 d'une date Postgres pour le CSV ; non-localisé volontairement
// (Excel/Sheets/Numbers parsent ISO sans ambiguïté, les libellés FR sont
// réservés à l'UI via `web/format.ts`).
const isoOrEmpty = (v: string | null | undefined): string => {
  if (v == null) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
};

// `cost_usd` est un float8 ; `String(1e-7)` → `"1e-7"`, qu'Excel parse comme du
// texte. On force une notation décimale à 8 chiffres (~3 décimales de plus que
// la précision actuelle de la grille tarifaire) pour garder la cellule
// numérique. NULL → "" (NULL est porteur d'info, jamais 0).
const fmtCostUsdCsv = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return "";
  return v.toFixed(8);
};

const CONV_CHANNELS = new Set(["LINKEDIN", "EMAIL", "OTHER"]);
const CONV_SORTS = new Set(["last_at", "first_at", "msg_count", "latest_at"]);

// Sérialise `conversations.transcript` (TranscriptItem[] = ConvMsg | string)
// pour le golden dataset export. Convertit `at` epoch ms → ISO 8601 UTC
// (les autres dates du CSV sont en ISO, on garde la cohérence). Items legacy
// (string brut) emis comme `{ text: "...", role: null }` pour préserver le
// contenu sans inventer de role/channel.
const serializeTranscriptForCsv = (
  transcript: db.TranscriptItem[] | null | undefined,
): string => {
  if (!transcript || !Array.isArray(transcript)) return "";
  const normalized = transcript.map((m) => {
    if (typeof m === "string") return { role: null, text: m };
    return {
      role: m.role,
      at: m.at > 0 ? new Date(m.at).toISOString() : null,
      channel: m.channel,
      ...(m.subject ? { subject: m.subject } : {}),
      text: m.text,
    };
  });
  return JSON.stringify(normalized);
};

const setCsvHeaders = (
  res: express.Response,
  filename: string,
): void => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
};

// Filtres conversations : extraction commune au GET JSON et au GET CSV
// (mêmes règles de parsing, évite la dérive). `sort`/`dir` ignorés à l'export
// (l'ordre n'a pas de sens hors page).
type ConvExportFilters = {
  favoriteOnly: boolean;
  hasCanon: boolean | undefined;
  minMessages: number | undefined;
  lastRole: string | undefined;
  channel: string | undefined;
  sort: string | undefined;
  dir: "asc" | "desc" | undefined;
};
const parseConvFilters = (req: express.Request): ConvExportFilters => {
  const q = req.query;
  const minRaw = parseInt(String(q.minMessages ?? ""), 10);
  // `typeof === "string"` guard : Express renvoie `string | string[] | ParsedQs`
  // pour les query params répétés ; les caster naïvement via `String()` produit
  // `"a,b"` (array) ou `"undefined"`, qui passent silencieusement les allowlists.
  const sortRaw = typeof q.sort === "string" ? q.sort : "";
  const channelRaw =
    typeof q.channel === "string" ? q.channel.toUpperCase() : "";
  return {
    favoriteOnly: String(q.favorite ?? "") === "1",
    hasCanon:
      q.hasCanon === "1" ? true : q.hasCanon === "0" ? false : undefined,
    minMessages: Number.isFinite(minRaw) && minRaw > 0 ? minRaw : undefined,
    lastRole:
      q.lastRole === "LEAD" || q.lastRole === "SENDER" ? q.lastRole : undefined,
    channel: CONV_CHANNELS.has(channelRaw) ? channelRaw : undefined,
    sort: CONV_SORTS.has(sortRaw) ? sortRaw : undefined,
    dir: q.dir === "asc" ? "asc" : q.dir === "desc" ? "desc" : undefined,
  };
};

const todayUtcYmd = (): string => new Date().toISOString().slice(0, 10);

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
      // ModelNotConfiguredError = action user requise (aller dans /eval/settings),
      // pas une 500. L'UI peut détecter via le code pour proposer la redirection.
      if (e instanceof db.ModelNotConfiguredError) {
        res
          .status(409)
          .json({ error: e.message, code: "MODEL_NOT_CONFIGURED" });
        return;
      }
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
    const batchId = req.body?.batchId ? String(req.body.batchId) : undefined;
    if (batchId !== undefined && !UUID_RE.test(batchId)) {
      res.status(400).json({ error: "batchId invalide" });
      return;
    }
    const modelIdParam = req.body?.modelId
      ? String(req.body.modelId)
      : undefined;
    if (modelIdParam !== undefined && !UUID_RE.test(modelIdParam)) {
      res.status(400).json({ error: "modelId invalide" });
      return;
    }
    const resolved = await db.resolveEffectiveModelId(modelIdParam);
    const result = await analyzeConversationWithDbPrompt(id, {
      model: resolved.awsModelId,
      promptName,
    });
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
      batchId,
      modelId: resolved.uuid,
      usage: result.usage,
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

// ---------- batchs d'analyses ----------
// Création : le serveur résout/déduplique les IDs (favorites OU liste cliente
// filtrée HEX24) et les fige dans `source_ids`. Cycle de vie ensuite côté
// client : il appelle POST /analyze/:id avec `batchId` pour chaque ID, puis
// PATCH /batches/:id { status: "done"|"aborted" } à la fin.
evalRouter.post(
  "/batches",
  wrap(async (req, res) => {
    const promptName = req.body?.promptName
      ? String(req.body.promptName)
      : null;
    const source: db.BatchSource =
      req.body?.source === "favorites" ? "favorites" : "ids";
    const modelIdParam = req.body?.modelId
      ? String(req.body.modelId)
      : undefined;
    if (modelIdParam !== undefined && !UUID_RE.test(modelIdParam)) {
      res.status(400).json({ error: "modelId invalide" });
      return;
    }
    // Résolution stricte au moment de la création du batch : on fige le
    // modèle qui sera utilisé pour toutes les analyses du batch. Si la
    // résolution échoue (pas de default settings, pas de modelId explicite),
    // le batch n'est pas créé.
    const resolved = await db.resolveEffectiveModelId(modelIdParam);
    let ids: string[];
    if (source === "favorites") {
      ids = await db.favoriteConversationIds();
    } else {
      const raw: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
      ids = [
        ...new Set(
          raw.map((v) => String(v)).filter((s) => HEX24.test(s)),
        ),
      ];
    }
    if (ids.length === 0) {
      res.status(400).json({ error: "aucune conversation à analyser" });
      return;
    }
    const batch = await db.createBatch({
      promptName,
      source,
      sourceIds: ids,
      modelId: resolved.uuid,
    });
    res.json(batch);
  }),
);

evalRouter.get(
  "/batches",
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20),
    );
    res.json(await db.listBatches(page, pageSize));
  }),
);

evalRouter.get(
  "/batches/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "batchId invalide" });
      return;
    }
    const batch = await db.getBatch(id);
    if (!batch) {
      res.status(404).json({ error: "batch inconnu" });
      return;
    }
    const rows = await db.getBatchAnalyses(id);
    const metrics = db.computeBatchMetricsFromRows(rows);
    res.json({ batch, rows, metrics });
  }),
);

// Export CSV des analyses d'un batch. UTF-8 + BOM (Excel sur Windows lit
// CP-1252 sans le BOM). Ordre colonnes figé (cf. spec Design Notes : lecture
// UX gauche→droite). tokens/cost/canon_label NULL ⇒ cellule vide (jamais 0 —
// NULL est porteur d'info "pas facturé").
// Cap export symétrique à `/conversations/export.csv` : les batches sont
// normalement O(100), mais on protège quand même la mémoire process.
const BATCH_EXPORT_CAP = 10000;
evalRouter.get(
  "/batches/:id/export.csv",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).type("text/plain").send("invalid batch id");
      return;
    }
    const batch = await db.getBatch(id);
    if (!batch) {
      res.status(404).type("text/plain").send("batch not found");
      return;
    }
    const count = await db.countBatchAnalyses(id);
    if (count > BATCH_EXPORT_CAP) {
      res
        .status(413)
        .type("text/plain")
        .send(
          `export too large: ${count} rows, max ${BATCH_EXPORT_CAP}. Contact support.`,
        );
      return;
    }
    const rows = await db.getBatchAnalyses(id);
    const header = toCsvRow([
      "conversation_id",
      "analysis_id",
      "status",
      "is_canon",
      "created_at",
      "verdict",
      "canon_label",
      "canon_sub_label",
      "new_label",
      "new_sub_label",
      "reason",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cost_usd",
    ]);
    const body = rows.map((r) =>
      toCsvRow([
        r.conversation_id,
        r.analysis_id,
        r.status,
        r.is_canon,
        isoOrEmpty(r.created_at),
        r.verdict,
        r.canon_label,
        r.canon_sub_label,
        r.new_label,
        r.new_sub_label,
        r.reason,
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        fmtCostUsdCsv(r.cost_usd),
      ]),
    );
    const csv = CSV_BOM + [header, ...body].join("\r\n");
    setCsvHeaders(res, `batch-${id}-${todayUtcYmd()}.csv`);
    res.send(csv);
  }),
);

evalRouter.patch(
  "/batches/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "batchId invalide" });
      return;
    }
    const status = req.body?.status;
    if (status !== "done" && status !== "aborted") {
      res.status(400).json({ error: "status doit être done|aborted" });
      return;
    }
    await db.updateBatchStatus(id, status);
    res.json({ ok: true });
  }),
);

// Suppression d'un batch + cascade applicative sur ses analyses.
// Inconditionnel sur confirmation utilisateur (pas de guard `running`
// côté serveur — la confirmation modale est autoritaire). Race batch
// running : les workers concurrents d'un autre onglet peuvent voir leurs
// POST /analyze/:cid suivants tomber en FK violation, logué côté serveur
// (trade-off documenté dans le warning du modal).
evalRouter.delete(
  "/batches/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "batchId invalide" });
      return;
    }
    // Atomic : DELETE RETURNING détecte l'absence en transaction (pas de
    // TOCTOU entre un getBatch préalable et le delete).
    const { deletedAnalyses, batchExisted } = await db.deleteBatch(id);
    if (!batchExisted) {
      res.status(404).json({ error: "batch_not_found" });
      return;
    }
    console.error(
      `[eval] batch_deleted id=${id} deletedAnalyses=${deletedAnalyses}`,
    );
    res.json({ ok: true, deletedAnalyses });
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
    const filters = parseConvFilters(req);
    res.json(
      await db.listConversations({
        page,
        pageSize,
        ...filters,
      }),
    );
  }),
);

// Export CSV de la liste conversations. Respecte tous les filtres courants
// (mêmes params que la route JSON) hors page/pageSize : on exporte tout le
// périmètre filtré. Probe `countConversations` avant fetch : > 10 000 ⇒ 413
// (cap dur pour éviter d'aspirer la DB en prod).
const CONV_EXPORT_CAP = 10000;
evalRouter.get(
  "/conversations/export.csv",
  wrap(async (req, res) => {
    const filters = parseConvFilters(req);
    const count = await db.countConversations(filters);
    if (count > CONV_EXPORT_CAP) {
      res
        .status(413)
        .type("text/plain")
        .send(
          `export too large: ${count} rows, max ${CONV_EXPORT_CAP}. Filter further.`,
        );
      return;
    }
    // Export "golden dataset" : LEFT JOIN canon + transcript inline. Pas de
    // pagination, on charge tout le périmètre filtré (cappé à 10k au-dessus).
    const rows = await db.listConversationsForExport(filters);
    const header = toCsvRow([
      "conversation_id",
      "is_favorite",
      "analyses_count",
      "has_canon",
      "canon_label",
      "canon_sub_label",
      "canon_reason",
      "msg_count",
      "first_at",
      "last_at",
      "latest_at",
      "last_role",
      "channels",
      "transcript",
    ]);
    const body = rows.map((r) =>
      toCsvRow([
        r.conversation_id,
        r.is_favorite,
        r.analyses_count,
        r.has_canon,
        r.canon_label,
        r.canon_sub_label,
        r.canon_reason,
        r.msg_count,
        isoOrEmpty(r.first_at),
        isoOrEmpty(r.last_at),
        isoOrEmpty(r.latest_at),
        r.last_role,
        r.channels ? r.channels.join(";") : "",
        serializeTranscriptForCsv(r.transcript),
      ]),
    );
    const csv = CSV_BOM + [header, ...body].join("\r\n");
    setCsvHeaders(res, `conversations-${todayUtcYmd()}.csv`);
    res.send(csv);
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
    const modelIdParam = req.body?.modelId
      ? String(req.body.modelId)
      : undefined;
    if (modelIdParam !== undefined && !UUID_RE.test(modelIdParam)) {
      res.status(400).json({ error: "modelId invalide" });
      return;
    }
    const resolved = await db.resolveEffectiveModelId(modelIdParam);
    const gen = await generateReply(id, {
      model: resolved.awsModelId,
      promptName,
    });
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
      // Validation stylométrique vs profil identité — null si conv sans
      // (identityId, channel) résolu ou profil absent. L'UI affiche un
      // badge explicite quand c'est null (cf. ConversationDetail).
      validation: gen.result.validation,
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
    const { rows, total } = await db.listReplies(page, pageSize);
    // Batch lookup des libellés humains (firstname + lastname ou email) pour
    // chaque identityId présent dans la page. Si Mongo plante, on dégrade
    // gracieusement vers null — la liste reste consultable.
    const identityIds = rows
      .map((r) => r.identity_id)
      .filter((v): v is string => !!v);
    let labels: Map<string, { label: string | null }> = new Map();
    try {
      labels = await fetchIdentityLabels(identityIds);
    } catch {
      // labels reste vide → UI affichera l'id brut comme fallback.
    }
    const enriched = rows.map((r) => ({
      ...r,
      identity_label: r.identity_id
        ? labels.get(r.identity_id)?.label ?? null
        : null,
    }));
    res.json({ rows: enriched, total });
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

// Détail d'une réponse + validation stylométrique recalculée live vs le
// profil identité courant. La validation n'est PAS persistée car le profil
// peut évoluer (re-analyse) — la valeur courante est toujours plus utile que
// le snapshot au moment de la génération.
evalRouter.get(
  "/replies/:id",
  wrap(async (req, res) => {
    const reply = await db.getReplyById(String(req.params.id));
    if (!reply) {
      res.status(404).json({ error: "Réponse introuvable" });
      return;
    }
    const ctx = (reply.context ?? {}) as {
      identityId?: string | null;
      channel?: string | null;
    };
    let validation: {
      score: number | null;
      breakdown: ReturnType<typeof compareMetrics>["breakdown"];
      reply_metrics: ReturnType<typeof computeMetrics>;
    } | null = null;
    let profileMissingReason: string | null = null;
    const identityId = ctx.identityId ?? null;
    const channel = ctx.channel ? String(ctx.channel).toUpperCase() : null;
    if (identityId && (channel === "LINKEDIN" || channel === "EMAIL")) {
      const current = await db.getCurrentIdentityProfile(identityId, channel);
      const payload = current?.payload as IdentityProfilePayload | undefined;
      if (payload?.metrics) {
        const replyMetrics = computeMetrics([reply.reply_text]);
        const cmp = compareMetrics(replyMetrics, payload.metrics);
        validation = {
          score: cmp.score,
          breakdown: cmp.breakdown,
          reply_metrics: replyMetrics,
        };
      } else {
        profileMissingReason = current
          ? "profile_payload_invalid"
          : "no_profile";
      }
    } else {
      profileMissingReason = "no_identity_or_channel";
    }
    res.json({
      id: reply.id,
      conversation_id: reply.conversation_id,
      prompt_name: reply.prompt_name,
      reply_text: reply.reply_text,
      context: reply.context,
      is_favorite: reply.is_favorite,
      created_at: reply.created_at,
      identity_id: identityId,
      channel: channel,
      validation,
      profile_missing_reason: profileMissingReason,
    });
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

// ---------- 6 · Registre des modèles + settings globaux ----------
// CRUD modèles d'inférence Bedrock. Le préfixe du model_id identifie le
// provider (eu.anthropic.*, meta.*, mistral.*…), pas besoin de le stocker
// à part. Soft delete via is_archived — préserve les FK historiques sur
// analyses/batches.
evalRouter.get(
  "/models",
  wrap(async (req, res) => {
    const includeArchived = req.query.archived === "1";
    res.json(await db.listModels(includeArchived));
  }),
);

// Parse prix optionnel : `undefined` = champ non envoyé (no-op côté update) ;
// `null` = explicitement effacé (NULL en DB) ; nombre ≥ 0 = nouvelle valeur.
// Tout le reste (string non numérique, négatif, NaN) → 400.
const parsePriceField = (
  v: unknown,
): number | null | undefined | "INVALID" => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n < 0) return "INVALID";
  return n;
};

evalRouter.post(
  "/models",
  wrap(async (req, res) => {
    const label = String(req.body?.label ?? "").trim();
    const modelId = String(req.body?.modelId ?? "").trim();
    if (!label || !modelId) {
      res.status(400).json({ error: "label et modelId sont requis" });
      return;
    }
    const priceIn = parsePriceField(req.body?.priceInputPerMtok);
    const priceOut = parsePriceField(req.body?.priceOutputPerMtok);
    if (priceIn === "INVALID" || priceOut === "INVALID") {
      res
        .status(400)
        .json({ error: "prix invalides (USD / Mtok, nombre ≥ 0 ou null)" });
      return;
    }
    try {
      const m = await db.createModel({
        label,
        modelId,
        priceInputPerMtok: priceIn,
        priceOutputPerMtok: priceOut,
      });
      res.json(m);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate|unique/i.test(msg)) {
        res.status(409).json({ error: "label ou modelId déjà existant" });
        return;
      }
      throw e;
    }
  }),
);

evalRouter.put(
  "/models/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id invalide" });
      return;
    }
    const label =
      req.body?.label !== undefined ? String(req.body.label).trim() : undefined;
    if (label !== undefined && label.length === 0) {
      res.status(400).json({ error: "label ne peut pas être vide" });
      return;
    }
    const priceIn = parsePriceField(req.body?.priceInputPerMtok);
    const priceOut = parsePriceField(req.body?.priceOutputPerMtok);
    if (priceIn === "INVALID" || priceOut === "INVALID") {
      res
        .status(400)
        .json({ error: "prix invalides (USD / Mtok, nombre ≥ 0 ou null)" });
      return;
    }
    try {
      const m = await db.updateModel(id, {
        label,
        priceInputPerMtok: priceIn,
        priceOutputPerMtok: priceOut,
      });
      if (!m) {
        res.status(404).json({ error: "modèle inconnu" });
        return;
      }
      res.json(m);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate|unique/i.test(msg)) {
        res.status(409).json({ error: "label déjà existant" });
        return;
      }
      throw e;
    }
  }),
);

evalRouter.delete(
  "/models/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id invalide" });
      return;
    }
    // Garde : un modèle défini comme default ne peut pas être archivé tant
    // qu'on n'a pas changé le default. Sinon les nouvelles analyses échoue
    // (no model configured) — comportement explicite.
    const currentDefault = await db.getSetting(db.SETTING_DEFAULT_MODEL_ID);
    if (currentDefault === id) {
      res
        .status(409)
        .json({ error: "default model, change settings first" });
      return;
    }
    const ok = await db.archiveModel(id);
    if (!ok) {
      res.status(404).json({ error: "modèle inconnu ou déjà archivé" });
      return;
    }
    res.json({ ok: true });
  }),
);

// Settings k/v générique : aujourd'hui un seul setting exposé en route
// dédiée (default_model_id) pour clarifier le contrat côté UI ; on pourra
// ajouter d'autres settings au même endpoint pattern.
evalRouter.get(
  "/settings/default-model",
  wrap(async (_req, res) => {
    const modelId = await db.getSetting(db.SETTING_DEFAULT_MODEL_ID);
    if (!modelId) {
      res.json({ modelId: null, model: null });
      return;
    }
    const m = await db.getModel(modelId);
    res.json({ modelId, model: m });
  }),
);

evalRouter.put(
  "/settings/default-model",
  wrap(async (req, res) => {
    const modelId = String(req.body?.modelId ?? "").trim();
    if (!UUID_RE.test(modelId)) {
      res.status(400).json({ error: "modelId invalide" });
      return;
    }
    const m = await db.getModel(modelId);
    if (!m) {
      res.status(400).json({ error: "modèle inconnu" });
      return;
    }
    if (m.is_archived) {
      res.status(400).json({ error: "modèle archivé" });
      return;
    }
    await db.setSetting(db.SETTING_DEFAULT_MODEL_ID, modelId);
    res.json({ modelId, model: m });
  }),
);

// ---------- 7 · Registre des endpoints MCP (admin) ----------
// Admin view of the registry: lists ALL rows (active + inactive + private) so
// the UI can toggle is_active / is_public. The MCP runtime uses
// `listEndpoints()` (filtered on active+public).
evalRouter.get(
  "/endpoints",
  wrap(async (_req, res) => {
    res.json(await db.listAllEndpoints());
  }),
);

// Flag toggle. No cache mutation, no SDK call: the next /mcp request reads
// the DB and sees the change.
evalRouter.patch(
  "/endpoints/:id/flags",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id invalide" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw_active = body.is_active;
    const raw_public = body.is_public;
    if (raw_active !== undefined && typeof raw_active !== "boolean") {
      res.status(400).json({ error: "is_active must be a boolean" });
      return;
    }
    if (raw_public !== undefined && typeof raw_public !== "boolean") {
      res.status(400).json({ error: "is_public must be a boolean" });
      return;
    }
    if (raw_active === undefined && raw_public === undefined) {
      res
        .status(400)
        .json({ error: "at least one of is_active, is_public must be provided" });
      return;
    }
    const updated = await db.updateEndpointFlags(id, {
      is_active: raw_active,
      is_public: raw_public,
    });
    if (!updated) {
      res.status(404).json({ error: "endpoint inconnu" });
      return;
    }
    res.json(updated);
  }),
);

// CRUD endpoints. Create / update / delete rows of type `proxy` or `builtin`.
// Flags (is_active / is_public) stay on the dedicated PATCH /:id/flags route.

interface ParsedEndpointBody {
  name: string;
  type: string;
  description: string | null;
  config: unknown;
}

const parseEndpointBody = (
  raw: unknown,
):
  | { ok: true; value: ParsedEndpointBody }
  | { ok: false; status: number; error: string } => {
  const body = (raw ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const nameErr = validateEndpointName(name);
  if (nameErr) return { ok: false, status: 400, error: nameErr };

  const type = typeof body.type === "string" ? body.type : "";
  const schema =
    type === "proxy"
      ? proxyConfigSchema
      : type === "builtin"
        ? builtinConfigSchema
        : null;
  if (!schema) {
    return {
      ok: false,
      status: 400,
      error: 'type must be "proxy" or "builtin"',
    };
  }

  const description =
    body.description === undefined ||
    body.description === null ||
    body.description === ""
      ? null
      : String(body.description);

  const parsed = schema.safeParse(body.config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join(".") || "config";
    return {
      ok: false,
      status: 400,
      error: `config.${path}: ${issue?.message ?? "invalid"}`,
    };
  }

  return {
    ok: true,
    value: { name, type, description, config: parsed.data },
  };
};

evalRouter.post(
  "/endpoints",
  wrap(async (req, res) => {
    const parsed = parseEndpointBody(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    try {
      const row = await db.createEndpoint(parsed.value);
      res.status(201).json(row);
    } catch (e) {
      if (e instanceof db.EndpointNameConflictError) {
        res.status(409).json({ error: "name already exists" });
        return;
      }
      throw e;
    }
  }),
);

evalRouter.put(
  "/endpoints/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id invalide" });
      return;
    }
    const parsed = parseEndpointBody(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    // Pre-check to distinguish 404 (row absent) from 200/409 — otherwise an
    // UPDATE without a match silently returns null with no signal as to why.
    const existing = await db.getEndpoint(id);
    if (!existing) {
      res.status(404).json({ error: "endpoint not found" });
      return;
    }
    try {
      const row = await db.updateEndpoint(id, parsed.value);
      if (!row) {
        res.status(404).json({ error: "endpoint not found" });
        return;
      }
      res.json(row);
    } catch (e) {
      if (e instanceof db.EndpointNameConflictError) {
        res.status(409).json({ error: "name already exists" });
        return;
      }
      throw e;
    }
  }),
);

evalRouter.delete(
  "/endpoints/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id invalide" });
      return;
    }
    const ok = await db.deleteEndpoint(id);
    if (!ok) {
      res.status(404).json({ error: "endpoint not found" });
      return;
    }
    res.status(204).end();
  }),
);

// =============================================================================
// Identity stylometric profiles (LAGM-16436)
// =============================================================================
// Pattern miroir des batchs d'analyses : POST /batches crée la coquille +
// fige le périmètre, puis le client lance POST /analyze/:batchId/:identityId
// en parallèle pour chaque identité, et PATCH /batches/:id { status } à la
// fin. Aucun tool MCP — uniquement /eval.

const DEFAULT_IDENTITY_TOKEN_CAP = 10_000;
const MIN_IDENTITY_TOKEN_CAP = 500;
const MAX_IDENTITY_TOKEN_CAP = 200_000;

const parseIdentityChannel = (v: unknown): "LINKEDIN" | "EMAIL" | null => {
  if (typeof v !== "string") return null;
  const up = v.toUpperCase();
  if (up === "LINKEDIN" || up === "EMAIL") return up;
  return null;
};

evalRouter.post(
  "/identities/batches",
  wrap(async (req, res) => {
    const raw: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [
      ...new Set(raw.map((v) => String(v)).filter((s) => HEX24.test(s))),
    ];
    if (ids.length === 0) {
      res.status(400).json({ error: "aucune identité valide à analyser" });
      return;
    }
    const modelIdParam = req.body?.modelId
      ? String(req.body.modelId)
      : undefined;
    if (modelIdParam !== undefined && !UUID_RE.test(modelIdParam)) {
      res.status(400).json({ error: "modelId invalide" });
      return;
    }
    const resolved = await db.resolveEffectiveModelId(modelIdParam);

    const tokenCapRaw = parseInt(String(req.body?.tokenCap ?? ""), 10);
    const tokenCap =
      Number.isFinite(tokenCapRaw) && tokenCapRaw > 0
        ? Math.min(MAX_IDENTITY_TOKEN_CAP, Math.max(MIN_IDENTITY_TOKEN_CAP, tokenCapRaw))
        : DEFAULT_IDENTITY_TOKEN_CAP;

    const batch = await db.createIdentitiesBatch({
      sourceIds: ids,
      tokenCap,
      modelId: resolved.uuid,
    });
    res.json(batch);
  }),
);

evalRouter.post(
  "/identities/analyze/:batchId/:identityId",
  wrap(async (req, res) => {
    const batchId = String(req.params.batchId);
    const identityId = String(req.params.identityId);
    if (!UUID_RE.test(batchId)) {
      res.status(400).json({ error: "batchId invalide" });
      return;
    }
    if (!HEX24.test(identityId)) {
      res.status(400).json({ error: "identityId invalide" });
      return;
    }
    const channel = parseIdentityChannel(req.body?.channel);
    if (!channel) {
      res.status(400).json({ error: "channel doit être LINKEDIN ou EMAIL" });
      return;
    }
    const batch = await db.getIdentitiesBatch(batchId);
    if (!batch) {
      res.status(404).json({ error: "batch inconnu" });
      return;
    }
    // P1: garde le batch en `running` — refuse les appels sur done/aborted
    // (évite re-billing depuis un onglet zombie ou un PATCH partiel).
    if (batch.status !== "running") {
      res.status(409).json({ error: `batch ${batch.status} — analyse refusée` });
      return;
    }
    // P1: idempotence cheap : si une analyse `ok` existe déjà pour
    // (batch, identity, channel), renvoyer la même sans facturer une 2ᵉ
    // inférence. Le client peut retry sans risque.
    const existing = await db.findIdentityAnalysis(batchId, identityId, channel);
    if (existing && existing.status === "ok") {
      res.json({
        analysisId: existing.id,
        identityId,
        channel,
        status: "ok",
        payload: existing.payload,
      });
      return;
    }
    // Modèle figé par le batch (résolu à la création). Même contrat que les
    // analyses : on n'autorise pas le client à override per-analyse.
    if (!batch.model_id || !batch.model_aws_id) {
      res.status(409).json({
        error: "batch sans modèle résolu",
        code: "MODEL_NOT_CONFIGURED",
      });
      return;
    }

    try {
      const result = await analyzeIdentity({
        identityId,
        channel,
        model: batch.model_aws_id,
        tokenCap: batch.token_cap,
      });
      const inserted = await db.insertIdentityAnalysis({
        batchId,
        identityId,
        channel,
        status: "ok",
        payload: result.payload,
        modelId: batch.model_id,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
      });
      res.json({
        analysisId: inserted.id,
        identityId,
        channel,
        status: "ok",
        payload: result.payload,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // P18: l'insert "error" peut lui-même échouer (DB hiccup). On l'isole
      // dans son propre try pour ne pas masquer l'erreur d'origine, qui doit
      // continuer à remonter au wrap() (→ 500).
      try {
        const inserted = await db.insertIdentityAnalysis({
          batchId,
          identityId,
          channel,
          status: "error",
          payload: null,
          modelId: batch.model_id,
          errorMessage: msg,
        });
        res.json({
          analysisId: inserted.id,
          identityId,
          channel,
          status: "error",
          error: msg,
        });
        return;
      } catch (e2) {
        console.error(
          "[identity-profiles] failed to record error analysis:",
          e2,
        );
        throw e;
      }
    }
  }),
);

evalRouter.patch(
  "/identities/batches/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "batchId invalide" });
      return;
    }
    const status = req.body?.status;
    if (status !== "done" && status !== "aborted") {
      res.status(400).json({ error: "status doit être done|aborted" });
      return;
    }
    // P5: l'helper renvoie false si le batch n'est plus `running` (déjà
    // finalisé ou inexistant). On surface ça en 409 plutôt que retourner ok.
    const updated = await db.updateIdentitiesBatchStatus(id, status);
    if (!updated) {
      res
        .status(409)
        .json({ error: "batch already finalized or not found" });
      return;
    }
    res.json({ ok: true });
  }),
);

evalRouter.get(
  "/identities/batches/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "batchId invalide" });
      return;
    }
    const batch = await db.getIdentitiesBatch(id);
    if (!batch) {
      res.status(404).json({ error: "batch inconnu" });
      return;
    }
    res.json(batch);
  }),
);

evalRouter.get(
  "/identities/profiles",
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20),
    );
    res.json(await db.listIdentityProfiles(page, pageSize));
  }),
);

evalRouter.get(
  "/identities/profiles/:identityId/:channel",
  wrap(async (req, res) => {
    const identityId = String(req.params.identityId);
    const channel = parseIdentityChannel(req.params.channel);
    if (!HEX24.test(identityId)) {
      res.status(400).json({ error: "identityId invalide" });
      return;
    }
    if (!channel) {
      res.status(400).json({ error: "channel invalide" });
      return;
    }
    const profile = await db.getIdentityProfile(identityId, channel);
    if (!profile) {
      res.status(404).json({ error: "profil inconnu" });
      return;
    }
    res.json(profile);
  }),
);

evalRouter.get(
  "/identities/profiles/:identityId/:channel/conversations",
  wrap(async (req, res) => {
    const identityId = String(req.params.identityId);
    const channel = parseIdentityChannel(req.params.channel);
    if (!HEX24.test(identityId)) {
      res.status(400).json({ error: "identityId invalide" });
      return;
    }
    if (!channel) {
      res.status(400).json({ error: "channel invalide" });
      return;
    }
    const convs = await db.listConversationsByIdentity(identityId, channel);
    res.json({ rows: convs });
  }),
);
