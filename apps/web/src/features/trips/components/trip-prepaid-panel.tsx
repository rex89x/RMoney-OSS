import { useMemo, useState } from 'react';
import {
  AlertCircle, CalendarClock, Check, FolderInput, ListChecks, Receipt, Users, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useUpdateTransaction, useTransactions, useCategories } from '@/features/ledger/hooks';
import { useAuth } from '@/hooks/use-auth';
import type { Transaction } from '@/features/ledger/types';
import { TransactionEditDialog } from '@/features/ledger/components/transaction-edit-dialog';
import { formatCurrency, cn } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useConfirm } from '@/components/ui/confirm';
import { TripTxPicker } from './trip-tx-picker';
import type { Trip } from '../types';

/**
 * 預付款分頁：列出 trip 的所有預付款 tx（trip.id + prepaid==true），分三組：
 *   - 自付 / 不需要收回
 *   - 我幫人墊付，待收
 *   - 已結清（loanSettledAt 有值）
 *
 * 同時顯示每位 counterparty 應收總額 + 一鍵標記已收。
 */
export function TripPrepaidPanel({ trip }: { trip: Trip }) {
  const update = useUpdateTransaction();
  const confirm = useConfirm();
  const { user, isViewer } = useAuth();
  const canEdit = !isViewer && (trip.userId === user?.uid || trip.ownerId === user?.uid);
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.key, c])),
    [categories],
  );
  const { data: txs = [], isLoading } = useTransactions(
    { tripId: trip.id, type: 'expense', limit: 500 },
    { enabled: true },
  );

  const prepaid = useMemo(
    () => txs.filter((t) => t.prepaid === true && !t.deletedAt),
    [txs],
  );

  const groups = useMemo(() => groupPrepaid(prepaid), [prepaid]);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  async function markReceived(tx: Transaction) {
    const ok = await confirm({
      title: '標記為已結清',
      description: `${tx.counterpartyName ?? '對方'} 已歸還 ${formatCurrency(reimburseDueTWD(tx))}？`,
      confirmText: '已結清',
    });
    if (!ok) return;
    try {
      await update.mutateAsync({ id: tx.id, patch: { loanSettledAt: new Date() } });
      toast.success('已標記結清');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失敗');
    }
  }

  async function unmarkReceived(tx: Transaction) {
    try {
      await update.mutateAsync({ id: tx.id, patch: { loanSettledAt: null } });
      toast.success('已恢復為待收');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失敗');
    }
  }

  return (
    <div className="space-y-4">
      <SummaryStrip groups={groups} />

      {canEdit ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <TripTxPicker
            trip={trip}
            trigger={
              <Button size="sm" variant="outline">
                <FolderInput className="size-4" /> 從花費中標記預付
              </Button>
            }
          />
        </div>
      ) : null}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-md" />
          ))}
        </div>
      ) : prepaid.length === 0 ? (
        <Card>
          <CardContent className="space-y-2 py-10 text-center text-sm text-muted-foreground">
            <Wallet className="mx-auto size-6" />
            <p>還沒有標記為預付的款項。</p>
            <p>新增花費時勾「這是預付款」，或在花費明細裡編輯既有 tx 改標。</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <PrepaidGroup
            title="待我收回的款（先墊付）"
            icon={Users}
            tone="warning"
            items={groups.pendingReceive}
            catMap={catMap}
            actions={canEdit ? (t) => (
              <Button size="sm" variant="outline" onClick={() => void markReceived(t)}>
                <Check className="size-4" /> 標記已收
              </Button>
            ) : undefined}
            onEdit={canEdit ? (t) => setEditingTx(t) : undefined}
          />
          <ReimbursementByPerson items={groups.pendingReceive} />
          <PrepaidGroup
            title="已結清"
            icon={ListChecks}
            tone="success"
            items={groups.settled}
            catMap={catMap}
            actions={canEdit ? (t) => (
              <Button size="sm" variant="ghost" onClick={() => void unmarkReceived(t)}>
                還原為待收
              </Button>
            ) : undefined}
            onEdit={canEdit ? (t) => setEditingTx(t) : undefined}
          />
          <PrepaidGroup
            title="自付（不需收回）"
            icon={Receipt}
            tone="muted"
            items={groups.selfPaid}
            catMap={catMap}
            onEdit={canEdit ? (t) => setEditingTx(t) : undefined}
          />
        </div>
      )}

      <TransactionEditDialog tx={editingTx} onClose={() => setEditingTx(null)} />
    </div>
  );
}

interface Groups {
  selfPaid: Transaction[];
  pendingReceive: Transaction[];
  settled: Transaction[];
  totalTWD: number;
  pendingTWD: number;
}

function groupPrepaid(items: Transaction[]): Groups {
  const selfPaid: Transaction[] = [];
  const pendingReceive: Transaction[] = [];
  const settled: Transaction[] = [];
  let totalTWD = 0;
  let pendingTWD = 0;
  for (const t of items) {
    totalTWD += t.amountTWD;
    if (t.splitMode === 'i-paid-others') {
      if (t.loanSettledAt) settled.push(t);
      else {
        pendingReceive.push(t);
        pendingTWD += reimburseDueTWD(t);
      }
    } else {
      selfPaid.push(t);
    }
  }
  return { selfPaid, pendingReceive, settled, totalTWD, pendingTWD };
}

