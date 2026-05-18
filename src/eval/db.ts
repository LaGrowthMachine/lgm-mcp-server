import { Pool } from "pg";
import {
  buildClassifierSystemPrompt,
  CONVERSATION_CLASSIFIER_VERSION,
} from "../agents/conversation-analyzer/conversationClassifier";

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
    CREATE UNIQUE INDEX IF NOT EXISTS prompts_one_active
      ON prompts ((is_active)) WHERE is_active;

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
  `);

  // Seed du défaut si la table prompts est vide.
  const { rows } = await p.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM prompts",
  );
  if (rows[0].n === "0") {
    await p.query(
      `INSERT INTO prompts (name, body, is_active)
       VALUES ($1, $2, true)`,
      [CODE_DEFAULT_PROMPT_NAME, CODE_DEFAULT_PROMPT_BODY],
    );
    console.error(
      `[db] seed prompt par défaut "${CODE_DEFAULT_PROMPT_NAME}" (actif)`,
    );
  }
};

// ---------- prompts ----------
export interface PromptRow {
  name: string;
  body: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export const listPrompts = async (): Promise<
  Omit<PromptRow, "body">[]
> => {
  const { rows } = await getPool().query(
    `SELECT name, is_active, created_at, updated_at
     FROM prompts ORDER BY created_at DESC`,
  );
  return rows;
};

export const getPrompt = async (
  name: string,
): Promise<PromptRow | null> => {
  const { rows } = await getPool().query<PromptRow>(
    "SELECT * FROM prompts WHERE name = $1",
    [name],
  );
  return rows[0] ?? null;
};

export const getActivePrompt = async (): Promise<PromptRow | null> => {
  const { rows } = await getPool().query<PromptRow>(
    "SELECT * FROM prompts WHERE is_active LIMIT 1",
  );
  return rows[0] ?? null;
};

// Nom suivant : max(nom numérique) + 1, défaut "1".
export const nextPromptName = async (): Promise<string> => {
  const { rows } = await getPool().query<{ name: string }>(
    "SELECT name FROM prompts",
  );
  let max = 0;
  for (const r of rows) {
    const n = parseInt(r.name, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
};

export const createPrompt = async (
  name: string,
  body: string,
): Promise<void> => {
  await getPool().query(
    "INSERT INTO prompts (name, body) VALUES ($1, $2)",
    [name, body],
  );
};

export const updatePrompt = async (
  name: string,
  body: string,
): Promise<void> => {
  await getPool().query(
    "UPDATE prompts SET body = $2, updated_at = now() WHERE name = $1",
    [name, body],
  );
};

export const deletePrompt = async (name: string): Promise<void> => {
  await getPool().query("DELETE FROM prompts WHERE name = $1", [name]);
};

export const activatePrompt = async (name: string): Promise<void> => {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE prompts SET is_active = false WHERE is_active");
    await client.query(
      "UPDATE prompts SET is_active = true, updated_at = now() WHERE name = $1",
      [name],
    );
    await client.query("COMMIT");
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
  transcript: string[],
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
  created_at: string;
  payload: unknown;
}

export const getConversationDetail = async (
  conversationId: string,
): Promise<{
  conversation_id: string;
  is_favorite: boolean;
  transcript: string[];
  analyses: AnalysisRow[];
} | null> => {
  const p = getPool();
  const c = await p.query(
    "SELECT conversation_id, is_favorite, transcript FROM conversations WHERE conversation_id = $1",
    [conversationId],
  );
  if (c.rows.length === 0) return null;
  const a = await p.query<AnalysisRow>(
    `SELECT id::text AS id, prompt_name, status, is_canon, created_at, payload
     FROM analyses WHERE conversation_id = $1 ORDER BY created_at DESC`,
    [conversationId],
  );
  return {
    conversation_id: c.rows[0].conversation_id,
    is_favorite: c.rows[0].is_favorite,
    transcript: c.rows[0].transcript,
    analyses: a.rows,
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
    `SELECT id::text AS id, prompt_name, status, is_canon, created_at, payload
     FROM analyses WHERE conversation_id = $1 AND is_canon LIMIT 1`,
    [conversationId],
  );
  return rows[0] ?? null;
};
