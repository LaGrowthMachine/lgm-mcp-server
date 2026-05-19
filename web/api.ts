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
}

export interface AnalysisRow {
  id: string;
  prompt_name: string | null;
  status: string;
  is_canon: boolean;
  created_at: string;
  payload: {
    conversation: TranscriptItem[];
    analysis: Record<string, unknown>;
  };
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
