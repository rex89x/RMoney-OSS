import { useEffect, useMemo, useState } from 'react';
import { Loader2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { formatTW } from '@/lib/tz';
import { formatCurrency, cn } from '@/lib/utils';
import { useCategories, useTransactions, useUpdateTransaction } from '@/features/ledger/hooks';
import type { Transaction } from '@/features/ledger/types';
import type { Trip } from '../types';

interface Props {
  trip: Trip;
  trigger: React.ReactNode;
}

export function TripTxPicker({ trip, trigger }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <TripTxPickerDialog trip={trip} open={open} onOpenChange={setOpen} />
    </>
  );
}

function TripTxPickerDialog({
  trip, open, onOpenChange,
}: { trip: Trip; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { user } = useAuth();
  const update = useUpdateTransaction();
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.key, c])),
    [categories],
  );

  const filters = useMemo(
    () => ({
      startDate: trip.startDate,
      endDate: trip.endDate,
      type: 'expense' as const,
      limit: 200,
    }),
    [trip.startDate, trip.endDate],
  );

  const { data: txs = [], isLoading } = useTransactions(filters, { enabled: open && Boolean(user?.uid) });

  const candidates = useMemo(
    () => txs.filter((t) => !t.tripId || t.tripId === trip.id),
    [txs, trip.id],
  );

  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    if (!open) return;
    // 預先勾選已歸到此 trip 的，方便辨識「移除」
    setPicked(new Set(candidates.filter((t) => t.tripId === trip.id).map((t) => t.id)));
    setKeyword('');
  }, [open, candidates, trip.id]);

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return candidates;
    return candidates.filter((t) => {
      const cat = catMap[t.category]?.name ?? t.category;
      return (
        t.note?.toLowerCase().includes(k) ||
        cat.toLowerCase().includes(k) ||
        t.paymentMethod?.toLowerCase().includes(k)
      );
    });
  }, [candidates, keyword, catMap]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  async function handleConfirm() {
    const initial = new Set(candidates.filter((t) => t.tripId === trip.id).map((t) => t.id));
    const toAttach: string[] = [];
    const toDetach: string[] = [];
    candidates.forEach((t) => {
      const wasIn = initial.has(t.id);
      const nowIn = picked.has(t.id);
      if (!wasIn && nowIn) toAttach.push(t.id);
      if (wasIn && !nowIn) toDetach.push(t.id);
    });
    if (toAttach.length === 0 && toDetach.length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      // 歸納時若 trip 有成員，預設套用「均分」；移除時清空 share 設定
      const hasMembers = (trip.members ?? []).length > 0;
      await Promise.all([
        ...toAttach.map((id) => update.mutateAsync({
          id,
          patch: hasMembers
            ? { tripId: trip.id, shareType: 'equal', payerId: null, customShares: undefined }
            : { tripId: trip.id },
        })),
        ...toDetach.map((id) => update.mutateAsync({
          id,
          patch: { tripId: null, shareType: null, payerId: null, customShares: undefined },
        })),
      ]);
      const parts: string[] = [];
      if (toAttach.length) parts.push(`歸入 ${toAttach.length} 筆${hasMembers ? '（預設均分）' : ''}`);
      if (toDetach.length) parts.push(`移除 ${toDetach.length} 筆`);
      toast.success(parts.join('，'));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失敗');
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="歸納其它消費到這趟旅程"
      description={`篩選條件：日期落在 ${formatTW(trip.startDate, 'yyyy/MM/dd')} – ${formatTW(trip.endDate, 'yyyy/MM/dd')}、類型為支出、自己的紀錄。已勾選的代表已歸入本旅程。`}
      contentClassName="sm:max-w-2xl"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            目前選了 {picked.size} 筆
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button onClick={() => void handleConfirm()} disabled={update.isPending}>
              {update.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              套用變更
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜尋備註 / 類別 / 付款方式"
        />
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-md" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            <Wallet className="mx-auto mb-2 size-5" />
            此區間沒有符合條件的支出。新增旅遊花費時可在 Quick Entry 直接帶 tripId。
          </div>
        ) : (
          <ul className="max-h-[55dvh] divide-y overflow-y-auto rounded-md border">
            {filtered.map((t) => (
              <PickerRow
                key={t.id}
                tx={t}
                checked={picked.has(t.id)}
                onToggle={() => toggle(t.id)}
                tripId={trip.id}
                categoryName={catMap[t.category]?.name ?? t.category}
              />
            ))}
          </ul>
        )}
      </div>
    </ResponsiveDialog>
  );
}

function PickerRow({
  tx, checked, onToggle, tripId, categoryName,
}: {
  tx: Transaction;
  checked: boolean;
  onToggle: () => void;
  tripId: string;
  categoryName: string;
}) {
  const inThisTrip = tx.tripId === tripId;
  const inOtherTrip = tx.tripId && tx.tripId !== tripId;
  return (
    <li
      className={cn(
        'flex items-start gap-3 p-3 cursor-pointer hover:bg-muted/40',
        checked && 'bg-primary/5',
      )}
      onClick={onToggle}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        className="mt-1 size-4 cursor-pointer accent-primary"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{categoryName}</span>
          {inThisTrip && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600">已在本旅程</span>}
          {inOtherTrip && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">屬另一旅程</span>}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatTW(tx.date, 'yyyy/MM/dd')} · {tx.paymentMethod ?? '—'}
          {tx.note ? ` · ${tx.note}` : ''}
        </div>
      </div>
      <div className="text-right text-sm tabular-nums">
        <div className="font-medium">−{formatCurrency(tx.amountTWD)}</div>
        {tx.currency !== 'TWD' && (
          <div className="text-[11px] text-muted-foreground">
            {tx.amount.toLocaleString()} {tx.currency}
          </div>
        )}
      </div>
    </li>
  );
}
