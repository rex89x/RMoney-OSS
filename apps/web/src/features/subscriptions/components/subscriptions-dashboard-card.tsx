import { useNavigate } from 'react-router-dom';
import { Repeat, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, cn } from '@/lib/utils';
import { useDetectedSubscriptions, useMonthlySubscriptionTotal } from '../hooks';
import { CYCLE_LABEL } from '../types';

export function SubscriptionsDashboardCard() {
  const { total, count, subs } = useMonthlySubscriptionTotal();
  const detected = useDetectedSubscriptions(6);
  const navigate = useNavigate();

  // 未加入清單但久未動的偵測項
  const known = new Set(subs.map((s) => s.name.toLowerCase()));
  const stale = detected.filter((d) => !known.has(d.displayName.toLowerCase()) && d.daysSinceLast > 60);
  const top = subs
    .slice()
    .sort((a, b) => b.amountTWD - a.amountTWD)
    .slice(0, 4);

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-muted/40"
      onClick={() => navigate('/settings?tab=subscriptions')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate('/settings?tab=subscriptions'); }}
    >
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Repeat className="size-4" /> 訂閱費</span>
          <span className="text-xs font-normal text-muted-foreground">{count} 個有效</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div>
          <div className="text-xl font-semibold tabular-nums">{formatCurrency(total)}</div>
          <div className="text-[11px] text-muted-foreground">每月平均（含年費換算）</div>
        </div>
        {top.length > 0 && (
          <ul className="space-y-1">
            {top.map((s) => (
              <li key={s.id} className="flex items-center justify-between text-xs">
                <span className="truncate">{s.name}</span>
                <span className={cn('tabular-nums text-muted-foreground', !s.active && 'line-through')}>
                  {formatCurrency(s.amountTWD)}
                  <span className="ml-1 text-[10px]">/{CYCLE_LABEL[s.billingCycle]}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {stale.length > 0 && (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="size-3" /> {stale.length} 個可能該砍
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
