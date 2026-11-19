import { useMemo, useState } from 'react';
import { CalendarClock, ChevronDown, ChevronUp, CircleSlash, CreditCard } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatTW } from '@/lib/tz';
import { cn, formatCurrency } from '@/lib/utils';
import {
  installmentRemainingTWD, installmentScheduleRows, lastInstallmentDate, nextInstallmentDate,
} from '../schedule';
import { INSTALLMENT_STATUS_LABEL, type InstallmentPlan } from '../types';

interface InstallmentCardProps {
  plan: InstallmentPlan;
  cardName: string;
  categoryName: string;
  onCancel: (plan: InstallmentPlan) => void;
  cancelling: boolean;
}

export function InstallmentCard({ plan, cardName, categoryName, onCancel, cancelling }: InstallmentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const remaining = installmentRemainingTWD(plan);
  const next = nextInstallmentDate(plan);
  const pct = Math.round((plan.paidPeriods / Math.max(1, plan.periods)) * 100);
  const rows = useMemo(() => (expanded ? installmentScheduleRows(plan) : []), [expanded, plan]);

  return (
    <li className="space-y-2 p-3 text-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <CreditCard className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{plan.title}</span>
            <Badge variant={plan.status === 'active' ? 'outline' : 'secondary'} className="shrink-0 text-[10px]">
              {INSTALLMENT_STATUS_LABEL[plan.status]}
            </Badge>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {cardName} · {categoryName} · 總額 {formatCurrency(plan.totalAmountTWD + plan.feeTWD)}
            {plan.feeTWD > 0 ? `（含手續費 ${formatCurrency(plan.feeTWD)}）` : '（0 利率）'}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-medium tabular-nums">{plan.paidPeriods}/{plan.periods} 期</div>
          {plan.status === 'active' ? (
            <div className="text-xs text-muted-foreground tabular-nums">未入帳 {formatCurrency(remaining)}</div>
          ) : null}
        </div>
      </div>
      <Progress value={pct} className="h-1.5" />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CalendarClock className="size-3" />
          {next ? `下期 ${formatTW(next, 'yyyy/MM/dd')}` : plan.status === 'cancelled' && plan.cancelledAt
            ? `${formatTW(plan.cancelledAt, 'yyyy/MM/dd')} 取消`
            : '已全部入帳'}
          {' · 繳到 '}{formatTW(lastInstallmentDate(plan), 'yyyy/MM')}
        </span>
        <span className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            明細
          </Button>
          {plan.status === 'active' ? (
            <Button size="sm" variant="ghost" onClick={() => onCancel(plan)} disabled={cancelling}>
              <CircleSlash className="size-4" /> 取消
            </Button>
          ) : null}
        </span>
      </div>
      {expanded ? (
        <ol className="max-h-60 divide-y overflow-y-auto rounded-md border text-xs">
          {rows.map((row) => (
            <li key={row.index} className={cn('flex items-center gap-2 px-3 py-1.5', !row.posted && 'text-muted-foreground')}>
              <span className="w-12 tabular-nums">{row.index}/{plan.periods}</span>
              <span className="flex-1 tabular-nums">{formatTW(row.date, 'yyyy/MM/dd')}</span>
              <span className="tabular-nums">{formatCurrency(row.amountTWD)}</span>
              <span className="w-12 text-right">{row.posted ? '已入帳' : '未入帳'}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}
