import { Pool } from "pg";
import { randomUUID } from "crypto";
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
  if (!pool) {
    pool = new Pool({
      connectionString: CONN,
      ssl: isLocalPg ? undefined : { rejectUnauthorized: false },
    });
    // Sans ce listener, une erreur sur un client idle (ex : Postgres tue la
    // connexion en cas de shutdown / kill) remonte en `uncaughtException` et
    // crashe le process. Le `/mcp` per-request handler catche déjà les
    // erreurs de QUERY ; on veut juste éviter le crash en backgound.
    pool.on("error", (err) => {
      console.error("[pg] pool idle client error:", err.message);
    });
  }
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
      msg_count       INT,
      first_at        TIMESTAMPTZ,
      last_at         TIMESTAMPTZ,
      last_role       TEXT,
      channels        TEXT[],
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

  // Tokens consommés par appel d'inférence (Converse `usage`). NULL pour les
  // analyses legacy (avant cette feature) ET pour les analyses 'skipped'
  // (pas d'inférence appelée). Le coût est dérivé à la lecture via le prix
  // unitaire du modèle (table `models`) — pas de snapshot pour permettre
  // d'amender la grille tarifaire rétroactivement.
  await p.query(`
    ALTER TABLE analyses
      ADD COLUMN IF NOT EXISTS input_tokens       INT,
      ADD COLUMN IF NOT EXISTS output_tokens      INT,
      ADD COLUMN IF NOT EXISTS cache_read_tokens  INT;
  `);

  // Métas conversation dénormalisées (cache du transcript), peuplées à
  // l'upsert. Idempotent, non destructif ; lignes legacy = NULL (affichées
  // « — » et exclues des filtres, self-healing à la prochaine ré-analyse).
  await p.query(`
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS msg_count INT,
      ADD COLUMN IF NOT EXISTS first_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_role TEXT,
      ADD COLUMN IF NOT EXISTS channels  TEXT[];
    CREATE INDEX IF NOT EXISTS conversations_last_at
      ON conversations (last_at DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS conversations_msg_count
      ON conversations (msg_count);
  `);

  // Batchs d'analyses : tout lancement crée une ligne `batches`, et chaque
  // analyse insérée pendant ce lancement porte sa FK `batch_id`. Idempotent,
  // non destructif ; analyses legacy gardent `batch_id NULL` (invisibles
  // dans la liste batchs, intactes côté `/conversations`). `source_ids`
  // capture le périmètre demandé (résolu côté serveur), pour qu'on sache
  // après coup ce qui a fini ou pas même si workers ont été tués.
  await p.query(`
    CREATE TABLE IF NOT EXISTS batches (
      id           UUID PRIMARY KEY,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      status       TEXT NOT NULL DEFAULT 'running',
      prompt_name  TEXT,
      source       TEXT NOT NULL,
      input_count  INT  NOT NULL,
      source_ids   TEXT[] NOT NULL DEFAULT '{}'
    );
    ALTER TABLE batches
      ADD COLUMN IF NOT EXISTS source_ids TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE analyses
      ADD COLUMN IF NOT EXISTS batch_id UUID
        REFERENCES batches(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS analyses_batch
      ON analyses (batch_id) WHERE batch_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS batches_created_at
      ON batches (created_at DESC);
  `);

  // Registre des modèles d'inférence + table de settings k/v générique. Le
  // modèle utilisé par chaque analyse/batch est persisté (FK SET NULL en cas
  // de suppression, mais en pratique on soft-delete via is_archived).
  // Settings k/v générique pour configs globales (default_model_id, etc.).
  await p.query(`
    CREATE TABLE IF NOT EXISTS models (
      id           UUID PRIMARY KEY,
      label        TEXT NOT NULL UNIQUE,
      aws_model_id TEXT NOT NULL,
      is_archived  BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Renommage pour bases pré-existantes : models.model_id (string AWS)
    -- prête à confusion avec analyses.model_id (UUID FK). aws_model_id est
    -- explicite.
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'models' AND column_name = 'model_id'
      ) THEN
        ALTER TABLE models RENAME COLUMN model_id TO aws_model_id;
      END IF;
    END $$;
    DROP INDEX IF EXISTS models_model_id_uniq;
    CREATE UNIQUE INDEX IF NOT EXISTS models_aws_model_id_uniq
      ON models (aws_model_id);
    -- Index partiel : l'écrasante majorité des SELECT filtre is_archived=false
    -- et trie par label. Un B-tree complet sur le booléen seul ne servait à
    -- rien (sélectivité ~50/50).
    DROP INDEX IF EXISTS models_active;
    CREATE INDEX IF NOT EXISTS models_label_active
      ON models (label) WHERE is_archived = false;
    -- Cleanup pour bases pré-existantes : provider était une étiquette UI
    -- jamais lue pour l'appel Bedrock (le préfixe d'aws_model_id suffit).
    ALTER TABLE models DROP CONSTRAINT IF EXISTS models_provider_model_id_key;
    ALTER TABLE models DROP COLUMN IF EXISTS provider;

    -- Grille tarifaire : USD par million de tokens (input / output). NULL =
    -- modèle sans prix configuré → coût affiché "—" mais tokens visibles.
    -- Pas de snapshot par analyse : on recalcule à la lecture (cf. note plus
    -- haut sur la colonne tokens des analyses).
    ALTER TABLE models
      ADD COLUMN IF NOT EXISTS price_input_per_mtok  NUMERIC(12, 6),
      ADD COLUMN IF NOT EXISTS price_output_per_mtok NUMERIC(12, 6);

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE analyses
      ADD COLUMN IF NOT EXISTS model_id UUID REFERENCES models(id) ON DELETE SET NULL;
    ALTER TABLE batches
      ADD COLUMN IF NOT EXISTS model_id UUID REFERENCES models(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS analyses_model
      ON analyses (model_id) WHERE model_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS batches_model
      ON batches (model_id) WHERE model_id IS NOT NULL;
  `);

  // Seed non-destructif : row "Legacy (claude-sonnet-4-6)" archived pour
  // représenter le modèle pré-feature, puis backfill `model_id` NULL → cette
  // row. Idempotent : ON CONFLICT DO NOTHING + WHERE model_id IS NULL.
  // Sécurise la cohérence FK (toutes les lignes pointent vers une row models
  // valide après cette migration), tout en gardant la trace historique. Une
  // fois en place, on peut activer la garde "model_id NOT NULL" dans une
  // future migration si besoin.
  {
    const legacyId = "00000000-0000-0000-0000-000000000001";
    await p.query(
      `INSERT INTO models (id, label, aws_model_id, is_archived)
       VALUES ($1, 'Legacy (claude-sonnet-4-6)', 'claude-sonnet-4-6', true)
       ON CONFLICT (id) DO NOTHING`,
      [legacyId],
    );
    const a = await p.query(
      `UPDATE analyses SET model_id = $1 WHERE model_id IS NULL`,
      [legacyId],
    );
    const b = await p.query(
      `UPDATE batches SET model_id = $1 WHERE model_id IS NULL`,
      [legacyId],
    );
    if ((a.rowCount ?? 0) > 0 || (b.rowCount ?? 0) > 0) {
      console.error(
        `[db] backfill Legacy model: analyses=${a.rowCount ?? 0} batches=${b.rowCount ?? 0}`,
      );
    }
  }

  // MCP endpoints registry. One row = one MCP tool, typed by `type`
  // (proxy | builtin). `config` is a JSONB blob constrained by a Zod schema
  // per type (see src/endpoints/types.ts). The common columns (name, type,
  // is_active, is_public, description) are the stable shell; everything
  // type-specific lives in `config`.
  await p.query(`
    CREATE TABLE IF NOT EXISTS endpoints (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT UNIQUE NOT NULL,
      type        TEXT NOT NULL,
      description TEXT,
      is_active   BOOLEAN NOT NULL DEFAULT true,
      is_public   BOOLEAN NOT NULL DEFAULT true,
      config      JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS endpoints_active_public
      ON endpoints (name) WHERE is_active AND is_public;
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

  // Endpoint seeding lives outside the app: `scripts/seed-endpoints.sql`
  // (run via `npm run seed:endpoints`). The DB is the source of truth and
  // deletions are permanent.
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

interface ConvMeta {
  msgCount: number;
  firstAt: Date | null;
  lastAt: Date | null;
  lastRole: string | null;
  channels: string[];
}

// Métas dérivées du transcript, mises en cache en colonnes à l'upsert (un
// re-fetch les rafraîchit). Tolérant : n'exploite que les éléments objet
// avec `at` epoch ms > 0 ; un transcript legacy (string[]) donne
// msg_count seul, le reste NULL.
const deriveConvMeta = (transcript: TranscriptItem[]): ConvMeta => {
  const msgs = transcript.filter(
    (m): m is ConvMsg =>
      typeof m === "object" && m !== null && typeof m.at === "number",
  );
  let firstAt: number | null = null;
  let last: ConvMsg | null = null;
  for (const m of msgs) {
    if (m.at <= 0) continue;
    if (firstAt === null || m.at < firstAt) firstAt = m.at;
    if (last === null || m.at >= last.at) last = m;
  }
  const channels = [...new Set(msgs.map((m) => m.channel))];
  return {
    msgCount: transcript.length,
    firstAt: firstAt === null ? null : new Date(firstAt),
    lastAt: last ? new Date(last.at) : null,
    lastRole: last ? last.role : null,
    channels,
  };
};

export const upsertConversation = async (
  conversationId: string,
  transcript: ConvMsg[],
): Promise<void> => {
  const meta = deriveConvMeta(transcript);
  await getPool().query(
    `INSERT INTO conversations
       (conversation_id, transcript, msg_count, first_at, last_at,
        last_role, channels)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
     ON CONFLICT (conversation_id)
     DO UPDATE SET transcript = EXCLUDED.transcript,
                   msg_count  = EXCLUDED.msg_count,
                   first_at   = EXCLUDED.first_at,
                   last_at    = EXCLUDED.last_at,
                   last_role  = EXCLUDED.last_role,
                   channels   = EXCLUDED.channels,
                   updated_at = now()`,
    [
      conversationId,
      JSON.stringify(transcript),
      meta.msgCount,
      meta.firstAt,
      meta.lastAt,
      meta.lastRole,
      meta.channels,
    ],
  );
};

export const insertAnalysis = async (args: {
  conversationId: string;
  promptName: string | null;
  status: string;
  payload: unknown;
  batchId?: string;
  modelId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
  };
}): Promise<{ id: string }> => {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO analyses
       (conversation_id, prompt_name, status, payload, batch_id, model_id,
        input_tokens, output_tokens, cache_read_tokens)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
     RETURNING id::text AS id`,
    [
      args.conversationId,
      args.promptName,
      args.status,
      JSON.stringify(args.payload),
      args.batchId ?? null,
      args.modelId ?? null,
      args.usage?.inputTokens ?? null,
      args.usage?.outputTokens ?? null,
      args.usage?.cacheReadInputTokens ?? null,
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
  msg_count: number | null;
  first_at: string | null;
  last_at: string | null;
  last_role: string | null;
  channels: string[] | null;
}

export interface ConvListMetrics {
  count: number;
  favorites: number;
  with_canon: number;
  avg_messages: number | null;
  period_from: string | null;
  period_to: string | null;
}

export interface ConvListFilters {
  page: number;
  pageSize: number;
  favoriteOnly: boolean;
  hasCanon?: boolean;
  minMessages?: number;
  lastRole?: string;
  channel?: string;
  sort?: string;
  dir?: "asc" | "desc";
}

const CONV_SORT_COLS: Record<string, string> = {
  last_at: "c.last_at",
  first_at: "c.first_at",
  msg_count: "c.msg_count",
  latest_at: "a.latest_at",
};

export const listConversations = async (
  f: ConvListFilters,
): Promise<{
  rows: ConvListRow[];
  total: number;
  metrics: ConvListMetrics;
}> => {
  const offset = (f.page - 1) * f.pageSize;
  const cond: string[] = [];
  const args: unknown[] = [];
  if (f.favoriteOnly) cond.push("c.is_favorite");
  if (f.hasCanon !== undefined)
    cond.push(`COALESCE(a.canon, false) = $${args.push(f.hasCanon)}`);
  if (f.minMessages !== undefined)
    cond.push(`c.msg_count >= $${args.push(f.minMessages)}`);
  if (f.lastRole) cond.push(`c.last_role = $${args.push(f.lastRole)}`);
  if (f.channel) cond.push(`$${args.push(f.channel)} = ANY(c.channels)`);
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  // Sous-requête `a` groupée par conv ⇒ au plus 1 ligne/conv, pas de fan-out :
  // count(*) = nb de conversations, et les metrics portent sur le set filtré
  // entier (pas la page).
  const from = `
    FROM conversations c
    LEFT JOIN (
      SELECT conversation_id,
             count(*) AS cnt,
             bool_or(is_canon) AS canon,
             max(created_at) AS latest_at
      FROM analyses GROUP BY conversation_id
    ) a ON a.conversation_id = c.conversation_id
    ${where}`;
  const p = getPool();

  const mRes = await p.query<{
    count: string;
    favorites: string;
    with_canon: string;
    avg_messages: string | null;
    period_from: string | null;
    period_to: string | null;
  }>(
    `SELECT count(*)::text AS count,
            count(*) FILTER (WHERE c.is_favorite)::text AS favorites,
            count(*) FILTER (WHERE COALESCE(a.canon, false))::text AS with_canon,
            avg(c.msg_count)::numeric(10,1)::text AS avg_messages,
            min(c.first_at)::text AS period_from,
            max(c.last_at)::text  AS period_to
     ${from}`,
    args,
  );
  const m = mRes.rows[0];

  const sortCol = CONV_SORT_COLS[f.sort ?? "last_at"] ?? "c.last_at";
  const dir = f.dir === "asc" ? "ASC" : "DESC";
  const { rows } = await p.query<ConvListRow>(
    `SELECT c.conversation_id,
            c.is_favorite,
            COALESCE(a.cnt, 0)::int  AS analyses_count,
            COALESCE(a.canon, false) AS has_canon,
            a.latest_at::text        AS latest_at,
            c.msg_count,
            c.first_at::text         AS first_at,
            c.last_at::text          AS last_at,
            c.last_role,
            c.channels
     ${from}
     ORDER BY ${sortCol} ${dir} NULLS LAST, c.updated_at DESC
     LIMIT $${args.push(f.pageSize)} OFFSET $${args.push(offset)}`,
    args,
  );
  return {
    rows,
    total: parseInt(m.count, 10),
    metrics: {
      count: parseInt(m.count, 10),
      favorites: parseInt(m.favorites, 10),
      with_canon: parseInt(m.with_canon, 10),
      avg_messages: m.avg_messages === null ? null : parseFloat(m.avg_messages),
      period_from: m.period_from,
      period_to: m.period_to,
    },
  };
};

export interface AnalysisRow {
  id: string;
  prompt_name: string | null;
  status: string;
  is_canon: boolean;
  edited_at: string | null;
  created_at: string;
  payload: unknown;
  model_id: string | null;
  model_label: string | null;
  model_aws_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  // Coût USD = (input_tokens × price_input + output_tokens × price_output) / 1e6
  // Calculé à la lecture (LEFT JOIN models). NULL si modèle sans prix.
  cost_usd: number | null;
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
    `SELECT a.id::text AS id, a.prompt_name, a.status, a.is_canon, a.edited_at,
            a.created_at, a.payload,
            a.model_id::text AS model_id,
            m.label AS model_label,
            m.aws_model_id AS model_aws_id,
            a.input_tokens, a.output_tokens, a.cache_read_tokens,
            CASE
              WHEN a.input_tokens IS NULL
               AND a.output_tokens IS NULL THEN NULL
              WHEN m.price_input_per_mtok IS NULL
               AND m.price_output_per_mtok IS NULL THEN NULL
              ELSE
                COALESCE(a.input_tokens,  0)::numeric / 1e6
                  * COALESCE(m.price_input_per_mtok,  0)
              + COALESCE(a.output_tokens, 0)::numeric / 1e6
                  * COALESCE(m.price_output_per_mtok, 0)
            END::float8 AS cost_usd
     FROM analyses a
     LEFT JOIN models m ON m.id = a.model_id
     WHERE a.conversation_id = $1
     ORDER BY a.created_at DESC`,
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

// ---------- batchs d'analyses ----------
// Tout lancement client crée une ligne `batches`, et chaque analyse insérée
// pendant le lancement porte sa FK `batch_id`. KPIs (pass / regression /
// drift) recalculés au vol depuis le canon courant — pas de snapshot : si
// le canon change, les chiffres des batchs antérieurs se mettent à jour en
// conséquence. Scope strict : `suggested_label` + `suggested_sub_label`.
export type BatchStatus = "running" | "done" | "aborted";
export type BatchSource = "ids" | "favorites";
// `skipped` = l'analyseur a délibérément renoncé (ex. : pas de message du
// lead à classer). N'est ni une erreur ni un échec : pas de signal mais pas
// de défaut. Le `reason` explicatif vit dans `payload.analysis.reason`.
export type BatchVerdict =
  | "pass"
  | "regression"
  | "no_canon"
  | "skipped"
  | "error";

export interface BatchRow {
  id: string;
  created_at: string;
  completed_at: string | null;
  status: BatchStatus;
  prompt_name: string | null;
  source: BatchSource;
  input_count: number;
  source_ids: string[];
  model_id: string | null;
  model_label: string | null;
  model_aws_id: string | null;
}

export interface BatchListItem {
  id: string;
  created_at: string;
  completed_at: string | null;
  status: BatchStatus;
  prompt_name: string | null;
  source: BatchSource;
  input_count: number;
  n_total: number;
  n_pass: number;
  n_regression: number;
  n_no_canon: number;
  n_skipped: number;
  n_error: number;
  // Nombre d'analyses canon dans ce batch — alimente le warning du modal
  // de suppression côté UI (perte de canon explicite, pas de re-promotion
  // automatique). Source : COUNT(*) FILTER (WHERE a.is_canon) agrégé par
  // batch (cf. BATCH_JOIN_CTE).
  n_canon: number;
  model_label: string | null;
  n_input_tokens: number | null;
  n_output_tokens: number | null;
  n_cache_read_tokens: number | null;
  cost_usd: number | null;
}

export interface BatchAnalysisItem {
  analysis_id: string;
  conversation_id: string;
  status: string;
  is_canon: boolean;
  created_at: string;
  has_canon: boolean;
  new_label: string | null;
  new_sub_label: string | null;
  canon_label: string | null;
  canon_sub_label: string | null;
  reason: string | null;
  verdict: BatchVerdict;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
}

export interface LabelBreakdownRow {
  canon_label: string | null;
  canon_sub_label: string | null;
  n: number;
  pass: number;
  regression: number;
  drift_to: string | null;
}

export interface BatchMetrics {
  n_total: number;
  n_pass: number;
  n_regression: number;
  n_no_canon: number;
  n_skipped: number;
  n_error: number;
  n_with_canon: number;
  // Nombre d'analyses canon dans ce batch — utilisé par l'UI pour
  // conditionner le warning "K analyse(s) servent de canon" du modal de
  // suppression.
  n_canon: number;
  pass_rate: number | null;
  by_label: LabelBreakdownRow[];
  by_sub_label: LabelBreakdownRow[];
  // Agrégats coût/tokens — NULL si aucune analyse n'a remonté de tokens
  // (legacy + skipped only). Le coût est NULL si tous les rows pertinents
  // ont un modèle sans prix.
  n_input_tokens: number | null;
  n_output_tokens: number | null;
  n_cache_read_tokens: number | null;
  cost_usd: number | null;
}

// Jointure verdict — réutilisée par `listBatches` (agrégé) et
// `getBatchAnalyses` (détail). Compare la classification de chaque analyse
// du batch au canon courant de la conv (au plus 1 ligne par conv via
// l'index `analyses_one_canon`). Verdict cohérent et déterministe.
//
// Les tokens (input/output/cache_read) sont remontés ici et le coût USD est
// calculé via LEFT JOIN models (prix par Mtok). Coût NULL si modèle sans
// prix ; tokens NULL pour les analyses legacy + skipped.
const BATCH_JOIN_CTE = `
  batch_an AS (
    SELECT a.id::text AS analysis_id, a.batch_id, a.conversation_id,
           a.status, a.is_canon, a.created_at,
           a.input_tokens, a.output_tokens, a.cache_read_tokens,
           a.model_id,
           a.payload->'analysis'->'classification'->>'suggested_label'
             AS new_label,
           a.payload->'analysis'->'classification'->>'suggested_sub_label'
             AS new_sub_label,
           a.payload->'analysis'->>'reason' AS reason
    FROM analyses a
    WHERE a.batch_id IS NOT NULL
  ),
  canon_an AS (
    SELECT a.conversation_id,
           a.payload->'analysis'->'classification'->>'suggested_label'
             AS canon_label,
           a.payload->'analysis'->'classification'->>'suggested_sub_label'
             AS canon_sub_label
    FROM analyses a WHERE a.is_canon = true
  ),
  joined AS (
    SELECT b.*, c.canon_label, c.canon_sub_label,
           (c.conversation_id IS NOT NULL) AS has_canon,
           CASE
             WHEN b.status = 'skipped' THEN 'skipped'
             WHEN b.status <> 'ok'     THEN 'error'
             WHEN c.conversation_id IS NULL THEN 'no_canon'
             WHEN b.new_label     IS NOT DISTINCT FROM c.canon_label
              AND b.new_sub_label IS NOT DISTINCT FROM c.canon_sub_label
                THEN 'pass'
             ELSE 'regression'
           END AS verdict,
           CASE
             -- Pas de tokens persistés (legacy ou status='skipped') → cost
             -- NULL, sinon on remonterait 0 sur des analyses où on n'a
             -- jamais facturé.
             WHEN b.input_tokens IS NULL
              AND b.output_tokens IS NULL THEN NULL
             -- Modèle sans grille tarifaire → cost NULL (tokens visibles
             -- séparément).
             WHEN m.price_input_per_mtok  IS NULL
              AND m.price_output_per_mtok IS NULL THEN NULL
             ELSE
               COALESCE(b.input_tokens,  0)::numeric / 1e6
                 * COALESCE(m.price_input_per_mtok,  0)
             + COALESCE(b.output_tokens, 0)::numeric / 1e6
                 * COALESCE(m.price_output_per_mtok, 0)
           END::float8 AS cost_usd
    FROM batch_an b
    LEFT JOIN canon_an c USING (conversation_id)
    LEFT JOIN models m  ON m.id = b.model_id
  )
`;

const selectBatchColsWithModel = `b.id, b.created_at::text AS created_at,
  b.completed_at::text AS completed_at,
  b.status, b.prompt_name, b.source, b.input_count, b.source_ids,
  b.model_id::text AS model_id,
  m.label AS model_label,
  m.aws_model_id AS model_aws_id`;

export const createBatch = async (args: {
  promptName: string | null;
  source: BatchSource;
  sourceIds: string[];
  modelId?: string | null;
}): Promise<BatchRow> => {
  const id = randomUUID();
  const { rows } = await getPool().query<BatchRow>(
    `WITH inserted AS (
       INSERT INTO batches (id, prompt_name, source, input_count, source_ids, model_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *
     )
     SELECT ${selectBatchColsWithModel}
     FROM inserted b
     LEFT JOIN models m ON m.id = b.model_id`,
    [
      id,
      args.promptName,
      args.source,
      args.sourceIds.length,
      args.sourceIds,
      args.modelId ?? null,
    ],
  );
  return rows[0];
};

// Transition `running` → `done` ou `aborted` ; no-op si déjà terminal.
export const updateBatchStatus = async (
  id: string,
  status: "done" | "aborted",
): Promise<boolean> => {
  const { rowCount } = await getPool().query(
    `UPDATE batches
        SET status = $2, completed_at = now()
      WHERE id = $1 AND status = 'running'`,
    [id, status],
  );
  return (rowCount ?? 0) > 0;
};

// Suppression d'un batch + cascade applicative sur ses analyses.
// Transaction atomique : on supprime d'abord les analyses (FK
// `ON DELETE SET NULL` conservée — pas de cascade SQL pour préserver la
// flexibilité schéma), puis le batch lui-même. ROLLBACK automatique sur
// erreur entre les deux DELETE. La confirmation utilisateur est autoritaire
// (pas de guard `status='running'` ici).
// `batchExisted` = `RETURNING id` du DELETE batches a renvoyé une row :
// permet à la route de distinguer "supprimé" de "déjà supprimé par
// quelqu'un d'autre" sans pré-check `getBatch` non-transactionnel.
export const deleteBatch = async (
  id: string,
): Promise<{ deletedAnalyses: number; batchExisted: boolean }> => {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const analysesRes = await client.query(
      "DELETE FROM analyses WHERE batch_id = $1",
      [id],
    );
    const batchRes = await client.query(
      "DELETE FROM batches WHERE id = $1 RETURNING id",
      [id],
    );
    await client.query("COMMIT");
    return {
      deletedAnalyses: analysesRes.rowCount ?? 0,
      batchExisted: (batchRes.rowCount ?? 0) > 0,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

export const getBatch = async (id: string): Promise<BatchRow | null> => {
  const { rows } = await getPool().query<BatchRow>(
    `SELECT ${selectBatchColsWithModel}
     FROM batches b
     LEFT JOIN models m ON m.id = b.model_id
     WHERE b.id = $1`,
    [id],
  );
  return rows[0] ?? null;
};

export const listBatches = async (
  page: number,
  pageSize: number,
): Promise<{ rows: BatchListItem[]; total: number }> => {
  const offset = (page - 1) * pageSize;
  const p = getPool();
  const totalRes = await p.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM batches",
  );
  const { rows } = await p.query<BatchListItem>(
    `WITH ${BATCH_JOIN_CTE},
     agg AS (
       SELECT batch_id,
              count(*)::int                                       AS n_total,
              count(*) FILTER (WHERE verdict='pass')::int         AS n_pass,
              count(*) FILTER (WHERE verdict='regression')::int   AS n_regression,
              count(*) FILTER (WHERE verdict='no_canon')::int     AS n_no_canon,
              count(*) FILTER (WHERE verdict='skipped')::int      AS n_skipped,
              count(*) FILTER (WHERE verdict='error')::int        AS n_error,
              -- Analyses canon dans ce batch — alimente le warning du modal
              -- "K analyse(s) servent de canon pour leur conversation".
              count(*) FILTER (WHERE is_canon)::int               AS n_canon,
              -- bigint→int : SUM(int) renvoie bigint, qui sort en string
              -- côté node-postgres (perte de typing JS). int est suffisant
              -- (max ~2.1B ; un batch réaliste = 100k conv × 2k tok = 2e8).
              SUM(input_tokens)::int      AS n_input_tokens,
              SUM(output_tokens)::int     AS n_output_tokens,
              SUM(cache_read_tokens)::int AS n_cache_read_tokens,
              SUM(cost_usd)::float8       AS cost_usd
       FROM joined GROUP BY batch_id
     )
     SELECT b.id,
            b.created_at::text   AS created_at,
            b.completed_at::text AS completed_at,
            b.status, b.prompt_name, b.source, b.input_count,
            COALESCE(a.n_total, 0)      AS n_total,
            COALESCE(a.n_pass, 0)       AS n_pass,
            COALESCE(a.n_regression, 0) AS n_regression,
            COALESCE(a.n_no_canon, 0)   AS n_no_canon,
            COALESCE(a.n_skipped, 0)    AS n_skipped,
            COALESCE(a.n_error, 0)      AS n_error,
            COALESCE(a.n_canon, 0)      AS n_canon,
            a.n_input_tokens,
            a.n_output_tokens,
            a.n_cache_read_tokens,
            a.cost_usd,
            m.label                     AS model_label
       FROM batches b
       LEFT JOIN agg a ON a.batch_id = b.id
       LEFT JOIN models m ON m.id = b.model_id
      ORDER BY b.created_at DESC
      LIMIT $1 OFFSET $2`,
    [pageSize, offset],
  );
  return { rows, total: parseInt(totalRes.rows[0].n, 10) };
};

export const getBatchAnalyses = async (
  batchId: string,
): Promise<BatchAnalysisItem[]> => {
  const { rows } = await getPool().query<BatchAnalysisItem>(
    `WITH ${BATCH_JOIN_CTE}
     SELECT analysis_id, conversation_id, status, is_canon,
            created_at::text AS created_at,
            has_canon, new_label, new_sub_label,
            canon_label, canon_sub_label, reason, verdict,
            input_tokens, output_tokens, cache_read_tokens, cost_usd
       FROM joined
      WHERE batch_id = $1
      ORDER BY created_at ASC`,
    [batchId],
  );
  return rows;
};

// Aggrège le breakdown par label puis par (label, sub_label) à partir de
// la liste jointe — peu de lignes par batch, autant le faire en JS plutôt
// qu'en SQL gymnastique. `drift_to` = destination la plus fréquente parmi
// les régressions du bucket (libellé de la classe perdue).
export const computeBatchMetricsFromRows = (
  rows: BatchAnalysisItem[],
): BatchMetrics => {
  let n_pass = 0;
  let n_regression = 0;
  let n_no_canon = 0;
  let n_skipped = 0;
  let n_error = 0;
  let n_with_canon = 0;
  // Compte le nombre d'analyses qui SONT canon dans ce batch (≠ n_with_canon
  // qui compte les analyses dont la conv a un canon, quel qu'il soit). Sert
  // au warning du modal de suppression — perte explicite si > 0.
  let n_canon = 0;
  // NULL agrégés : on garde null tant qu'aucun row n'a remonté de tokens /
  // coût (= legacy ou batch tout-skipped). Premier row non-null bascule
  // l'accumulateur en number, et on additionne les autres en COALESCE(0).
  let n_input_tokens: number | null = null;
  let n_output_tokens: number | null = null;
  let n_cache_read_tokens: number | null = null;
  let cost_usd: number | null = null;
  const addNullable = (
    acc: number | null,
    v: number | null | undefined,
  ): number | null => {
    if (v == null) return acc;
    return (acc ?? 0) + v;
  };
  for (const r of rows) {
    if (r.has_canon) n_with_canon++;
    if (r.is_canon) n_canon++;
    if (r.verdict === "pass") n_pass++;
    else if (r.verdict === "regression") n_regression++;
    else if (r.verdict === "no_canon") n_no_canon++;
    else if (r.verdict === "skipped") n_skipped++;
    else if (r.verdict === "error") n_error++;
    n_input_tokens = addNullable(n_input_tokens, r.input_tokens);
    n_output_tokens = addNullable(n_output_tokens, r.output_tokens);
    n_cache_read_tokens = addNullable(n_cache_read_tokens, r.cache_read_tokens);
    cost_usd = addNullable(cost_usd, r.cost_usd);
  }
  const pass_rate =
    n_pass + n_regression > 0 ? n_pass / (n_pass + n_regression) : null;

  type Acc = {
    canon_label: string | null;
    canon_sub_label: string | null;
    n: number;
    pass: number;
    regression: number;
    drift: Map<string, number>;
  };
  const bucket = (
    keyOf: (r: BatchAnalysisItem) => string,
    canonOf: (
      r: BatchAnalysisItem,
    ) => { l: string | null; sl: string | null },
    destOf: (r: BatchAnalysisItem) => string | null,
  ): LabelBreakdownRow[] => {
    const m = new Map<string, Acc>();
    for (const r of rows) {
      if (r.verdict !== "pass" && r.verdict !== "regression") continue;
      const k = keyOf(r);
      let a = m.get(k);
      if (!a) {
        const ck = canonOf(r);
        a = {
          canon_label: ck.l,
          canon_sub_label: ck.sl,
          n: 0,
          pass: 0,
          regression: 0,
          drift: new Map(),
        };
        m.set(k, a);
      }
      a.n++;
      if (r.verdict === "pass") a.pass++;
      else {
        a.regression++;
        const d = destOf(r);
        if (d !== null) a.drift.set(d, (a.drift.get(d) ?? 0) + 1);
      }
    }
    return [...m.values()]
      .map((a) => ({
        canon_label: a.canon_label,
        canon_sub_label: a.canon_sub_label,
        n: a.n,
        pass: a.pass,
        regression: a.regression,
        drift_to:
          [...a.drift.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
      }))
      .sort((x, y) => y.n - x.n);
  };

  const by_label = bucket(
    (r) => `${r.canon_label ?? "__null__"}`,
    (r) => ({ l: r.canon_label, sl: null }),
    (r) => r.new_label,
  );
  const by_sub_label = bucket(
    (r) => `${r.canon_label ?? "__null__"}|${r.canon_sub_label ?? "__null__"}`,
    (r) => ({ l: r.canon_label, sl: r.canon_sub_label }),
    (r) => r.new_sub_label,
  );

  return {
    n_total: rows.length,
    n_pass,
    n_regression,
    n_no_canon,
    n_skipped,
    n_error,
    n_with_canon,
    n_canon,
    pass_rate,
    by_label,
    by_sub_label,
    n_input_tokens,
    n_output_tokens,
    n_cache_read_tokens,
    cost_usd,
  };
};

// =============================================================================
// Models registry + Settings (k/v) + resolution helper
// =============================================================================

export interface Model {
  id: string;
  label: string;
  aws_model_id: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  // Prix unitaire USD / million de tokens. NULL ⇒ coût non calculable
  // (les tokens restent visibles, le coût affiche "—").
  price_input_per_mtok: number | null;
  price_output_per_mtok: number | null;
}

// pg renvoie NUMERIC en string par défaut (perte de précision sinon). On
// caste explicitement en float côté SELECT → typage Model côté serveur OK.
const selectModelCols = `id::text AS id, label, aws_model_id,
  is_archived, created_at::text AS created_at, updated_at::text AS updated_at,
  price_input_per_mtok::float8  AS price_input_per_mtok,
  price_output_per_mtok::float8 AS price_output_per_mtok`;

export const listModels = async (
  includeArchived = false,
): Promise<Model[]> => {
  const { rows } = await getPool().query<Model>(
    `SELECT ${selectModelCols} FROM models
     ${includeArchived ? "" : "WHERE is_archived = false"}
     ORDER BY label ASC`,
  );
  return rows;
};

export const getModel = async (id: string): Promise<Model | null> => {
  const { rows } = await getPool().query<Model>(
    `SELECT ${selectModelCols} FROM models WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
};

export const createModel = async (args: {
  label: string;
  modelId: string;
  priceInputPerMtok?: number | null;
  priceOutputPerMtok?: number | null;
}): Promise<Model> => {
  const id = randomUUID();
  const { rows } = await getPool().query<Model>(
    `INSERT INTO models (id, label, aws_model_id,
                         price_input_per_mtok, price_output_per_mtok)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${selectModelCols}`,
    [
      id,
      args.label,
      args.modelId,
      args.priceInputPerMtok ?? null,
      args.priceOutputPerMtok ?? null,
    ],
  );
  return rows[0];
};

export const updateModel = async (
  id: string,
  args: {
    label?: string;
    priceInputPerMtok?: number | null;
    priceOutputPerMtok?: number | null;
  },
): Promise<Model | null> => {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (args.label !== undefined) {
    values.push(args.label);
    fields.push(`label = $${values.length}`);
  }
  if (args.priceInputPerMtok !== undefined) {
    values.push(args.priceInputPerMtok);
    fields.push(`price_input_per_mtok = $${values.length}`);
  }
  if (args.priceOutputPerMtok !== undefined) {
    values.push(args.priceOutputPerMtok);
    fields.push(`price_output_per_mtok = $${values.length}`);
  }
  if (fields.length === 0) return getModel(id);
  fields.push(`updated_at = now()`);
  values.push(id);
  const { rows } = await getPool().query<Model>(
    `UPDATE models SET ${fields.join(", ")}
     WHERE id = $${values.length}
     RETURNING ${selectModelCols}`,
    values,
  );
  return rows[0] ?? null;
};

export const archiveModel = async (id: string): Promise<boolean> => {
  const { rowCount } = await getPool().query(
    `UPDATE models SET is_archived = true, updated_at = now()
     WHERE id = $1 AND is_archived = false`,
    [id],
  );
  return (rowCount ?? 0) > 0;
};

// Settings k/v générique.
export const getSetting = async (key: string): Promise<string | null> => {
  const { rows } = await getPool().query<{ value: string }>(
    `SELECT value FROM settings WHERE key = $1`,
    [key],
  );
  return rows[0]?.value ?? null;
};

export const setSetting = async (
  key: string,
  value: string,
): Promise<void> => {
  await getPool().query(
    `INSERT INTO settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
};

export const SETTING_DEFAULT_MODEL_ID = "default_model_id";

// Erreur typée pour distinguer "config user manquante" (action user : aller
// dans /eval/settings) d'une vraie 500. Mappée en 409 dans routes.ts.
export class ModelNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelNotConfiguredError";
  }
}

// Résolution du modèle effectif. Priorité : modelId explicite (de la route)
// > settings.default_model_id > erreur claire (PAS de fallback env). Retourne
// { uuid, awsModelId }. Vérifie aussi is_archived (un modèle archivé ne peut
// être ni explicite ni default valide).
export const resolveEffectiveModelId = async (
  explicitModelId?: string | null,
): Promise<{ uuid: string; awsModelId: string }> => {
  const explicit = explicitModelId?.trim();
  if (explicit) {
    const m = await getModel(explicit);
    if (!m) throw new ModelNotConfiguredError(`Model not found: ${explicit}`);
    if (m.is_archived) {
      throw new ModelNotConfiguredError(`Model is archived: ${m.label}`);
    }
    return { uuid: m.id, awsModelId: m.aws_model_id };
  }
  const defaultId = await getSetting(SETTING_DEFAULT_MODEL_ID);
  if (!defaultId) {
    throw new ModelNotConfiguredError(
      "No inference model configured: set a default in /eval/settings or pass modelId.",
    );
  }
  const m = await getModel(defaultId);
  if (!m || m.is_archived) {
    throw new ModelNotConfiguredError(
      "Default model is missing or archived: update /eval/settings.",
    );
  }
  return { uuid: m.id, awsModelId: m.aws_model_id };
};

// =============================================================================
// Endpoints registry
// =============================================================================

export interface EndpointRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
  is_active: boolean;
  is_public: boolean;
  config: unknown;
  created_at: string;
  updated_at: string;
}

// Cast timestamps to text so pg returns ISO strings (rather than Date
// objects) — keeps the JSON payload stable.
const selectEndpointCols = `id::text AS id, name, type, description, is_active,
  is_public, config, created_at::text AS created_at,
  updated_at::text AS updated_at`;

// MCP runtime view: active + public, sorted by name (stable `tools/list`
// between boots — useful for regression diffs).
export const listEndpoints = async (): Promise<EndpointRow[]> => {
  const { rows } = await getPool().query<EndpointRow>(
    `SELECT ${selectEndpointCols}
       FROM endpoints
      WHERE is_active = true AND is_public = true
      ORDER BY name ASC`,
  );
  return rows;
};

// Admin view: every row, including inactive/private. The active+public
// filter stays reserved for the MCP runtime — the UI needs full state to
// toggle.
export const listAllEndpoints = async (): Promise<EndpointRow[]> => {
  const { rows } = await getPool().query<EndpointRow>(
    `SELECT ${selectEndpointCols}
       FROM endpoints
      ORDER BY name ASC`,
  );
  return rows;
};

// Admin flag toggle. UPDATE … RETURNING * — no cache mutation, no SDK call:
// the next /mcp request reads the DB and sees the change. Dynamic SET
// pattern mirrors updateModel.
export const updateEndpointFlags = async (
  id: string,
  flags: { is_active?: boolean; is_public?: boolean },
): Promise<EndpointRow | null> => {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (flags.is_active !== undefined) {
    values.push(flags.is_active);
    fields.push(`is_active = $${values.length}`);
  }
  if (flags.is_public !== undefined) {
    values.push(flags.is_public);
    fields.push(`is_public = $${values.length}`);
  }
  if (fields.length === 0) return null;
  fields.push(`updated_at = now()`);
  values.push(id);
  const { rows } = await getPool().query<EndpointRow>(
    `UPDATE endpoints SET ${fields.join(", ")}
      WHERE id = $${values.length}
      RETURNING ${selectEndpointCols}`,
    values,
  );
  return rows[0] ?? null;
};

// Thrown by createEndpoint/updateEndpoint when the UNIQUE(name) constraint
// is violated. The route layer maps it to a 409 Conflict.
export class EndpointNameConflictError extends Error {
  constructor(name: string) {
    super(`endpoint name already exists: ${name}`);
    this.name = "EndpointNameConflictError";
  }
}

const isUniqueViolation = (
  e: unknown,
): e is { code: string } =>
  !!e && typeof e === "object" && (e as { code?: unknown }).code === "23505";

export interface EndpointWriteInput {
  name: string;
  type: string;
  description?: string | null;
  config: unknown;
}

export const getEndpoint = async (
  id: string,
): Promise<EndpointRow | null> => {
  const { rows } = await getPool().query<EndpointRow>(
    `SELECT ${selectEndpointCols} FROM endpoints WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
};

// Create a row from the admin UI. Flags default to true/true; toggling them
// goes through PATCH /flags. Catches 23505 → EndpointNameConflictError so
// the route can map it to 409.
export const createEndpoint = async (
  input: EndpointWriteInput,
): Promise<EndpointRow> => {
  try {
    const { rows } = await getPool().query<EndpointRow>(
      `INSERT INTO endpoints (name, type, description, config)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING ${selectEndpointCols}`,
      [
        input.name,
        input.type,
        input.description ?? null,
        JSON.stringify(input.config ?? {}),
      ],
    );
    return rows[0];
  } catch (e) {
    if (isUniqueViolation(e)) throw new EndpointNameConflictError(input.name);
    throw e;
  }
};

// Full update from the admin UI. Does NOT touch flags (dedicated route).
// Updates name, type, description, config, updated_at. Returns null if the
// row doesn't exist.
export const updateEndpoint = async (
  id: string,
  input: EndpointWriteInput,
): Promise<EndpointRow | null> => {
  try {
    const { rows } = await getPool().query<EndpointRow>(
      `UPDATE endpoints
          SET name = $1,
              type = $2,
              description = $3,
              config = $4::jsonb,
              updated_at = now()
        WHERE id = $5
        RETURNING ${selectEndpointCols}`,
      [
        input.name,
        input.type,
        input.description ?? null,
        JSON.stringify(input.config ?? {}),
        id,
      ],
    );
    return rows[0] ?? null;
  } catch (e) {
    if (isUniqueViolation(e)) throw new EndpointNameConflictError(input.name);
    throw e;
  }
};

// Hard delete — no soft delete. To re-seed the initial rows on a fresh env,
// run `npm run seed:endpoints` (idempotent ON CONFLICT (name)).
export const deleteEndpoint = async (id: string): Promise<boolean> => {
  const { rowCount } = await getPool().query(
    `DELETE FROM endpoints WHERE id = $1`,
    [id],
  );
  return (rowCount ?? 0) > 0;
};
