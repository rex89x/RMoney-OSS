import { useMemo } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useGoals } from '@/features/goals/hooks';
import { useInvestmentPlans } from '@/features/investments/hooks';
import { hasRetirementSetup } from '@/features/investments/retirement';
import { useAccounts } from '@/features/accounts/hooks';
import { useEmergencyFund } from '@/features/net-worth/hooks';
import { monthTWRange, nowTW } from '@/lib/tz';
import { useTransactions } from './hooks';
import { useMyExpenseShare } from './use-my-share';
import { isConsumptionExpense, isEarnedIncome } from '@/features/analytics/metrics';

export interface FinancialHealthMetrics {
  averageMonthlyIncomeTWD: number;
  averageMonthlyExpenseTWD: number;
  averageMonthlySurplusTWD: number;
  savingsRatePct: number | null;
  emergencyMonths: number;
  savingsGoalProgressPct: number | null;
  plannedMonthlyInvestmentTWD: number;
  hasRetirementPlan: boolean;
  recommendations: string[];
}

export function useFinancialHealth(): FinancialHealthMetrics & { isLoading: boolean } {
  const { profile } = useAuth();
  const myExpenseShare = useMyExpenseShare();
  const range = useMemo(() => previousThreeFullMonths(), []);
  const { data: transactions = [], isLoading: txLoading } = useTransactions({
    startDate: range.start,
    endDate: range.end,
    limit: 2000,
  });
  const { data: goals = [], isLoading: goalsLoading } = useGoals();
  const { data: plans = [], isLoading: plansLoading } = useInvestmentPlans();
  const { data: accounts = [] } = useAccounts();

  const cashFlow = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const transaction of transactions) {
      if (isEarnedIncome(transaction)) income += transaction.amountTWD;
      if (isConsumptionExpense(transaction)) expense += myExpenseShare(transaction);
    }
    return {
      averageMonthlyIncomeTWD: income / 3,
      averageMonthlyExpenseTWD: expense / 3,
    };
  }, [myExpenseShare, transactions]);

  const emergencyTargetMonths = profile?.preferences?.emergencyFund?.targetMonths ?? 6;
  const emergencyBaseline = profile?.preferences?.emergencyFund?.monthlyBaseline
    ?? cashFlow.averageMonthlyExpenseTWD;
  const emergency = useEmergencyFund(emergencyBaseline, emergencyTargetMonths);

  const metrics = useMemo<FinancialHealthMetrics>(() => {
    const averageMonthlySurplusTWD = cashFlow.averageMonthlyIncomeTWD - cashFlow.averageMonthlyExpenseTWD;
    const savingsRatePct = cashFlow.averageMonthlyIncomeTWD > 0
      ? averageMonthlySurplusTWD / cashFlow.averageMonthlyIncomeTWD * 100
      : null;
    const totalGoalTarget = goals.reduce((sum, goal) => sum + goal.targetTWD, 0);
    const totalGoalCurrent = goals.reduce((sum, goal) => sum + goal.currentTWD, 0);
    const savingsGoalProgressPct = totalGoalTarget > 0
      ? Math.min(100, totalGoalCurrent / totalGoalTarget * 100)
      : null;
    const plannedMonthlyInvestmentTWD = plans.reduce(
      (sum, plan) => sum + plan.monthlyContributionTWD,
      0,
    );
    // pension 帳戶 + 明確勾選「退休規劃」的投資計畫；舊計畫沒有旗標時退回名稱比對（retirement.ts）
    const hasRetirementPlan = hasRetirementSetup(plans, accounts);
    const recommendations: string[] = [];

    if (savingsRatePct === null) {
      recommendations.push('近 3 個完整月份沒有收入資料，請先補齊收入記帳，才能評估儲蓄率。');
    } else if (savingsRatePct < 0) {
      recommendations.push('近 3 個月平均支出高於收入，先處理現金流缺口，再提高投資投入。');
    } else if (savingsRatePct < 10) {
      recommendations.push('目前儲蓄率低於 10%，可先從固定支出與非必要支出找出可調整項目。');
    }
    if (emergency.monthsCovered < 3) {
      recommendations.push('緊急預備金低於 3 個月支出，建議優先補足流動資金。');
    } else if (emergency.monthsCovered < emergencyTargetMonths) {
      recommendations.push(`緊急預備金尚未達 ${emergencyTargetMonths} 個月目標，可持續定額補足。`);
    }
    if (!hasRetirementPlan) {
      recommendations.push('尚未建立退休規劃：可在帳戶新增「退休帳戶」（勞退個人專戶 / 自提），或在下方投資計畫勾選「這是退休規劃」。');
    }
    if (averageMonthlySurplusTWD > 0 && plannedMonthlyInvestmentTWD > averageMonthlySurplusTWD) {
      recommendations.push('目前計畫的每月投資額高於近 3 個月平均結餘，建議調整投入額或支出。');
    }
    if (!(profile?.preferences?.allocationTargets?.length)) {
      recommendations.push('尚未設定投資配置比例，請建立股票、債券與現金等目標占比。');
    }
    if (!recommendations.length) {
      recommendations.push('現金流、緊急預備金與長期規劃目前沒有明顯缺口；請每月持續檢視配置偏差。');
    }

    return {
      ...cashFlow,
      averageMonthlySurplusTWD,
      savingsRatePct,
      emergencyMonths: emergency.monthsCovered,
      savingsGoalProgressPct,
      plannedMonthlyInvestmentTWD,
      hasRetirementPlan,
      recommendations,
    };
  }, [
    accounts,
    cashFlow,
    emergency.monthsCovered,
    emergencyTargetMonths,
    goals,
    plans,
    profile?.preferences?.allocationTargets?.length,
  ]);

  return {
    ...metrics,
    isLoading: txLoading || goalsLoading || plansLoading,
  };
}

function previousThreeFullMonths(): { start: Date; end: Date } {
  const tw = nowTW();
  const startMonth = new Date(tw.getFullYear(), tw.getMonth() - 3, 1);
  const endMonth = new Date(tw.getFullYear(), tw.getMonth(), 0);
  return {
    start: monthTWRange(startMonth.getFullYear(), startMonth.getMonth() + 1).start,
    end: monthTWRange(endMonth.getFullYear(), endMonth.getMonth() + 1).end,
  };
}
