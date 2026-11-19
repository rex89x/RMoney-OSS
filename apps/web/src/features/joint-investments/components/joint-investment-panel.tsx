import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  AlertTriangle, ChevronRight, LineChart as LineChartIcon, Link2, Loader2, Plus, RefreshCw, Users, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { useConfirm } from '@/components/ui/confirm';
import { useAuth } from '@/hooks/use-auth';
import { cn, formatCurrency } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { HOUSEHOLD_FUND_COLOR, memberColor } from '@/features/household/entries';
import { memberCan, type Household } from '@/features/household/types';
import { pnlPct, type Agg } from '../calc';
import {
  useDeleteJointHolding, useJointSnapshots, useJointValuation, useRefreshHouseholdQuotes,
} from '../hooks';
import type { JointHolding } from '../types';
import { HoldingDialog } from './holding-dialog';
import { JointPlanCard } from './joint-plan-card';
import { LinkPortfolioDialog } from './link-portfolio-dialog';
import { TradeDialog } from './trade-dialog';

interface JointInvestmentPanelProps {
  household: Household;
}

/** 共同投資的 bucket 顏色：共同持有 = 公基金同色（「兩個人的錢」），個人 = 成員色 */
export const JOINT_BUCKET_COLOR = HOUSEHOLD_FUND_COLOR;
const VALUE_COLOR = '#3b82f6';
const COST_COLOR = '#6b7280';

const TOOLTIP_STYLE = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 12,
  color: 'hsl(var(--popover-foreground))',
};

function signed(n: number): string {
  if (Math.abs(n) < 0.5) return formatCurrency(0);
  return `${n > 0 ? '+' : '−'}${formatCurrency(Math.abs(n))}`;
}

function pctText(a: Pick<Agg, 'unrealizedTWD' | 'costTWD'>): string {
  const p = pnlPct(a);
  return p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}

function toneClass(n: number): string {
  return n > 0.5 ? 'text-success' : n < -0.5 ? 'text-destructive' : 'text-muted-foreground';
}

