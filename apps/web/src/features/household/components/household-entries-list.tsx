import { useCallback, useMemo, useState } from 'react';
import { ArrowRight, ChevronRight, HandCoins, PiggyBank, Receipt, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useConfirm } from '@/components/ui/confirm';
import { DataTablePagination, DataTableToolbar, useDataTable, type FilterDef } from '@/components/data-table';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency, cn } from '@/lib/utils';
import { addTWCalendarMonths, formatTW, nowTW, startOfTWDay } from '@/lib/tz';
import { resolveIcon } from '@/lib/icons';
import { useCategories, useSoftDeleteTransaction } from '@/features/ledger/hooks';
import type { Transaction } from '@/features/ledger/types';
import { HOUSEHOLD_LEDGER_MONTHS, useDeleteHouseholdFundEntry, useHouseholdLedger } from '../hooks';
import {
  buildHouseholdEntries, entryPayerColor, HOUSEHOLD_ENTRY_LABEL,
  type HouseholdEntryKind, type HouseholdEntryRow,
} from '../entries';
import { HOUSEHOLD_FUND_PAYER_ID, type Household, type HouseholdFundEntry } from '../types';
import { MemberChip } from './member-chip';
import { HouseholdEntryDialog } from './household-entry-dialog';
import { HouseholdTxDetailDialog } from './household-tx-detail-dialog';
import { HouseholdFundEntryDialog } from './household-fund-entry-dialog';
import { ShareEditDialog } from '@/features/ledger/components/share-edit-dialog';

const RANGE_OPTIONS = [
  { months: 1, label: '近 1 個月' },
  { months: 3, label: '近 3 個月' },
  { months: 6, label: '近 6 個月' },
  { months: HOUSEHOLD_LEDGER_MONTHS, label: `近 ${HOUSEHOLD_LEDGER_MONTHS} 個月` },
] as const;

const KIND_ICON: Record<HouseholdEntryKind, typeof Receipt> = {
  expense: Receipt,
  contribution: PiggyBank,
  reimbursement: Undo2,
  settlement: HandCoins,
};

/**
 * 共同帳本的完整時間軸：共同支出 + 公基金存入 + 結算轉帳。
 * 搜尋 / 篩選 / 分頁都走 useDataTable，資料量大也不會一次吐幾百列。
 */
