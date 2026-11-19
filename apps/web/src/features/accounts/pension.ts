/**
 * 退休帳戶（account type = pension）試算：以目前餘額 + 每月提繳 + 預期年化報酬，
 * 估算到退休年齡時的帳戶價值。純函式，不 import firebase。
 *
 * 口徑與 investments/investment-planner 的 futureValue 一致：月利率 = 年化 / 12、期末提繳。
 * 退休時間點 = 出生年 + 退休年齡 那一年的 1 月（只有出生年，不追到月份）。
 */
import type { PensionAccountDetails } from './types';

export const DEFAULT_RETIREMENT_AGE = 65;
export const DEFAULT_PENSION_RETURN_PCT = 3;

/** 每月提繳 = 月提繳工資 × (雇主 % + 自提 %) */
export function pensionMonthlyContributionTWD(details: PensionAccountDetails): number {
  const salary = details.monthlySalaryTWD ?? 0;
  const pct = (details.employerContributionPct ?? 0) + (details.selfContributionPct ?? 0);
  if (!(salary > 0) || !(pct > 0)) return 0;
  return salary * pct / 100;
}

/** 期末年金終值：current × (1+r)^n + monthly × ((1+r)^n − 1) / r */
export function futureValueWithContributions(
  current: number,
  monthlyContribution: number,
  annualReturnPct: number,
  months: number,
): number {
  const n = Math.max(0, Math.floor(months));
  const r = annualReturnPct / 100 / 12;
  if (Math.abs(r) < 1e-9) return current + monthlyContribution * n;
  const growth = Math.pow(1 + r, n);
  return current * growth + monthlyContribution * ((growth - 1) / r);
}

/** 距離退休還有幾個月；已過退休年齡回 0。twYear / twMonth（1–12）用台北日曆 */
export function monthsUntilRetirement(
  birthYear: number,
  retirementAge: number,
  twYear: number,
  twMonth: number,
): number {
  const months = (birthYear + retirementAge - twYear) * 12 - (twMonth - 1);
  return Math.max(0, months);
}

export interface PensionProjection {
  monthsLeft: number;
  retirementYear: number;
  monthlyContributionTWD: number;
  expectedReturnPct: number;
  projectedTWD: number;
}

/** 缺出生年 → null（無法推算剩餘期數） */
export function projectPension(
  balanceTWD: number,
  details: PensionAccountDetails | undefined,
  today: { twYear: number; twMonth: number },
): PensionProjection | null {
  if (!details?.birthYear) return null;
  const retirementAge = details.retirementAge ?? DEFAULT_RETIREMENT_AGE;
  const expectedReturnPct = details.expectedReturnPct ?? DEFAULT_PENSION_RETURN_PCT;
  const monthlyContributionTWD = pensionMonthlyContributionTWD(details);
  const monthsLeft = monthsUntilRetirement(details.birthYear, retirementAge, today.twYear, today.twMonth);
  return {
    monthsLeft,
    retirementYear: details.birthYear + retirementAge,
    monthlyContributionTWD,
    expectedReturnPct,
    projectedTWD: futureValueWithContributions(balanceTWD, monthlyContributionTWD, expectedReturnPct, monthsLeft),
  };
}
