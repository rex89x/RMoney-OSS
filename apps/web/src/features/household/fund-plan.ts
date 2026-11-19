/**
 * 公基金每月計畫（純函式）：每月固定投入的進度、固定扣款狀態、可用月數試算。
 *
 * 自動化在 Apps Script `apps-script/src/HouseholdFundPlan.gs`（每天 01:00），規則要一致：
 * - 存入／扣款日超過當月天數 → 用月底（`fundPlanDueDay`）
 * - 固定扣款交易 id = `fundplan_{hid}_{itemId}_{yyyyMM}`（`fundPlanExpenseTxId`），前端「立即扣款」用同一個 id，不會重複
 * - 本月是否已存 = fund_entries 有 `planMonth === 本月` 且 `contributorUid === 本人`
 */
import { z } from 'zod';
import { formatTWMonthKey } from '@/lib/tz';
import { effectiveAmountTWD, HOUSEHOLD_FUND_PAYER_ID, type Transaction, type TxShare } from '@/features/ledger/types';
import type { Household, HouseholdFundEntry, HouseholdFundFixedExpense, HouseholdFundPlan } from './types';

export function fundPlanMonthKey(date: Date): string {
  return formatTWMonthKey(date);
}

/** 'yyyy-MM' → { year, month } */
export function parseMonthKey(key: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function fundPlanDueDay(dayOfMonth: number, year: number, month: number): number {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(Math.max(1, Math.round(dayOfMonth) || 1), last);
}

/** 台北某日中午（UTC 04:00）：寫入 Timestamp 時不會因時區被推到前一天，與 Apps Script 相同 */
export function fundPlanDueDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 4, 0, 0));
}

export function fundPlanExpenseTxId(householdId: string, itemId: string, monthKey: string): string {
  return `fundplan_${householdId}_${itemId}_${monthKey.replace('-', '')}`;
}

