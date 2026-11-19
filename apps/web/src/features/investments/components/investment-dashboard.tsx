import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Area, AreaChart,
  CartesianGrid, Legend,
} from 'recharts';
import {
  TrendingUp, TrendingDown, RefreshCw, Wallet, ArrowUpRight, ArrowDownRight,
  PieChart as PieIcon, LineChart as LineIcon, Layers, Coins, Receipt, Target, AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';
import { formatTW, nowTW } from '@/lib/tz';
import {
  useDividends,
  useInvestmentPlans,
  useLatestSnapshot,
  usePortfolioSnapshots,
  useRealizedLots,
  useTriggerSnapshot,
} from '../hooks';
import type { PortfolioSnapshot, PortfolioSnapshotPosition } from '../types';
import { AllocationVsTarget } from './allocation-vs-target';
import { RebalanceCalculator } from './rebalance-calculator';
import { BenchmarkComparison } from './benchmark-comparison';
import { PerformanceCard } from './performance-card';

const CHART_COLORS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899',
  '#06b6d4', '#f97316', '#84cc16', '#a855f7', '#64748b',
];

const MARKET_COLOR: Record<string, string> = { TW: '#3b82f6', US: '#8b5cf6' };

type RangeKey = '30d' | '90d' | '365d';
const RANGE_DAYS: Record<RangeKey, number> = { '30d': 30, '90d': 90, '365d': 365 };

