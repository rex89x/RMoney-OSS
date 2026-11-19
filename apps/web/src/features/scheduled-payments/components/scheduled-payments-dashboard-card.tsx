import { useNavigate } from 'react-router-dom';
import { CalendarClock, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, cn } from '@/lib/utils';
import { formatTW, startOfTWDay } from '@/lib/tz';
import { useUpcomingScheduledPayments } from '../hooks';

export function ScheduledPaymentsDashboardCard() {
  const upcoming = useUpcomingScheduledPayments(60);
  const navigate = useNavigate();

  if (upcoming.length === 0) {
    return (
      <Card
        className="cursor-pointer transition-colors hover:bg-muted/40"
        onClick={() => navigate('/settings?tab=scheduled')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') navigate('/settings?tab=scheduled'); }}
      >
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="size-4" /> 排程支出
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">60 天內沒有排程</p>
        </CardContent>
      </Card>
    );
  }

  const today = startOfTWDay();
  const total = upcoming.reduce((s, p) => s + p.amountTWD, 0);

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-muted/40"
      onClick={() => navigate('/settings?tab=scheduled')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate('/settings?tab=scheduled'); }}
    >
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><CalendarClock className="size-4" /> 即將到期排程</span>
          <span className="text-xs font-normal text-muted-foreground">{upcoming.length} 筆 · {formatCurrency(total)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5">
          {upcoming.slice(0, 5).map((p) => {
            const days = Math.round((p.dueDate.getTime() - today.getTime()) / 86400000);
            const overdue = days < 0;
            const soon = days >= 0 && days <= p.remindBeforeDays;
            return (
              <li key={p.id} className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="truncate">{p.name}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {formatTW(p.dueDate, 'MM/dd')}
                    {overdue ? <span className="ml-1 text-red-500">已逾期 {-days}d</span> :
                      <span className={cn('ml-1', soon && 'text-amber-500')}>{days}d</span>}
                  </div>
                </div>
                <span className="tabular-nums">{formatCurrency(p.amountTWD)}</span>
                {overdue && <AlertTriangle className="size-3 text-red-500" />}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
