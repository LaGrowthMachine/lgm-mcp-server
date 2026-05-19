import { Pool } from "pg";
import {
  buildClassifierSystemPrompt,
  CONVERSATION_CLASSIFIER_VERSION,
} from "../agents/conversation-analyzer/conversationClassifier";
import { ConvMsg } from "../agents/conversation-analyzer/conversationFormatter";

// Le transcript stocké : nouveau format structuré. Tolérant en lecture aux
// anciennes lignes string[] (transcripts antérieurs, non re-analysés).
export type TranscriptItem = ConvMsg | string;
import {
  CODE_DEFAULT_REPLY_PROMPT_BODY,
  CODE_DEFAULT_REPLY_PROMPT_NAME,
} from "./replyPromptDefault";

// 2 familles de prompts versionnés indépendamment : 'analysis' (classifier)
// et 'reply' (génération de réponse, playbook DG). Même mécanique CRUD /
// version / actif, scoppée par `kind`.
export type PromptKind = "analysis" | "reply";

// Postgres : add-on Heroku (DATABASE_URL) en prod, docker local sinon.
// EVAL_DATABASE_URL prend le pas si défini (override explicite).
const CONN =
  process.env.EVAL_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://eval:eval@localhost:5433/eval";
const isLocalPg = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);

// Le défaut en dur (constante code) : utilisé comme fallback quand aucun
// prompt actif n'existe en DB, et seedé en DB au 1er lancement pour qu'il
// apparaisse dans le CRUD. Le placeholder {{DELIMITER}} est substitué par un
// délimiteur aléatoire à chaque inférence (défense prompt-injection).
export const CODE_DEFAULT_PROMPT_BODY =
  buildClassifierSystemPrompt("{{DELIMITER}}");
export const CODE_DEFAULT_PROMPT_NAME = CONVERSATION_CLASSIFIER_VERSION; // "v1"

let pool: Pool | null = null;
export const getPool = (): Pool => {
  if (!pool)
    pool = new Pool({
      connectionString: CONN,
      ssl: isLocalPg ? undefined : { rejectUnauthorized: false },
    });
  return pool;
};

