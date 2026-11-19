/**
 * 記帳統計的單一計算來源（純函式，無 React / Firestore 依賴，可直接單元測試）。
 *
 * 「支出」「收入」的定義全系統只看這裡：
 * - 消費支出 = type 'expense'，但排除資產轉換 / 對帳 / 結算這類「不是真的花掉」的類別
 * - 實際收入 = type 'income'，但排除對帳調整 / 共同帳結算收回
 * 首頁、記帳分析、年度回顧、月底預測、Apps Script 推播都要用同一份清單
 * （GAS 端對應 `apps-script/src/Notifications.gs` 的 `NON_CONSUMPTION_EXPENSE_CATEGORIES_`）。
 */
import type { Transaction } from '@/features/ledger/types';
import { formatTW } from '@/lib/tz';

/** 不算「花掉」的支出類別：租賃購入（資產轉換）、對帳調整、共同帳結算（還錢） */
export const NON_CONSUMPTION_EXPENSE_CATEGORIES: ReadonlyArray<string> = [
  'rental_purchase', 'adjustment', 'household_settlement',
];

/** 不算「賺到」的收入類別：對帳調整、共同帳結算收回 */
export const NON_EARNED_INCOME_CATEGORIES: ReadonlyArray<string> = [
  'adjustment_income', 'household_settlement_income',
];

/** 被動收入（不需上班換來的） */
export const PASSIVE_INCOME_CATEGORIES: ReadonlyArray<string> = ['invest_return', 'rental_income'];

export type TxLike = Pick<Transaction, 'type' | 'category' | 'amountTWD' | 'date'> & {
  deletedAt?: Date | null;
  note?: string | null;
  recurringId?: string | null;
};

export type ShareFn<T extends TxLike = TxLike> = (tx: T) => number;

export function isConsumptionExpense(tx: Pick<TxLike, 'type' | 'category' | 'deletedAt'>): boolean {
  return !tx.deletedAt && tx.type === 'expense' && !NON_CONSUMPTION_EXPENSE_CATEGORIES.includes(tx.category);
}

export function isEarnedIncome(tx: Pick<TxLike, 'type' | 'category' | 'deletedAt'>): boolean {
  return !tx.deletedAt && tx.type === 'income' && !NON_EARNED_INCOME_CATEGORIES.includes(tx.category);
}

export interface PeriodSummary {
  expense: number;
  income: number;
  net: number;
  /** (收入 − 支出) / 收入；沒有收入時為 null */
  savingsRate: number | null;
  expenseCount: number;
  incomeCount: number;
  byCategory: Map<string, number>;
  incomeByCategory: Map<string, number>;
}

export function summarizePeriod<T extends TxLike>(txs: readonly T[], share: ShareFn<T>): PeriodSummary {
  let expense = 0;
  let income = 0;
  let expenseCount = 0;
  let incomeCount = 0;
  const byCategory = new Map<string, number>();
  const incomeByCategory = new Map<string, number>();
  for (const t of txs) {
    if (isConsumptionExpense(t)) {
      const v = share(t);
      expense += v;
      expenseCount += 1;
      const k = t.category || 'other';
      byCategory.set(k, (byCategory.get(k) ?? 0) + v);
    } else if (isEarnedIncome(t)) {
      income += t.amountTWD;
      incomeCount += 1;
      const k = t.category || 'other_income';
      incomeByCategory.set(k, (incomeByCategory.get(k) ?? 0) + t.amountTWD);
    }
  }
  const net = income - expense;
  return {
    expense, income, net,
    savingsRate: income > 0 ? net / income : null,
    expenseCount, incomeCount, byCategory, incomeByCategory,
  };
}

/** (cur − prev) / prev；prev ≤ 0 時無法比較回 null */
export function percentChange(cur: number, prev: number): number | null {
  if (!(prev > 0)) return null;
  return (cur - prev) / prev;
}

export interface CategoryDelta {
  key: string;
  current: number;
  previous: number;
  delta: number;
}

/** 類別增減，依「增加最多」排序（delta 大到小） */
export function compareCategories(cur: Map<string, number>, prev: Map<string, number>): CategoryDelta[] {
  const keys = new Set([...cur.keys(), ...prev.keys()]);
  return Array.from(keys)
    .map((key) => {
      const current = cur.get(key) ?? 0;
      const previous = prev.get(key) ?? 0;
      return { key, current, previous, delta: current - previous };
    })
    .sort((a, b) => b.delta - a.delta);
}

