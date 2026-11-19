import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Check, CreditCard, CalendarClock, Target, HandCoins, Coffee, Repeat, Tag, EyeOff, Undo2, ListTodo,
  HeartHandshake, ShieldCheck, type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { cn, formatCurrency } from '@/lib/utils';
import { TransactionEditDialog } from '@/features/ledger/components/transaction-edit-dialog';
import { useMarkScheduledPaid } from '@/features/scheduled-payments/hooks';
import { useUpsertSubscription } from '@/features/subscriptions/hooks';
import type { DetectedSubscription } from '@/features/subscriptions/detector';
import type { Transaction } from '@/features/ledger/types';
import { useCompleteInboxTodo, useDismissInboxItem } from '../hooks';
import { INBOX_GROUPS, type InboxItem, type InboxKind, type InboxTodo } from '../types';

const KIND_ICON: Record<InboxKind, LucideIcon> = {
  manual: ListTodo,
  'uncategorized-tx': Tag,
  'unsettled-loan': HandCoins,
  'payout-unpaid': Coffee,
  'subscription-candidate': Repeat,
  'credit-card-due': CreditCard,
  'scheduled-payment-due': CalendarClock,
  'budget-warn': Target,
  insurance: ShieldCheck,
  household: HeartHandshake,
};

const SEVERITY_DOT: Record<InboxItem['severity'], string> = {
  urgent: 'bg-destructive',
  warn: 'bg-warning',
  info: 'bg-muted-foreground/50',
};

interface InboxListProps {
  items: InboxItem[];
  /** 首頁卡片用：不分組、限制數量 */
  compact?: boolean;
  limit?: number;
  /** 已略過清單（頁面底部可還原） */
  dismissedItems?: InboxItem[];
}

export function InboxList({ items, compact = false, limit, dismissedItems = [] }: InboxListProps) {
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const dismiss = useDismissInboxItem();
  const markScheduled = useMarkScheduledPaid();
  const upsertSub = useUpsertSubscription();
  const completeTodo = useCompleteInboxTodo();
  const [showDismissed, setShowDismissed] = useState(false);

  async function handleResolve(item: InboxItem) {
    try {
      if (item.kind === 'manual') {
        const todo = item.payload?.todo as InboxTodo | undefined;
        if (!todo) return;
        await completeTodo.mutateAsync(todo);
        return;
      }
      if (item.kind === 'scheduled-payment-due') {
        const id = item.payload?.scheduledId;
        if (typeof id !== 'string') return;
        await markScheduled.mutateAsync(id);
        toast.success('已標記繳費');
        return;
      }
      if (item.kind === 'subscription-candidate') {
        const d = item.payload?.detected as DetectedSubscription | undefined;
        if (!d) return;
        await upsertSub.mutateAsync({
          input: {
            name: d.displayName,
            amountTWD: d.amountTWD,
            billingCycle: d.cycle,
            nextChargeDate: null,
            paymentMethod: d.paymentMethod ?? null,
            category: d.category ?? null,
            vendor: null,
            active: true,
            lastChargedAt: d.lastSeen,
            note: null,
          },
        });
        toast.success(`已加入訂閱：${d.displayName}`);
        return;
      }
    } catch (err) {
      console.error('[inboxResolve]', err);
      toast.error(err instanceof Error ? err.message : '處理失敗');
    }
  }

  const visible = limit ? items.slice(0, limit) : items;

  if (items.length === 0 && !compact) {
    return (
      <div className="space-y-4">
        <EmptyState icon={Check} title="沒有待處理事項" description="帳單、代墊、預算與待整理交易都清空了。" />
        {dismissedItems.length > 0 ? (
          <DismissedSection items={dismissedItems} open={showDismissed} onToggle={() => setShowDismissed((v) => !v)} />
        ) : null}
      </div>
    );
  }

  const groups = compact
    ? [{ kind: null as InboxKind | null, label: '', items: visible }]
    : INBOX_GROUPS
      .map((g) => ({ kind: g.kind, label: g.label, items: visible.filter((i) => i.kind === g.kind) }))
      .filter((g) => g.items.length > 0);

  return (
    <div className={cn('space-y-4', compact && 'space-y-1')}>
      {groups.map((g) => (
        <section key={g.kind ?? 'all'}>
          {g.label ? (
            <h3 className="mb-1.5 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {g.label}
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium">{g.items.length}</span>
            </h3>
          ) : null}
          <ul className={cn('divide-y rounded-xl border bg-card', compact && 'border-0 bg-transparent divide-y-0')}>
            {g.items.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                compact={compact}
                busy={dismiss.isPending || markScheduled.isPending || upsertSub.isPending || completeTodo.isPending}
                onEdit={item.tx ? () => setEditingTx(item.tx ?? null) : undefined}
                onResolve={
                  item.kind === 'scheduled-payment-due' || item.kind === 'subscription-candidate' || item.kind === 'manual'
                    ? () => void handleResolve(item)
                    : undefined
                }
                onDismiss={() => void dismiss.mutateAsync({ id: item.id })}
              />
            ))}
          </ul>
        </section>
      ))}
      {!compact && dismissedItems.length > 0 ? (
        <DismissedSection items={dismissedItems} open={showDismissed} onToggle={() => setShowDismissed((v) => !v)} />
      ) : null}
      <TransactionEditDialog tx={editingTx} onClose={() => setEditingTx(null)} />
    </div>
  );
}

