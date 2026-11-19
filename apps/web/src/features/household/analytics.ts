/**
 * 共同帳本分析（純函式，元件只負責畫）。
 *
 * 口徑與總覽 / 月報一致：
 * - 共同支出金額 = `householdPortionTWD()`（出遊交易只算共同帳本成員那幾份）
 * - 公基金支出 = `paidByUid === HOUSEHOLD_FUND_PAYER_ID`，金額用 `effectiveAmountTWD()`（與 summarizeHouseholdFund 相同）
 * - 月份一律以台北時間切（monthTWRange）
 * 圖表每月一點（CLAUDE.md pitfall #13），最多 24 個月。
 */
import { addTWCalendarMonths, formatTW, formatTWMonthKey, monthTWRange, nowTW } from '@/lib/tz';
import { effectiveAmountTWD, HOUSEHOLD_FUND_PAYER_ID, txPayerId, type Transaction } from '@/features/ledger/types';
import { householdPortionTWD, sharesOfTx } from './balance';
import { fundPlanDueDay } from './fund-plan';
import type { HouseholdFundEntry, HouseholdFundPlan } from './types';

export const OTHER_CATEGORY_KEY = '__other__';

export interface MonthWindow {
  key: string;
  label: string;
  start: Date;
  end: Date;
}

/** 最近 n 個台北月份（含本月），舊 → 新；offset 往前推（用來算「前一段期間」） */
export function lastMonths(n: number, offset = 0): MonthWindow[] {
  const base = nowTW();
  return Array.from({ length: n }, (_, i) => {
    const d = addTWCalendarMonths(base, -(n - 1 - i) - offset);
    const range = monthTWRange(d.getFullYear(), d.getMonth() + 1);
    return { key: formatTWMonthKey(range.start), label: formatTW(range.start, 'yy/M'), ...range };
  });
}

function activeExpenses(txs: Transaction[]): Transaction[] {
  return txs.filter((tx) => !tx.deletedAt && tx.type === 'expense');
}

function inWindow(tx: Transaction, start: Date, end: Date): boolean {
  return tx.date >= start && tx.date <= end;
}

export interface MonthlyRow {
  key: string;
  label: string;
  totalTWD: number;
  fundTWD: number;
  count: number;
  /** 近 3 個月移動平均（資料不足 3 個月時用現有月份平均） */
  movingAvgTWD: number;
  byCategory: Record<string, number>;
}

export function buildMonthlyRows(txs: Transaction[], memberIds: string[], months: MonthWindow[]): MonthlyRow[] {
  const expenses = activeExpenses(txs);
  const rows = months.map((month) => {
    const byCategory: Record<string, number> = {};
    let total = 0;
    let fund = 0;
    let count = 0;
    for (const tx of expenses) {
      if (!inWindow(tx, month.start, month.end)) continue;
      const amount = householdPortionTWD(tx, memberIds);
      total += amount;
      count += 1;
      byCategory[tx.category] = (byCategory[tx.category] ?? 0) + amount;
      if (tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID) fund += effectiveAmountTWD(tx);
    }
    return { key: month.key, label: month.label, totalTWD: total, fundTWD: fund, count, movingAvgTWD: 0, byCategory };
  });
  return rows.map((row, index) => {
    const window = rows.slice(Math.max(0, index - 2), index + 1);
    return { ...row, movingAvgTWD: Math.round(window.reduce((sum, item) => sum + item.totalTWD, 0) / window.length) };
  });
}

export interface PeriodKpis {
  totalTWD: number;
  previousTWD: number;
  /** null = 前一段期間沒有資料 */
  changePct: number | null;
  monthlyAvgTWD: number;
  count: number;
  avgTicketTWD: number;
  fundShare: number;
  /** 有設月預算時，期間內有幾個月在預算內 */
  monthsWithinBudget: number | null;
}

