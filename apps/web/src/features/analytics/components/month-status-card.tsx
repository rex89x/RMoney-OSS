import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Gauge } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatCurrency } from '@/lib/utils';
import { useBudget, useCategories } from '@/features/ledger/hooks';
import { useMonthlyForecast, usePeriodComparison, useTodayKey } from '../hooks';
import { buildMonthHeadline, compareCategories, percentChange } from '../metrics';
import { currentMonthInfo, twDateFromKey } from '../periods';
import { DeltaBadge } from './delta-badge';

/**
 * 首頁最上方「本月狀態」：已花 / 預算進度 / 月底預估 / 儲蓄率 + 一句話結論。
 * 數字口徑 = 消費支出 / 實際收入（features/analytics/metrics.ts）。
 */
export function MonthStatusCard() {
  const today = useTodayKey();
  const info = useMemo(() => currentMonthInfo(twDateFromKey(today)), [today]);
  const cmp = usePeriodComparison('thisMonth');
  const forecast = useMonthlyForecast();
  const { data: budget } = useBudget(info.monthKey);
  const { data: categories = [] } = useCategories();

  const view = useMemo(() => {
    const catName = (k: string) => categories.find((c) => c.key === k)?.name ?? k;
    const deltas = compareCategories(cmp.current.byCategory, cmp.previous.byCategory);
    const inc = deltas[0];
    const dec = deltas[deltas.length - 1];
    const budgetTotal = budget?.total && budget.total > 0 ? budget.total : null;
    const projected = forecast?.expectedTotalExpense ?? null;
    const daysLeft = info.daysInMonth - info.day + 1;
    const remaining = budgetTotal != null ? budgetTotal - cmp.current.expense : null;
    const savingsDelta = cmp.current.savingsRate != null && cmp.previous.savingsRate != null
      ? cmp.current.savingsRate - cmp.previous.savingsRate
      : null;
    return {
      headline: buildMonthHeadline({
        spent: cmp.current.expense,
        prevSpent: cmp.previous.expense,
        topIncrease: inc && inc.delta > 0 ? { name: catName(inc.key), delta: inc.delta } : null,
        topDecrease: dec && dec.delta < 0 ? { name: catName(dec.key), delta: dec.delta } : null,
        budget: budgetTotal,
        projected,
      }),
      budgetTotal,
      projected,
      remaining,
      perDay: remaining != null ? remaining / Math.max(1, daysLeft) : null,
      pctUsed: budgetTotal ? cmp.current.expense / budgetTotal : null,
      pctElapsed: info.day / info.daysInMonth,
      spentDelta: percentChange(cmp.current.expense, cmp.previous.expense),
      savingsDelta,
    };
  }, [cmp, forecast, budget, categories, info]);

  if (cmp.isLoading) {
    return <Card><CardContent className="p-4"><Skeleton className="h-28 w-full" /></CardContent></Card>;
  }

  const overBudget = view.remaining != null && view.remaining < 0;
  const projectedOver = view.budgetTotal != null && view.projected != null && view.projected > view.budgetTotal;

  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Gauge className="size-3.5" /> 本月狀態 · {info.month} 月（第 {info.day} / {info.daysInMonth} 天）
            </div>
            <p className="mt-1 text-sm font-medium leading-snug">{view.headline}</p>
          </div>
          <Link
            to="/ledger?tab=analysis"
            className="flex shrink-0 items-center text-xs text-muted-foreground hover:text-foreground"
          >
            分析 <ChevronRight className="size-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="本月已花" value={formatCurrency(cmp.current.expense)}>
            <DeltaBadge value={view.spentDelta} goodWhen="down" suffix="vs 上月同期" />
          </Stat>
          <Stat
            label="月底預估支出"
            value={view.projected != null ? formatCurrency(view.projected) : '—'}
            tone={projectedOver ? 'bad' : undefined}
          >
            <span className="text-[11px] text-muted-foreground">
              {view.budgetTotal != null ? `預算 ${formatCurrency(view.budgetTotal)}` : '依近 6 個月節奏推估'}
            </span>
          </Stat>
          <Stat
            label={view.budgetTotal != null ? '今日起每天可花' : '本月收入'}
            value={view.perDay != null ? formatCurrency(Math.max(0, view.perDay)) : formatCurrency(cmp.current.income)}
            tone={overBudget ? 'bad' : undefined}
          >
            <span className={cn('text-[11px]', overBudget ? 'text-destructive' : 'text-muted-foreground')}>
              {view.remaining != null
                ? overBudget ? `已超支 ${formatCurrency(-view.remaining)}` : `預算剩 ${formatCurrency(view.remaining)}`
                : '尚未設定預算'}
            </span>
          </Stat>
          <Stat
            label="儲蓄率"
            value={cmp.current.savingsRate != null ? `${Math.round(cmp.current.savingsRate * 100)}%` : '—'}
            tone={cmp.current.savingsRate != null && cmp.current.savingsRate < 0 ? 'bad' : undefined}
          >
            {cmp.current.savingsRate != null
              ? <DeltaBadge value={view.savingsDelta} goodWhen="up" points suffix="vs 上月同期" />
              : <span className="text-[11px] text-muted-foreground">本月尚無收入</span>}
          </Stat>
        </div>

        {view.pctUsed != null ? (
          <div>
            <div className="relative h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full', overBudget ? 'bg-destructive' : view.pctUsed > view.pctElapsed + 0.1 ? 'bg-warning' : 'bg-primary')}
                style={{ width: `${Math.min(100, view.pctUsed * 100)}%` }}
              />
              <div
                className="absolute inset-y-0 w-0.5 bg-foreground/60"
                style={{ left: `${Math.min(100, view.pctElapsed * 100)}%` }}
                aria-hidden
              />
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
              <span>預算已用 {Math.round(view.pctUsed * 100)}%</span>
              <span>時間進度 {Math.round(view.pctElapsed * 100)}%</span>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({
  label, value, tone, children,
}: { label: string; value: string; tone?: 'bad'; children?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('truncate text-lg font-semibold tabular-nums', tone === 'bad' && 'text-destructive')}>{value}</div>
      {children}
    </div>
  );
}
