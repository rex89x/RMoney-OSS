import type { LucideIcon } from 'lucide-react';

export type AnalysisKind =
  | 'monthlyReview' | 'subscriptionAudit' | 'portfolioReview' | 'transactionCleanup' | 'tripReview';

export interface AnalysisDefinition {
  kind: AnalysisKind;
  title: string;
  description: string;
  /** Claude 會自己查詢的資料範圍，顯示在確認框讓使用者知道它可能讀到什麼 */
  dataScope: string;
  icon: LucideIcon;
  needsMonth: boolean;
  /** 可以指定旅程（不指定就由 Claude 自己挑規劃中 / 進行中的） */
  needsTrip?: boolean;
}

export interface AnalysisRequest {
  kind: AnalysisKind;
  month?: string;
  tripId?: string;
  /** 使用者想特別關注的重點（選填） */
  focus?: string;
}

export interface AnalysisEstimate {
  kind: AnalysisKind;
  title: string;
  model: string;
  /** 基礎 prompt（system + 工具定義 + 任務）的 tokens，由 count_tokens 精算 */
  inputTokens: number;
  /** 含多輪工具查詢後的累計 input 估計區間 */
  inputTokensRange: [number, number];
  outputTokensRange: [number, number];
  costUSDRange: [number, number];
  maxCostUSD: number;
  maxRounds: number;
  cycleSpentUSD: number;
  creditUSD: number;
}

export interface AnalysisToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface AnalysisResult {
  kind: AnalysisKind;
  title: string;
  markdown: string;
  truncated: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  generatedAt: string;
  month?: string;
  /** Claude 這次自己查了哪些資料（舊版結果沒有這個欄位） */
  toolCalls?: AnalysisToolCall[];
  rounds?: number;
}
