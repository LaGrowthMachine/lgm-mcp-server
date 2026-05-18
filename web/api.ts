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
    conversation: string[];
    analysis: Record<string, unknown>;
  };
}

export interface ConvDetail {
  conversation_id: string;
  is_favorite: boolean;
  transcript: string[];
  analyses: AnalysisRow[];
}

export interface PromptListItem {
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