export function HouseholdEntriesList({ household }: { household: Household }) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const { txs, fundEntries, settlements, isLoading } = useHouseholdLedger(household);
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c])), [categories]);
  const softDelete = useSoftDeleteTransaction();
  const deleteFundEntry = useDeleteHouseholdFundEntry();
  const confirm = useConfirm();

  const [months, setMonths] = useState<number>(6);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [splitTx, setSplitTx] = useState<Transaction | null>(null);
  const [detail, setDetail] = useState<Transaction | null>(null);
  const [editingEntry, setEditingEntry] = useState<HouseholdFundEntry | null>(null);

  const since = useMemo(() => startOfTWDay(addTWCalendarMonths(nowTW(), -months)), [months]);
  const rows = useMemo(
    () => buildHouseholdEntries({ household, myUid, txs, fundEntries, settlements })
      .filter((row) => row.date >= since),
    [household, myUid, txs, fundEntries, settlements, since],
  );

  const usedCategoryKeys = useMemo(() => {
    const keys = new Set(rows.map((row) => row.categoryKey).filter((k): k is string => Boolean(k)));
    return categories.filter((c) => keys.has(c.key));
  }, [rows, categories]);

  const filters = useMemo<FilterDef[]>(() => [
    {
      id: 'kind',
      label: '類型',
      kind: 'select',
      includeAll: true,
      options: (Object.keys(HOUSEHOLD_ENTRY_LABEL) as HouseholdEntryKind[])
        .map((k) => ({ value: k, label: HOUSEHOLD_ENTRY_LABEL[k] })),
    },
    {
      id: 'from',
      label: '誰',
      kind: 'select',
      includeAll: true,
      options: [
        ...household.memberIds.map((id) => ({
          value: id,
          label: `${household.members[id]?.displayName ?? id}${id === myUid ? '（我）' : ''}`,
        })),
        { value: HOUSEHOLD_FUND_PAYER_ID, label: '公基金' },
      ],
    },
    {
      id: 'category',
      label: '類別',
      kind: 'select',
      includeAll: true,
      options: usedCategoryKeys.map((c) => ({ value: c.key, label: c.name })),
    },
  ], [household, myUid, usedCategoryKeys]);

  const accessor = useCallback((row: HouseholdEntryRow, id: string): unknown => {
    if (id === 'kind') return row.kind;
    if (id === 'from') return row.fromUid ?? '';
    if (id === 'category') return row.categoryKey ?? '';
    if (id === 'note') return row.note ?? '';
    if (id === 'categoryName') return row.categoryKey ? catMap[row.categoryKey]?.name ?? row.categoryKey : '';
    if (id === 'date') return row.date;
    return undefined;
  }, [catMap]);

  const table = useDataTable<HouseholdEntryRow>({
    data: rows,
    accessor,
    searchFields: ['note', 'categoryName'],
    filters,
    pageSize: 25,
    urlKey: 'hh',
  });

  /** 時間範圍內的合計（不隨搜尋 / 篩選變動，所以標示成「此範圍」避免誤讀） */
  const rangeTotals = useMemo(() => {
    let expense = 0;
    let contribution = 0;
    let myShare = 0;
    for (const row of rows) {
      if (row.kind === 'expense') { expense += row.amountTWD; myShare += row.myShareTWD; }
      if (row.kind === 'contribution') contribution += row.amountTWD;
    }
    return { expense, contribution, myShare };
  }, [rows]);

  async function handleDeleteExpense(tx: Transaction) {
    const ok = await confirm({
      title: '刪除這筆共同支出？',
      description: `${catMap[tx.category]?.name ?? tx.category} ${formatCurrency(tx.amountTWD, 'TWD')}${tx.note ? ` · ${tx.note}` : ''}`,
      confirmText: '刪除',
    });
    if (!ok) return;
    setDeletingId(tx.id);
    try {
      await softDelete.mutateAsync(tx.id);
      toast.success('已刪除');
      setDetail(null);
    } catch (err) {
      console.error('[householdTxDelete]', err);
      toast.error(err instanceof Error ? err.message : '刪除失敗');
    } finally {
      setDeletingId(null);
    }
  }

  async function handleDeleteContribution(row: HouseholdEntryRow) {
    const ok = await confirm({
      title: row.kind === 'reimbursement' ? '刪除這筆公基金撥還？' : '刪除這筆公基金存入？',
      description: `${formatTW(row.date, 'yyyy/MM/dd')} · ${formatCurrency(row.amountTWD)}`,
      confirmText: '刪除',
    });
    if (!ok) return;
    try {
      await deleteFundEntry.mutateAsync({ householdId: household.id, id: row.id });
      toast.success('已刪除');
    } catch (err) {
      console.error('[householdFundEntryDelete]', err);
    }
  }

  if (isLoading) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option.months}
            type="button"
            onClick={() => { setMonths(option.months); table.setPage(1); }}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              months === option.months ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-xl border p-3 text-center">
        <div>
          <p className="text-[11px] text-muted-foreground">此範圍共同支出</p>
          <p className="text-base font-semibold tabular-nums">{formatCurrency(rangeTotals.expense, 'TWD')}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">我這份</p>
          <p className="text-base font-semibold tabular-nums">{formatCurrency(rangeTotals.myShare, 'TWD')}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">公基金存入</p>
          <p className="text-base font-semibold tabular-nums text-success">{formatCurrency(rangeTotals.contribution, 'TWD')}</p>
        </div>
      </div>

      <DataTableToolbar table={table} searchPlaceholder="搜尋備註或類別…" />

      {table.totalFiltered === 0 ? (
        <EmptyState
          icon={Receipt}
          title="這個範圍沒有紀錄"
          description="換個時間範圍或清除篩選；也可以用「新增共同支出」開始記"
        />
      ) : (
        <ul className="divide-y rounded-xl border">
          {table.rows.map((row) => (
            <EntryRow
              key={row.key}
              row={row}
              household={household}
              myUid={myUid}
              categoryName={row.categoryKey ? catMap[row.categoryKey]?.name ?? row.categoryKey : null}
              categoryIcon={row.categoryKey ? catMap[row.categoryKey]?.icon : undefined}
              categoryColor={row.categoryKey ? catMap[row.categoryKey]?.color : undefined}
              onOpenExpense={(tx) => setDetail(tx)}
              onDeleteContribution={() => void handleDeleteContribution(row)}
              onEditContribution={() => { if (row.fundEntry) setEditingEntry(row.fundEntry); }}
              busy={deletingId === row.id}
            />
          ))}
        </ul>
      )}

      <DataTablePagination table={table} pageSizes={[10, 25, 50, 100]} />

      <HouseholdTxDetailDialog
        household={household}
        tx={detail}
        open={Boolean(detail)}
        onOpenChange={(o) => { if (!o) setDetail(null); }}
        onEdit={(tx) => { setDetail(null); setEditing(tx); }}
        onEditSplit={(tx) => { setDetail(null); setSplitTx(tx); }}
        onDelete={(tx) => void handleDeleteExpense(tx)}
        deleting={deletingId === detail?.id}
      />
      <ShareEditDialog tx={splitTx} onClose={() => setSplitTx(null)} />
      <HouseholdFundEntryDialog
        household={household}
        open={Boolean(editingEntry)}
        onOpenChange={(next) => { if (!next) setEditingEntry(null); }}
        entry={editingEntry}
      />
      <HouseholdEntryDialog
        household={household}
        open={Boolean(editing)}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        tx={editing}
      />
    </div>
  );
}