export function buildPeriodKpis(current: MonthlyRow[], previous: MonthlyRow[], budget: number | null): PeriodKpis {
  const totalTWD = current.reduce((sum, row) => sum + row.totalTWD, 0);
  const previousTWD = previous.reduce((sum, row) => sum + row.totalTWD, 0);
  const count = current.reduce((sum, row) => sum + row.count, 0);
  const fund = current.reduce((sum, row) => sum + row.fundTWD, 0);
  return {
    totalTWD,
    previousTWD,
    changePct: previousTWD > 0 ? ((totalTWD - previousTWD) / previousTWD) * 100 : null,
    monthlyAvgTWD: current.length > 0 ? Math.round(totalTWD / current.length) : 0,
    count,
    avgTicketTWD: count > 0 ? Math.round(totalTWD / count) : 0,
    fundShare: totalTWD > 0 ? fund / totalTWD : 0,
    monthsWithinBudget: budget && budget > 0 ? current.filter((row) => row.totalTWD <= budget).length : null,
  };
}

/** 期間內金額最高的前 n 個類別（其他併成 OTHER_CATEGORY_KEY），給堆疊長條用 */
export function topCategoryKeys(rows: MonthlyRow[], n = 5): string[] {
  const totals = new Map<string, number>();
  rows.forEach((row) => Object.entries(row.byCategory).forEach(([key, value]) => totals.set(key, (totals.get(key) ?? 0) + value)));
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key]) => key);
}

export type CategoryStackRow = { label: string } & Record<string, number | string>;

export function buildCategoryStack(rows: MonthlyRow[], keys: string[]): CategoryStackRow[] {
  return rows.map((row) => {
    const out: CategoryStackRow = { label: row.label };
    let other = 0;
    Object.entries(row.byCategory).forEach(([key, value]) => {
      if (keys.includes(key)) out[key] = value;
      else other += value;
    });
    keys.forEach((key) => { if (typeof out[key] !== 'number') out[key] = 0; });
    out[OTHER_CATEGORY_KEY] = other;
    return out;
  });
}

export interface CategoryChangeRow {
  key: string;
  currentTWD: number;
  previousTWD: number;
  diffTWD: number;
  /** null = 前一段期間沒有這個類別 */
  diffPct: number | null;
  share: number;
}

/** 這段期間 vs 前一段同長度期間，每個類別的增減（依本期金額排序） */
export function buildCategoryChanges(current: MonthlyRow[], previous: MonthlyRow[]): CategoryChangeRow[] {
  const sum = (rows: MonthlyRow[]) => {
    const map = new Map<string, number>();
    rows.forEach((row) => Object.entries(row.byCategory).forEach(([key, value]) => map.set(key, (map.get(key) ?? 0) + value)));
    return map;
  };
  const cur = sum(current);
  const prev = sum(previous);
  const total = [...cur.values()].reduce((a, b) => a + b, 0);
  const keys = new Set([...cur.keys(), ...prev.keys()]);
  return [...keys]
    .map((key) => {
      const currentTWD = cur.get(key) ?? 0;
      const previousTWD = prev.get(key) ?? 0;
      return {
        key,
        currentTWD,
        previousTWD,
        diffTWD: currentTWD - previousTWD,
        diffPct: previousTWD > 0 ? ((currentTWD - previousTWD) / previousTWD) * 100 : null,
        share: total > 0 ? currentTWD / total : 0,
      };
    })
    .sort((a, b) => b.currentTWD - a.currentTWD || b.previousTWD - a.previousTWD);
}

export interface PaidVsShareRow {
  uid: string;
  /** 實際付出去的（墊付共同支出） */
  paidTWD: number;
  /** 依分攤應負擔 */
  shareTWD: number;
  /** 存進公基金 */
  contributedTWD: number;
}

