import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import { TrendingUp, TrendingDown, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';
import { useNetWorthNow, useNetWorthSnapshots } from '../hooks';

export function NetWorthDashboardCard() {
  const now = useNetWorthNow();
  const { data: snapshots = [] } = useNetWorthSnapshots(12);
  const navigate = useNavigate();

  const chartData = useMemo(
    () => snapshots.map((s) => ({ month: s.month, net: s.netWorthTWD })),
    [snapshots],
  );

  const lastTwo = snapshots.slice(-2);
  const mom = lastTwo.length === 2 ? lastTwo[1]!.netWorthTWD - lastTwo[0]!.netWorthTWD : 0; // 非空：索引已做邊界 / 長度檢查
  const momPct = lastTwo.length === 2 && lastTwo[0]!.netWorthTWD // 非空：索引已做邊界 / 長度檢查
    ? (mom / Math.abs(lastTwo[0]!.netWorthTWD)) * 100 // 非空：索引已做邊界 / 長度檢查
    : 0;
  const momPositive = mom >= 0;

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-muted/40"
      onClick={() => navigate('/net-worth')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate('/net-worth'); }}
    >
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Wallet className="size-4" /> 淨值</span>
          {lastTwo.length === 2 && (
            <span className={cn('text-xs font-normal', momPositive ? 'text-emerald-500' : 'text-red-500')}>
              {momPositive ? <TrendingUp className="inline size-3" /> : <TrendingDown className="inline size-3" />}
              {' '}{momPositive ? '+' : ''}{formatPercent(momPct)} MoM
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-2xl font-semibold">{formatCurrency(now.netWorthTWD)}</div>
        <div className="grid auto-cols-fr grid-flow-col gap-2 text-[10px] text-muted-foreground">
          <div title={now.rentalAbsorbedTWD > 0
            ? `帳戶餘額 ${formatCurrency(now.rawLiquidTWD)} + 租賃購入抵銷 ${formatCurrency(now.rentalAbsorbedTWD)}`
            : undefined}>
            <div className="opacity-70">現金/銀行</div>
            <div className="font-medium tabular-nums text-foreground">{formatCurrency(now.liquidTWD)}</div>
          </div>
          <div>
            <div className="opacity-70">投資</div>
            <div className="font-medium tabular-nums text-foreground">{formatCurrency(now.investmentTWD)}</div>
          </div>
          {now.manualAssetsTWD > 0 ? (
            <div>
              <div className="opacity-70">手動資產</div>
              <div className="font-medium tabular-nums text-foreground">{formatCurrency(now.manualAssetsTWD)}</div>
            </div>
          ) : null}
          {now.insurancePensionTWD > 0 ? (
            <div>
              <div className="opacity-70">保險 / 退休</div>
              <div className="font-medium tabular-nums text-foreground">{formatCurrency(now.insurancePensionTWD)}</div>
            </div>
          ) : null}
          {now.rentalUnrecoveredTWD > 0 ? (
            <div>
              <div className="opacity-70">租賃未回收</div>
              <div className="font-medium tabular-nums text-foreground">{formatCurrency(now.rentalUnrecoveredTWD)}</div>
            </div>
          ) : null}
          <div>
            <div className="opacity-70">負債</div>
            <div className="font-medium tabular-nums text-red-500">−{formatCurrency(now.liabilitiesTWD + now.creditCardOutstandingTWD)}</div>
          </div>
        </div>
        {chartData.length >= 2 ? (
          <div className="h-[60px] -mx-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="month" hide />
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Tooltip formatter={(v: number) => [formatCurrency(v), '淨值']} />
                <Area type="monotone" dataKey="net" stroke="#10b981" strokeWidth={2} fill="url(#nwGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
