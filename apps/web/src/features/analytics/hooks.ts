import { useMemo } from 'react';
import { useTransactions, useBudget, useCategories } from '@/features/ledger/hooks';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import { useNetWorthNow } from '@/features/net-worth/hooks';
import type { Category, Transaction } from '@/features/ledger/types';
import { formatTW, nowTW } from '@/lib/tz';
import { computeMonthlyForecast, type MonthlyForecast } from './forecast';
import { detectCategoryAnomalies, type CategoryAnomaly } from './anomaly';
import {
  filterUntilKey, isConsumptionExpense, isEarnedIncome, summarizePeriod, type PeriodSummary,
} from './metrics';
import {
  comparisonRange, pastMonthsRange, periodRange, todayKeyOf, twDateFromKey,
  type ComparisonRange, type PeriodKey, type PeriodRange,
} from './periods';

/**
 * 統計用的交易查詢一律走這個 limit：同一個期間在不同卡片會得到同一個 query key，
 * TanStack Query 只讀一次 Firestore。
 */
export const RANGE_TX_LIMIT = 5000;

const EMPTY: Transaction[] = [];
const EMPTY_CATEGORIES: Category[] = [];

export interface RangeTransactions {
  txs: Transaction[];
  isLoading: boolean;
  /** 筆數達上限，統計可能不完整 */
  truncated: boolean;
}

export function useRangeTransactions(
  range: Pick<PeriodRange, 'start' | 'end'>,
  options?: { enabled?: boolean },
): RangeTransactions {
  const q = useTransactions({ startDate: range.start, endDate: range.end, limit: RANGE_TX_LIMIT }, options);
  const txs = q.data ?? EMPTY;
  return { txs, isLoading: q.isLoading, truncated: txs.length >= RANGE_TX_LIMIT };
}

/** 今天（台北）— 只在跨日時改變，當 memo key 用，避免每次 render 產生新的 Date 讓 query key 變動 */
export function useTodayKey(): string {
  return todayKeyOf(nowTW());
}

export function usePeriodRange(key: PeriodKey): PeriodRange {
  const today = useTodayKey();
  return useMemo(() => periodRange(key, twDateFromKey(today)), [key, today]);
}

export function useComparisonRange(key: PeriodKey): ComparisonRange {
  const today = useTodayKey();
  return useMemo(() => comparisonRange(key, twDateFromKey(today)), [key, today]);
}

export interface PeriodComparison {
  range: PeriodRange;
  comparison: ComparisonRange;
  txs: Transaction[];
  /** 比較期間（已裁到同期） */
  prevTxs: Transaction[];
  current: PeriodSummary;
  previous: PeriodSummary;
  isLoading: boolean;
  truncated: boolean;
}

/** 某期間 vs 比較期間的彙總（消費支出 / 實際收入口徑） */
export function usePeriodComparison(key: PeriodKey, filter?: (tx: Transaction) => boolean): PeriodComparison {
  const range = usePeriodRange(key);
  const comparison = useComparisonRange(key);
  const cur = useRangeTransactions(range);
  const prev = useRangeTransactions(comparison);
  const myShare = useMyExpenseShare();
  return useMemo(() => {
    const txs = filter ? cur.txs.filter(filter) : cur.txs;
    const prevAll = filterUntilKey(prev.txs, comparison.cutoffKey);
    const prevTxs = filter ? prevAll.filter(filter) : prevAll;
    return {
      range,
      comparison,
      txs,
      prevTxs,
      current: summarizePeriod(txs, myShare),
      previous: summarizePeriod(prevTxs, myShare),
      isLoading: cur.isLoading || prev.isLoading,
      truncated: cur.truncated || prev.truncated,
    };
  }, [range, comparison, cur.txs, prev.txs, cur.isLoading, prev.isLoading, cur.truncated, prev.truncated, myShare, filter]);
}

/** 本月以前 6 個完整月份（forecast / anomaly / 首頁共用同一個 query） */
function usePastSixMonths() {
  const today = useTodayKey();
  const range = useMemo(() => pastMonthsRange(twDateFromKey(today), 6), [today]);
  return { range, ...useRangeTransactions(range) };
}