interface EntryRowProps {
  row: HouseholdEntryRow;
  household: Household;
  myUid: string;
  categoryName: string | null;
  categoryIcon?: string | undefined;
  categoryColor?: string | undefined;
  onOpenExpense: (tx: Transaction) => void;
  onDeleteContribution: () => void;
  onEditContribution: () => void;
  busy: boolean;
}

function EntryRow({
  row, household, myUid, categoryName, categoryIcon, categoryColor, onOpenExpense, onDeleteContribution, onEditContribution, busy,
}: EntryRowProps) {
  const Icon = row.kind === 'expense' ? resolveIcon(categoryIcon) : KIND_ICON[row.kind];
  const fundPaid = row.fromUid === HOUSEHOLD_FUND_PAYER_ID;
  const tint = entryPayerColor(household, row.fromUid);

  const title = row.kind === 'expense'
    ? (categoryName ?? '共同支出')
    : row.kind === 'contribution'
      ? `${household.members[row.fromUid ?? '']?.displayName ?? '成員'} 存入公基金`
      : row.kind === 'reimbursement'
        ? `公基金撥還給 ${household.members[row.toUid ?? '']?.displayName ?? '成員'}`
        : '結算轉帳';

  const body = (
    <>
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: `${tint}1a` }}
      >
        <Icon className="size-4" style={{ color: row.kind === 'expense' ? categoryColor ?? tint : tint }} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate font-medium">
          {title}
          {row.note ? <span className="truncate text-xs font-normal text-muted-foreground">· {row.note}</span> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="tabular-nums">{formatTW(row.date, 'M/d (EEE)')}</span>
          {row.kind === 'expense' ? (
            fundPaid
              ? (
                <span className="inline-flex items-center gap-1">
                  <PiggyBank className="size-3.5" /> 公基金負擔
                  {row.tx?.fundAdvancedBy ? ` · ${household.members[row.tx.fundAdvancedBy]?.displayName ?? '成員'}先墊` : ''}
                </span>
              )
              : household.memberIds.includes(row.fromUid ?? '')
                ? <><MemberChip member={household.members[row.fromUid ?? '']} className="text-xs" /><span>付</span></>
                : <span>旅伴付</span>
          ) : null}
          {row.kind === 'expense' && row.tx?.tripId ? (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">出遊</Badge>
          ) : null}
          {row.kind === 'settlement' ? (
            <span className="inline-flex items-center gap-1">
              <MemberChip member={household.members[row.fromUid ?? '']} className="text-xs" />
              <ArrowRight className="size-3" />
              <MemberChip member={household.members[row.toUid ?? '']} className="text-xs" />
            </span>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={cn(
          'font-semibold tabular-nums',
          row.kind === 'contribution' && 'text-success',
        )}>
          {row.kind === 'contribution' ? '+' : ''}{formatCurrency(row.amountTWD, 'TWD')}
        </div>
        <div className="text-[11px] tabular-nums text-muted-foreground">
          {row.kind === 'expense'
            ? (fundPaid ? '不分攤' : `我這份 ${formatCurrency(row.myShareTWD, 'TWD')}`)
            : HOUSEHOLD_ENTRY_LABEL[row.kind]}
        </div>
      </div>
    </>
  );

  if (row.kind === 'expense' && row.tx) {
    const tx = row.tx;
    return (
      <li>
        <button
          type="button"
          onClick={() => onOpenExpense(tx)}
          className="flex w-full items-center gap-3 p-3 text-left text-sm transition-colors hover:bg-muted/50"
        >
          {body}
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </li>
    );
  }

  const canDelete = (row.kind === 'contribution' || row.kind === 'reimbursement')
    && (row.createdBy === myUid || household.ownerId === myUid);

  return (
    <li className="flex items-center gap-3 p-3 text-sm">
      {body}
      {canDelete ? (
        <div className="flex shrink-0 gap-0.5">
          <Button size="sm" variant="ghost" onClick={onEditContribution} disabled={busy || !row.fundEntry}>修改</Button>
          <Button size="sm" variant="ghost" onClick={onDeleteContribution} disabled={busy}>刪除</Button>
        </div>
      ) : <span className="w-4 shrink-0" />}
    </li>
  );
}
