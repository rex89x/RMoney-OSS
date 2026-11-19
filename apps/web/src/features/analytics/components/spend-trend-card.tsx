import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, formatAxisTWD } from '@/lib/chart-theme';
import type { Transaction } from '@/features/ledger/types';
import { spendBuckets, type SpendBucket } from '../metrics';
import { ledgerListHref } from '../drilldown';

const UNIT_LABEL = { day: '每日', week: '每週', month: '每月' } as const;

interface SpendTrendCardProps {
  txs: Transaction[];
  share: (tx: Transaction) => number;
  startKey: string;
  endKey: string;
}

/** 區間花費走勢：依長度自動切日 / 週 / 月；點長條看該期間交易 */
export function SpendTrendCard({ txs, share, startKey, endKey }: SpendTrendCardProps) {
  const navigate = useNavigate();
  const { unit, buckets } = useMemo(() => spendBuckets(txs, share, startKey, endKey), [txs, share, startKey, endKey]);
  const avg = buckets.length ? buckets.reduce((s, b) => s + b.value, 0) / buckets.length : 0;

  function open(b: SpendBucket | undefined) {
    if (!b) return;
    navigate(ledgerListHref({ type: 'expense', startKey: b.startKey, endKey: b.endKey }));
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><BarChart3 className="size-4" /> {UNIT_LABEL[unit]}花費</span>
          <span className="text-xs font-normal text-muted-foreground">平均 {formatCurrency(avg)} · 點長條看明細</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="h-[240px] px-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
            <XAxis dataKey="label" {...AXIS_PROPS} interval="preserveStartEnd" minTickGap={12} />
            <YAxis {...AXIS_PROPS} width={44} tickFormatter={formatAxisTWD} />
            <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(v: number) => [formatCurrency(v), '支出']} />
            {avg > 0 ? <ReferenceLine y={avg} stroke={CHART_COLORS.muted} strokeDasharray="4 4" /> : null}
            <Bar
              dataKey="value"
              fill={CHART_COLORS.expense}
              radius={[3, 3, 0, 0]}
              cursor="pointer"
              onClick={(item: { payload?: SpendBucket }) => open(item.payload)}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