/** 主 Dashboard 用：本月結餘預測 */
export function useMonthlyForecast(): MonthlyForecast | null {
  const today = useTodayKey();
  const monthRange = usePeriodRange('thisMonth');
  const { txs: thisMonthTxs } = useRangeTransactions(monthRange);
  const { txs: pastTxs } = usePastSixMonths();
  const { data: budget } = useBudget(today.slice(0, 7));
  const myShare = useMyExpenseShare();
  // 提供「目前可用現金」當基準，月底預測才不會永遠負（基準包含 rental 抵銷）
  const nw = useNetWorthNow();

  return useMemo(() => {
    if (thisMonthTxs.length === 0 && pastTxs.length === 0) return null;
    const tw = twDateFromKey(today);
    // 把過去 6 個月按月份聚合（消費支出 / 實際收入口徑）
    const byMonth = new Map<string, { month: string; expense: number; income: number }>();
    for (let i = 1; i <= 6; i++) {
      const d = new Date(tw.getFullYear(), tw.getMonth() - i, 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      byMonth.set(k, { month: k, expense: 0, income: 0 });
    }
    for (const t of pastTxs) {
      const row = byMonth.get(formatTW(t.date, 'yyyy-MM'));
      if (!row) continue;
      if (isConsumptionExpense(t)) row.expense += myShare(t);
      else if (isEarnedIncome(t)) row.income += t.amountTWD;
    }
    // 把目前可用現金（displayLiquid，已抵銷 rental purchase）丟進 forecast，
    // forecast 內部會用 (expectedIncome − incomeSoFar) − (expectedExpense − spentSoFar) 推月底結餘。
    return computeMonthlyForecast(thisMonthTxs, [...byMonth.values()], budget?.total ?? null, myShare, nowTW(), {
      currentLiquidTWD: nw.liquidTWD,
    });
  }, [thisMonthTxs, pastTxs, budget, myShare, today, nw.liquidTWD]);
}

/** 類別異常 */
export function useCategoryAnomalies(): CategoryAnomaly[] {
  const today = useTodayKey();
  const monthRange = usePeriodRange('thisMonth');
  const { txs: thisMonthTxs } = useRangeTransactions(monthRange);
  const { txs: pastTxs } = usePastSixMonths();
  const myShare = useMyExpenseShare();

  return useMemo(() => {
    const tw = twDateFromKey(today);
    const dayOfMonth = tw.getDate();
    const monthlyMaps: Array<Map<string, number>> = [];
    const indexOfMonth = new Map<string, number>();
    for (let i = 1; i <= 6; i++) {
      const d = new Date(tw.getFullYear(), tw.getMonth() - i, 1);
      indexOfMonth.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, i - 1);
      monthlyMaps.push(new Map());
    }
    for (const t of pastTxs) {
      if (!isConsumptionExpense(t)) continue;
      const i = indexOfMonth.get(formatTW(t.date, 'yyyy-MM'));
      if (i == null) continue;
      if (Number(formatTW(t.date, 'd')) > dayOfMonth) continue; // 同期間
      const map = monthlyMaps[i]!; // 非空：索引已做邊界 / 長度檢查
      const k = t.category || 'other';
      map.set(k, (map.get(k) ?? 0) + myShare(t));
    }
    return detectCategoryAnomalies(thisMonthTxs, monthlyMaps, myShare, nowTW());
  }, [thisMonthTxs, pastTxs, myShare, today]);
}

export interface CategoryInfo {
  name: string;
  color?: string;
}

/** 類別 key → 名稱 / 顏色（找不到時回 key 本身） */
export function useCategoryLookup(): (key: string) => CategoryInfo {
  const { data: categories = EMPTY_CATEGORIES } = useCategories();
  return useMemo(() => {
    const map = new Map(categories.map((c) => [c.key, c]));
    return (key: string) => {
      const c = map.get(key);
      return { name: c?.name ?? key, color: c?.color };
    };
  }, [categories]);
}
