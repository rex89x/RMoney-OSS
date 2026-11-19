import { useMemo } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { TrendingUp, TrendingDown, Wallet, Building, Banknote, CreditCard, Home, Layers, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { ErrorBoundary } from '@/components/error-boundary';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';
import { nowTW } from '@/lib/tz';
import {
  useNetWorthNow, useNetWorthSnapshots, useTriggerNetWorthSnapshot, useUpsertNetWorthSnapshot,
} from '../hooks';
import { NetWorthPanel } from './net-worth-panel';
import { HouseholdFundShareCard } from './household-fund-share-card';

const COMPOSITION_COLORS = {
  liquid: '#10b981',
  investment: '#8b5cf6',
  manual: '#3b82f6',
  rental: '#0ea5e9',
  insurancePension: '#6366f1',
  liabilities: '#ef4444',
  cc: '#f59e0b',
  installment: '#f97316',
};

export function NetWorthPage() {
  const now = useNetWorthNow();
  const { data: snapshots = [], isLoading } = useNetWorthSnapshots(24);
  const upsertSnapshot = useUpsertNetWorthSnapshot();
  const triggerSnapshot = useTriggerNetWorthSnapshot();
  const pending = upsertSnapshot.isPending || triggerSnapshot.isPending;

  async function captureNow() {
    const tw = nowTW();
    const month = `${tw.getFullYear()}-${String(tw.getMonth() + 1).padStart(2, '0')}`;
    try {
      // 優先走 Apps Script，與排程算法一致
      await triggerSnapshot.mutateAsync();
      toast.success(`已更新 ${month} 淨值快照`);
    } catch (err) {
      console.warn('[netWorth] Apps Script snapshot failed, falling back to direct write', err);
      // Apps Script 寫的是 raw 值（rawLiquid / rentalUnrecoveredRaw），fallback 對齊
      await upsertSnapshot.mutateAsync({
        month,
        liquidTWD: now.rawLiquidTWD,
        investmentTWD: now.investmentTWD,
        manualAssetsTWD: now.manualAssetsTWD,
        rentalUnrecoveredTWD: now.rentalUnrecoveredRawTWD,
        insurancePensionTWD: now.insurancePensionTWD,
        liabilitiesTWD: now.liabilitiesTWD,
        creditCardOutstandingTWD: now.creditCardOutstandingTWD,
        installmentRemainingTWD: now.installmentRemainingTWD,
        netWorthTWD: now.netWorthTWD,
      });
      toast.success(`已更新 ${month} 淨值快照（前端寫入）`);
    }
  }

  const chartData = useMemo(
    () => snapshots.map((s) => ({
      month: s.month,
      net: s.netWorthTWD,
      assets: s.liquidTWD + s.investmentTWD + s.manualAssetsTWD + s.insurancePensionTWD + s.rentalUnrecoveredTWD,
      debts: s.liabilitiesTWD + s.creditCardOutstandingTWD + s.installmentRemainingTWD,
    })),
    [snapshots],
  );

  const compositionData = useMemo(() => [
    { name: '流動現金', value: now.liquidTWD, color: COMPOSITION_COLORS.liquid },
    { name: '投資組合', value: now.investmentTWD, color: COMPOSITION_COLORS.investment },
    { name: '手動資產', value: now.manualAssetsTWD, color: COMPOSITION_COLORS.manual },
    { name: '保險 / 退休', value: now.insurancePensionTWD, color: COMPOSITION_COLORS.insurancePension },
    { name: '租賃未回收', value: now.rentalUnrecoveredTWD, color: COMPOSITION_COLORS.rental },
  ].filter((d) => d.value > 0), [now]);

  const debtData = useMemo(() => [
    { name: '貸款負債', value: now.liabilitiesTWD, color: COMPOSITION_COLORS.liabilities },
    { name: '信用卡未繳', value: now.creditCardOutstandingTWD, color: COMPOSITION_COLORS.cc },
    { name: '分期未入帳', value: now.installmentRemainingTWD, color: COMPOSITION_COLORS.installment },
  ].filter((d) => d.value > 0), [now]);

  const lastTwo = snapshots.slice(-2);
  const mom = lastTwo.length === 2
    ? lastTwo[1]!.netWorthTWD - lastTwo[0]!.netWorthTWD // 非空：索引已做邊界 / 長度檢查
    : 0;
  const momPct = lastTwo.length === 2 && lastTwo[0]!.netWorthTWD // 非空：索引已做邊界 / 長度檢查
    ? (mom / Math.abs(lastTwo[0]!.netWorthTWD)) * 100 // 非空：索引已做邊界 / 長度檢查
    : 0;

  return (
    <ErrorBoundary scope="NetWorth">
      <PageHeader
        title="淨值"
        description="現金/銀行 + 投資 + 資產 + 保險解約金 / 退休帳戶 − 貸款 − 信用卡未繳 − 分期未入帳"
      />

      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-col items-start justify-between gap-2 pb-2 sm:flex-row sm:items-center">
            <CardTitle className="text-base">當前淨值</CardTitle>
            <Button size="sm" variant="outline" onClick={() => void captureNow()} disabled={pending}>
              <RefreshCw className={cn('size-4', pending && 'animate-spin')} /> 更新本月快照
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="text-3xl font-semibold">{formatCurrency(now.netWorthTWD)}</div>
              {lastTwo.length === 2 && (
                <div className={cn('text-sm', mom >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                  {mom >= 0 ? <TrendingUp className="inline size-3" /> : <TrendingDown className="inline size-3" />}
                  {' '}{mom >= 0 ? '+' : ''}{formatCurrency(mom)} ({formatPercent(momPct)}) vs 上月
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Bullet color={COMPOSITION_COLORS.liquid} label="現金/銀行" value={now.liquidTWD} icon={Banknote} />
              <Bullet color={COMPOSITION_COLORS.investment} label="投資" value={now.investmentTWD} icon={Wallet} />
              <Bullet color={COMPOSITION_COLORS.manual} label="手動" value={now.manualAssetsTWD} icon={Building} />
              {now.insurancePensionTWD > 0 ? (
                <Bullet color={COMPOSITION_COLORS.insurancePension} label="保險 / 退休" value={now.insurancePensionTWD} icon={ShieldCheck} />
              ) : null}
              {now.rentalUnrecoveredTWD > 0 ? (
                <Bullet color={COMPOSITION_COLORS.rental} label="租賃未回收" value={now.rentalUnrecoveredTWD} icon={Home} />
              ) : null}
              <Bullet color={COMPOSITION_COLORS.liabilities} label="貸款" value={-now.liabilitiesTWD} icon={CreditCard} />
              <Bullet color={COMPOSITION_COLORS.cc} label="卡費未繳" value={-now.creditCardOutstandingTWD} icon={CreditCard} />
              {now.installmentRemainingTWD > 0 ? (
                <Bullet color={COMPOSITION_COLORS.installment} label="分期未入帳" value={-now.installmentRemainingTWD} icon={Layers} />
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">月度淨值走勢</CardTitle></CardHeader>
          <CardContent className="h-[280px] px-0 pr-4 sm:px-2">
            {isLoading ? <Skeleton className="h-full" /> : chartData.length < 2 ? (
              <p className="flex h-full items-center justify-center text-sm text-muted-foreground">至少需 2 個月才能畫曲線（按上方更新本月快照即可累積）</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="netGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} width={48} />
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  <Area type="monotone" dataKey="net" name="淨值" stroke="#10b981" strokeWidth={2} fill="url(#netGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">資產組成</CardTitle></CardHeader>
            <CardContent className="h-[260px]">
              {compositionData.length === 0 ? <p className="flex h-full items-center justify-center text-sm text-muted-foreground">尚無資產</p> : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={compositionData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                      {compositionData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip formatter={(v: number, n) => [formatCurrency(v), n]} />
                    <Legend formatter={(v) => <span className="text-xs">{v}</span>} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">負債組成</CardTitle></CardHeader>
            <CardContent className="h-[260px]">
              {debtData.length === 0 ? <p className="flex h-full items-center justify-center text-sm text-muted-foreground">無負債</p> : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={debtData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                      {debtData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip formatter={(v: number, n) => [formatCurrency(v), n]} />
                    <Legend formatter={(v) => <span className="text-xs">{v}</span>} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        <HouseholdFundShareCard />
        <NetWorthPanel />
      </div>
    </ErrorBoundary>
  );
}

function Bullet({
  color, label, value, icon: Icon,
}: { color: string; label: string; value: number; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="rounded-md border p-2">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
        <Icon className="size-3" /> {label}
      </div>
      <div className={cn('mt-0.5 text-sm font-semibold tabular-nums', value < 0 && 'text-red-500')}>
        {formatCurrency(value)}
      </div>
    </div>
  );
}