/** 期間內每位成員：付了多少、應負擔多少、存了多少公基金（看分工是否平均） */
export function buildPaidVsShare(
  txs: Transaction[],
  entries: HouseholdFundEntry[],
  memberIds: string[],
  start: Date,
  end: Date,
): PaidVsShareRow[] {
  const rows = new Map(memberIds.map((uid) => [uid, { uid, paidTWD: 0, shareTWD: 0, contributedTWD: 0 }]));
  for (const tx of activeExpenses(txs)) {
    if (!inWindow(tx, start, end)) continue;
    const shares = sharesOfTx(tx, memberIds);
    const payer = txPayerId(tx);
    const payerRow = rows.get(payer);
    if (payerRow) payerRow.paidTWD += householdPortionTWD(tx, memberIds);
    memberIds.forEach((uid) => {
      const row = rows.get(uid);
      // 公基金付的不算任何人的負擔（與誰欠誰一致）
      if (row && tx.paidByUid !== HOUSEHOLD_FUND_PAYER_ID) row.shareTWD += shares[uid] ?? 0;
    });
  }
  for (const entry of entries) {
    if (entry.type === 'reimbursement' || entry.date < start || entry.date > end || !entry.contributorUid) continue;
    const row = rows.get(entry.contributorUid);
    if (row) row.contributedTWD += entry.amountTWD;
  }
  return [...rows.values()];
}

const WEEKDAY_LABELS = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];

export interface WeekdayRow {
  label: string;
  totalTWD: number;
  count: number;
}

/** 星期幾花最多（台北時間） */
export function buildWeekdayRows(txs: Transaction[], memberIds: string[], start: Date, end: Date): WeekdayRow[] {
  const rows = WEEKDAY_LABELS.map((label) => ({ label, totalTWD: 0, count: 0 }));
  for (const tx of activeExpenses(txs)) {
    if (!inWindow(tx, start, end)) continue;
    // ISO 星期：1 = 週一 … 7 = 週日
    const index = Number(formatTW(tx.date, 'i')) - 1;
    const row = rows[index];
    if (!row) continue;
    row.totalTWD += householdPortionTWD(tx, memberIds);
    row.count += 1;
  }
  return rows;
}

export interface FundMonthRow {
  key: string;
  label: string;
  contributedTWD: number;
  spentTWD: number;
  /** 月底累計餘額（從第一筆紀錄算起，不只期間內） */
  balanceTWD: number;
}

export function buildFundMonthRows(entries: HouseholdFundEntry[], txs: Transaction[], months: MonthWindow[]): FundMonthRow[] {
  const fundTxs = activeExpenses(txs).filter((tx) => tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID);
  return months.map((month) => {
    let contributed = 0;
    let spent = 0;
    let balance = 0;
    for (const entry of entries) {
      // 撥還不影響帳上可用餘額（義務在記支出時已扣），也不是存入
      if (entry.type === 'reimbursement') continue;
      if (entry.date <= month.end) balance += entry.amountTWD;
      if (entry.date >= month.start && entry.date <= month.end) contributed += entry.amountTWD;
    }
    for (const tx of fundTxs) {
      const amount = effectiveAmountTWD(tx);
      if (tx.date <= month.end) balance -= amount;
      if (inWindow(tx, month.start, month.end)) spent += amount;
    }
    return { key: month.key, label: month.label, contributedTWD: contributed, spentTWD: spent, balanceTWD: balance };
  });
}

export interface MonthForecast {
  spentTWD: number;
  /** 依目前日均推估的月底金額 */
  projectedTWD: number;
  dayOfMonth: number;
  daysInMonth: number;
  /** 預算剩餘每天可花（沒預算或已超支為 null） */
  dailyAllowanceTWD: number | null;
  budgetTWD: number | null;
  overBudget: boolean;
  projectedOverBudget: boolean;
}

