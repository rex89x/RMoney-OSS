import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, cn } from '@/lib/utils';
import { formatTWMonthKey } from '@/lib/tz';
import { useRentals } from '../hooks';
import {
  avgMonthlyIncomeTWD, estimateMonthsToPayback, netPnLTWD, paybackProgressPct, totalReceivedTWD,
} from '../types';

export function RentalsDashboardCard() {
  const { data: rentals = [], isLoading } = useRentals();

  const stats = useMemo(() => {
    const active = rentals.filter((r) => r.status === 'active');
    const cost = rentals.reduce((s, r) => s + r.purchaseAmountTWD, 0);
    const received = rentals.reduce((s, r) => s + totalReceivedTWD(r), 0);
    const expectedMonthly = active.reduce((s, r) => s + r.expectedMonthlyIncome, 0);
    const thisMonthKey = formatTWMonthKey(new Date());
    const thisMonthReceived = rentals.reduce((s, r) => {
      return s + r.incomes.filter((inc) => inc.monthKey === thisMonthKey).reduce((x, inc) => x + inc.amountTWD, 0);
    }, 0);
    const overallProgress = cost > 0 ? Math.min(100, (received / cost) * 100) : 0;
    const remaining = Math.max(0, cost - received);
    const avgMonthly = rentals.reduce((s, r) => s + avgMonthlyIncomeTWD(r), 0);
    const monthsLeft = avgMonthly > 0 && remaining > 0 ? remaining / avgMonthly : null;
    return {
      active: active.length,
      total: rentals.length,
      cost,
      received,
      pnl: received - cost,
      expectedMonthly,
      thisMonthReceived,
      overallProgress,
      monthsLeft,
    };
  }, [rentals]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4" /> 租賃資產
          </CardTitle>
        </CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">載入中…</p></CardContent>
      </Card>
    );
  }

  if (rentals.length === 0) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4" /> 租賃資產
          </CardTitle>
          <Link to="/ledger?view=rentals" className="text-xs text-muted-foreground hover:text-foreground">
            前往設定
          </Link>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            尚未建立租賃資產。在「記帳 → 租賃」新增。
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="size-4" /> 租賃資產
        </CardTitle>
        <Link to="/ledger?view=rentals" className="text-xs text-muted-foreground hover:text-foreground">
          {stats.active}/{stats.total} 活躍
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="累積收款" value={formatCurrency(stats.received)} tone="success" highlight />
          <Stat label="整體回本" value={`${stats.overallProgress.toFixed(1)}%`} />
          <Stat
            label="預估剩餘"
            value={stats.monthsLeft != null
              ? `${stats.monthsLeft.toFixed(1)} 個月`
              : stats.cost > 0 && stats.received >= stats.cost
                ? '已回本'
                : '—'}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/20 p-3 text-sm">
          <div>
            <div className="text-[11px] text-muted-foreground">本月已收</div>
            <div className="mt-0.5 font-medium tabular-nums text-success">
              {formatCurrency(stats.thisMonthReceived)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">預期月收</div>
            <div className="mt-0.5 font-medium tabular-nums">
              {formatCurrency(stats.expectedMonthly)}
            </div>
          </div>
        </div>

        <ul className="space-y-1.5">
          {rentals.slice(0, 4).map((r) => {
            const progress = paybackProgressPct(r);
            const pnl = netPnLTWD(r);
            const avg = avgMonthlyIncomeTWD(r);
            const monthsLeft = estimateMonthsToPayback(r);
            const received = totalReceivedTWD(r);
            return (
              <li key={r.id} className="rounded-md border px-3 py-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="truncate font-medium">{r.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-success">
                    +{formatCurrency(received)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-success transition-all"
                    style={{ width: `${Math.min(100, progress)}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
                  <span>{progress.toFixed(1)}% 回本 · {r.incomes.length} 期</span>
                  {monthsLeft != null && monthsLeft > 0 ? (
                    <span>還需 {monthsLeft.toFixed(1)} 個月（按 {formatCurrency(avg)} / 月）</span>
                  ) : monthsLeft === 0 ? (
                    <span className="text-success">已回本</span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                  成本 {formatCurrency(r.purchaseAmountTWD)} · 損益 {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
                </div>
              </li>
            );
          })}
        </ul>
        {rentals.length > 4 ? (
          <p className="text-center text-[11px] text-muted-foreground">
            還有 {rentals.length - 4} 筆，到「記帳 → 租賃」查看
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({
  label, value, tone, highlight,
}: { label: string; value: string; tone?: 'success' | 'danger'; highlight?: boolean }) {
  const cls = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-destructive' : '';
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn(
        'mt-0.5 tabular-nums',
        highlight ? 'text-base font-semibold' : 'text-sm font-medium',
        cls,
      )}>
        {value}
      </div>
    </div>
  );
}
