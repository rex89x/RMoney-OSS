import { useCallback, useMemo } from 'react';
import { ArrowRight, HandCoins, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useConfirm } from '@/components/ui/confirm';
import { DataTablePagination, DataTableToolbar, useDataTable, type FilterDef } from '@/components/data-table';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useDeleteSettlement, useSettlements } from '../hooks';
import type { Household, Settlement } from '../types';
import { MemberChip } from './member-chip';

export function SettlementsList({ household }: { household: Household }) {
  const { user } = useAuth();
  const { data: settlements = [], isLoading } = useSettlements(household.id);
  const del = useDeleteSettlement();
  const confirm = useConfirm();

  const filters = useMemo<FilterDef[]>(() => [
    {
      id: 'fromUid',
      label: '付款人',
      kind: 'select',
      includeAll: true,
      options: household.memberIds.map((id) => ({
        value: id,
        label: household.members[id]?.displayName ?? id,
      })),
    },
    { id: 'date', label: '日期', kind: 'dateRange' },
  ], [household]);

  const accessor = useCallback((row: Settlement, id: string): unknown => {
    if (id === 'fromUid') return row.fromUid;
    if (id === 'date') return row.date;
    if (id === 'note') return row.note ?? '';
    return undefined;
  }, []);

  const table = useDataTable<Settlement>({
    data: settlements,
    accessor,
    searchFields: ['note'],
    filters,
    pageSize: 25,
    urlKey: 'st',
  });

  async function handleDelete(id: string, label: string) {
    const ok = await confirm({
      title: '刪除這筆結算？',
      description: `${label}。若當時有「同時記到帳本」，那筆交易不會自動刪除，請到記帳頁處理。`,
      confirmText: '刪除',
    });
    if (!ok) return;
    try {
      await del.mutateAsync({ householdId: household.id, id });
      toast.success('已刪除');
    } catch (err) {
      console.error('[deleteSettlement]', err);
    }
  }

  if (isLoading) return <Skeleton className="h-20" />;
  if (settlements.length === 0) {
    return <EmptyState icon={HandCoins} title="還沒有結算紀錄" description="到總覽按「結算」記錄一筆實際轉帳" />;
  }
  return (
    <div className="space-y-3">
    <DataTableToolbar table={table} searchPlaceholder="搜尋備註…" />
    {table.totalFiltered === 0 ? (
      <EmptyState icon={HandCoins} title="沒有符合的結算紀錄" description="換個篩選條件再看看" />
    ) : (
    <ul className="divide-y rounded-xl border">
      {table.rows.map((s) => {
        const label = `${household.members[s.fromUid]?.displayName ?? '?'} → ${household.members[s.toUid]?.displayName ?? '?'} ${formatCurrency(s.amountTWD, 'TWD')}`;
        return (
          <li key={s.id} className="flex items-center gap-3 p-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <MemberChip member={household.members[s.fromUid]} />
                <ArrowRight className="size-3.5 text-muted-foreground" />
                <MemberChip member={household.members[s.toUid]} />
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {formatTW(s.date, 'yyyy/MM/dd')}{s.note ? ` · ${s.note}` : ''}{s.linkedTxId ? ' · 已記帳' : ''}
              </div>
            </div>
            <div className="font-semibold tabular-nums">{formatCurrency(s.amountTWD, 'TWD')}</div>
            {s.createdBy === user?.uid ? (
              <Button size="icon-sm" variant="ghost" onClick={() => void handleDelete(s.id, label)} aria-label="刪除">
                <Trash2 className="size-4" />
              </Button>
            ) : <span className="w-8" />}
          </li>
        );
      })}
    </ul>
    )}
    <DataTablePagination table={table} pageSizes={[10, 25, 50, 100]} />
    </div>
  );
}