export const ensureSchema = async (): Promise<void> => {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS prompts (
      name        TEXT PRIMARY KEY,
      body        TEXT NOT NULL,
      is_active   BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      transcript      JSONB NOT NULL,
      is_favorite     BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id              BIGSERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL
        REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      prompt_name     TEXT,
      status          TEXT NOT NULL,
      payload         JSONB NOT NULL,
      is_canon        BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS analyses_conv
      ON analyses (conversation_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS analyses_one_canon
      ON analyses (conversation_id) WHERE is_canon;

    -- Réponses générées : 1 ligne par (conv, version de prompt). Régénérer
    -- avec la même version écrase (cf. upsertReply). 1 seule favorite/conv
    -- (= la baseline validée, équivalent du canon des analyses).
    CREATE TABLE IF NOT EXISTS replies (
      id              BIGSERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL
        REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      prompt_name     TEXT NOT NULL,
      reply_text      TEXT NOT NULL,
      context         JSONB NOT NULL,
      is_favorite     BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS replies_conv_prompt
      ON replies (conversation_id, prompt_name);
    CREATE UNIQUE INDEX IF NOT EXISTS replies_one_favorite
      ON replies (conversation_id) WHERE is_favorite;
    CREATE INDEX IF NOT EXISTS replies_conv
      ON replies (conversation_id, created_at DESC);
  `);

  // Migration idempotente : ajout de `kind` (familles analysis/reply) et
  // passage de la PK prompts (name) → (kind, name) pour que "v1" coexiste
  // dans les 2 familles. L'ancien index "un seul actif" devient par-kind.
  await p.query(`
    ALTER TABLE prompts
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'analysis';
    DROP INDEX IF EXISTS prompts_one_active;
    CREATE UNIQUE INDEX IF NOT EXISTS prompts_one_active_per_kind
      ON prompts (kind) WHERE is_active;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'prompts_pkey' AND array_length(conkey, 1) = 2
      ) THEN
        ALTER TABLE prompts DROP CONSTRAINT IF EXISTS prompts_pkey;
        ALTER TABLE prompts ADD PRIMARY KEY (kind, name);
      END IF;
    END $$;
  `);

  // Cycle de vie prompt : draft (éditable) | validated (figé, sens unique).
  // Migration idempotente : colonne 'status' (défaut 'draft'), puis backfill
  // unique → le prompt actif de chaque famille devient 'validated' (il est
  // « en prod » ; seul un validated peut être actif). Le reste reste 'draft'.
  await p.query(`
    ALTER TABLE prompts
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
    ALTER TABLE prompts
      ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;
    UPDATE prompts SET status = 'validated', validated_at = now()
      WHERE is_active AND status <> 'validated';
  `);

  // Analyses éditables à la main : `edited_at` (NULL = jamais éditée).
  // Idempotent, non destructif.
  await p.query(`
    ALTER TABLE analyses
      ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
  `);

  // Seed par famille : défaut analysis (classifier) + défaut reply (playbook
  // DG), chacun actif si sa famille est vide.
  const seed = async (
    kind: PromptKind,
    name: string,
    body: string,
  ): Promise<void> => {
    const { rows } = await p.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM prompts WHERE kind = $1",
      [kind],
    );
    if (rows[0].n === "0") {
      await p.query(
        `INSERT INTO prompts (kind, name, body, is_active, status, validated_at)
         VALUES ($1, $2, $3, true, 'validated', now())`,
        [kind, name, body],
      );
      console.error(`[db] seed prompt ${kind} "${name}" (validé, live)`);
    }
  };
  await seed("analysis", CODE_DEFAULT_PROMPT_NAME, CODE_DEFAULT_PROMPT_BODY);
  await seed(
    "reply",
    CODE_DEFAULT_REPLY_PROMPT_NAME,
    CODE_DEFAULT_REPLY_PROMPT_BODY,
  );
};

// ---------- prompts ----------
// Cycle de vie : 'draft' (éditable, testable via run ad-hoc) → 'validated'
// (figé, sens unique). Le prompt « live » (MCP + défaut éval) = le DERNIER
// validé de la famille (max(validated_at)). Pas de flag « actif » séparé :
// valider promeut implicitement. Rollback = supprimer le validé fautif (le
// précédent redevient live) ou cloner un ancien en brouillon puis revalider.
export type PromptStatus = "draft" | "validated";

export interface PromptRow {
  kind: PromptKind;
  name: string;
  body: string;
  is_active: boolean; // vestige (legacy/seed) — non utilisé pour la sélection
  status: PromptStatus;
  validated_at: string | null;
  created_at: string;
  updated_at: string;
}

// `kind` par défaut 'analysis' : conserve la compat des appelants existants
// (analyzer.ts appelle getActivePrompt() sans argument).
export const listPrompts = async (
  kind: PromptKind = "analysis",
): Promise<(Omit<PromptRow, "body"> & { used: boolean })[]> => {
  const usedTable = kind === "reply" ? "replies" : "analyses";
  const { rows } = await getPool().query(
    `SELECT p.kind, p.name, p.is_active, p.status, p.validated_at,
            p.created_at, p.updated_at,
            EXISTS(
              SELECT 1 FROM ${usedTable} u WHERE u.prompt_name = p.name
            ) AS used
     FROM prompts p WHERE p.kind = $1 ORDER BY p.created_at DESC`,
    [kind],
  );
  return rows;
};

export const getPrompt = async (
  name: string,
  kind: PromptKind = "analysis",
): Promise<PromptRow | null> => {
  const { rows } = await getPool().query<PromptRow>(
    "SELECT * FROM prompts WHERE kind = $1 AND name = $2",
    [kind, name],
  );
  return rows[0] ?? null;
};

// Prompt « live » = le prompt explicitement promu (1 seul par famille, flag
// is_active). Utilisé par le tool MCP ET comme défaut de l'app d'éval.
export const getActivePrompt = async (
  kind: PromptKind = "analysis",
): Promise<PromptRow | null> => {
  const { rows } = await getPool().query<PromptRow>(
    "SELECT * FROM prompts WHERE kind = $1 AND is_active LIMIT 1",
    [kind],
  );
  return rows[0] ?? null;
};

// Un prompt est « utilisé » dès qu'une analyse/réponse porte son nom →
// non supprimable (traçabilité). L'édition reste régie par le statut.
export const isPromptUsed = async (
  name: string,
  kind: PromptKind = "analysis",
): Promise<boolean> => {
  const table = kind === "reply" ? "replies" : "analyses";
  const { rows } = await getPool().query<{ used: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM ${table} WHERE prompt_name = $1
     ) AS used`,
    [name],
  );
  return rows[0]?.used ?? false;
};

// Nom suivant harmonisé `vN` : on prend le plus grand suffixe numérique
// parmi les noms `vN` OU `N` (compat ancien) dans la famille, +1. Défaut "v1".
export const nextPromptName = async (
  kind: PromptKind = "analysis",
): Promise<string> => {
  const { rows } = await getPool().query<{ name: string }>(
    "SELECT name FROM prompts WHERE kind = $1",
    [kind],
  );
  let max = 0;
  for (const r of rows) {
    const m = /^v?(\d+)$/i.exec(r.name.trim());
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `v${max + 1}`;
};

export const createPrompt = async (
  name: string,
  body: string,
  kind: PromptKind = "analysis",
): Promise<void> => {
  await getPool().query(
    "INSERT INTO prompts (kind, name, body) VALUES ($1, $2, $3)",
    [kind, name, body],
  );
};

// Édition autorisée UNIQUEMENT sur un brouillon. Renvoie false si le prompt
// est validé (figé) ou introuvable → la route répond 409/404.
export const updatePrompt = async (
  name: string,
  body: string,
  kind: PromptKind = "analysis",
): Promise<boolean> => {
  const { rowCount } = await getPool().query(
    `UPDATE prompts SET body = $3, updated_at = now()
     WHERE kind = $1 AND name = $2 AND status = 'draft'`,
    [kind, name, body],
  );
  return (rowCount ?? 0) > 0;
};

export const deletePrompt = async (
  name: string,
  kind: PromptKind = "analysis",
): Promise<void> => {
  await getPool().query("DELETE FROM prompts WHERE kind = $1 AND name = $2", [
    kind,
    name,
  ]);
};

// Valide un brouillon (sens unique → contenu figé). NE met PAS live :
// la mise en live est une action explicite séparée (setLivePrompt).
// Renvoie false si déjà validé / introuvable → route 409/404.
export const validatePrompt = async (
  name: string,
  kind: PromptKind = "analysis",
): Promise<boolean> => {
  const { rowCount } = await getPool().query(
    `UPDATE prompts SET status = 'validated', validated_at = now(),
            updated_at = now()
     WHERE kind = $1 AND name = $2 AND status = 'draft'`,
    [kind, name],
  );
  return (rowCount ?? 0) > 0;
};

// Met un prompt « live » (1 seul par famille). Seul un `validated` peut
// l'être. Atomique : dé-live l'ancien, live le nouveau. Renvoie false si
// introuvable OU non validé → route 409/404.
export const setLivePrompt = async (
  name: string,
  kind: PromptKind = "analysis",
): Promise<boolean> => {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>(
      "SELECT status FROM prompts WHERE kind = $1 AND name = $2",
      [kind, name],
    );
    if (rows.length === 0 || rows[0].status !== "validated") {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      "UPDATE prompts SET is_active = false WHERE kind = $1 AND is_active",
      [kind],
    );
    await client.query(
      "UPDATE prompts SET is_active = true, updated_at = now() WHERE kind = $1 AND name = $2",
      [kind, name],
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

// ---------- conversations + analyses ----------
export const upsertConversation = async (
  conversationId: string,
  transcript: ConvMsg[],
): Promise<void> => {
  await getPool().query(
    `INSERT INTO conversations (conversation_id, transcript)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (conversation_id)
     DO UPDATE SET transcript = EXCLUDED.transcript, updated_at = now()`,
    [conversationId, JSON.stringify(transcript)],
  );
};

export const insertAnalysis = async (args: {
  conversationId: string;
  promptName: string | null;
  status: string;
  payload: unknown;
}): Promise<{ id: string }> => {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO analyses (conversation_id, prompt_name, status, payload)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id::text AS id`,
    [
      args.conversationId,
      args.promptName,
      args.status,
      JSON.stringify(args.payload),
    ],
  );
  return rows[0];
};

export interface ConvListRow {
  conversation_id: string;
  is_favorite: boolean;
  analyses_count: number;
  has_canon: boolean;
  latest_at: string | null;
}

export const listConversations = async (
  page: number,
  pageSize: number,
  favoriteOnly: boolean,
): Promise<{ rows: ConvListRow[]; total: number }> => {
  const offset = (page - 1) * pageSize;
  const where = favoriteOnly ? "WHERE c.is_favorite" : "";
  const p = getPool();
  const totalRes = await p.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM conversations c ${where}`,
  );
  const { rows } = await p.query<ConvListRow>(
    `SELECT c.conversation_id,
            c.is_favorite,
            COALESCE(a.cnt, 0)::int   AS analyses_count,
            COALESCE(a.canon, false)  AS has_canon,
            a.latest_at
     FROM conversations c
     LEFT JOIN (
       SELECT conversation_id,
              count(*) AS cnt,
              bool_or(is_canon) AS canon,
              max(created_at) AS latest_at
       FROM analyses GROUP BY conversation_id
     ) a ON a.conversation_id = c.conversation_id
     ${where}
     ORDER BY a.latest_at DESC NULLS LAST, c.updated_at DESC
     LIMIT $1 OFFSET $2`,
    [pageSize, offset],
  );
  return { rows, total: parseInt(totalRes.rows[0].n, 10) };
};

export interface AnalysisRow {
  id: string;
  prompt_name: string | null;
  status: string;
  is_canon: boolean;
  edited_at: string | null;
  created_at: string;
  payload: unknown;
}

export const getConversationDetail = async (
  conversationId: string,
): Promise<{
  conversation_id: string;
  is_favorite: boolean;
  transcript: TranscriptItem[];
  analyses: AnalysisRow[];
  replies: ReplyRow[];
} | null> => {
  const p = getPool();
  const c = await p.query(
    "SELECT conversation_id, is_favorite, transcript FROM conversations WHERE conversation_id = $1",
    [conversationId],
  );
  if (c.rows.length === 0) return null;
  const a = await p.query<AnalysisRow>(
    `SELECT id::text AS id, prompt_name, status, is_canon, edited_at,
            created_at, payload
     FROM analyses WHERE conversation_id = $1 ORDER BY created_at DESC`,
    [conversationId],
  );
  const r = await p.query<ReplyRow>(
    `SELECT id::text AS id, conversation_id, prompt_name, reply_text,
            context, is_favorite, created_at
     FROM replies WHERE conversation_id = $1
     ORDER BY is_favorite DESC, created_at DESC`,
    [conversationId],
  );
  return {
    conversation_id: c.rows[0].conversation_id,
    is_favorite: c.rows[0].is_favorite,
    transcript: c.rows[0].transcript,
    analyses: a.rows,
    replies: r.rows,
  };
};

export const setFavorite = async (
  conversationId: string,
  value: boolean,
): Promise<void> => {
  await getPool().query(
    "UPDATE conversations SET is_favorite = $2, updated_at = now() WHERE conversation_id = $1",
    [conversationId, value],
  );
};

export const deleteConversation = async (
  conversationId: string,
): Promise<void> => {
  await getPool().query(
    "DELETE FROM conversations WHERE conversation_id = $1",
    [conversationId],
  );
};

export const favoriteConversationIds = async (): Promise<string[]> => {
  const { rows } = await getPool().query<{ conversation_id: string }>(
    "SELECT conversation_id FROM conversations WHERE is_favorite ORDER BY updated_at DESC",
  );
  return rows.map((r) => r.conversation_id);
};

// Marque une analyse comme canon (déstitue l'ancienne canon de la même conv).
export const setCanon = async (analysisId: string): Promise<void> => {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM analyses WHERE id = $1",
      [analysisId],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return;
    }
    const conv = rows[0].conversation_id;
    await client.query(
      "UPDATE analyses SET is_canon = false WHERE conversation_id = $1 AND is_canon",
      [conv],
    );
    await client.query(
      "UPDATE analyses SET is_canon = true WHERE id = $1",
      [analysisId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

export const deleteAnalysis = async (analysisId: string): Promise<void> => {
  await getPool().query("DELETE FROM analyses WHERE id = $1", [analysisId]);
};

// Analyse canon d'une conv (pour comparer une nouvelle analyse au canon).
export const getCanonAnalysis = async (
  conversationId: string,
): Promise<AnalysisRow | null> => {
  const { rows } = await getPool().query<AnalysisRow>(
    `SELECT id::text AS id, prompt_name, status, is_canon, edited_at,
            created_at, payload
     FROM analyses WHERE conversation_id = $1 AND is_canon LIMIT 1`,
    [conversationId],
  );
  return rows[0] ?? null;
};

// Réécrit payload.analysis.classification et estampille edited_at.
// status / promptVersion / transcript intacts. false si introuvable → 404.
export const updateAnalysisClassification = async (
  analysisId: string,
  classification: unknown,
): Promise<boolean> => {
  const p = getPool();
  const { rows } = await p.query<{ payload: unknown }>(
    "SELECT payload FROM analyses WHERE id = $1",
    [analysisId],
  );
  if (rows.length === 0) return false;
  const payload = (rows[0].payload ?? {}) as Record<string, unknown>;
  const analysis = (payload.analysis ?? {}) as Record<string, unknown>;
  analysis.classification = classification;
  payload.analysis = analysis;
  await p.query(
    "UPDATE analyses SET payload = $2::jsonb, edited_at = now() WHERE id = $1",
    [analysisId, JSON.stringify(payload)],
  );
  return true;
};

// ---------- réponses ----------
export interface ReplyRow {
  id: string;
  conversation_id: string;
  prompt_name: string;
  reply_text: string;
  context: unknown;
  is_favorite: boolean;
  created_at: string;
}

// 1 réponse par (conv, version de prompt). Régénérer avec la même version
// écrase texte + contexte (la favorite éventuelle du slot est conservée).
export const upsertReply = async (args: {
  conversationId: string;
  promptName: string;
  replyText: string;
  context: unknown;
}): Promise<{ id: string }> => {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO replies (conversation_id, prompt_name, reply_text, context)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (conversation_id, prompt_name)
     DO UPDATE SET reply_text = EXCLUDED.reply_text,
                   context    = EXCLUDED.context,
                   created_at = now()
     RETURNING id::text AS id`,
    [
      args.conversationId,
      args.promptName,
      args.replyText,
      JSON.stringify(args.context ?? {}),
    ],
  );
  return rows[0];
};

// Réponse favoritée d'une conv = baseline de référence pour le diff batch.
export const getFavoriteReply = async (
  conversationId: string,
): Promise<ReplyRow | null> => {
  const { rows } = await getPool().query<ReplyRow>(
    `SELECT id::text AS id, conversation_id, prompt_name, reply_text,
            context, is_favorite, created_at
     FROM replies WHERE conversation_id = $1 AND is_favorite LIMIT 1`,
    [conversationId],
  );
  return rows[0] ?? null;
};

// (Dé)favorite une réponse. value=true ⇒ déstitue l'ancienne favorite de la
// même conv (1 seule favorite/conv). value=false ⇒ retire juste celle-ci.
export const setFavoriteReply = async (
  replyId: string,
  value: boolean,
): Promise<void> => {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM replies WHERE id = $1",
      [replyId],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return;
    }
    if (value) {
      await client.query(
        "UPDATE replies SET is_favorite = false WHERE conversation_id = $1 AND is_favorite",
        [rows[0].conversation_id],
      );
      await client.query(
        "UPDATE replies SET is_favorite = true WHERE id = $1",
        [replyId],
      );
    } else {
      await client.query(
        "UPDATE replies SET is_favorite = false WHERE id = $1",
        [replyId],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

export const deleteReply = async (replyId: string): Promise<void> => {
  await getPool().query("DELETE FROM replies WHERE id = $1", [replyId]);
};

// Liste globale des réponses (vue liste : clic → renvoie sur la conv).
export interface ReplyListRow {
  id: string;
  conversation_id: string;
  prompt_name: string;
  is_favorite: boolean;
  created_at: string;
  preview: string;
}

export const listReplies = async (
  page: number,
  pageSize: number,
): Promise<{ rows: ReplyListRow[]; total: number }> => {
  const offset = (page - 1) * pageSize;
  const p = getPool();
  const totalRes = await p.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM replies",
  );
  const { rows } = await p.query<ReplyListRow>(
    `SELECT id::text AS id, conversation_id, prompt_name, is_favorite,
            created_at, left(reply_text, 160) AS preview
     FROM replies
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [pageSize, offset],
  );
  return { rows, total: parseInt(totalRes.rows[0].n, 10) };
};
