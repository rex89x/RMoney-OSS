import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, Cell,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';
import { useTransactions, useCategories } from '@/features/ledger/hooks';
import { useExpenseBreakdown } from '@/features/ledger/use-my-share';
import { ViewScopeToggle, type ViewScope } from '@/components/ui/view-scope-toggle';
import type { Trip } from '../types';

/**
 * 出遊預算 vs 實支：以 trip.budget 對比真實支出（即使 trip 的 transactions 已分類）
 * 並按類別拆分。
 */
export function TripBudgetVsActual({ trip }: { trip: Trip }) {
  const { data: txs = [] } = useTransactions({ tripId: trip.id, limit: 1000 });
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c])), [categories]);
  const breakdown = useExpenseBreakdown();
  const [viewScope, setViewScope] = useState<ViewScope>('mine');

  // 預算是整趟的 → 預算列一律用整趟總額；分類圖 / 日均依切換（預設只看我負擔的）
  const totalAll = useMemo(
    () => txs.reduce((s, t) => (t.deletedAt || t.type !== 'expense' ? s : s + breakdown(t).totalTWD), 0),
    [txs, breakdown],
  );
  const data = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const t of txs) {
      if (t.deletedAt || t.type !== 'expense') continue;
      const k = t.category || 'other';
      const b = breakdown(t);
      byCat.set(k, (byCat.get(k) ?? 0) + (viewScope === 'mine' ? b.shareTWD : b.totalTWD));
    }
    return [...byCat.entries()]
      .map(([k, v]) => ({
        category: k,
        name: catMap[k]?.name ?? k,
        actual: v,
        color: catMap[k]?.color ?? '#94a3b8',
      }))
      .sort((a, b) => b.actual - a.actual);
  }, [txs, catMap, breakdown, viewScope]);

  const total = data.reduce((s, d) => s + d.actual, 0);
  const budget = trip.budget || 0;
  const pct = budget > 0 ? (totalAll / budget) * 100 : 0;
  const remaining = budget - totalAll;

  // Per-day metrics
  const days = Math.max(1, Math.ceil((trip.endDate.getTime() - trip.startDate.getTime()) / 86400000) + 1);
  const dailyAvg = total / days;
  const memberCount = (trip.members?.length ?? 1) || 1;
  const perPerson = totalAll / memberCount;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">預算 vs 實支</CardTitle>
          <ViewScopeToggle value={viewScope} onChange={setViewScope} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="預算（整趟）" value={formatCurrency(budget)} />
          <Stat label="整趟已支出" value={formatCurrency(totalAll)} accent={pct > 100 ? 'text-red-500' : pct > 80 ? 'text-amber-500' : ''} />
          <Stat label="剩餘" value={formatCurrency(remaining)} accent={remaining < 0 ? 'text-red-500' : 'text-emerald-500'} />
          <Stat label="使用率" value={formatPercent(pct, 0)} />
        </div>
        <Progress value={Math.min(100, pct)} className={cn('h-2', pct > 100 && '[&>div]:bg-red-500')} />
        {pct > 100 && <p className="text-xs text-red-500">已超支 {formatCurrency(-remaining)}</p>}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={viewScope === 'mine' ? '我負擔' : '全部'} value={formatCurrency(total)} />
          <Stat label="天數" value={`${days} 天`} />
          <Stat label={viewScope === 'mine' ? '我的日均' : '日均'} value={formatCurrency(dailyAvg)} />
          <Stat label="人均（整趟）" value={formatCurrency(perPerson)} />
        </div>

        {data.length > 0 && (
          <div className="h-[240px] -mx-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ left: 60, right: 8, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 10 }} width={64} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Legend formatter={() => <span className="text-xs">支出 (TWD)</span>} />
                <Bar dataKey="actual" name="actual">
                  {data.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn('text-sm font-semibold tabular-nums', accent)}>{value}</div>
    </div>
  );
}