export function InvestmentDashboard() {
  const [range, setRange] = useState<RangeKey>('90d');
  const days = RANGE_DAYS[range];
  const { data: snapshots = [], isLoading } = usePortfolioSnapshots(days);
  const { data: latest, isLoading: latestLoading } = useLatestSnapshot();
  const trigger = useTriggerSnapshot();
  const navigate = useNavigate();

  if (isLoading || latestLoading) {
    return <div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-64" /><Skeleton className="h-48" /></div>;
  }

  if (!latest) {
    return (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          <Wallet className="mx-auto size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            尚無投資快照。每日台北時間 07:00（美股收盤後）會自動產生一筆，
            也可以立即手動觸發一次。
          </p>
          <Button onClick={() => void trigger.mutateAsync()} disabled={trigger.isPending}>
            <RefreshCw className={cn('size-4', trigger.isPending && 'animate-spin')} /> 立即產生快照
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <KpiStrip snapshot={latest} />

      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-3 pb-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <LineIcon className="size-4" /> 總值走勢（TWD）
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={range} onValueChange={(v) => setRange(v as RangeKey)}>
              <TabsList>
                <TabsTrigger value="30d" className="text-xs">30 天</TabsTrigger>
                <TabsTrigger value="90d" className="text-xs">90 天</TabsTrigger>
                <TabsTrigger value="365d" className="text-xs">1 年</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={async () => {
                try { await trigger.mutateAsync(); toast.success('已更新'); }
                catch (err) { toast.error(err instanceof Error ? err.message : '更新失敗'); }
              }}
              disabled={trigger.isPending}
              aria-label="重新整理"
            >
              <RefreshCw className={cn('size-4', trigger.isPending && 'animate-spin')} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="h-[260px] px-0 pr-4 sm:px-2">
          <ValueHistoryChart snapshots={snapshots} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <PieIcon className="size-4" /> 市場分布
            </CardTitle>
          </CardHeader>
          <CardContent className="h-[240px]">
            <MarketPie snapshot={latest} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="size-4" /> 持倉佔比 Top 5
            </CardTitle>
          </CardHeader>
          <CardContent className="h-[240px]">
            <PositionPie snapshot={latest} onClick={(sym) => navigate(`/investments/${encodeURIComponent(sym)}`)} />
          </CardContent>
        </Card>
      </div>

      <AllocationVsTarget />

      <RebalanceCalculator />

      <InvestmentPlansStrip latestValueTWD={latest.totalValueTWD} />

      <PerformanceCard />

      <BenchmarkComparison />

      <PnlIncomeStrip />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4" /> 個股損益（點擊查看詳情）
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pt-0">
          <PositionsTable
            positions={latest.positions}
            onClick={(sym) => navigate(`/investments/${encodeURIComponent(sym)}`)}
          />
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            快照時間：{formatTW(latest.createdAt, 'yyyy/MM/dd HH:mm')}
            {latest.fxRatesUsed?.['USD/TWD']
              ? ` · USD/TWD ${latest.fxRatesUsed['USD/TWD'].toFixed(4)}`
              : ''}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function InvestmentPlansStrip({ latestValueTWD }: { latestValueTWD: number }) {
  const { data: plans = [] } = useInvestmentPlans();
  const navigate = useNavigate();
  if (plans.length === 0) return null;
  const rows = plans.map((plan) => {
    const current = plan.currentAmountTWD ?? (plan.fundingSource === 'portfolio' ? latestValueTWD : 0);
    const progress = plan.targetAmountTWD > 0 ? (current / plan.targetAmountTWD) * 100 : 0;
    const gap = Math.max(0, plan.targetAmountTWD - current);
    return { plan, current, progress, gap };
  });
  const behind = rows.filter((row) => row.gap > row.plan.monthlyContributionTWD * 12).length;
  return (
    <Card className="cursor-pointer hover:bg-muted/40" onClick={() => navigate('/investments?tab=planner')}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Target className="size-4" /> 投資計畫追蹤</span>
          {behind > 0 ? <span className="flex items-center gap-1 text-xs text-amber-500"><AlertTriangle className="size-3" /> {behind} 筆需加速</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.slice(0, 3).map(({ plan, progress, gap }) => (
          <div key={plan.id} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{plan.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatPercent(progress, 1)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, progress)}%` }} />
            </div>
            <div className="text-[11px] text-muted-foreground">距離目標還差 {formatCurrency(gap)}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PnlIncomeStrip() {
  const { data: lots = [] } = useRealizedLots();
  const { data: divs = [] } = useDividends();
  const navigate = useNavigate();
  const year = nowTW().getFullYear();
  const realizedYear = lots
    .filter((l) => Number(formatTW(l.sellDate, 'yyyy')) === year)
    .reduce((s, l) => s + l.realizedPnlTWD, 0);
  const divYear = divs
    .filter((d) => Number(formatTW(d.payDate, 'yyyy')) === year)
    .reduce((s, d) => s + d.amountTWD, 0);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Card className="cursor-pointer hover:bg-muted/40" onClick={() => navigate('/investments?tab=realized')}>
        <CardContent className="p-3">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground"><Receipt className="size-3" /> {year} 已實現</div>
          <div className={cn('text-lg font-semibold tabular-nums', realizedYear >= 0 ? 'text-emerald-500' : 'text-red-500')}>
            {realizedYear >= 0 ? '+' : ''}{formatCurrency(realizedYear)}
          </div>
        </CardContent>
      </Card>
      <Card className="cursor-pointer hover:bg-muted/40" onClick={() => navigate('/investments?tab=dividends')}>
        <CardContent className="p-3">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground"><Coins className="size-3" /> {year} 股息</div>
          <div className="text-lg font-semibold tabular-nums text-emerald-500">+{formatCurrency(divYear)}</div>
        </CardContent>
      </Card>
    </div>
  );
}

function KpiStrip({ snapshot }: { snapshot: PortfolioSnapshot }) {
  const pnlPositive = snapshot.unrealizedPnlTWD >= 0;
  const dayPositive = snapshot.dayChangeTWD >= 0;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Kpi label="總市值" value={formatCurrency(snapshot.totalValueTWD)} accent="text-foreground" />
      <Kpi label="總成本" value={formatCurrency(snapshot.totalCostTWD)} accent="text-muted-foreground" />
      <Kpi
        label="未實現損益"
        value={`${pnlPositive ? '+' : ''}${formatCurrency(snapshot.unrealizedPnlTWD)}`}
        sub={formatPercent(snapshot.unrealizedPnlPct)}
        accent={pnlPositive ? 'text-emerald-500' : 'text-red-500'}
        icon={pnlPositive ? TrendingUp : TrendingDown}
      />
      <Kpi
        label="今日漲跌"
        value={`${dayPositive ? '+' : ''}${formatCurrency(snapshot.dayChangeTWD)}`}
        sub={formatPercent(snapshot.dayChangePct)}
        accent={dayPositive ? 'text-emerald-500' : 'text-red-500'}
        icon={dayPositive ? ArrowUpRight : ArrowDownRight}
      />
    </div>
  );
}

function Kpi({
  label, value, sub, accent, icon: Icon,
}: {
  label: string; value: string; sub?: string; accent: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground sm:text-xs">
          {Icon ? <Icon className="size-3" /> : null}
          {label}
        </div>
        <div className={cn('mt-1 truncate text-base font-semibold sm:text-lg', accent)}>{value}</div>
        {sub ? <div className={cn('text-[11px] sm:text-xs', accent)}>{sub}</div> : null}
      </CardContent>
    </Card>
  );
}

function ValueHistoryChart({ snapshots }: { snapshots: PortfolioSnapshot[] }) {
  const data = useMemo(
    () => snapshots.map((s) => ({
      date: s.date,
      value: s.totalValueTWD,
      cost: s.totalCostTWD,
    })),
    [snapshots],
  );
  if (data.length < 2) {
    return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">資料不足，至少需 2 天才能畫曲線</p>;
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 10, right: 5, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="valueGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.5} />
            <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10 }}
          tickFormatter={(v: string) => v.slice(5)}
          minTickGap={20}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
          width={48}
        />
        <Tooltip
          formatter={(v: number, name) => [formatCurrency(v), name === 'value' ? '總市值' : '總成本']}
          labelFormatter={(d) => `日期 ${d}`}
        />
        <Area type="monotone" dataKey="value" stroke="#8b5cf6" strokeWidth={2} fill="url(#valueGrad)" />
        <Area type="monotone" dataKey="cost" stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 2" fill="transparent" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function MarketPie({ snapshot }: { snapshot: PortfolioSnapshot }) {
  const data = useMemo(() => {
    const out: Array<{ name: string; value: number; color: string }> = [];
    Object.entries(snapshot.byMarket).forEach(([mk, v]) => {
      if (v && v.valueTWD > 0) out.push({ name: mk, value: v.valueTWD, color: MARKET_COLOR[mk] ?? '#94a3b8' });
    });
    return out;
  }, [snapshot]);
  if (data.length === 0) return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">尚無資料</p>;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
          {data.map((d, i) => <Cell key={i} fill={d.color} />)}
        </Pie>
        <Tooltip formatter={(v: number, n) => [formatCurrency(v), n]} />
        <Legend formatter={(v) => <span className="text-xs">{v}</span>} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function PositionPie({
  snapshot, onClick,
}: { snapshot: PortfolioSnapshot; onClick: (sym: string) => void }) {
  const data = useMemo(() => {
    const top = [...snapshot.positions]
      .sort((a, b) => b.valueTWD - a.valueTWD)
      .slice(0, 5);
    const sumTop = top.reduce((s, p) => s + p.valueTWD, 0);
    const rest = snapshot.totalValueTWD - sumTop;
    const rows = top.map((p, i) => ({
      symbol: p.symbol,
      name: p.symbol,
      value: p.valueTWD,
      color: CHART_COLORS[i % CHART_COLORS.length] ?? '#94a3b8',
    }));
    if (rest > 0.01) rows.push({ symbol: '__rest', name: '其他', value: rest, color: '#cbd5e1' });
    return rows;
  }, [snapshot]);
  if (data.length === 0) return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">尚無資料</p>;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
          cursor="pointer"
          onClick={(e: { symbol?: string }) => { if (e?.symbol && e.symbol !== '__rest') onClick(e.symbol); }}
        >
          {data.map((d, i) => <Cell key={i} fill={d.color} />)}
        </Pie>
        <Tooltip formatter={(v: number, n) => [formatCurrency(v), n]} />
        <Legend formatter={(v) => <span className="text-xs">{v}</span>} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function PositionsTable({
  positions, onClick,
}: { positions: PortfolioSnapshotPosition[]; onClick: (sym: string) => void }) {
  if (positions.length === 0) return <p className="px-3 py-4 text-sm text-muted-foreground">尚無持倉</p>;
  const sorted = [...positions].sort((a, b) => b.valueTWD - a.valueTWD);
  return (
    <ul className="divide-y">
      {sorted.map((p) => {
        const pnlPositive = p.pnlTWD >= 0;
        const dayPositive = p.dayChangeTWD >= 0;
        return (
          <li
            key={p.symbol}
            onClick={() => onClick(p.symbol)}
            className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm transition-colors hover:bg-muted/50"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onClick(p.symbol); }}
          >
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: MARKET_COLOR[p.market] ?? '#94a3b8' }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.symbol}</span>
                <span className="text-[10px] text-muted-foreground">{p.market}</span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {p.shares} × {p.currentPrice.toFixed(2)}
                {p.market === 'US' ? ` (USD/TWD ${p.fxRate.toFixed(2)})` : ''}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm">{formatCurrency(p.valueTWD)}</div>
              <div className={cn('text-[11px]', pnlPositive ? 'text-emerald-500' : 'text-red-500')}>
                {pnlPositive ? '+' : ''}{formatCurrency(p.pnlTWD)} ({formatPercent(p.pnlPct)})
              </div>
            </div>
            <div className={cn('hidden text-right sm:block', dayPositive ? 'text-emerald-500' : 'text-red-500')}>
              <div className="text-[10px] uppercase opacity-60">今日</div>
              <div className="text-xs">{dayPositive ? '+' : ''}{formatCurrency(p.dayChangeTWD)}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
