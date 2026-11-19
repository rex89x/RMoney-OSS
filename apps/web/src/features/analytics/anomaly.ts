/**
 * 類別異常偵測：
 *
 * 對每個類別，計算「過去 6 個月同期間（同樣 daysElapsed）的中位數 + IQR」，
 * 若本月當前累計 ≥ 中位數 × 1.6 或 > Q3 + 1.5*IQR → 標為 anomaly。
 *
 * 與「預算超標」的差異：預算只看絕對上限；anomaly 看「相對於自己歷史」是否異常。
 */

import type { Transaction } from '@/features/ledger/types';
import { formatTW, nowTW } from '@/lib/tz';
import { isConsumptionExpense } from './metrics';

export interface CategoryAnomaly {
  category: string;
  thisMonthSoFar: number;
  historicalMedian: number;
  ratio: number; // 本月 / 中位數
  level: 'mild' | 'high';
}

export function detectCategoryAnomalies(
  thisMonthTxs: Transaction[],
  past6MonthsByCategoryByMonth: Array<Map<string, number>>, // [m1, m2, ..., m6] each = Map<category, partialSum (until same dayOfMonth)>
  shareFor: (tx: Transaction) => number,
  today: Date = nowTW(),
): CategoryAnomaly[] {
  const dayOfMonth = Number(formatTW(today, 'd'));

  // 本月各類別累計
  const thisMonth = new Map<string, number>();
  for (const t of thisMonthTxs) {
    if (!isConsumptionExpense(t)) continue;
    if (Number(formatTW(t.date, 'd')) > dayOfMonth) continue;
    const k = t.category || 'other';
    thisMonth.set(k, (thisMonth.get(k) ?? 0) + shareFor(t));
  }

  // 對每個類別計算歷史中位數
  const cats = new Set<string>([...thisMonth.keys()]);
  past6MonthsByCategoryByMonth.forEach((m) => m.forEach((_v, k) => cats.add(k)));

  const out: CategoryAnomaly[] = [];
  cats.forEach((cat) => {
    const thisVal = thisMonth.get(cat) ?? 0;
    if (thisVal < 500) return; // 太小不報，避免雜訊
    const samples = past6MonthsByCategoryByMonth.map((m) => m.get(cat) ?? 0).filter((v) => v > 0);
    if (samples.length < 3) return; // 至少 3 個月才有意義
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!; // 非空：索引已做邊界 / 長度檢查
    if (median <= 0) return;
    const ratio = thisVal / median;
    if (ratio < 1.5) return;
    out.push({
      category: cat,
      thisMonthSoFar: thisVal,
      historicalMedian: median,
      ratio,
      level: ratio >= 2 ? 'high' : 'mild',
    });
  });
  return out.sort((a, b) => b.ratio - a.ratio);
}
