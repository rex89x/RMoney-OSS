/**
 * 年度回顧資料彙整：以台北年份為範圍，整合 transactions / net_worth_snapshots /
 * portfolio_snapshots / dividends / realized_lots / trips。純讀取、純前端計算。
 */
import { useMemo } from 'react';
import { useCategories, useTransactions } from '@/features/ledger/hooks';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import { useNetWorthSnapshots } from '@/features/net-worth/hooks';
import { useDividends, usePortfolioSnapshots, useRealizedLots } from '@/features/investments/hooks';
import { useTrips } from '@/features/trips/hooks';
import type { Transaction } from '@/features/ledger/types';
import { formatTW, fromTW } from '@/lib/tz';
import { isConsumptionExpense, isEarnedIncome } from '@/features/analytics/metrics';

export interface YearTotals {
  income: number;
  expense: number;
  net: number;
  savingsRate: number | null;
  txCount: number;
}

export interface CategoryRow { key: string; name: string; color: string; amount: number; prevAmount: number }
export interface MerchantRow { note: string; amount: number; count: number }
export interface MonthRow { month: string; income: number; expense: number }
export interface TripRow { id: string; name: string; destination: string; startDate: Date; spend: number; days: number }

export interface AnnualReview {
  year: number;
  totals: YearTotals;
  prevTotals: YearTotals;
  months: MonthRow[];
  categories: CategoryRow[];
  merchants: MerchantRow[];
  trips: TripRow[];
  tripSpendTotal: number;
  invest: {
    startValueTWD: number | null;
    endValueTWD: number | null;
    startCostTWD: number | null;
    endCostTWD: number | null;
    dividendsTWD: number;
    realizedTWD: number;
    /** 市值變動 − 新投入成本 + 股息 + 已實現 */
    gainTWD: number | null;
    returnPct: number | null;
  };
  netWorth: {
    startTWD: number | null;
    endTWD: number | null;
    startMonth: string | null;
    endMonth: string | null;
  };
  isLoading: boolean;
}

function yearRange(year: number): { start: Date; end: Date } {
  return {
    start: fromTW(new Date(year, 0, 1, 0, 0, 0, 0)),
    end: fromTW(new Date(year, 11, 31, 23, 59, 59, 999)),
  };
}

function totalsOf(txs: Transaction[], myShare: (t: Transaction) => number): YearTotals {
  let income = 0;
  let expense = 0;
  let txCount = 0;
  for (const t of txs) {
    // 消費支出 / 實際收入口徑：對帳調整、租賃購入、共同帳結算不算（與首頁、分析頁一致）
    if (isEarnedIncome(t)) { income += t.amountTWD; txCount += 1; }
    else if (isConsumptionExpense(t)) { expense += myShare(t); txCount += 1; }
  }
  const net = income - expense;
  return { income, expense, net, savingsRate: income > 0 ? net / income : null, txCount };
}

