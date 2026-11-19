import { useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, Gauge, Settings2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/hooks/use-auth';
import { resolveIcon } from '@/lib/icons';
import { cn, formatCurrency } from '@/lib/utils';
import { useCategories } from '@/features/ledger/hooks';
import { useHouseholdLedger, useHouseholdMonthSummary } from '../hooks';
import {
  buildCategoryBudgetRows, buildMonthlyRows, forecastMonth, lastMonths, upcomingDeductions,
} from '../analytics';
import { memberCan, type Household } from '../types';
import { HouseholdBudgetDialog } from './household-budget-dialog';

/** 總覽：本月花費推估、類別預算進度、接下來兩週的公基金固定扣款 */
export function HouseholdMonthPulseCard({ household }: { household: Household }) {
  const { user } = useAuth();
  const { summary } = useHouseholdMonthSummary(household);
  const { txs } = useHouseholdLedger(household);
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c])), [categories]);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const canEditBudget = memberCan(household, user?.uid, 'canEditSettings');

  const budget = household.monthlyBudgetTWD ?? null;
  const forecast = forecastMonth(summary.totalTWD, budget);
  const budgetRows = buildCategoryBudgetRows(summary.byCategory, household.categoryBudgets ?? {});
  const upcoming = useMemo(
    () => upcomingDeductions(household.fundPlan, new Set(txs.map((tx) => tx.id)), household.id),
    [household.fundPlan, household.id, txs],
  );
  // 近 3 個完整月份的類別平均，給預算設定參考
  const averages = useMemo(() => {
    const rows = buildMonthlyRows(txs, household.memberIds, lastMonths(3, 1));
    const out: Record<string, number> = {};
    rows.forEach((row) => Object.entries(row.byCategory).forEach(([key, value]) => { out[key] = (out[key] ?? 0) + value / 3; }));
    Object.keys(out).forEach((key) => { out[key] = Math.round(out[key] ?? 0); });
    return out;
  }, [txs, household.memberIds]);

  const spentPct = forecast.budgetTWD ? Math.min(100, (forecast.spentTWD / forecast.budgetTWD) * 100) : null;
  const timePct = (forecast.dayOfMonth / forecast.daysInMonth) * 100;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Gauge className="size-4" /> 本月脈動</CardTitle>
        {canEditBudget ? (
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setBudgetOpen(true)}>
            <Settings2 className="size-4" /> 預算
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          <Metric label="目前已花" value={formatCurrency(forecast.spentTWD)} hint={`第 ${forecast.dayOfMonth} / ${forecast.daysInMonth} 天`} />
          <Metric
            label="月底推估"
            value={formatCurrency(forecast.projectedTWD)}
            hint="依目前日均"
            tone={forecast.projectedOverBudget ? 'bad' : undefined}
          />
          <Metric
            label="剩餘每天可花"
            value={forecast.dailyAllowanceTWD !== null ? formatCurrency(forecast.dailyAllowanceTWD) : '—'}
            hint={forecast.budgetTWD ? `預算 ${formatCurrency(forecast.budgetTWD)}` : '尚未設定總預算'}
            tone={forecast.overBudget ? 'bad' : undefined}
            className="col-span-2 sm:col-span-1"
          />
        </div>

        {spentPct !== null ? (
          <div>
            <div className="relative">
              <Progress
                value={spentPct}
                className="h-2"
                indicatorClassName={forecast.overBudget ? 'bg-destructive' : forecast.projectedOverBudget ? 'bg-warning' : undefined}
              />
              {/* 時間進度刻度：花費條超過這條線代表花得比時間快 */}
              <div className="absolute -top-1 h-4 w-0.5 bg-foreground/60" style={{ left: `${timePct}%` }} aria-hidden />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              直線是本月時間進度（{Math.round(timePct)}%）；花費 {Math.round(spentPct)}%
              {forecast.projectedOverBudget && !forecast.overBudget ? '，照目前速度月底會超支' : ''}
              {forecast.overBudget ? '，已超過預算' : ''}
            </p>
          </div>
        ) : null}

        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">類別預算</h4>
          {budgetRows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              還沒設定類別預算。{canEditBudget ? '按右上「預算」可以替餐飲、日用品等類別設上限。' : ''}
            </p>
          ) : (
            <ul className="space-y-2">
              {budgetRows.map((row) => {
                const category = catMap[row.key];
                const Icon = resolveIcon(category?.icon);
                return (
                  <li key={row.key} className="text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon className="size-3.5 shrink-0" style={{ color: category?.color }} />
                        <span className="break-words">{category?.name ?? row.key}</span>
                        {row.state !== 'ok' ? (
                          <Badge variant={row.state === 'over' ? 'destructive' : 'warning'} className="h-4 px-1 text-[10px]">
                            {row.state === 'over' ? '超支' : '快用完'}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        <span className="font-medium text-foreground">{formatCurrency(row.spentTWD)}</span> / {formatCurrency(row.budgetTWD)}
                      </span>
                    </div>
                    <Progress
                      value={Math.min(100, row.pct)}
                      className="mt-1 h-1.5"
                      indicatorClassName={row.state === 'over' ? 'bg-destructive' : row.state === 'warn' ? 'bg-warning' : undefined}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {upcoming.length > 0 ? (
          <div className="space-y-2">
            <h4 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <CalendarClock className="size-3.5" /> 接下來 14 天公基金固定扣款
            </h4>
            <ul className="space-y-1 text-xs">
              {upcoming.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 break-words">
                    {item.name || catMap[item.categoryKey]?.name || '固定扣款'}
                    <span className="ml-1 text-muted-foreground">
                      {Number(item.date.slice(5, 7))}/{Number(item.date.slice(8, 10))}
                      {item.daysAway === 0 ? '（今天）' : `（${item.daysAway} 天後）`}
                    </span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">{formatCurrency(item.amountTWD)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {forecast.projectedOverBudget ? (
          <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 p-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            照目前速度月底約 {formatCurrency(forecast.projectedTWD)}，會超出預算 {formatCurrency(forecast.projectedTWD - (forecast.budgetTWD ?? 0))}。
          </p>
        ) : null}
      </CardContent>
      <HouseholdBudgetDialog household={household} open={budgetOpen} onOpenChange={setBudgetOpen} averages={averages} />
    </Card>
  );
}

function Metric({ label, value, hint, tone, className }: { label: string; value: string; hint: string; tone?: 'bad'; className?: string }) {
  return (
    <div className={cn('min-w-0 rounded-lg bg-muted/50 p-2', className)}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-sm font-semibold tabular-nums', tone === 'bad' && 'text-destructive')}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{hint}</div>
    </div>
  );
}
