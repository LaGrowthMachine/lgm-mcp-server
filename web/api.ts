import axios from "axios";

export const http = axios.create({ baseURL: "/api/eval" });

export interface DiscoverResp {
  users: number;
  count: number;
  ids: string[];
  perUser: { userId: string; ids: string[] }[];
}

export interface VsCanon {
  verdict: "match" | "diff" | "incomparable";
  changes: string[];
}

export interface AnalyzeResp {
  conversationId: string;
  analysisId: string;
  promptName: string;
  status: string;
  analysis: Record<string, unknown>;
  hasCanon: boolean;
  vsCanon: VsCanon;
}

// Message structuré du transcript (cf. conversationFormatter.ts côté serveur).
// Tolérant : les anciens transcripts non re-analysés sont des strings brutes.
export interface ConvMsg {
  role: "LEAD" | "SENDER";
  at: number;
  channel: "LINKEDIN" | "EMAIL" | "OTHER";
  subject?: string;
  text: string;
}
export type TranscriptItem = ConvMsg | string;

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

export interface ConvListResp {
  rows: ConvListRow[];
  total: number;
  metrics: ConvListMetrics;
}

export interface AnalysisRow {
  id: string;
  prompt_name: string | null;
  status: string;
  is_canon: boolean;
  edited_at: string | null; // ≠ null ⇒ classification éditée à la main
  created_at: string;
  payload: {
    conversation: TranscriptItem[];
    analysis: Record<string, unknown>;
  };
  model_id: string | null;
  model_label: string | null;
  model_aws_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
}

export interface ReplyRowApi {
  id: string;
  conversation_id: string;
  prompt_name: string;
  reply_text: string;
  context: Record<string, unknown>;
  is_favorite: boolean;
  created_at: string;
}

export interface ConvDetail {
  conversation_id: string;
  is_favorite: boolean;
  transcript: TranscriptItem[];
  analyses: AnalysisRow[];
  replies: ReplyRowApi[];
}

export interface GenerateReplyResp {
  conversationId: string;
  replyId: string | null;
  promptName: string;
  status: "ok" | "skipped";
  reason?: string;
  replyText: string | null;
  hasFavorite: boolean;
  vsFavorite: VsCanon;
}

export interface ReplyListItem {
  id: string;
  conversation_id: string;
  prompt_name: string;
  is_favorite: boolean;
  created_at: string;
  preview: string;
}

export type PromptKind = "analysis" | "reply";
export type PromptStatus = "draft" | "validated";

export interface PromptListItem {
  kind: PromptKind;
  name: string;
  is_active: boolean; // = live (1 seul par famille)
  status: PromptStatus;
  used: boolean; // a produit ≥1 analyse/réponse → non supprimable
  validated_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- batchs d'analyses ----------
// Cf. src/eval/db.ts. Un batch = un lancement (liste d'IDs ou favorites). Les
// KPIs vivent côté serveur (recompute on the fly depuis le canon courant).
export type BatchStatus = "running" | "done" | "aborted";
export type BatchSource = "ids" | "favorites";
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
  pass_rate: number | null;
  by_label: LabelBreakdownRow[];
  by_sub_label: LabelBreakdownRow[];
  n_input_tokens: number | null;
  n_output_tokens: number | null;
  n_cache_read_tokens: number | null;
  cost_usd: number | null;
}

export interface BatchListResp {
  rows: BatchListItem[];
  total: number;
}

export interface BatchDetailResp {
  batch: BatchRow;
  rows: BatchAnalysisItem[];
  metrics: BatchMetrics;
}

// ---------- registre des modèles + settings ----------
export interface Model {
  id: string;
  label: string;
  aws_model_id: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  // Prix unitaire USD / million de tokens. NULL ⇒ modèle sans prix configuré.
  price_input_per_mtok: number | null;
  price_output_per_mtok: number | null;
}

export interface DefaultModelResp {
  modelId: string | null;
  model: Model | null;
}

// ---------- MCP endpoints registry (admin) ----------
// Admin view: all rows incl. inactive/private. The MCP runtime uses a
// separate server route filtered on active+public.
export type EndpointType = "proxy" | "builtin";

// Mirror of `BUILTIN_HANDLERS` in src/endpoints/types.ts. The two bundles
// don't share a rootDir; keep both arrays in sync. Adding a handler here AND
// in the server-side array is required for it to be selectable from the form.
export const BUILTIN_HANDLERS = [
  "analyze_conversation",
  "explore_db",
] as const;
export type BuiltinHandler = (typeof BUILTIN_HANDLERS)[number];

export interface EndpointRow {
  id: string;
  name: string;
  type: EndpointType;
  description: string | null;
  is_active: boolean;
  is_public: boolean;
  config: unknown;
  created_at: string;
  updated_at: string;
}

export const listEndpoints = async (): Promise<EndpointRow[]> =>
  http.get<EndpointRow[]>("/endpoints").then((r) => r.data);

export const patchEndpointFlags = async (
  id: string,
  flags: { is_active?: boolean; is_public?: boolean },
): Promise<EndpointRow> =>
  http.patch<EndpointRow>(`/endpoints/${id}/flags`, flags).then((r) => r.data);

// Flag changes go through PATCH /flags; this payload is for the full CRUD.
// Input refinements (enum/pattern/format/min/max) are round-tripped even when
// the form has no dedicated control for them — editing a row that carries
// them shouldn't lose them.
export interface EndpointInputConfigInput {
  name: string;
  kind: "string" | "number" | "boolean";
  optional?: boolean;
  default?: unknown;
  describe: string;
  enum?: string[];
  pattern?: string;
  pattern_message?: string;
  format?: "url";
  min?: number;
  max?: number;
}

export interface ProxyEndpointConfig {
  method: "GET" | "POST";
  path: string;
  label?: string;
  title?: string;
  tracking_event?: string;
  destructive_hint?: boolean;
  inputs: EndpointInputConfigInput[];
}

export interface BuiltinEndpointConfig {
  handler: BuiltinHandler;
  label?: string;
  title?: string;
  tracking_event?: string;
  inputs: EndpointInputConfigInput[];
}

export type EndpointInput =
  | {
      name: string;
      type: "proxy";
      description?: string | null;
      config: ProxyEndpointConfig;
    }
  | {
      name: string;
      type: "builtin";
      description?: string | null;
      config: BuiltinEndpointConfig;
    };

export const createEndpoint = async (
  input: EndpointInput,
): Promise<EndpointRow> =>
  http.post<EndpointRow>("/endpoints", input).then((r) => r.data);

export const updateEndpoint = async (
  id: string,
  input: EndpointInput,
): Promise<EndpointRow> =>
  http.put<EndpointRow>(`/endpoints/${id}`, input).then((r) => r.data);

export const deleteEndpoint = async (id: string): Promise<void> => {
  await http.delete(`/endpoints/${id}`);
};
