import { useMemo } from 'react';
import { Calendar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatCurrency, cn } from '@/lib/utils';
import { useBudget } from '@/features/ledger/hooks';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import {
  isConsumptionExpense, twDateFromKey, usePeriodRange, useRangeTransactions, useTodayKey,
} from '@/features/analytics';

/**
 * 「我能花多少」剩餘額度卡：
 *   - 用本月預算總額 − 本月已花 = 還能花
 *   - / 本月剩餘天數 = 每日剩餘建議
 *   - 沒設預算 → 顯示需設定的提示
 */
export function DailyBudgetRemainingCard() {
  const today = useTodayKey();
  const tw = useMemo(() => twDateFromKey(today), [today]);
  const month = today.slice(0, 7);
  const { data: budget } = useBudget(month);
  const { txs } = useRangeTransactions(usePeriodRange('thisMonth'));
  const myShare = useMyExpenseShare();

  const data = useMemo(() => {
    const expenseTotal = txs.filter(isConsumptionExpense).reduce((s, t) => s + myShare(t), 0);
    const budgetTotal = budget?.total ?? 0;
    const remaining = budgetTotal - expenseTotal;
    const lastDay = new Date(tw.getFullYear(), tw.getMonth() + 1, 0).getDate();
    const today = tw.getDate();
    const daysLeft = Math.max(1, lastDay - today + 1); // 含今天
    const dailyRemaining = remaining / daysLeft;
    const pctSpent = budgetTotal ? Math.min(100, (expenseTotal / budgetTotal) * 100) : 0;
    return { expenseTotal, budgetTotal, remaining, daysLeft, dailyRemaining, pctSpent, today, lastDay };
  }, [txs, budget, myShare, tw]);

  if (!data.budgetTotal) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Calendar className="size-4" /> 今日剩餘額度</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">尚未設定本月預算 — 到 設定 → 預算 設定後即可顯示每日剩餘額度建議。</p>
        </CardContent>
      </Card>
    );
  }

  const overBudget = data.remaining < 0;
  const tightBudget = !overBudget && data.dailyRemaining < (data.budgetTotal / data.lastDay) * 0.5;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Calendar className="size-4" /> 今日剩餘額度</span>
          <span className="text-xs font-normal text-muted-foreground">
            還剩 {data.daysLeft} 天
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className={cn('text-3xl font-semibold tabular-nums',
            overBudget ? 'text-destructive' : tightBudget ? 'text-warning' : 'text-success')}>
            {formatCurrency(data.dailyRemaining)}
          </span>
          <span className="text-xs text-muted-foreground">/ 天</span>
        </div>
        <p className="text-xs text-muted-foreground">
          本月剩 {formatCurrency(data.remaining)}（{formatCurrency(data.expenseTotal)} / {formatCurrency(data.budgetTotal)}）
        </p>
        <Progress value={data.pctSpent} className={cn('h-2', overBudget && '[&>div]:bg-destructive')} />
        {overBudget ? (
          <p className="text-xs text-destructive">已超支 {formatCurrency(-data.remaining)}</p>
        ) : tightBudget ? (
          <p className="text-xs text-warning">花費節奏偏快，今日請控制在 {formatCurrency(data.dailyRemaining)} 以內</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
