import { Pool } from "pg";

// Persistance durable de l'historique des analyses du harness d'éval.
// Le FS Heroku est éphémère (wipé à chaque deploy) → Postgres add-on.
// Voir spec conv-eval-harness (défaut critique #2, décision D6).

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

const buildPool = (connectionString: string): Pool => {
  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  return new Pool({
    connectionString,
    // Heroku Postgres impose TLS avec certs auto-signés.
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
};

export const getPool = (): Pool => {
  if (pool) return pool;
  const cs = process.env.DATABASE_URL;
  if (!cs) {
    throw new Error(
      "DATABASE_URL env var is not set (Heroku Postgres add-on requis pour le harness d'éval).",
    );
  }
  pool = buildPool(cs);
  // pg gère la reconnexion par client ; on garde le pool, on log juste.
  pool.on("error", (err) => {
    console.error(`[eval] pg pool error: ${err.message}`);
  });
  return pool;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conv_eval_analyses (
  id              BIGSERIAL   PRIMARY KEY,
  conversation_id TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_version  TEXT,
  status          TEXT        NOT NULL,
  payload         JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS conv_eval_conv_ts
  ON conv_eval_analyses (conversation_id, created_at DESC);
`;

// Idempotent, mémoïsé. Appelé paresseusement avant tout accès.
export const ensureSchema = async (): Promise<void> => {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((e) => {
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
};

export interface AnalysisRow {
  id: string;
  conversationId: string;
  createdAt: string;
  promptVersion: string | null;
  status: string;
  payload: unknown;
}

const rowToAnalysis = (r: Record<string, unknown>): AnalysisRow => ({
  id: String(r.id),
  conversationId: String(r.conversation_id),
  createdAt:
    r.created_at instanceof Date
      ? r.created_at.toISOString()
      : String(r.created_at),
  promptVersion: r.prompt_version == null ? null : String(r.prompt_version),
  status: String(r.status),
  payload: r.payload,
});

export const insertAnalysis = async (args: {
  conversationId: string;
  promptVersion: string | null;
  status: string;
  payload: unknown;
}): Promise<void> => {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO conv_eval_analyses (conversation_id, prompt_version, status, payload)
     VALUES ($1, $2, $3, $4)`,
    [
      args.conversationId,
      args.promptVersion,
      args.status,
      JSON.stringify(args.payload),
    ],
  );
};

// Les 2 dernières analyses d'une conv (la base du diff anti-régression).
export const getLastTwoAnalyses = async (
  conversationId: string,
): Promise<AnalysisRow[]> => {
  await ensureSchema();
  const res = await getPool().query(
    `SELECT id, conversation_id, created_at, prompt_version, status, payload
       FROM conv_eval_analyses
      WHERE conversation_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 2`,
    [conversationId],
  );
  return res.rows.map(rowToAnalysis);
};

// Toutes les convs ayant au moins une analyse, + leur compte (pour la
// section diff et la progression).
export const listConversationsWithCounts = async (): Promise<
  { conversationId: string; count: number; lastAt: string }[]
> => {
  await ensureSchema();
  const res = await getPool().query(
    `SELECT conversation_id,
            COUNT(*)::int       AS count,
            MAX(created_at)     AS last_at
       FROM conv_eval_analyses
      GROUP BY conversation_id
      ORDER BY MAX(created_at) DESC`,
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    conversationId: String(r.conversation_id),
    count: Number(r.count),
    lastAt:
      r.last_at instanceof Date ? r.last_at.toISOString() : String(r.last_at),
  }));
};

// Nombre de convs (parmi `ids`) ayant ≥1 analyse — progression section 2.
export const countAnalyzedAmong = async (
  ids: string[],
): Promise<number> => {
  if (ids.length === 0) return 0;
  await ensureSchema();
  const res = await getPool().query(
    `SELECT COUNT(DISTINCT conversation_id)::int AS n
       FROM conv_eval_analyses
      WHERE conversation_id = ANY($1::text[])`,
    [ids],
  );
  return Number(res.rows[0]?.n ?? 0);
};
