import { useMemo } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip, Cell, ReferenceLine,
} from 'recharts';
import { TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/utils';
import { useCategories } from '@/features/ledger/hooks';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, formatAxisTWD } from '@/lib/chart-theme';
import { usePeriodRange, useRangeTransactions } from '../hooks';
import { isConsumptionExpense, isEarnedIncome } from '../metrics';

interface WaterfallStep {
  label: string;
  start: number;
  end: number;
  delta: number;
  color: string;
  isPivot?: boolean;
}

/**
 * Cash flow waterfall：本月收入 → 各類別扣除 → 結餘
 */
export function CashflowWaterfallCard() {
  const { txs, isLoading } = useRangeTransactions(usePeriodRange('thisMonth'));
  const { data: categories = [] } = useCategories();
  const myShare = useMyExpenseShare();

  const data = useMemo(() => {
    const catMap = Object.fromEntries(categories.map((c) => [c.key, c]));
    const income = txs.filter(isEarnedIncome).reduce((s, t) => s + t.amountTWD, 0);
    const byCat = new Map<string, number>();
    for (const t of txs) {
      if (!isConsumptionExpense(t)) continue;
      const k = t.category || 'other';
      byCat.set(k, (byCat.get(k) ?? 0) + myShare(t));
    }
    const sorted = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 6);
    const restSum = sorted.slice(6).reduce((s, [, v]) => s + v, 0);

    const steps: WaterfallStep[] = [];
    let running = 0;
    steps.push({ label: '收入', start: 0, end: income, delta: income, color: CHART_COLORS.income, isPivot: true });
    running = income;
    top.forEach(([k, v]) => {
      const cat = catMap[k];
      steps.push({
        label: cat?.name ?? k,
        start: running - v,
        end: running,
        delta: -v,
        color: cat?.color ?? CHART_COLORS.muted,
      });
      running -= v;
    });
    if (restSum > 0) {
      steps.push({ label: '其他', start: running - restSum, end: running, delta: -restSum, color: CHART_COLORS.muted });
      running -= restSum;
    }
    steps.push({ label: '結餘', start: 0, end: running, delta: running, color: running >= 0 ? CHART_COLORS.income : CHART_COLORS.expense, isPivot: true });

    return steps.map((s) => ({
      label: s.label,
      // Recharts: 用兩個 bar，一個透明（base 高度）、一個彩色（delta 高度）
      base: Math.min(s.start, s.end),
      bar: Math.abs(s.end - s.start),
      delta: s.delta,
      color: s.color,
      isPivot: s.isPivot,
    }));
  }, [txs, categories, myShare]);

  if (isLoading) return <Card><CardContent className="py-3"><Skeleton className="h-48" /></CardContent></Card>;
  if (data.length <= 1) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="size-4" /> 本月現金流瀑布
        </CardTitle>
      </CardHeader>
      <CardContent className="h-[280px] px-0 pr-4 sm:px-2">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <XAxis dataKey="label" {...AXIS_PROPS} interval={0} angle={-15} textAnchor="end" height={40} />
            <YAxis {...AXIS_PROPS} tickFormatter={formatAxisTWD} width={44} />
            <ReferenceLine y={0} stroke={CHART_COLORS.muted} strokeDasharray="2 2" />
            <Tooltip
              {...CHART_TOOLTIP_PROPS}
              formatter={(_v: number, _n, item) => {
                const d = item.payload as { delta: number };
                return [(d.delta >= 0 ? '+' : '') + formatCurrency(d.delta), '增減'];
              }}
            />
            <Bar dataKey="base" stackId="a" fill="transparent" />
            <Bar dataKey="bar" stackId="a" radius={[2, 2, 2, 2]}>
              {data.map((d, i) => <Cell key={i} fill={d.color} />)}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
