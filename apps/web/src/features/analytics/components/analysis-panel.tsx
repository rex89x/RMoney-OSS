import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Filter, PieChart, Receipt, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatCurrency } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useBudget } from '@/features/ledger/hooks';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import type { Transaction } from '@/features/ledger/types';
import {
  useCategoryLookup, usePeriodComparison, usePeriodRange, useRangeTransactions, useTodayKey,
} from '../hooks';
import { isConsumptionExpense, percentChange, summarizePeriod } from '../metrics';
import { PERIOD_LABEL, currentMonthInfo, twDateFromKey, type PeriodKey } from '../periods';
import { ledgerListHref } from '../drilldown';
import { CategoryBars } from './category-bars';
import { DeltaBadge } from './delta-badge';
import { SpendTrendCard } from './spend-trend-card';
import { CategoryBudgetPaceCard } from './category-budget-pace-card';
import { IncomeBreakdownCard } from './income-breakdown-card';
import { CategoryTrendCard } from './category-trend-card';
import { FixedVariableCard } from './fixed-variable-card';
import { MerchantRankingCard } from './merchant-ranking-card';
import { SpendingPatternCard } from './spending-pattern-card';

const RANGES: PeriodKey[] = ['thisMonth', 'lastMonth', 'last30d', 'last90d', 'ytd'];

/**
 * 記帳 → 分析：期間 KPI（含與比較期間的增減）、類別排行、走勢、預算節奏、收入來源、
 * 長期類別趨勢、固定 / 變動、商家排行、消費習慣。所有圖都能點進交易列表。
 */
