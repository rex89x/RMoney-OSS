/**
 * 從 transactions 自動偵測規律性訂閱：
 *   - 同 note / merchant key（清理後的字串）
 *   - 金額相近（±15%）
 *   - 至少出現 3 個月、且間隔 ≈ 28-32 天（monthly）或其他週期
 *   - 過去 90 天內仍有出現視為 active
 */

import type { Transaction } from '@/features/ledger/types';
import { effectiveAmountTWD } from '@/features/ledger/types';

export interface DetectedSubscription {
  /** 用 noteKey 當識別 */
  noteKey: string;
  displayName: string;
  amountTWD: number;
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
  /** 推估的 cycle */
  cycle: 'monthly' | 'yearly' | 'weekly' | 'biweekly';
  paymentMethod?: string;
  category?: string;
  /** 距今天最近一次 tx 的天數 */
  daysSinceLast: number;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);
}

export function detectSubscriptions(txs: Transaction[]): DetectedSubscription[] {
  const today = Date.now();
  const grouped = new Map<string, Transaction[]>();
  for (const tx of txs) {
    if (tx.deletedAt) continue;
    if (tx.type !== 'expense') continue;
    const key = normalizeKey(tx.note ?? tx.subCategory ?? tx.category);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(tx);
  }

  const results: DetectedSubscription[] = [];
  grouped.forEach((items, key) => {
    if (items.length < 3) return;

    // 金額相近
    const amounts = items.map((t) => effectiveAmountTWD(t));
    const median = amounts.sort((a, b) => a - b)[Math.floor(amounts.length / 2)]!; // 非空：索引已做邊界 / 長度檢查
    const within = items.filter((t) => Math.abs(effectiveAmountTWD(t) - median) <= median * 0.15);
    if (within.length < 3) return;

    // 排序日期
    within.sort((a, b) => a.date.getTime() - b.date.getTime());
    const intervals: number[] = [];
    for (let i = 1; i < within.length; i++) {
      const diff = (within[i]!.date.getTime() - within[i - 1]!.date.getTime()) / 86400000; // 非空：索引已做邊界 / 長度檢查
      intervals.push(diff);
    }
    const medInterval = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)]!; // 非空：索引已做邊界 / 長度檢查

    let cycle: DetectedSubscription['cycle'] = 'monthly';
    if (medInterval <= 8) cycle = 'weekly';
    else if (medInterval <= 16) cycle = 'biweekly';
    else if (medInterval <= 35) cycle = 'monthly';
    else if (medInterval >= 350 && medInterval <= 380) cycle = 'yearly';
    else return; // 不像訂閱

    const last = within[within.length - 1]!.date; // 非空：索引已做邊界 / 長度檢查
    const daysSinceLast = Math.floor((today - last.getTime()) / 86400000);
    if (cycle === 'monthly' && daysSinceLast > 60) return; // 已 2 個月沒扣，不算 active
    if (cycle === 'yearly' && daysSinceLast > 400) return;

    results.push({
      noteKey: key,
      displayName: within[within.length - 1]!.note ?? key, // 非空：索引已做邊界 / 長度檢查
      amountTWD: Math.round(median),
      occurrences: within.length,
      firstSeen: within[0]!.date, // 非空：索引已做邊界 / 長度檢查
      lastSeen: last,
      cycle,
      paymentMethod: within[within.length - 1]!.paymentMethod, // 非空：索引已做邊界 / 長度檢查
      category: within[within.length - 1]!.category, // 非空：索引已做邊界 / 長度檢查
      daysSinceLast,
    });
  });

  // 依「久沒用」排序前面（提示可能該砍）
  return results.sort((a, b) => b.daysSinceLast - a.daysSinceLast);
}
