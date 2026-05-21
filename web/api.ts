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
}

export interface DefaultModelResp {
  modelId: string | null;
  model: Model | null;
}