interface RowProps {
  item: InboxItem;
  compact: boolean;
  busy: boolean;
  onEdit?: () => void;
  onResolve?: () => void;
  onDismiss: () => void;
}

function InboxRow({ item, compact, busy, onEdit, onResolve, onDismiss }: RowProps) {
  const Icon = KIND_ICON[item.kind];
  const resolveLabel = item.kind === 'scheduled-payment-due' ? '已繳' : item.kind === 'subscription-candidate' ? '加入訂閱' : item.kind === 'manual' ? '完成' : '';
  return (
    <li className={cn('flex items-center gap-3 px-3 py-2.5', compact && 'px-1 py-1.5')}>
      <span className={cn('size-1.5 shrink-0 rounded-full', SEVERITY_DOT[item.severity])} aria-hidden />
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{item.title}</span>
          {item.amountTWD != null ? (
            <span className="shrink-0 text-sm tabular-nums">{formatCurrency(item.amountTWD)}</span>
          ) : null}
        </div>
        {item.detail ? <div className="truncate text-xs text-muted-foreground">{item.detail}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.kind === 'manual' && item.href ? (
          <Button size="icon-sm" variant="ghost" asChild aria-label="前往">
            <Link to={item.href}><ArrowRight className="size-4" /></Link>
          </Button>
        ) : null}
        {onEdit ? (
          <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>整理</Button>
        ) : onResolve ? (
          <Button size="sm" variant="outline" onClick={onResolve} disabled={busy}>
            <Check className="size-3.5" /> {resolveLabel}
          </Button>
        ) : item.href ? (
          <Button size="sm" variant="outline" asChild>
            <Link to={item.href}>前往 <ArrowRight className="size-3.5" /></Link>
          </Button>
        ) : null}
        <Button size="icon-sm" variant="ghost" onClick={onDismiss} disabled={busy} aria-label="略過">
          <EyeOff className="size-4" />
        </Button>
      </div>
    </li>
  );
}

function DismissedSection({ items, open, onToggle }: { items: InboxItem[]; open: boolean; onToggle: () => void }) {
  const dismiss = useDismissInboxItem();
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 px-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <EyeOff className="size-3.5" /> 已略過 {items.length} 項{open ? '（收合）' : '（展開）'}
      </button>
      {open ? (
        <ul className="mt-2 divide-y rounded-xl border bg-card opacity-70">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {INBOX_GROUPS.find((g) => g.kind === item.kind)?.label ?? item.kind}
              </Badge>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <Button
                size="icon-sm" variant="ghost" aria-label="還原"
                disabled={dismiss.isPending}
                onClick={() => void dismiss.mutateAsync({ id: item.id, undo: true })}
              >
                <Undo2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