export function useAnnualReview(year: number): AnnualReview {
  const range = useMemo(() => yearRange(year), [year]);
  const prevRange = useMemo(() => yearRange(year - 1), [year]);
  const { data: txs = [], isLoading: l1 } = useTransactions({ startDate: range.start, endDate: range.end, limit: 8000 });
  const { data: prevTxs = [], isLoading: l2 } = useTransactions({ startDate: prevRange.start, endDate: prevRange.end, limit: 8000 });
  const { data: categories = [] } = useCategories();
  const { data: nwSnaps = [] } = useNetWorthSnapshots(48);
  const { data: pfSnaps = [] } = usePortfolioSnapshots(800);
  const { data: dividends = [] } = useDividends();
  const { data: lots = [] } = useRealizedLots();
  const { data: trips = [] } = useTrips();
  const myShare = useMyExpenseShare();

  return useMemo(() => {
    const totals = totalsOf(txs, myShare);
    const prevTotals = totalsOf(prevTxs, myShare);
    const catByKey = new Map(categories.map((c) => [c.key, c]));

    // 月度
    const months: MonthRow[] = Array.from({ length: 12 }, (_, i) => ({ month: `${i + 1}月`, income: 0, expense: 0 }));
    for (const t of txs) {
      const m = Number(formatTW(t.date, 'M')) - 1;
      const row = months[m];
      if (!row) continue;
      if (isEarnedIncome(t)) row.income += t.amountTWD;
      else if (isConsumptionExpense(t)) row.expense += myShare(t);
    }

    // 類別（本年 vs 去年）
    const catAmt = new Map<string, number>();
    const prevCatAmt = new Map<string, number>();
    for (const t of txs) if (isConsumptionExpense(t)) catAmt.set(t.category, (catAmt.get(t.category) ?? 0) + myShare(t));
    for (const t of prevTxs) if (isConsumptionExpense(t)) prevCatAmt.set(t.category, (prevCatAmt.get(t.category) ?? 0) + myShare(t));
    const catRows: CategoryRow[] = Array.from(new Set([...catAmt.keys(), ...prevCatAmt.keys()])).map((key) => ({
      key,
      name: catByKey.get(key)?.name ?? key,
      color: catByKey.get(key)?.color ?? '#6B7280',
      amount: catAmt.get(key) ?? 0,
      prevAmount: prevCatAmt.get(key) ?? 0,
    })).sort((a, b) => b.amount - a.amount);

    // 商家（備註）
    const merchantMap = new Map<string, MerchantRow>();
    for (const t of txs) {
      if (!isConsumptionExpense(t)) continue;
      const note = (t.note ?? '').replace(/\s+/g, ' ').trim();
      if (!note) continue;
      const key = note.toLowerCase();
      const row = merchantMap.get(key) ?? { note, amount: 0, count: 0 };
      row.amount += myShare(t);
      row.count += 1;
      merchantMap.set(key, row);
    }
    const merchants = Array.from(merchantMap.values()).sort((a, b) => b.amount - a.amount).slice(0, 10);

    // 出遊
    const tripSpend = new Map<string, number>();
    for (const t of txs) if (isConsumptionExpense(t) && t.tripId) tripSpend.set(t.tripId, (tripSpend.get(t.tripId) ?? 0) + myShare(t));
    const tripRows: TripRow[] = trips
      .filter((tr) => Number(formatTW(tr.startDate, 'yyyy')) === year || tripSpend.has(tr.id))
      .map((tr) => ({
        id: tr.id,
        name: tr.name,
        destination: tr.destination.join(' · '),
        startDate: tr.startDate,
        spend: tripSpend.get(tr.id) ?? 0,
        days: Math.max(1, Math.round((tr.endDate.getTime() - tr.startDate.getTime()) / 86400000) + 1),
      }))
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
    const tripSpendTotal = tripRows.reduce((s, r) => s + r.spend, 0);

    // 投資：年內第一 / 最後一筆快照
    const yStart = `${year}-01-01`;
    const yEnd = `${year}-12-31`;
    const inYear = pfSnaps.filter((s) => s.date >= yStart && s.date <= yEnd);
    const before = pfSnaps.filter((s) => s.date < yStart);
    const startSnap = before[before.length - 1] ?? inYear[0] ?? null;
    const endSnap = inYear[inYear.length - 1] ?? null;
    const dividendsTWD = dividends.filter((d) => Number(formatTW(d.payDate, 'yyyy')) === year).reduce((s, d) => s + d.amountTWD, 0);
    const realizedTWD = lots.filter((l) => Number(formatTW(l.sellDate, 'yyyy')) === year).reduce((s, l) => s + l.realizedPnlTWD, 0);
    let gainTWD: number | null = null;
    let returnPct: number | null = null;
    if (startSnap && endSnap) {
      const contribution = endSnap.totalCostTWD - startSnap.totalCostTWD;
      gainTWD = (endSnap.totalValueTWD - startSnap.totalValueTWD) - contribution + dividendsTWD + realizedTWD;
      const base = startSnap.totalValueTWD + Math.max(0, contribution) / 2;
      returnPct = base > 0 ? (gainTWD / base) * 100 : null;
    }

    // 淨值
    const nwInYear = nwSnaps.filter((s) => s.month.startsWith(String(year)));
    const nwBefore = nwSnaps.filter((s) => s.month < `${year}-01`);
    const nwStart = nwBefore[nwBefore.length - 1] ?? nwInYear[0] ?? null;
    const nwEnd = nwInYear[nwInYear.length - 1] ?? null;

    return {
      year,
      totals,
      prevTotals,
      months,
      categories: catRows,
      merchants,
      trips: tripRows,
      tripSpendTotal,
      invest: {
        startValueTWD: startSnap?.totalValueTWD ?? null,
        endValueTWD: endSnap?.totalValueTWD ?? null,
        startCostTWD: startSnap?.totalCostTWD ?? null,
        endCostTWD: endSnap?.totalCostTWD ?? null,
        dividendsTWD,
        realizedTWD,
        gainTWD,
        returnPct,
      },
      netWorth: {
        startTWD: nwStart?.netWorthTWD ?? null,
        endTWD: nwEnd?.netWorthTWD ?? null,
        startMonth: nwStart?.month ?? null,
        endMonth: nwEnd?.month ?? null,
      },
      isLoading: l1 || l2,
    };
  }, [year, txs, prevTxs, categories, nwSnaps, pfSnaps, dividends, lots, trips, myShare, l1, l2]);
}
