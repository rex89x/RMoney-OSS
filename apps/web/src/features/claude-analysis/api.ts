import { callAppsScript } from '@/lib/apps-script';
import { AnalysisRequestSchema } from './schema';
import type { AnalysisEstimate, AnalysisKind, AnalysisRequest, AnalysisResult } from './types';

/** 先估價：免費的 count_tokens 算基礎 prompt，再估多輪查詢的區間；不會呼叫 Claude 生成 */
export async function estimateAnalysis(request: AnalysisRequest): Promise<AnalysisEstimate> {
  const body = AnalysisRequestSchema.parse(request);
  const res = await callAppsScript('estimateClaudeAnalysis', undefined, body);
  return res as unknown as AnalysisEstimate;
}

/** 使用者確認後才執行；confirmed 旗標讓後端拒絕任何未經確認的呼叫 */
export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisResult> {
  const body = AnalysisRequestSchema.parse(request);
  const res = await callAppsScript('runClaudeAnalysis', undefined, { ...body, confirmed: true });
  return { ...(res as unknown as AnalysisResult), month: body.month };
}

// ---- 上次結果（只存在這台裝置的 localStorage，方便回頭看；不存 Firestore） ----

const STORAGE_PREFIX = 'claude-analysis:last:';

export function loadLastResult(kind: AnalysisKind): AnalysisResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + kind);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AnalysisResult>;
    return typeof parsed.markdown === 'string' && parsed.kind === kind ? (parsed as AnalysisResult) : null;
  } catch (err) {
    console.warn('[loadLastResult]', err);
    return null;
  }
}

export function saveLastResult(result: AnalysisResult): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + result.kind, JSON.stringify(result));
  } catch (err) {
    console.warn('[saveLastResult]', err);
  }
}