export function forecastMonth(monthTotalTWD: number, budget: number | null, now: Date = new Date()): MonthForecast {
  const key = formatTWMonthKey(now);
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dayOfMonth = Number(formatTW(now, 'd'));
  const projected = dayOfMonth > 0 ? Math.round((monthTotalTWD / dayOfMonth) * daysInMonth) : monthTotalTWD;
  const remainingDays = daysInMonth - dayOfMonth + 1;
  const hasBudget = budget !== null && budget > 0;
  return {
    spentTWD: monthTotalTWD,
    projectedTWD: projected,
    dayOfMonth,
    daysInMonth,
    dailyAllowanceTWD: hasBudget && monthTotalTWD < budget ? Math.floor((budget - monthTotalTWD) / remainingDays) : null,
    budgetTWD: hasBudget ? budget : null,
    overBudget: hasBudget && monthTotalTWD > budget,
    projectedOverBudget: hasBudget && projected > budget,
  };
}

export type BudgetState = 'ok' | 'warn' | 'over';

export interface CategoryBudgetRow {
  key: string;
  budgetTWD: number;
  spentTWD: number;
  pct: number;
  state: BudgetState;
}

/** 類別預算進度：≥ 80% 警示、> 100% 超支；依使用率排序 */
export function buildCategoryBudgetRows(byCategory: Array<{ key: string; totalTWD: number }>, budgets: Record<string, number>): CategoryBudgetRow[] {
  const spent = new Map(byCategory.map((row) => [row.key, row.totalTWD]));
  return Object.entries(budgets)
    .filter(([, budget]) => budget > 0)
    .map(([key, budgetTWD]) => {
      const spentTWD = spent.get(key) ?? 0;
      const pct = (spentTWD / budgetTWD) * 100;
      return { key, budgetTWD, spentTWD, pct, state: (pct > 100 ? 'over' : pct >= 80 ? 'warn' : 'ok') as BudgetState };
    })
    .sort((a, b) => b.pct - a.pct);
}

export function topExpenses(txs: Transaction[], memberIds: string[], start: Date, end: Date, limit = 8): Array<{ tx: Transaction; amountTWD: number }> {
  return activeExpenses(txs)
    .filter((tx) => inWindow(tx, start, end))
    .map((tx) => ({ tx, amountTWD: householdPortionTWD(tx, memberIds) }))
    .sort((a, b) => b.amountTWD - a.amountTWD)
    .slice(0, limit);
}

export interface UpcomingDeduction {
  id: string;
  name: string;
  categoryKey: string;
  amountTWD: number;
  /** 台北日期 'yyyy-MM-dd' */
  date: string;
  daysAway: number;
}

/** 接下來 days 天內的公基金固定扣款（本月已扣的不列） */
export function upcomingDeductions(
  plan: HouseholdFundPlan | null | undefined,
  chargedTxIds: Set<string>,
  householdId: string,
  now: Date = new Date(),
  days = 14,
): UpcomingDeduction[] {
  if (!plan || !plan.enabled) return [];
  const todayKey = formatTW(now, 'yyyy-MM-dd');
  const today = Date.UTC(Number(todayKey.slice(0, 4)), Number(todayKey.slice(5, 7)) - 1, Number(todayKey.slice(8, 10)));
  const out: UpcomingDeduction[] = [];
  for (let offset = 0; offset <= 1; offset += 1) {
    const ref = new Date(today);
    ref.setUTCMonth(ref.getUTCMonth() + offset, 1);
    const year = ref.getUTCFullYear();
    const month = ref.getUTCMonth() + 1;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    if (plan.startMonth && monthKey < plan.startMonth) continue;
    for (const item of plan.fixedExpenses) {
      if (!item.enabled) continue;
      const day = fundPlanDueDay(item.dayOfMonth, year, month);
      const due = Date.UTC(year, month - 1, day);
      const daysAway = Math.round((due - today) / 86_400_000);
      if (daysAway < 0 || daysAway > days) continue;
      if (chargedTxIds.has(`fundplan_${householdId}_${item.id}_${monthKey.replace('-', '')}`)) continue;
      out.push({
        id: `${item.id}@${monthKey}`,
        name: item.name,
        categoryKey: item.categoryKey,
        amountTWD: item.amountTWD,
        date: `${monthKey}-${String(day).padStart(2, '0')}`,
        daysAway,
      });
    }
  }
  return out.sort((a, b) => a.daysAway - b.daysAway);
}
