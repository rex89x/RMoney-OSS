import type { ClaudeModel } from './types';

export const CLAUDE_MODEL_LABELS: Record<ClaudeModel, { label: string; description: string }> = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5（預設）', description: 'US$4 / US$20 每百萬 tokens，品質與成本平衡' },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', description: 'US$2 / US$10，約 Opus 一半價格' },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5', description: 'US$0.10 / US$0.50，最省，適合解析 / OCR' },
  'claude-fable-5-2': { label: 'Claude Fable 5.2', description: 'US$8 / US$40，最強也最貴' },
};

export function claudeModelLabel(model: string): string {
  return (CLAUDE_MODEL_LABELS as Record<string, { label: string }>)[model]?.label.replace('（預設）', '') ?? model;
}

/** 與後端 callClaude_ 的 feature 名稱一致 */
export const AI_FEATURE_LABELS: Record<string, string> = {
  financeAsk: '財務問答',
  receiptOcr: '收據辨識',
  aiImport: 'AI 匯入解析',
  telegramQuickEntry: 'Telegram 快速記帳',
  itineraryGenerate: '行程生成',
  itineraryImport: '行程 AI 匯入',
  itinerarySuggest: '行程建議',
  tripNotes: '旅遊筆記',
  flightWatch: '機票價格搜尋',
  'analysis:monthlyReview': 'AI 分析：月度回顧',
  'analysis:subscriptionAudit': 'AI 分析：訂閱健檢',
  'analysis:portfolioReview': 'AI 分析：投資健檢',
  'analysis:transactionCleanup': 'AI 分析：記帳品質',
  'analysis:tripReview': 'AI 分析：旅遊計畫',
};

export function formatUSD(value: number, digits = 2): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: Math.max(digits, value > 0 && value < 0.01 ? 4 : digits),
  }).format(value);
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(value);
}
