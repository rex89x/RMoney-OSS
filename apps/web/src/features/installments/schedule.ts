/**
 * 分期期數 / 金額 / 日期的純函式（無 Firestore 依賴，apps/web/tests/amortization.test.cjs 直接測）。
 *
 * 口徑必須與 apps-script/src/Installments.gs 一致（apps-script/tests/installments.test.cjs 有 parity 測試）：
 *   perPeriod = floor((total + fee) / N)，第 1..N−1 期 = perPeriod，第 N 期 = (total + fee) − perPeriod × (N − 1)
 *   第 i 期日期 = addTWCalendarMonths(startDate, i − 1)（一律從首期日推算，月底 clamp，pitfall #23）
 */
import { addTWCalendarMonths } from '@/lib/tz';
import type { InstallmentPlan } from './types';

type PlanAmounts = Pick<InstallmentPlan, 'totalAmountTWD' | 'feeTWD' | 'periods' | 'perPeriodTWD'>;
type PlanRemaining = PlanAmounts & Pick<InstallmentPlan, 'paidPeriods' | 'status'>;
type PlanTimeline = Pick<InstallmentPlan, 'periods' | 'paidPeriods' | 'status' | 'startDate'>;

function normalizePeriods(periods: number): number {
  return Math.max(1, Math.round(Number(periods) || 0));
}

/** 每期金額（整數 TWD）；尾差由最後一期吸收 */
export function installmentPerPeriodTWD(totalWithFeeTWD: number, periods: number): number {
  return Math.floor(Math.round(totalWithFeeTWD) / normalizePeriods(periods));
}

/** 把總額切成 N 期；加總 = round(total) */
export function splitInstallmentAmounts(totalWithFeeTWD: number, periods: number): number[] {
  const n = normalizePeriods(periods);
  const total = Math.round(totalWithFeeTWD);
  const per = installmentPerPeriodTWD(total, n);
  return Array.from({ length: n }, (_, i) => (i < n - 1 ? per : total - per * (n - 1)));
}

/** 第 index 期金額（index 從 1 起算）。perPeriodTWD < 0 代表舊資料沒存，現算 */
export function installmentPeriodAmount(plan: PlanAmounts, index: number): number {
  const n = normalizePeriods(plan.periods);
  const total = Math.round(plan.totalAmountTWD) + Math.round(plan.feeTWD || 0);
  const per = plan.perPeriodTWD >= 0 ? plan.perPeriodTWD : installmentPerPeriodTWD(total, n);
  return index < n ? per : total - per * (n - 1);
}

/** 第 index 期入帳日（index 從 1 起算） */
export function installmentPeriodDate(startDate: Date, index: number): Date {
  return addTWCalendarMonths(startDate, index - 1);
}

/** 尚未入帳（還沒進信用卡餘額）的金額；只算進行中的計畫 */
export function installmentRemainingTWD(plan: PlanRemaining): number {
  if (plan.status !== 'active') return 0;
  const n = normalizePeriods(plan.periods);
  let remaining = 0;
  for (let i = Math.max(0, plan.paidPeriods) + 1; i <= n; i++) remaining += installmentPeriodAmount(plan, i);
  return remaining;
}

export function totalInstallmentRemainingTWD(plans: readonly PlanRemaining[]): number {
  return plans.reduce((s, p) => s + installmentRemainingTWD(p), 0);
}

/** 下一期入帳日；已繳完 / 已取消回傳 null */
export function nextInstallmentDate(plan: PlanTimeline): Date | null {
  if (plan.status !== 'active') return null;
  const next = plan.paidPeriods + 1;
  if (next > normalizePeriods(plan.periods)) return null;
  return installmentPeriodDate(plan.startDate, next);
}

/** 最後一期日期（顯示「繳到哪個月」） */
export function lastInstallmentDate(plan: Pick<InstallmentPlan, 'periods' | 'startDate'>): Date {
  return installmentPeriodDate(plan.startDate, normalizePeriods(plan.periods));
}

export interface InstallmentScheduleRow {
  index: number;
  date: Date;
  amountTWD: number;
  posted: boolean;
}

export function installmentScheduleRows(plan: PlanAmounts & PlanTimeline): InstallmentScheduleRow[] {
  const n = normalizePeriods(plan.periods);
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    date: installmentPeriodDate(plan.startDate, i + 1),
    amountTWD: installmentPeriodAmount(plan, i + 1),
    posted: i + 1 <= plan.paidPeriods,
  }));
}