export interface RankedRow {
  key: string;
  value: number;
}

export const OTHER_KEY = '__other';

/** 取前 n 名，剩下合併成一列 `__other`（n 名以內就不加） */
export function topWithOther<R extends RankedRow>(rows: readonly R[], n: number): Array<R | RankedRow> {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  if (sorted.length <= n) return sorted;
  const head = sorted.slice(0, n);
  const rest = sorted.slice(n).reduce((s, r) => s + r.value, 0);
  return rest > 0 ? [...head, { key: OTHER_KEY, value: rest }] : head;
}

export interface MerchantRow {
  /** 顯示用（第一次出現的寫法） */
  name: string;
  amount: number;
  count: number;
  /** 最常見的類別 */
  category: string;
}

/** 正規化備註當商家 key：去空白、轉小寫、去掉尾端金額 / 數量 */
export function merchantKey(note: string | null | undefined): string {
  return (note ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s×x*]*\d+(\.\d+)?\s*(元|份|個|杯)?$/i, '')
    .trim()
    .toLowerCase();
}

export function merchantRanking<T extends TxLike>(txs: readonly T[], share: ShareFn<T>, limit = 10): MerchantRow[] {
  const map = new Map<string, MerchantRow & { cats: Map<string, number> }>();
  for (const t of txs) {
    if (!isConsumptionExpense(t)) continue;
    const key = merchantKey(t.note);
    if (!key) continue;
    const row = map.get(key) ?? {
      name: (t.note ?? '').replace(/\s+/g, ' ').trim(), amount: 0, count: 0, category: t.category, cats: new Map(),
    };
    row.amount += share(t);
    row.count += 1;
    row.cats.set(t.category, (row.cats.get(t.category) ?? 0) + 1);
    map.set(key, row);
  }
  return Array.from(map.values())
    .map(({ cats, ...row }) => ({
      ...row,
      category: [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? row.category,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

/** 依星期幾加總（index 0 = 週一 … 6 = 週日，以台北時間判斷） */
export function weekdayTotals<T extends TxLike>(txs: readonly T[], share: ShareFn<T>): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const t of txs) {
    if (!isConsumptionExpense(t)) continue;
    const i = Number(formatTW(t.date, 'i')) - 1; // ISO: 1 = Monday
    out[i] = (out[i] ?? 0) + share(t);
  }
  return out;
}

/** 依台北日期（yyyy-MM-dd）加總消費支出 */
export function dailyTotals<T extends TxLike>(txs: readonly T[], share: ShareFn<T>): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of txs) {
    if (!isConsumptionExpense(t)) continue;
    const k = formatTW(t.date, 'yyyy-MM-dd');
    map.set(k, (map.get(k) ?? 0) + share(t));
  }
  return map;
}

export interface MonthlyCategorySeries {
  /** 每列 = 一個月，欄位 = 類別 key（含 `__other`）+ month + total */
  rows: Array<Record<string, number | string>>;
  /** 有畫出來的類別 key（依總額大到小，最後可能是 `__other`） */
  keys: string[];
}

/** 近 N 個月各類別堆疊：取總額前 topN 類別，其餘合併成 `__other` */
export function monthlyCategorySeries<T extends TxLike>(
  txs: readonly T[],
  share: ShareFn<T>,
  monthKeys: readonly string[],
  topN = 5,
): MonthlyCategorySeries {
  const perMonth = new Map<string, Map<string, number>>(monthKeys.map((m) => [m, new Map()]));
  const totals = new Map<string, number>();
  for (const t of txs) {
    if (!isConsumptionExpense(t)) continue;
    const m = perMonth.get(formatTW(t.date, 'yyyy-MM'));
    if (!m) continue;
    const v = share(t);
    const k = t.category || 'other';
    m.set(k, (m.get(k) ?? 0) + v);
    totals.set(k, (totals.get(k) ?? 0) + v);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const top = ranked.slice(0, topN);
  const hasOther = ranked.length > topN;
  const rows = monthKeys.map((month) => {
    const m = perMonth.get(month) ?? new Map<string, number>();
    const row: Record<string, number | string> = { month };
    let total = 0;
    let other = 0;
    for (const [k, v] of m) {
      total += v;
      if (top.includes(k)) row[k] = v;
      else other += v;
    }
    for (const k of top) row[k] ??= 0;
    if (hasOther) row[OTHER_KEY] = other;
    row.total = total;
    return row;
  });
  return { rows, keys: hasOther ? [...top, OTHER_KEY] : top };
}

/** 固定支出比對：週期交易（recurringId）或備註含訂閱 / 排程支出名稱 */
export function buildFixedExpenseMatcher(keywords: ReadonlyArray<string | null | undefined>) {
  const words = keywords
    .map((w) => (w ?? '').trim().toLowerCase())
    .filter((w) => w.length >= 2);
  return (tx: Pick<TxLike, 'note' | 'recurringId'>): boolean => {
    if (tx.recurringId) return true;
    const note = (tx.note ?? '').toLowerCase();
    return note.length > 0 && words.some((w) => note.includes(w));
  };
}

export interface FixedVariableSplit {
  fixed: number;
  variable: number;
  fixedItems: Array<{ name: string; amount: number }>;
}

export function splitFixedVariable<T extends TxLike>(
  txs: readonly T[],
  share: ShareFn<T>,
  isFixed: (tx: T) => boolean,
): FixedVariableSplit {
  let fixed = 0;
  let variable = 0;
  const items = new Map<string, { name: string; amount: number }>();
  for (const t of txs) {
    if (!isConsumptionExpense(t)) continue;
    const v = share(t);
    if (isFixed(t)) {
      fixed += v;
      const name = (t.note ?? '').trim() || t.category;
      const key = name.toLowerCase();
      const row = items.get(key) ?? { name, amount: 0 };
      row.amount += v;
      items.set(key, row);
    } else {
      variable += v;
    }
  }
  return { fixed, variable, fixedItems: [...items.values()].sort((a, b) => b.amount - a.amount) };
}

export type BucketUnit = 'day' | 'week' | 'month';

export interface SpendBucket {
  /** 顯示用標籤 */
  label: string;
  /** 區間（yyyy-MM-dd，含頭尾），點擊時帶到交易列表 */
  startKey: string;
  endKey: string;
  value: number;
}

/** 依區間長度自動選粒度：≤ 62 天按日、≤ 200 天按週（週一起算）、其餘按月（避免 Recharts 點數過多） */
export function pickBucketUnit(days: number): BucketUnit {
  if (days <= 62) return 'day';
  if (days <= 200) return 'week';
  return 'month';
}

/**
 * 把 [startKey, endKey]（台北日期）切成 bucket 並加總消費支出。
 * startKey / endKey 都是 yyyy-MM-dd；以 UTC 日期運算避免本機時區干擾。
 */
export function spendBuckets<T extends TxLike>(
  txs: readonly T[],
  share: ShareFn<T>,
  startKey: string,
  endKey: string,
): { unit: BucketUnit; buckets: SpendBucket[] } {
  const start = keyToUtc(startKey);
  const end = keyToUtc(endKey);
  const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const unit = pickBucketUnit(days);
  const buckets: SpendBucket[] = [];
  const indexOfDay = new Map<string, number>();
  let cursor = start;
  while (cursor <= end) {
    const bStart = cursor;
    let bEnd: number;
    if (unit === 'day') bEnd = bStart;
    else if (unit === 'week') {
      const dow = (new Date(bStart).getUTCDay() + 6) % 7; // 0 = Monday
      bEnd = bStart + (6 - dow) * 86400000;
    } else {
      const d = new Date(bStart);
      bEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
    }
    bEnd = Math.min(bEnd, end);
    const i = buckets.length;
    for (let x = bStart; x <= bEnd; x += 86400000) indexOfDay.set(utcToKey(x), i);
    const sKey = utcToKey(bStart);
    buckets.push({
      label: unit === 'month' ? sKey.slice(0, 7).replace('-', '/') : `${sKey.slice(5, 7)}/${sKey.slice(8, 10)}`,
      startKey: sKey,
      endKey: utcToKey(bEnd),
      value: 0,
    });
    cursor = bEnd + 86400000;
  }
  for (const [day, v] of dailyTotals(txs, share)) {
    const i = indexOfDay.get(day);
    if (i != null) buckets[i]!.value += v;
  }
  return { unit, buckets };
}

function keyToUtc(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

// 這裡的 ms 都是 Date.UTC 建出來的「純日期」，toISOString 不會有 Asia/Taipei 跨日問題
function utcToKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface BudgetPaceRow {
  key: string;
  used: number;
  limit: number;
  /** used / limit */
  pct: number;
  /** 照時間進度此時「應該」用掉的額度 */
  expectedByNow: number;
  status: 'over' | 'ahead' | 'ok';
}

/** 類別預算節奏：over = 已超過額度；ahead = 超過時間進度 15% 以上 */
export function categoryBudgetPace(
  byCategory: Map<string, number>,
  limits: Record<string, number>,
  pctElapsed: number,
): BudgetPaceRow[] {
  return Object.entries(limits)
    .filter(([, limit]) => limit > 0)
    .map(([key, limit]) => {
      const used = byCategory.get(key) ?? 0;
      const expectedByNow = limit * pctElapsed;
      const status: BudgetPaceRow['status'] = used > limit
        ? 'over'
        : used > expectedByNow + limit * 0.15 ? 'ahead' : 'ok';
      return { key, used, limit, pct: used / limit, expectedByNow, status };
    })
    .sort((a, b) => b.pct - a.pct);
}

export interface MonthHeadlineInput {
  spent: number;
  prevSpent: number;
  /** 增加最多的類別（名稱 + 增加額），沒有就 null */
  topIncrease: { name: string; delta: number } | null;
  topDecrease: { name: string; delta: number } | null;
  budget: number | null;
  projected: number | null;
}

/** 首頁「本月狀態」一句話結論 */
export function buildMonthHeadline(i: MonthHeadlineInput): string {
  const parts: string[] = [];
  const change = percentChange(i.spent, i.prevSpent);
  if (change == null) {
    parts.push(i.spent > 0 ? '上月同期沒有支出可比較' : '本月還沒有支出');
  } else if (Math.abs(change) < 0.05) {
    parts.push('花費跟上月同期差不多');
  } else if (change > 0) {
    parts.push(`比上月同期多花 ${Math.round(change * 100)}%`);
    if (i.topIncrease && i.topIncrease.delta > 0) {
      parts.push(`主要是${i.topIncrease.name} +${formatInt(i.topIncrease.delta)}`);
    }
  } else {
    parts.push(`比上月同期少花 ${Math.round(-change * 100)}%`);
    if (i.topDecrease && i.topDecrease.delta < 0) {
      parts.push(`${i.topDecrease.name}省最多 ${formatInt(i.topDecrease.delta)}`);
    }
  }
  if (i.budget != null && i.budget > 0 && i.projected != null) {
    const diff = i.projected - i.budget;
    parts.push(diff > 0
      ? `照目前速度月底會超支 ${formatInt(diff)}`
      : `照目前速度月底可剩 ${formatInt(-diff)}`);
  }
  return parts.join('，');
}

function formatInt(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
}

export interface BudgetImpactInput {
  /** 這筆存檔「前」本月已花（消費支出） */
  monthSpentBefore: number;
  /** 這筆存檔「前」此類別本月已花 */
  categorySpentBefore: number;
  amount: number;
  categoryName: string;
  categoryLimit: number | null;
  monthBudget: number | null;
  /** 含今天的剩餘天數 */
  daysLeft: number;
}

/** 記帳存檔後的 toast 說明：類別預算 > 總預算 > 每日剩餘額度 */
export function budgetImpactMessage(i: BudgetImpactInput): string | null {
  const parts: string[] = [];
  if (i.categoryLimit != null && i.categoryLimit > 0) {
    const used = i.categorySpentBefore + i.amount;
    const pct = Math.round((used / i.categoryLimit) * 100);
    parts.push(used > i.categoryLimit
      ? `${i.categoryName}已超出預算 ${formatInt(used - i.categoryLimit)}`
      : `${i.categoryName}本月已用 ${pct}%`);
  }
  if (i.monthBudget != null && i.monthBudget > 0) {
    const remaining = i.monthBudget - (i.monthSpentBefore + i.amount);
    if (remaining < 0) parts.push(`本月總預算已超支 ${formatInt(-remaining)}`);
    else parts.push(`今日起每天可花 ${formatInt(remaining / Math.max(1, i.daysLeft))}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** 只留到 cutoffKey（yyyy-MM-dd，台北，含當天）的交易：比較「同期」用 */
export function filterUntilKey<T extends Pick<TxLike, 'date'>>(txs: readonly T[], cutoffKey: string): T[] {
  return txs.filter((t) => formatTW(t.date, 'yyyy-MM-dd') <= cutoffKey);
}