function reimburseDueTWD(tx: Transaction): number {
  if (tx.myShareTWD == null) return tx.amountTWD;
  return Math.max(0, tx.amountTWD - tx.myShareTWD);
}

function SummaryStrip({ groups }: { groups: Groups }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Stat
        icon={Receipt}
        label="預付款總額"
        value={formatCurrency(groups.totalTWD)}
        sub={`${groups.selfPaid.length + groups.pendingReceive.length + groups.settled.length} 筆`}
        tone="default"
      />
      <Stat
        icon={AlertCircle}
        label="待收金額"
        value={formatCurrency(groups.pendingTWD)}
        sub={`${groups.pendingReceive.length} 筆`}
        tone="warning"
      />
      <Stat
        icon={ListChecks}
        label="已結清筆數"
        value={`${groups.settled.length}`}
        sub="筆"
        tone="success"
      />
    </div>
  );
}

function Stat({
  icon: Icon, label, value, sub, tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tone: 'default' | 'warning' | 'success';
}) {
  const toneCls = {
    default: 'text-foreground',
    warning: 'text-amber-500',
    success: 'text-emerald-500',
  }[tone];
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3 sm:p-4">
        <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-full bg-muted', toneCls)}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] text-muted-foreground">{label}</div>
          <div className={cn('truncate text-lg font-semibold tabular-nums', toneCls)}>{value}</div>
          {sub ? <div className="text-[11px] text-muted-foreground">{sub}</div> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ReimbursementByPerson({ items }: { items: Transaction[] }) {
  const byName = useMemo(() => {
    const map = new Map<string, { name: string; total: number; rows: Transaction[] }>();
    for (const t of items) {
      const key = (t.counterpartyName?.trim() || '未指定');
      const cur = map.get(key) ?? { name: key, total: 0, rows: [] };
      cur.total += reimburseDueTWD(t);
      cur.rows.push(t);
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [items]);

  if (byName.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4" /> 按對方統計（待收）
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {byName.map((g) => (
            <li key={g.name} className="flex items-start justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{g.name}</div>
                <div className="text-xs text-muted-foreground">
                  {g.rows.length} 筆 · {g.rows.map((r) => r.note ?? r.category).filter(Boolean).slice(0, 3).join('、')}
                  {g.rows.length > 3 ? '…' : ''}
                </div>
              </div>
              <div className="text-right text-sm font-semibold tabular-nums text-amber-500">
                {formatCurrency(g.total)}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function PrepaidGroup({
  title, icon: Icon, tone, items, catMap, actions, onEdit,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'success' | 'warning' | 'muted';
  items: Transaction[];
  catMap: Record<string, { name: string; color?: string }>;
  actions?: (t: Transaction) => React.ReactNode;
  onEdit?: (t: Transaction) => void;
}) {
  if (items.length === 0) return null;
  const total = items.reduce(
    (s, t) => s + (t.splitMode === 'i-paid-others' && !t.loanSettledAt ? reimburseDueTWD(t) : t.amountTWD),
    0,
  );
  const toneCls = {
    success: 'text-emerald-500',
    warning: 'text-amber-500',
    muted: 'text-muted-foreground',
  }[tone];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className={cn('flex items-center gap-2 text-base', toneCls)}>
          <Icon className="size-4" /> {title}
          <span className="text-xs font-normal text-muted-foreground">（{items.length}）</span>
        </CardTitle>
        <span className={cn('text-sm font-semibold tabular-nums', toneCls)}>
          {formatCurrency(total)}
        </span>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <ul className="divide-y">
          {items.map((t) => (
            <li key={t.id} className="flex items-start gap-2 px-4 py-2.5 text-sm">
              <button
                type="button"
                onClick={() => onEdit?.(t)}
                disabled={!onEdit}
                className="min-w-0 flex-1 text-left disabled:cursor-default"
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium truncate">{catMap[t.category]?.name ?? t.category}</span>
                  {t.splitMode === 'i-paid-others' && !t.loanSettledAt && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">
                      墊付 → {t.counterpartyName ?? '未指定'}
                    </span>
                  )}
                  {t.loanSettledAt && (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600">已結清</span>
                  )}
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <CalendarClock className="size-3" />
                  {formatTW(t.date, 'yyyy/MM/dd')}
                  {t.note ? ` · ${t.note}` : ''}
                </div>
                {t.splitMode === 'i-paid-others' && t.myShareTWD != null && (
                  <div className="text-[11px] text-muted-foreground">
                    我自付：{formatCurrency(t.myShareTWD)} · 待收：{formatCurrency(reimburseDueTWD(t))}
                  </div>
                )}
              </button>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <div className="text-sm font-semibold tabular-nums">
                  {formatCurrency(t.amountTWD)}
                </div>
                {t.currency !== 'TWD' && (
                  <div className="text-[11px] text-muted-foreground">
                    {t.amount.toLocaleString()} {t.currency}
                  </div>
                )}
                {actions ? actions(t) : null}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