export function newFundPlanItemId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `fx${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function emptyFundPlan(household: Household, now: Date): HouseholdFundPlan {
  return {
    enabled: true,
    dayOfMonth: 5,
    startMonth: fundPlanMonthKey(now),
    autoRecord: false,
    contributions: Object.fromEntries(household.memberIds.map((uid) => [uid, 0])),
    fixedExpenses: [],
  };
}

export type FundContributionState = 'done' | 'partial' | 'due' | 'upcoming' | 'none';

export interface FundContributionStatus {
  uid: string;
  plannedTWD: number;
  recordedTWD: number;
  /** 本月計畫存入的紀錄（可能多筆，例如分兩次存） */
  entries: HouseholdFundEntry[];
  state: FundContributionState;
}

/** skipped = 本月那筆扣款被刪掉了（軟刪），自動化不會再補 */
export type FundExpenseState = 'charged' | 'skipped' | 'due' | 'upcoming' | 'paused';

export interface FundExpenseStatus {
  item: HouseholdFundFixedExpense;
  dueDay: number;
  txId: string;
  tx: Transaction | null;
  state: FundExpenseState;
}

export interface FundPlanStatus {
  monthKey: string;
  /** 本月是否在計畫期間內（startMonth 之後） */
  active: boolean;
  dueDay: number;
  contributions: FundContributionStatus[];
  expenses: FundExpenseStatus[];
  plannedInflowTWD: number;
  fixedOutflowTWD: number;
  /** 近 3 個完整月份，非固定扣款的公基金支出平均 */
  avgVariableOutflowTWD: number;
  /** 每月淨流入 = 計畫存入 − 固定扣款 − 平均其他支出 */
  netMonthlyTWD: number;
  /** 淨流入為負時，目前餘額還能撐幾個月；淨流入 ≥ 0 為 null */
  runwayMonths: number | null;
}

function isFundExpense(tx: Transaction): boolean {
  return !tx.deletedAt && tx.type === 'expense' && tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID;
}

export function buildFundPlanStatus(params: {
  household: Household;
  plan: HouseholdFundPlan;
  entries: HouseholdFundEntry[];
  txs: Transaction[];
  balanceTWD: number;
  now: Date;
}): FundPlanStatus {
  const { household, plan, entries, txs, balanceTWD, now } = params;
  const monthKey = fundPlanMonthKey(now);
  const parsed = parseMonthKey(monthKey) ?? { year: 1970, month: 1 };
  const todayDay = Number(formatTWDay(now));
  const active = !plan.startMonth || monthKey >= plan.startMonth;
  const dueDay = fundPlanDueDay(plan.dayOfMonth, parsed.year, parsed.month);

  const contributions = household.memberIds.map((uid): FundContributionStatus => {
    const plannedTWD = plan.contributions[uid] ?? 0;
    const mine = entries.filter((entry) => entry.type !== 'reimbursement' && entry.planMonth === monthKey && entry.contributorUid === uid);
    const recordedTWD = mine.reduce((sum, entry) => sum + entry.amountTWD, 0);
    let state: FundContributionState;
    if (plannedTWD <= 0) state = recordedTWD > 0 ? 'done' : 'none';
    else if (recordedTWD >= plannedTWD) state = 'done';
    else if (recordedTWD > 0) state = 'partial';
    else state = active && todayDay >= dueDay ? 'due' : 'upcoming';
    return { uid, plannedTWD, recordedTWD, entries: mine, state };
  });

  const txById = new Map(txs.map((tx) => [tx.id, tx]));
  const expenses = plan.fixedExpenses.map((item): FundExpenseStatus => {
    const itemDue = fundPlanDueDay(item.dayOfMonth, parsed.year, parsed.month);
    const txId = fundPlanExpenseTxId(household.id, item.id, monthKey);
    const tx = txById.get(txId) ?? null;
    let state: FundExpenseState;
    if (tx) state = tx.deletedAt ? 'skipped' : 'charged';
    else if (!item.enabled) state = 'paused';
    else state = active && todayDay >= itemDue ? 'due' : 'upcoming';
    return { item, dueDay: itemDue, txId, tx, state };
  });

  const plannedInflowTWD = household.memberIds.reduce((sum, uid) => sum + (plan.contributions[uid] ?? 0), 0);
  const fixedOutflowTWD = plan.fixedExpenses.filter((item) => item.enabled).reduce((sum, item) => sum + item.amountTWD, 0);

  // 近 3 個「完整」月份（不含本月）的非固定扣款公基金支出
  const recentMonths = new Set([1, 2, 3].map((offset) => {
    const d = new Date(Date.UTC(parsed.year, parsed.month - 1 - offset, 15));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }));
  const fixedPrefix = `fundplan_${household.id}_`;
  const variableTotal = txs
    .filter((tx) => isFundExpense(tx) && !tx.id.startsWith(fixedPrefix) && recentMonths.has(fundPlanMonthKey(tx.date)))
    .reduce((sum, tx) => sum + effectiveAmountTWD(tx), 0);
  const avgVariableOutflowTWD = Math.round(variableTotal / 3);
  const netMonthlyTWD = plannedInflowTWD - fixedOutflowTWD - avgVariableOutflowTWD;
  const runwayMonths = netMonthlyTWD < 0 && balanceTWD > 0 ? balanceTWD / -netMonthlyTWD : netMonthlyTWD < 0 ? 0 : null;

  return {
    monthKey,
    active,
    dueDay,
    contributions,
    expenses,
    plannedInflowTWD,
    fixedOutflowTWD,
    avgVariableOutflowTWD,
    netMonthlyTWD,
    runwayMonths,
  };
}

function formatTWDay(date: Date): string {
  // 'yyyy-MM' 已有月份；這裡只要台北當天的日
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', day: 'numeric' }).format(date);
}

// ---------- 表單 ----------

export const HouseholdFundFixedExpenseSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, '請輸入名稱').max(40, '最多 40 字'),
  amountTWD: z.coerce.number().int('請輸入整數').positive('金額需大於 0'),
  categoryKey: z.string().min(1, '請選擇類別'),
  dayOfMonth: z.coerce.number().int().min(1).max(31),
  enabled: z.boolean(),
});

export const HouseholdFundPlanSchema = z.object({
  enabled: z.boolean(),
  dayOfMonth: z.coerce.number().int().min(1, '1–31').max(31, '1–31'),
  startMonth: z.string().regex(/^\d{4}-\d{2}$/, '請選擇開始月份'),
  autoRecord: z.boolean(),
  contributions: z.record(z.string(), z.coerce.number().int('請輸入整數').min(0, '不可為負數')),
  fixedExpenses: z.array(HouseholdFundFixedExpenseSchema).max(20, '最多 20 筆固定扣款'),
});

export type HouseholdFundPlanFormValues = z.input<typeof HouseholdFundPlanSchema>;

/** 公基金付款仍依預設比例記錄各成員負擔（與 SplitEditor ratio 模式、Apps Script fundPlanShares_ 一致；尾差給最後一位） */
export function fundPlanShares(amountTWD: number, memberIds: string[], splitRatio: Record<string, number>): TxShare[] {
  if (memberIds.length === 0) return [];
  const total = memberIds.reduce((sum, id) => sum + (splitRatio[id] ?? 0), 0);
  let allocated = 0;
  return memberIds.map((memberId, index) => {
    const weight = total > 0 ? (splitRatio[memberId] ?? 0) / total : 1 / memberIds.length;
    const amount = index === memberIds.length - 1 ? amountTWD - allocated : Math.round(amountTWD * weight);
    allocated += amount;
    return { memberId, amountTWD: amount };
  });
}