export function AnalysisPanel() {
  const navigate = useNavigate();
  const [rangeKey, setRangeKey] = useState<PeriodKey>('thisMonth');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const filter = useCallback((t: Transaction) => !excluded.has(t.category), [excluded]);
  const cmp = usePeriodComparison(rangeKey, excluded.size > 0 ? filter : undefined);
  const myShare = useMyExpenseShare();
  const lookup = useCategoryLookup();

  // 預算節奏永遠看本月（與選的期間無關）
  const today = useTodayKey();
  const month = useMemo(() => currentMonthInfo(twDateFromKey(today)), [today]);
  const monthRange = usePeriodRange('thisMonth');
  const { txs: monthTxs } = useRangeTransactions(monthRange);
  const monthSummary = useMemo(() => summarizePeriod(monthTxs, myShare), [monthTxs, myShare]);
  const { data: budget } = useBudget(month.monthKey);

  const { range, comparison, current, previous } = cmp;
  const compareLabel = `vs ${comparison.label}`;

  // 類別篩選選單：用未排除前的資料
  const { txs: rangeTxsAll } = useRangeTransactions(range);
  const allCategoryKeys = useMemo(() => {
    const set = new Set<string>();
    for (const t of rangeTxsAll) if (isConsumptionExpense(t)) set.add(t.category);
    return Array.from(set);
  }, [rangeTxsAll]);

  const categoryRows = useMemo(
    () => [...current.byCategory.entries()].map(([key, value]) => {
      const info = lookup(key);
      return { key, name: info.name, color: info.color, value, prev: previous.byCategory.get(key) ?? 0 };
    }),
    [current.byCategory, previous.byCategory, lookup],
  );

  const topTxs = useMemo(
    () => cmp.txs
      .filter(isConsumptionExpense)
      .map((tx) => ({ tx, my: myShare(tx) }))
      .filter((x) => x.my > 0)
      .sort((a, b) => b.my - a.my)
      .slice(0, 5),
    [cmp.txs, myShare],
  );

  function toggleCategory(key: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const savingsDelta = current.savingsRate != null && previous.savingsRate != null
    ? current.savingsRate - previous.savingsRate
    : null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border bg-muted/30 p-0.5 text-xs">
          {RANGES.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setRangeKey(k)}
              className={cn(
                'rounded px-2.5 py-1 transition-colors',
                rangeKey === k ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {PERIOD_LABEL[k]}
            </button>
          ))}
        </div>
        {allCategoryKeys.length > 0 ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1">
                <Filter className="size-3.5" />
                類別
                {excluded.size > 0 ? <Badge variant="secondary" className="ml-1">排除 {excluded.size}</Badge> : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-60 p-2" align="start">
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="font-medium">顯示 / 排除類別</span>
                {excluded.size > 0 ? (
                  <button type="button" onClick={() => setExcluded(new Set())} className="text-muted-foreground hover:underline">
                    清除
                  </button>
                ) : null}
              </div>
              <ul className="max-h-64 space-y-0.5 overflow-y-auto">
                {allCategoryKeys.map((k) => {
                  const off = excluded.has(k);
                  return (
                    <li key={k}>
                      <button
                        type="button"
                        onClick={() => toggleCategory(k)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors',
                          off ? 'bg-muted text-muted-foreground line-through' : 'hover:bg-muted',
                        )}
                      >
                        <span className="truncate">{lookup(k).name}</span>
                        {off ? <X className="size-3.5" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </PopoverContent>
          </Popover>
        ) : null}
        <span className="text-[11px] text-muted-foreground">
          {range.startKey.replace(/-/g, '/')} – {range.endKey.replace(/-/g, '/')} · {compareLabel}（{comparison.startKey.slice(5).replace('-', '/')} – {comparison.cutoffKey.slice(5).replace('-', '/')}）
        </span>
      </div>

      {cmp.truncated ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          此期間交易超過單次讀取上限，統計可能不完整，請改選較短的期間。
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="支出" value={formatCurrency(current.expense)} loading={cmp.isLoading}
          sub={<DeltaBadge value={percentChange(current.expense, previous.expense)} goodWhen="down" suffix={compareLabel} />} />
        <Kpi label="收入" value={formatCurrency(current.income)} loading={cmp.isLoading}
          sub={<DeltaBadge value={percentChange(current.income, previous.income)} goodWhen="up" suffix={compareLabel} />} />
        <Kpi label="結餘" value={formatCurrency(current.net)} loading={cmp.isLoading}
          tone={current.net < 0 ? 'bad' : 'good'}
          sub={<span className="text-[11px] text-muted-foreground">{comparison.label} {formatCurrency(previous.net)}</span>} />
        <Kpi label="儲蓄率" loading={cmp.isLoading}
          value={current.savingsRate != null ? `${Math.round(current.savingsRate * 100)}%` : '—'}
          tone={current.savingsRate != null && current.savingsRate < 0 ? 'bad' : undefined}
          sub={<DeltaBadge value={savingsDelta} goodWhen="up" points suffix={compareLabel} />} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2"><PieChart className="size-4" /> 類別排行</span>
              <span className="text-xs font-normal text-muted-foreground">{current.expenseCount} 筆</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryBars
              rows={categoryRows}
              maxRows={8}
              compareLabel={`${compareLabel}（同期）`}
              onSelect={(keys) => navigate(ledgerListHref({ type: 'expense', category: keys, startKey: range.startKey, endKey: range.endKey }))}
            />
          </CardContent>
        </Card>
        <SpendTrendCard txs={cmp.txs} share={myShare} startKey={range.startKey} endKey={range.endKey} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <CategoryBudgetPaceCard
          budget={budget}
          byCategory={monthSummary.byCategory}
          monthExpense={monthSummary.expense}
          pctElapsed={month.day / month.daysInMonth}
          lookup={lookup}
        />
        <IncomeBreakdownCard
          incomeByCategory={current.incomeByCategory}
          prevIncomeByCategory={previous.incomeByCategory}
          compareLabel={compareLabel}
          lookup={lookup}
          startKey={range.startKey}
          endKey={range.endKey}
        />
      </div>

      <CategoryTrendCard />

      <div className="grid gap-4 lg:grid-cols-2">
        <FixedVariableCard txs={cmp.txs} share={myShare} />
        <SpendingPatternCard txs={cmp.txs} share={myShare} startKey={range.startKey} endKey={range.endKey} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <MerchantRankingCard txs={cmp.txs} share={myShare} lookup={lookup} startKey={range.startKey} endKey={range.endKey} />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Receipt className="size-4" /> 最大 5 筆支出</CardTitle>
          </CardHeader>
          <CardContent>
            {topTxs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{PERIOD_LABEL[rangeKey]}尚無支出</p>
            ) : (
              <ul className="divide-y">
                {topTxs.map(({ tx: t, my }) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      <span className="text-muted-foreground">{formatTW(t.date, 'MM/dd')}</span>{' '}
                      {lookup(t.category).name}{t.note ? ` · ${t.note}` : ''}
                      {my < t.amountTWD - 0.5 ? (
                        <span className="ml-1 text-[11px] text-muted-foreground">（整筆 {formatCurrency(t.amountTWD)}）</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">{formatCurrency(my)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Kpi({
  label, value, sub, tone, loading,
}: { label: string; value: string; sub?: React.ReactNode; tone?: 'good' | 'bad'; loading?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        {loading ? <Skeleton className="mt-1 h-7 w-24" /> : (
          <div className={cn('mt-1 text-lg font-semibold tabular-nums [overflow-wrap:anywhere] sm:text-xl',
            tone === 'bad' && 'text-destructive', tone === 'good' && 'text-success')}
          >
            {value}
          </div>
        )}
        <div className="mt-0.5">{sub}</div>
      </CardContent>
    </Card>
  );
}
