import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ResponsiveContainer, Area, AreaChart, XAxis, YAxis, Tooltip,
} from 'recharts';
import { TrendingUp, TrendingDown, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';
import { usePortfolioSnapshots, useLatestSnapshot } from '../hooks';

/**
 * 投資組合 Dashboard 卡片（主 Dashboard 用，緊湊版）
 * 點擊跳到 /investments?tab=dashboard
 */
export function PortfolioDashboardCard() {
  const { data: latest, isLoading: latestLoading } = useLatestSnapshot();
  const { data: snapshots = [] } = usePortfolioSnapshots(30);
  const navigate = useNavigate();

  const chartData = useMemo(
    () => snapshots.map((s) => ({ date: s.date, value: s.totalValueTWD })),
    [snapshots],
  );

  if (latestLoading) {
    return <Card><CardContent><Skeleton className="h-32" /></CardContent></Card>;
  }

  if (!latest) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4" /> 投資組合
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">尚無投資快照</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => navigate('/investments?tab=dashboard')}>
            前往投資頁
          </Button>
        </CardContent>
      </Card>
    );
  }

  const pnlPositive = latest.unrealizedPnlTWD >= 0;
  const dayPositive = latest.dayChangeTWD >= 0;

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-muted/40"
      onClick={() => navigate('/investments?tab=dashboard')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate('/investments?tab=dashboard'); }}
    >
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Wallet className="size-4" /> 投資組合</span>
          <span className="text-xs font-normal text-muted-foreground">{latest.date}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] text-muted-foreground">總市值</div>
            <div className="text-base font-semibold">{formatCurrency(latest.totalValueTWD)}</div>
          </div>
          <div>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              {dayPositive ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              今日漲跌
            </div>
            <div className={cn('text-base font-semibold', dayPositive ? 'text-emerald-500' : 'text-red-500')}>
              {dayPositive ? '+' : ''}{formatCurrency(latest.dayChangeTWD)}
              <span className="ml-1 text-[10px]">{formatPercent(latest.dayChangePct)}</span>
            </div>
          </div>
        </div>
        <div className={cn('text-xs', pnlPositive ? 'text-emerald-500' : 'text-red-500')}>
          未實現損益 {pnlPositive ? '+' : ''}{formatCurrency(latest.unrealizedPnlTWD)} ({formatPercent(latest.unrealizedPnlPct)})
        </div>
        {chartData.length >= 2 ? (
          <div className="h-[80px] -mx-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="dashGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" hide />
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Tooltip
                  formatter={(v: number) => [formatCurrency(v), '總市值']}
                  labelFormatter={(d) => `日期 ${d}`}
                />
                <Area type="monotone" dataKey="value" stroke="#8b5cf6" strokeWidth={2} fill="url(#dashGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
