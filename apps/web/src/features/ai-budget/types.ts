import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

/** 可在設定中選的 Claude 模型（後端 CLAUDE_SELECTABLE_MODELS_ 白名單要同步） */
export type ClaudeModel = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5' | 'claude-fable-5-2';

export const CLAUDE_MODELS: ClaudeModel[] = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-2',
];

export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'claude-opus-5-5';

export function isClaudeModel(value: unknown): value is ClaudeModel {
  return typeof value === 'string' && (CLAUDE_MODELS as string[]).includes(value);
}

export interface AiBudgetConfig {
  id: string;
  userId: string;
  /** 每個計費週期的 Claude API 額度（USD） */
  monthlyCreditUSD: number;
  /** 每月幾號（台北時間 00:00）重置，1–28 */
  cycleResetDay: number;
  warningPercent: number;
  hardStopEnabled: boolean;
  /** 行程 / 問答 / 分析 / 機票搜尋 */
  defaultModel: ClaudeModel;
  /** 收據 OCR / 匯入解析 / Telegram 快速記帳 */
  fastModel: ClaudeModel;
  lastAlertCycle: string | null;
  lastAlertLevel: string | null;
  updatedAt: Date;
}

export interface AiUsageTotals {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

export interface AiUsageBreakdown {
  requests: number;
  totalTokens: number;
  costUSD: number;
}

export interface AiUsageSummary {
  ok: true;
  cycleOffset: number;
  cycleStart: string;
  cycleEnd: string;
  resetDay: number;
  creditUSD: number;
  totals: AiUsageTotals;
  byFeature: Record<string, AiUsageBreakdown>;
  byModel: Record<string, AiUsageBreakdown>;
  byDay: Record<string, number>;
  usdToTwd: number;
  apiKeyConfigured: boolean;
  defaultModel: string;
  fastModel: string;
  priceVersion: string;
}

export interface AiForecast {
  spentUSD: number;
  remainingUSD: number;
  projectedUSD: number;
  usagePercent: number;
  projectedUsagePercent: number;
  elapsedDays: number;
  totalDays: number;
  daysLeft: number;
  /** 照目前速度，剩下的天數平均每天還能花多少 */
  dailyAllowanceUSD: number;
}

export interface AiScenarioInput {
  model: ClaudeModel;
  monthlyRequests: number;
  inputTokensPerRequest: number;
  outputTokensPerRequest: number;
  webSearchesPerMonth: number;
}

export const aiBudgetConfigConverter: FirestoreDataConverter<AiBudgetConfig> = {
  toFirestore: (config) => {
    const { id: _id, ...rest } = config as AiBudgetConfig;
    void _id;
    return { ...rest, updatedAt: Timestamp.fromDate(rest.updatedAt) };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): AiBudgetConfig => {
    const data = snap.data() as DocumentData;
    const resetDay = Math.floor(Number(data.cycleResetDay));
    return {
      id: snap.id,
      userId: typeof data.userId === 'string' ? data.userId : snap.id,
      monthlyCreditUSD: Number(data.monthlyCreditUSD) > 0 ? Number(data.monthlyCreditUSD) : 100,
      cycleResetDay: resetDay >= 1 && resetDay <= 28 ? resetDay : 23,
      warningPercent: Number(data.warningPercent) || 80,
      hardStopEnabled: data.hardStopEnabled === true,
      defaultModel: isClaudeModel(data.defaultModel) ? data.defaultModel : DEFAULT_CLAUDE_MODEL,
      fastModel: isClaudeModel(data.fastModel) ? data.fastModel : DEFAULT_CLAUDE_MODEL,
      lastAlertCycle: typeof data.lastAlertCycle === 'string' ? data.lastAlertCycle : null,
      lastAlertLevel: typeof data.lastAlertLevel === 'string' ? data.lastAlertLevel : null,
      updatedAt: tsToDate(data.updatedAt) ?? new Date(),
    };
  },
};
