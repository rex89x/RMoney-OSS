import { useMemo } from 'react';
import { Receipt, Repeat } from 'lucide-react';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Badge } from '@/components/ui/badge';
import { useTransactions } from '@/features/ledger/hooks';
import { paymentMethodLabel, type PaymentMethod } from '@/features/ledger/payment-methods';
import { type Account } from '@/features/accounts';
import { addTWCalendarMonths, formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import type { Transaction } from '@/features/ledger/types';
import { clampDayToMonth, type CreditCardBill } from '../types';

interface BillDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pm: PaymentMethod | null;
  cardAccount: Account | null;
  cycleMonth: string;
  cycleStart: Date;
  cycleEnd: Date;
  bill: CreditCardBill | null;
}

function txMatchesCard(tx: Transaction, pm: PaymentMethod, cardAccount: Account | null): boolean {
  if (cardAccount && tx.fromAccountId === cardAccount.id) return true;
  if (cardAccount && tx.toAccountId === cardAccount.id) return true;
  if (tx.paymentMethod === pm.name) return true;
  if (tx.paymentMethod === paymentMethodLabel(pm)) return true;
  return false;
}

export function BillDetailsDialog({
  open,
  onOpenChange,
  pm,
  cardAccount,
  cycleMonth,
  cycleStart,
  cycleEnd,
  bill,
}: BillDetailsDialogProps) {
  const { data: txs = [], isLoading } = useTransactions({
    startDate: cycleStart,
    endDate: cycleEnd,
    limit: 500,
  });

  const matched = useMemo(
    () => (pm ? txs.filter((tx) => txMatchesCard(tx, pm, cardAccount)) : []),
    [txs, pm, cardAccount],
  );

  const totals = useMemo(() => {
    let consumption = 0;
    let topUp = 0;
    for (const tx of matched) {
      if (tx.type === 'expense' && cardAccount && tx.fromAccountId === cardAccount.id) {
        consumption += tx.amountTWD;
      } else if (
        tx.type === 'transfer'
        && cardAccount
        && tx.toAccountId === cardAccount.id
        && tx.category !== 'credit_card_payment'
      ) {
        topUp += tx.amountTWD;
      } else if (tx.type === 'expense' && !cardAccount) {
        consumption += tx.amountTWD;
      }
    }
    return { consumption, topUp, total: consumption + topUp };
  }, [matched, cardAccount]);

  if (!pm) return null;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${paymentMethodLabel(pm)} — ${cycleMonth} 帳單明細`}
      description={`期間 ${formatTW(cycleStart, 'MM/dd')} – ${formatTW(cycleEnd, 'MM/dd')}`}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3 rounded-lg border p-3 text-center">
          <Stat label="消費" value={totals.consumption} tone="danger" />
          <Stat label="自動加值" value={totals.topUp} tone="warning" />
          <Stat label="合計" value={totals.total} tone="default" highlight />
        </div>
        {bill?.amount != null ? (
          <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            銀行帳單金額：NT${Math.round(bill.amount).toLocaleString()}
            {totals.total > 0 ? (
              <> · 系統合計差額 NT${Math.round(bill.amount - totals.total).toLocaleString()}</>
            ) : null}
          </div>
        ) : null}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中…</p>
        ) : matched.length === 0 ? (
          <p className="rounded-md border p-4 text-center text-sm text-muted-foreground">
            這一期還沒有任何 TX 落在這張卡上。
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {matched.map((tx) => (
              <BillTxRow key={tx.id} tx={tx} cardAccount={cardAccount} />
            ))}
          </ul>
        )}
      </div>
    </ResponsiveDialog>
  );
}

function Stat({
  label, value, tone, highlight,
}: { label: string; value: number; tone?: 'default' | 'danger' | 'warning'; highlight?: boolean }) {
  const tint = tone === 'danger' ? 'text-destructive' : tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : '';
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 tabular-nums', highlight ? 'text-lg font-semibold' : 'text-base font-medium', tint)}>
        NT${Math.round(value).toLocaleString()}
      </div>
    </div>
  );
}

function BillTxRow({ tx, cardAccount }: { tx: Transaction; cardAccount: Account | null }) {
  const isTopUp = tx.type === 'transfer' && cardAccount?.id === tx.toAccountId && tx.category !== 'credit_card_payment';
  return (
    <li className="flex items-center gap-3 p-3 text-sm">
      <span className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full',
        isTopUp ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400' : 'bg-destructive/20 text-destructive',
      )}>
        {isTopUp ? <Repeat className="size-4" /> : <Receipt className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{tx.note || tx.category}</div>
        <div className="truncate text-xs text-muted-foreground">
          {formatTW(tx.date, 'MM/dd HH:mm')} · {tx.paymentMethod}
          {isTopUp ? ' · 自動加值' : ''}
        </div>
      </div>
      {tx.tripId ? <Badge variant="outline">出遊</Badge> : null}
      <div className="text-right text-sm font-medium tabular-nums">
        NT${Math.round(tx.amountTWD).toLocaleString()}
      </div>
    </li>
  );
}

export function deriveCycleRange(args: {
  effectiveDue: Date;
  statementDay: number | null | undefined;
}): { start: Date; end: Date } {
  const { effectiveDue, statementDay } = args;
  if (statementDay != null) {
    const dueDay = effectiveDue.getDate();
    const targetMonthOffset = statementDay >= dueDay ? -1 : 0;
    const baseMonth = effectiveDue.getMonth() + targetMonthOffset;
    const year = effectiveDue.getFullYear();
    const day = clampDayToMonth(year, baseMonth, statementDay);
    const end = new Date(year, baseMonth, day, 23, 59, 59, 999);
    const start = addTWCalendarMonths(end, -1);
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }
  const end = new Date(effectiveDue);
  end.setHours(23, 59, 59, 999);
  const start = addTWCalendarMonths(end, -1);
  start.setDate(start.getDate() + 1);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}
