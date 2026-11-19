import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/utils';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, formatAxisTWD, paletteColor } from '@/lib/chart-theme';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import { OTHER_KEY, monthlyCategorySeries } from '../metrics';
import { recentMonthKeys, recentMonthsRange, twDateFromKey } from '../periods';
import { useCategoryLookup, useRangeTransactions, useTodayKey } from '../hooks';
import { ledgerListHref } from '../drilldown';

const MONTHS = 12;

/** 近 12 個月各類別堆疊：看哪一類在長期變多 / 變少 */
export function CategoryTrendCard() {
  const today = useTodayKey();
  const navigate = useNavigate();
  const { range, monthKeys } = useMemo(() => {
    const tw = twDateFromKey(today);
    return { range: recentMonthsRange(tw, MONTHS), monthKeys: recentMonthKeys(tw, MONTHS) };
  }, [today]);
  const { txs, isLoading } = useRangeTransactions(range);
  const myShare = useMyExpenseShare();
  const lookup = useCategoryLookup();

  const series = useMemo(() => monthlyCategorySeries(txs, myShare, monthKeys, 5), [txs, myShare, monthKeys]);
  const data = useMemo(
    () => series.rows.map((r): Record<string, number | string> => ({ ...r, label: String(r.month).slice(2).replace('-', '/') })),
    [series.rows],
  );
  const avg = series.rows.length ? series.rows.reduce((s, r) => s + Number(r.total ?? 0), 0) / series.rows.length : 0;

  function openMonth(month: string | undefined) {
    if (!month) return;
    const [y, m] = month.split('-').map(Number) as [number, number];
    const last = new Date(y, m, 0).getDate();
    navigate(ledgerListHref({ type: 'expense', startKey: `${month}-01`, endKey: `${month}-${String(last).padStart(2, '0')}` }));
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Layers className="size-4" /> 近 12 個月類別趨勢</span>
          <span className="text-xs font-normal text-muted-foreground">月均 {formatCurrency(avg)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="h-[280px] px-2">
        {isLoading ? <Skeleton className="h-full w-full" /> : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
              <XAxis dataKey="label" {...AXIS_PROPS} />
              <YAxis {...AXIS_PROPS} width={44} tickFormatter={formatAxisTWD} />
              <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(v: number, name: string) => [formatCurrency(v), name]} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
              {series.keys.map((k, i) => {
                const info = k === OTHER_KEY ? { name: '其他', color: CHART_COLORS.muted } : lookup(k);
                return (
                  <Bar
                    key={k}
                    dataKey={k}
                    name={info.name}
                    stackId="cat"
                    fill={info.color ?? paletteColor(i)}
                    cursor="pointer"
                    onClick={(item: { payload?: { month?: string } }) => openMonth(item.payload?.month)}
                  />
                );
              })}
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