/** /shared?tab=invest：兩人的共同投資帳 */
export function JointInvestmentPanel({ household }: JointInvestmentPanelProps) {
  const { user, isOwner } = useAuth();
  const myUid = user?.uid ?? '';
  const { holdings, valuation, isLoading, lastQuoteAt } = useJointValuation(household);
  const { data: snapshots = [] } = useJointSnapshots(household.id);
  const refresh = useRefreshHouseholdQuotes();
  const del = useDeleteJointHolding();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [tradeHolding, setTradeHolding] = useState<JointHolding | null>(null);
  const [filter, setFilter] = useState<string>('all');

  const canManageJoint = memberCan(household, myUid, 'canManageInvestments');
  const canEditHolding = (h: JointHolding) =>
    h.bucket === 'personal' ? h.ownerUid === myUid : canManageJoint;

  const bucketLabel = (key: string) =>
    key === 'joint' ? '共同持有' : `${household.members[key]?.displayName ?? '成員'}${key === myUid ? '（我）' : ''}`;
  const bucketColor = (key: string) => (key === 'joint' ? JOINT_BUCKET_COLOR : memberColor(household, key));

  const bucketKeys = useMemo(
    () => ['joint', ...household.memberIds].filter((k) => valuation.byBucket[k]),
    [household.memberIds, valuation.byBucket],
  );

  const visible = useMemo(
    () => valuation.holdings.filter((v) => (filter === 'all' ? true : v.bucketKey === filter))
      .filter((v) => v.summary.shares > 0 || Math.abs(v.realizedTWD) > 0.5),
    [valuation.holdings, filter],
  );

  const history = useMemo(() => snapshots.map((s) => ({
    label: formatTW(new Date(`${s.date}T00:00:00+08:00`), 'M/d'),
    value: Math.round(s.valueTWD),
    cost: Math.round(s.costTWD),
  })), [snapshots]);

  const pnlBars = useMemo(() => valuation.holdings
    .filter((v) => v.summary.shares > 0 && !v.priceMissing)
    .map((v) => ({ key: v.holding.id, label: v.holding.symbol, pnl: Math.round(v.unrealizedTWD) }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 10), [valuation.holdings]);

  async function handleDelete(h: JointHolding) {
    const ok = await confirm({
      title: `刪除 ${h.symbol}？`,
      description: h.source === 'portfolio'
        ? '只會取消連結，不會動到你投資頁的持倉。'
        : '這檔的所有交易紀錄都會刪除，無法復原。',
      confirmText: '刪除',
    });
    if (!ok) return;
    try {
      await del.mutateAsync({ householdId: household.id, id: h.id });
      setTradeHolding(null);
      toast.success('已刪除');
    } catch (err) {
      console.error('[deleteJointHolding]', err);
    }
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">
        {lastQuoteAt ? `報價更新於 ${formatTW(lastQuoteAt, 'M/d HH:mm')}` : '盤中每 15 分鐘自動更新報價'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => refresh.mutate(household.id)} disabled={refresh.isPending || holdings.length === 0}>
          {refresh.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} 更新報價
        </Button>
        {isOwner && household.ownerId === myUid ? (
          <Button size="sm" variant="outline" onClick={() => setLinkOpen(true)}>
            <Link2 className="size-4" /> 連結我的持股
          </Button>
        ) : null}
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="size-4" /> 新增持股</Button>
      </div>
    </div>
  );

  const dialogs = (
    <>
      <HoldingDialog household={household} open={addOpen} onOpenChange={setAddOpen} />
      {isOwner ? <LinkPortfolioDialog householdId={household.id} holdings={holdings} open={linkOpen} onOpenChange={setLinkOpen} /> : null}
      <TradeDialog
        householdId={household.id}
        holding={tradeHolding ? (holdings.find((h) => h.id === tradeHolding.id) ?? null) : null}
        canEdit={tradeHolding ? canEditHolding(tradeHolding) : false}
        onOpenChange={(open) => { if (!open) setTradeHolding(null); }}
        onDelete={(h) => void handleDelete(h)}
        deleting={del.isPending}
      />
    </>
  );

  if (isLoading) {
    return <div className="space-y-4">{header}<Skeleton className="h-28" /><Skeleton className="h-64" /></div>;
  }

  if (holdings.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          icon={LineChartIcon}
          title="開始你們的共同投資帳"
          description="記錄兩人一起買的股票（共同持有）、各自的持股，也可以把投資頁的部位連結進來。損益、配置與目標進度會自動算好。"
        />
        <JointPlanCard household={household} currentValueTWD={0} />
        {dialogs}
      </div>
    );
  }

  const memberRows = household.memberIds.map((id) => ({ id, agg: valuation.byMember[id] }));
  const memberTotal = memberRows.reduce((s, r) => s + Math.max(0, r.agg?.valueTWD ?? 0), 0);
  const bucketTotal = bucketKeys.reduce((s, k) => s + Math.max(0, valuation.byBucket[k]?.valueTWD ?? 0), 0);

  return (
    <div className="space-y-4">
      {header}

      <StatGrid>
        <StatTile label="總市值" value={formatCurrency(valuation.valueTWD)} hint={`成本 ${formatCurrency(valuation.costTWD)}`} />
        <StatTile
          label="未實現損益"
          value={signed(valuation.unrealizedTWD)}
          hint={pctText(valuation)}
          valueClassName={toneClass(valuation.unrealizedTWD)}
        />
        <StatTile label="今日變動" value={signed(valuation.dayChangeTWD)} valueClassName={toneClass(valuation.dayChangeTWD)} hint="依最新報價漲跌" />
        <StatTile label="已實現損益" value={signed(valuation.realizedTWD)} valueClassName={toneClass(valuation.realizedTWD)} hint="賣出後落袋的部分" />
      </StatGrid>

      {valuation.missing.length > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {valuation.missing.slice(0, 5).join('、')} 暫時沒有報價，市值先以成本計。按「更新報價」抓一次，或等下一次自動更新。
          </span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Users className="size-4" /> 各自擁有多少</CardTitle>
            <p className="text-xs text-muted-foreground">個人持股 + 共同持有依比例分到的份額</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {memberRows.map(({ id, agg }) => {
              const value = agg?.valueTWD ?? 0;
              const share = memberTotal > 0 ? (Math.max(0, value) / memberTotal) * 100 : 0;
              return (
                <div key={id} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: memberColor(household, id) }} aria-hidden />
                      {household.members[id]?.displayName ?? id}{id === myUid ? '（我）' : ''}
                    </span>
                    <span className="tabular-nums">
                      {formatCurrency(value)}
                      <span className={cn('ml-2 text-xs', toneClass(agg?.unrealizedTWD ?? 0))}>{agg ? pctText(agg) : '—'}</span>
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="presentation">
                    <div className="h-full rounded-full" style={{ width: `${share}%`, backgroundColor: memberColor(household, id) }} />
                  </div>
                  <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                    占 {share.toFixed(0)}% · 損益 {signed(agg?.unrealizedTWD ?? 0)}
                  </p>
                </div>
              );
            })}

            <div className="border-t pt-3">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">依持有方式</p>
              <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label="持有方式比例">
                {bucketKeys.map((k) => {
                  const v = Math.max(0, valuation.byBucket[k]?.valueTWD ?? 0);
                  return bucketTotal > 0 && v > 0 ? (
                    <div key={k} style={{ width: `${(v / bucketTotal) * 100}%`, backgroundColor: bucketColor(k) }} />
                  ) : null;
                })}
              </div>
              <ul className="mt-2 space-y-1 text-xs">
                {bucketKeys.map((k) => {
                  const b = valuation.byBucket[k];
                  if (!b) return null;
                  return (
                    <li key={k} className="flex items-center justify-between gap-2">
                      <button type="button" className="inline-flex items-center gap-1.5 hover:underline" onClick={() => setFilter(k)}>
                        <span className="size-2.5 rounded-sm" style={{ backgroundColor: bucketColor(k) }} aria-hidden />
                        {bucketLabel(k)}
                      </button>
                      <span className="tabular-nums">
                        {formatCurrency(b.valueTWD)}
                        <span className={cn('ml-2', toneClass(b.unrealizedTWD))}>{signed(b.unrealizedTWD)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><LineChartIcon className="size-4" /> 市值走勢</CardTitle>
            <p className="text-xs text-muted-foreground">每天 07:00 / 18:00 自動記一筆，看得出兩人一起累積的速度</p>
          </CardHeader>
          <CardContent>
            {history.length < 2 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">資料累積中，明天起就會有走勢圖。</p>
            ) : (
              <div className="h-[220px]" role="img" aria-label={`市值走勢，最新 ${formatCurrency(history[history.length - 1]?.value ?? 0)}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      width={56}
                      domain={['auto', 'auto']}
                      tickFormatter={(v: number) => (v >= 10000 ? `${Math.round(v / 10000)}萬` : String(v))}
                    />
                    <Tooltip formatter={(value: number, name: string) => [formatCurrency(value), name]} contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="cost" name="投入成本" stroke={COST_COLOR} strokeWidth={2} strokeDasharray="4 3" dot={false} />
                    <Line type="monotone" dataKey="value" name="市值" stroke={VALUE_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {pnlBars.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Wallet className="size-4" /> 各檔未實現損益</CardTitle>
          </CardHeader>
          <CardContent>
            <div style={{ height: Math.max(120, pnlBars.length * 32) }} role="img" aria-label="各檔未實現損益">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pnlBars} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v: number) => (Math.abs(v) >= 10000 ? `${Math.round(v / 10000)}萬` : String(v))} />
                  <YAxis type="category" dataKey="label" fontSize={11} tickLine={false} axisLine={false} width={64} />
                  <Tooltip cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }} formatter={(value: number) => [signed(value), '未實現損益']} contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="pnl" radius={4} barSize={16}>
                    {pnlBars.map((b) => (
                      <Cell key={b.key} fill={b.pnl >= 0 ? 'hsl(var(--success))' : 'hsl(var(--destructive))'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="space-y-2 pb-2">
          <CardTitle className="text-base">持股明細</CardTitle>
          <div className="scrollbar-none -mx-6 flex gap-1.5 overflow-x-auto px-6" role="tablist" aria-label="依持有方式篩選">
            {['all', ...bucketKeys].map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={filter === k}
                onClick={() => setFilter(k)}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs transition-colors',
                  filter === k ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {k !== 'all' ? <span className="size-2 rounded-full" style={{ backgroundColor: bucketColor(k) }} aria-hidden /> : null}
                {k === 'all' ? '全部' : bucketLabel(k)}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {visible.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">這個分類沒有持股</p>
          ) : (
            <ul className="divide-y">
              {visible.map((v) => {
                const h = v.holding;
                const quoteText = v.quote && !v.priceMissing
                  ? ` · ${v.quote.price} (${v.quote.changePercent >= 0 ? '+' : ''}${v.quote.changePercent.toFixed(2)}%)`
                  : '';
                return (
                  <li key={h.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 sm:px-6"
                      onClick={() => setTradeHolding(h)}
                    >
                      <span className="h-10 w-1 shrink-0 rounded-full" style={{ backgroundColor: bucketColor(v.bucketKey) }} aria-hidden />
                      <span className="min-w-0 flex-1 space-y-0.5">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="shrink-0 font-medium">{h.symbol}</span>
                            <span className="truncate text-sm text-muted-foreground">{h.name !== h.symbol ? h.name : ''}</span>
                            {h.source === 'portfolio' ? <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-label="連結自投資組合" /> : null}
                          </span>
                          <span className="shrink-0 text-sm font-medium tabular-nums">{formatCurrency(v.valueTWD)}</span>
                        </span>
                        <span className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
                          <span className="min-w-0 truncate text-muted-foreground">
                            {bucketLabel(v.bucketKey)} · {v.summary.shares.toLocaleString('en-US')} 股{quoteText}
                          </span>
                          <span className={cn('shrink-0', toneClass(v.unrealizedTWD))}>{signed(v.unrealizedTWD)} · {pctText(v)}</span>
                        </span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <JointPlanCard household={household} currentValueTWD={valuation.valueTWD} />
      {dialogs}
    </div>
  );
}

