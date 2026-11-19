/**
 * 月底結餘預測：
 *
 * 取本月已發生的 income / expense（個人份額）+ 近 6 個月固定 + 變動支出 baseline，
 * 推估月底結餘。
 *
 * 排除項：
 *   - category === 'rental_purchase' — 一次性的租賃購入是「資產轉換」不是真支出
 *     （已被淨值用 rentalUnrecovered 虛擬資產抵銷，不該被算進「日常開銷節奏」）
 *   - type === 'transfer' — 帳戶之間搬錢
 *
 * 演算法：
 *   1. 本月日常支出 spentSoFar（排除 rental_purchase）、已收入 incomeSoFar
 *   2. dayOfMonth / lastDay = pctElapsed
 *   3. 過去 6 個月平均日常支出 / 收入 = monthlyAvg（同樣排除 rental_purchase）
 *   4. expectedTotalExpense = spentSoFar + 歷史剩餘節奏 + 目前超支的一半
 *      線性外推在月中遇到一筆大額支出會暴衝，所以只把超出歷史節奏的部分折半納入。
 *   5. expectedTotalIncome = max(incomeSoFar, monthlyIncomeAvg)
 *   6. expectedNet = income − expense；若起始現金已知（startingLiquidTWD）就回傳預估月底結餘
 */

import type { Transaction } from '@/features/ledger/types';
import { nowTW } from '@/lib/tz';
import { NON_CONSUMPTION_EXPENSE_CATEGORIES, isEarnedIncome } from './metrics';

/** 同 `NON_CONSUMPTION_EXPENSE_CATEGORIES`（保留舊名給既有呼叫端） */
export const FORECAST_EXCLUDED_CATEGORIES: ReadonlyArray<string> = NON_CONSUMPTION_EXPENSE_CATEGORIES;

export function isForecastExcludedExpense(tx: Pick<Transaction, 'type' | 'category'>): boolean {
  return tx.type === 'expense' && FORECAST_EXCLUDED_CATEGORIES.includes(tx.category);
}

export interface MonthlyForecast {
  spentSoFar: number;
  incomeSoFar: number;
  pctElapsed: number;
  daysLeft: number;
  monthlyExpenseAvg: number;
  monthlyIncomeAvg: number;
  expectedTotalExpense: number;
  expectedTotalIncome: number;
  /** 本月預期淨流（income − expense），不含資產轉換 */
  expectedNet: number;
  /** 月底預期可用現金（startingLiquidTWD + expectedNet），給 monthly forecast card 「月底結餘」用 */
  expectedEndingLiquid?: number;
  /** 預估超支 = expected − budget（正值=超） */
  expectedOverBudget?: number;
  /** 本月已被排除（rental_purchase 等）支出總額；給 UI 標註用 */
  excludedExpenseTWD: number;
}

export interface ForecastOptions {
  /** 「目前」的可用現金（淨值卡上的 displayLiquidTWD，已抵銷掉 rental purchase）— 用來推估月底現金 */
  currentLiquidTWD?: number;
}

export function computeMonthlyForecast(
  thisMonthTxs: Transaction[],
  pastMonthsTxs: Array<{ month: string; expense: number; income: number }>,
  budgetTotal: number | null,
  shareFor: (tx: Transaction) => number,
  today: Date = nowTW(),
  options: ForecastOptions = {},
): MonthlyForecast {
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const dayOfMonth = today.getDate();
  const pctElapsed = dayOfMonth / lastDay;
  const daysLeft = Math.max(0, lastDay - dayOfMonth);

  let spentSoFar = 0;
  let incomeSoFar = 0;
  let excludedExpenseTWD = 0;
  for (const t of thisMonthTxs) {
    if (t.deletedAt) continue;
    if (t.type === 'expense') {
      if (isForecastExcludedExpense(t)) {
        excludedExpenseTWD += shareFor(t);
        continue;
      }
      spentSoFar += shareFor(t);
    } else if (isEarnedIncome(t)) {
      incomeSoFar += t.amountTWD;
    }
  }

  const validPast = pastMonthsTxs.filter((m) => m.expense > 0 || m.income > 0);
  const monthlyExpenseAvg = validPast.length
    ? validPast.reduce((s, m) => s + m.expense, 0) / validPast.length
    : 0;
  const monthlyIncomeAvg = validPast.length
    ? validPast.reduce((s, m) => s + m.income, 0) / validPast.length
    : 0;

  const elapsedBaselineExpense = monthlyExpenseAvg * pctElapsed;
  const remainingBaselineExpense = Math.max(0, monthlyExpenseAvg * (1 - pctElapsed));
  const overspendSoFar = Math.max(0, spentSoFar - elapsedBaselineExpense);
  const expectedTotalExpense = pctElapsed < 0.1
    ? Math.max(spentSoFar, monthlyExpenseAvg)
    : spentSoFar + remainingBaselineExpense + overspendSoFar * 0.5;

  const expectedTotalIncome = Math.max(incomeSoFar, monthlyIncomeAvg);

  const expectedNet = expectedTotalIncome - expectedTotalExpense;
  // 從「目前現金」往前推剩下月份的 income / expense：
  //   ending = current + (expectedIncome − incomeSoFar) − (expectedExpense − spentSoFar)
  const expectedEndingLiquid = options.currentLiquidTWD != null
    ? options.currentLiquidTWD
      + Math.max(0, expectedTotalIncome - incomeSoFar)
      - Math.max(0, expectedTotalExpense - spentSoFar)
    : undefined;
  const expectedOverBudget = budgetTotal != null ? expectedTotalExpense - budgetTotal : undefined;

  return {
    spentSoFar,
    incomeSoFar,
    pctElapsed,
    daysLeft,
    monthlyExpenseAvg,
    monthlyIncomeAvg,
    expectedTotalExpense,
    expectedTotalIncome,
    expectedNet,
    expectedEndingLiquid,
    expectedOverBudget,
    excludedExpenseTWD,
  };
}
