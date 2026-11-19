import { useCallback, useMemo } from 'react';
import { useBudget } from '@/features/ledger/hooks';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import { formatTW } from '@/lib/tz';
import { useCategoryLookup, usePeriodRange, useRangeTransactions, useTodayKey } from './hooks';
import { budgetImpactMessage, isConsumptionExpense, summarizePeriod } from './metrics';
import { currentMonthInfo, twDateFromKey } from './periods';

/**
 * 記帳存檔後的預算回饋：「餐飲本月已用 82% · 今日起每天可花 340」。
 * 只對「本月、消費類支出」有意義，其餘回 null（呼叫端顯示一般的「已新增」）。
 */
export function useBudgetImpact(enabled: boolean) {
  const today = useTodayKey();
  const info = useMemo(() => currentMonthInfo(twDateFromKey(today)), [today]);
  const { txs } = useRangeTransactions(usePeriodRange('thisMonth'), { enabled });
  const { data: budget } = useBudget(info.monthKey);
  const share = useMyExpenseShare();
  const lookup = useCategoryLookup();
  const summary = useMemo(() => summarizePeriod(txs, share), [txs, share]);

  return useCallback((input: { type: string; category: string; date: Date; myAmountTWD: number }): string | null => {
    if (!isConsumptionExpense({ type: input.type as 'expense', category: input.category })) return null;
    if (formatTW(input.date, 'yyyy-MM') !== info.monthKey) return null;
    return budgetImpactMessage({
      monthSpentBefore: summary.expense,
      categorySpentBefore: summary.byCategory.get(input.category) ?? 0,
      amount: input.myAmountTWD,
      categoryName: lookup(input.category).name,
      categoryLimit: budget?.byCategory?.[input.category] ?? null,
      monthBudget: budget?.total ?? null,
      daysLeft: info.daysInMonth - info.day + 1,
    });
  }, [summary, budget, lookup, info]);
}
