import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { ArrowDownLeft, ArrowUpRight, Check, Coffee, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DataTablePagination, DataTableToolbar, useDataTable, type FilterDef,
} from '@/components/data-table';
import { formatCurrency, cn } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useTransactions, useUpdateTransaction } from '../hooks';
import { loanDeltaTWD, type Transaction } from '../types';
import { PAYOUT_GROUP_CATEGORY } from '@/features/payouts/types';
import { PayoutGroupsPanel } from '@/features/payouts';
import { usePayoutGroups } from '@/features/payouts/hooks';

interface CounterpartyAgg {
  name: string;
  txs: Transaction[];
  net: number;       // +: 對方欠我；-: 我欠對方
  pending: number;   // 未結清總額（abs）
  settledCount: number;
}

export function LoansPanel() {
  const [view, setView] = useState<'individual' | 'group'>('individual');
  const [autoChecked, setAutoChecked] = useState(false);
  const oneYearAgo = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d;
  }, []);
  const { data: txs = [] } = useTransactions({ startDate: oneYearAgo, limit: 2000 });
  const { data: payoutGroups = [] } = usePayoutGroups();
  const update = useUpdateTransaction();

  const loanTxs = useMemo(
    () => txs.filter((t) =>
      t.splitMode && t.splitMode !== 'self' && t.counterpartyName
      // 過濾掉 PayoutGroup 自動生的 tx，避免雙重顯示；共同帳本的分攤在 /shared 結算
      && t.category !== PAYOUT_GROUP_CATEGORY && !t.householdId),
    [txs],
  );

  // 沒個別代墊但有墊付團 → 自動切到 group view，避免使用者找不到墊付團
  useEffect(() => {
    if (autoChecked) return;
    if (loanTxs.length === 0 && payoutGroups.length > 0) {
      setView('group');
    }
    setAutoChecked(true);
  }, [autoChecked, loanTxs.length, payoutGroups.length]);

  // segmented control 在最上方；group view 切到 PayoutGroupsPanel
  const switcher = (
    <div className="inline-flex rounded-md border bg-muted/30 p-0.5 text-sm">
      <button
        type="button"
        onClick={() => setView('individual')}
        className={cn(
          'flex items-center gap-1 rounded px-3 py-1.5 transition-colors',
          view === 'individual' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Users className="size-3.5" /> 個別代墊
      </button>
      <button
        type="button"
        onClick={() => setView('group')}
        className={cn(
          'flex items-center gap-1 rounded px-3 py-1.5 transition-colors',
          view === 'group' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Coffee className="size-3.5" /> 墊付團
      </button>
    </div>
  );

  const byCounterparty = useMemo(() => {
    const map = new Map<string, CounterpartyAgg>();
    for (const t of loanTxs) {
      const name = t.counterpartyName!;
      if (!map.has(name)) map.set(name, { name, txs: [], net: 0, pending: 0, settledCount: 0 });
      const agg = map.get(name)!;
      agg.txs.push(t);
      const delta = loanDeltaTWD(t);
      if (t.loanSettledAt) {
        agg.settledCount++;
      } else {
        agg.net += delta;
        agg.pending += Math.abs(delta);
      }
    }
    return Array.from(map.values()).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  }, [loanTxs]);

  const totals = useMemo(() => {
    const owedToMe = byCounterparty.reduce((s, c) => s + Math.max(0, c.net), 0);
    const iOwe = byCounterparty.reduce((s, c) => s + Math.max(0, -c.net), 0);
    return { owedToMe, iOwe, net: owedToMe - iOwe };
  }, [byCounterparty]);

  // 篩選 + 分頁：counterparty 一多就會擠到看不完
  const filters: FilterDef[] = useMemo(() => [
    {
      id: 'direction',
      label: '方向',
      kind: 'select',
      options: [
        { value: 'owedToMe', label: '對方欠我' },
        { value: 'iOwe', label: '我欠對方' },
        { value: 'settled', label: '已平' },
      ],
    },
  ], []);

  const accessor = useMemo(() => (row: CounterpartyAgg, id: string) => {
    switch (id) {
      case 'direction':
        if (row.net > 0.01) return 'owedToMe';
        if (row.net < -0.01) return 'iOwe';
        return 'settled';
      case 'name': return row.name;
      default: return (row as unknown as Record<string, unknown>)[id];
    }
  }, []);

  const table = useDataTable<CounterpartyAgg>({
    data: byCounterparty,
    accessor,
    searchFields: ['name'],
    filters,
    pageSize: 5,
    urlKey: 'ln',
  });

  // 對方 Top 5 的小圖（按 |net| 排）— 也可以是 settled 數量
  const topChart = useMemo(() => {
    return byCounterparty.slice(0, 8).map((c) => ({
      name: c.name.length > 6 ? `${c.name.slice(0, 5)}…` : c.name,
      應收: Math.max(0, c.net),
      應付: Math.max(0, -c.net),
    }));
  }, [byCounterparty]);

  async function toggleSettled(tx: Transaction) {
    if (tx.loanSettledAt) {
      await update.mutateAsync({ id: tx.id, patch: { loanSettledAt: null } });
      toast.success('已標記為未結清');
    } else {
      await update.mutateAsync({ id: tx.id, patch: { loanSettledAt: new Date() } });
      toast.success('已標記為已結清');
    }
  }

  // hooks 都跑完才能 early-return，避免 hooks order 變化
  if (view === 'group') {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">{switcher}</div>
        <PayoutGroupsPanel />
      </div>
    );
  }

  if (loanTxs.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">{switcher}</div>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            尚無代墊或借貸紀錄。在新增記帳時展開「代墊 / 借貸」即可記錄；
            若是揪團一次代付多人，可點右上「墊付團」切到專屬管理頁。
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">{switcher}</div>
      <Card>
        <CardHeader><CardTitle className="text-base">總覽</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="對方欠我" value={formatCurrency(totals.owedToMe)} tone="success" />
            <Stat label="我欠對方" value={formatCurrency(totals.iOwe)} tone="danger" />
            <Stat
              label="淨額"
              value={`${totals.net >= 0 ? '+' : ''}${formatCurrency(totals.net)}`}
              tone={totals.net >= 0 ? 'success' : 'danger'}
            />
          </div>
          {topChart.length > 0 ? (
            <div className="rounded-md border p-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Top 對象</div>
              <div className="h-[120px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topChart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} width={36} />
                    <Tooltip formatter={(v: number) => formatCurrency(v)} />
                    <Bar dataKey="應收" fill="#10b981">
                      {topChart.map((_, i) => <Cell key={i} />)}
                    </Bar>
                    <Bar dataKey="應付" fill="#ef4444">
                      {topChart.map((_, i) => <Cell key={i} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <DataTableToolbar table={table} searchPlaceholder="搜尋對象姓名…" />

      {table.rows.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            沒有符合條件的對象
          </CardContent>
        </Card>
      ) : table.rows.map((agg) => (
        <Card key={agg.name}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">{agg.name}</CardTitle>
            <div className="flex items-center gap-2 text-sm">
              {agg.net > 0.01 ? (
                <Badge variant="success">應收 {formatCurrency(agg.net)}</Badge>
              ) : agg.net < -0.01 ? (
                <Badge variant="destructive">應付 {formatCurrency(-agg.net)}</Badge>
              ) : (
                <Badge variant="secondary">平</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded-md border">
              {agg.txs.map((t) => {
                const delta = loanDeltaTWD(t);
                const isCredit = (t.splitMode === 'i-paid-others');
                return (
                  <li key={t.id} className="flex items-center gap-3 p-3 text-sm">
                    {isCredit ? (
                      <ArrowUpRight className="size-4 shrink-0 text-success" />
                    ) : (
                      <ArrowDownLeft className="size-4 shrink-0 text-destructive" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{t.note || t.category}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatTW(t.date, 'yyyy/MM/dd')}
                        {' · 總 '}{formatCurrency(t.amountTWD)}
                        {' · 我這份 '}{formatCurrency(t.myShareTWD ?? 0)}
                        {t.loanSettledAt && <> · 已結清 {formatTW(t.loanSettledAt, 'MM/dd')}</>}
                      </div>
                    </div>
                    <div className={`text-right text-sm tabular-nums ${t.loanSettledAt ? 'text-muted-foreground line-through' : isCredit ? 'text-success' : 'text-destructive'}`}>
                      {isCredit ? '+' : '-'}{formatCurrency(Math.abs(delta || (t.amountTWD - (t.myShareTWD ?? 0))))}
                    </div>
                    <Button
                      size="icon-sm"
                      variant={t.loanSettledAt ? 'default' : 'outline'}
                      onClick={() => void toggleSettled(t)}
                      title={t.loanSettledAt ? '取消結清' : '標記結清'}
                    >
                      <Check className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ))}

      <DataTablePagination table={table} pageSizes={[5, 10, 25, 50]} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' }) {
  const cls = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-destructive' : '';
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}
