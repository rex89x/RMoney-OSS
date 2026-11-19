import { useCallback, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Pencil, PiggyBank, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { useConfirm } from '@/components/ui/confirm';
import { DataTablePagination, DataTableToolbar, useDataTable, type FilterDef } from '@/components/data-table';
import { useAuth } from '@/hooks/use-auth';
import { cn, formatCurrency } from '@/lib/utils';
import { formatTW, monthTWRange, nowTW } from '@/lib/tz';
import { resolveIcon } from '@/lib/icons';
import { useCategories, useSoftDeleteTransaction } from '@/features/ledger/hooks';
import { effectiveAmountTWD, type Transaction } from '@/features/ledger/types';
import { ShareEditDialog } from '@/features/ledger/components/share-edit-dialog';
import { useDeleteHouseholdFundEntry, useHouseholdFundSummary } from '../hooks';
import { HOUSEHOLD_FUND_COLOR, memberColor } from '../entries';
import { memberCan, type Household, type HouseholdFundEntry } from '../types';
import { MemberChip } from './member-chip';
import { HouseholdFundEntryDialog } from './household-fund-entry-dialog';
import { HouseholdFundTransfersCard } from './household-fund-transfers-card';
import { HouseholdFundPlanCard } from './household-fund-plan-card';
import { HouseholdTxDetailDialog } from './household-tx-detail-dialog';
import { HouseholdEntryDialog } from './household-entry-dialog';

type FundDirection = 'in' | 'out';

interface FundRow {
  key: string;
  id: string;
  direction: FundDirection;
  date: Date;
  amountTWD: number;
  /** 這筆之後的累計「帳上可用」餘額 */
  balanceAfter: number;
  /** 撥還給先墊的成員：不影響帳上可用，只標示現金轉出 */
  reimbursement: boolean;
  memberUid: string | null;
  categoryKey: string | null;
  note: string | null;
  createdBy: string | null;
  entry?: HouseholdFundEntry;
  tx?: Transaction;
}

/**
 * 公基金獨立分頁：餘額、誰存了多少、以及「存入 ↔ 公基金支付的共同支出」完整流水帳。
 * 之前這些只擠在總覽的一張小卡裡，看不到支出也看不到歷史。
 */
export function HouseholdFundPanel({ household }: { household: Household }) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const { summary, entries, fundExpenses, isLoading } = useHouseholdFundSummary(household);
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c])), [categories]);
  const deleteEntry = useDeleteHouseholdFundEntry();
  const confirm = useConfirm();
  const [entryOpen, setEntryOpen] = useState(false);
  /** 修改中的公基金存入 */
  const [editingEntry, setEditingEntry] = useState<HouseholdFundEntry | null>(null);
  /** 公基金支出：明細 → 編輯（金額、類別、改回個人付款…）或只改分攤 */
  const [detail, setDetail] = useState<Transaction | null>(null);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [splitTx, setSplitTx] = useState<Transaction | null>(null);
  const [deletingTxId, setDeletingTxId] = useState<string | null>(null);
  const softDelete = useSoftDeleteTransaction();

  const monthRange = useMemo(() => {
    const now = nowTW();
    return monthTWRange(now.getFullYear(), now.getMonth() + 1);
  }, []);

  const rows = useMemo<FundRow[]>(() => {
    const merged = [
      ...entries.map((entry) => ({
        key: `entry:${entry.id}`,
        id: entry.id,
        reimbursement: entry.type === 'reimbursement',
        direction: (entry.type === 'reimbursement' || entry.amountTWD < 0 ? 'out' : 'in') as FundDirection,
        date: entry.date,
        amountTWD: Math.abs(entry.amountTWD),
        memberUid: entry.contributorUid,
        categoryKey: null,
        note: entry.note,
        createdBy: entry.createdBy,
        entry,
      })),
      ...fundExpenses.map((tx) => ({
        key: `tx:${tx.id}`,
        id: tx.id,
        reimbursement: false,
        direction: 'out' as FundDirection,
        date: tx.date,
        amountTWD: effectiveAmountTWD(tx),
        memberUid: null,
        categoryKey: tx.category,
        note: tx.note ?? null,
        createdBy: tx.userId,
        tx,
      })),
    ].sort((a, b) => a.date.getTime() - b.date.getTime());

    let running = 0;
    const withBalance = merged.map((row) => {
      if (!row.reimbursement) running += row.direction === 'in' ? row.amountTWD : -row.amountTWD;
      return { ...row, balanceAfter: running };
    });
    return withBalance.reverse();
  }, [entries, fundExpenses]);

  const monthSpend = useMemo(
    () => fundExpenses
      .filter((tx) => tx.date >= monthRange.start && tx.date <= monthRange.end)
      .reduce((total, tx) => total + effectiveAmountTWD(tx), 0),
    [fundExpenses, monthRange],
  );

  const usedCategories = useMemo(() => {
    const keys = new Set(rows.map((row) => row.categoryKey).filter((k): k is string => Boolean(k)));
    return categories.filter((c) => keys.has(c.key));
  }, [rows, categories]);

  const filters = useMemo<FilterDef[]>(() => [
    {
      id: 'direction',
      label: '方向',
      kind: 'select',
      includeAll: true,
      options: [{ value: 'in', label: '存入' }, { value: 'out', label: '支出' }],
    },
    {
      id: 'member',
      label: '存入者',
      kind: 'select',
      includeAll: true,
      options: household.memberIds.map((id) => ({
        value: id,
        label: `${household.members[id]?.displayName ?? id}${id === myUid ? '（我）' : ''}`,
      })),
    },
    {
      id: 'category',
      label: '支出類別',
      kind: 'select',
      includeAll: true,
      options: usedCategories.map((c) => ({ value: c.key, label: c.name })),
    },
  ], [household, myUid, usedCategories]);

  const accessor = useCallback((row: FundRow, id: string): unknown => {
    if (id === 'direction') return row.direction;
    if (id === 'member') return row.memberUid ?? '';
    if (id === 'category') return row.categoryKey ?? '';
    if (id === 'note') return row.note ?? '';
    if (id === 'categoryName') return row.categoryKey ? catMap[row.categoryKey]?.name ?? row.categoryKey : '';
    return undefined;
  }, [catMap]);

  const table = useDataTable<FundRow>({
    data: rows,
    accessor,
    searchFields: ['note', 'categoryName'],
    filters,
    pageSize: 25,
    urlKey: 'fund',
  });

  const canContribute = memberCan(household, myUid, 'canAddExpense');
  const contributionTotal = summary.contributionsTWD || 1;

  async function handleDelete(entry: HouseholdFundEntry) {
    const accepted = await confirm({
      title: '刪除這筆公基金存入？',
      description: `${formatTW(entry.date, 'yyyy/MM/dd')} · ${formatCurrency(entry.amountTWD)}`,
      confirmText: '刪除',
    });
    if (!accepted) return;
    try {
      await deleteEntry.mutateAsync({ householdId: household.id, id: entry.id });
      toast.success('已刪除');
    } catch (error) {
      console.error('[deleteHouseholdFundEntry]', error);
    }
  }

  async function handleDeleteExpense(tx: Transaction) {
    const accepted = await confirm({
      title: '刪除這筆公基金支出？',
      description: `${catMap[tx.category]?.name ?? tx.category} ${formatCurrency(effectiveAmountTWD(tx))}${tx.note ? ` · ${tx.note}` : ''}；金額會加回公基金餘額`,
      confirmText: '刪除',
    });
    if (!accepted) return;
    setDeletingTxId(tx.id);
    try {
      await softDelete.mutateAsync(tx.id);
      toast.success('已刪除，金額已回到公基金');
      setDetail(null);
    } catch (error) {
      console.error('[deleteFundExpense]', error);
      toast.error(error instanceof Error ? error.message : '刪除失敗');
    } finally {
      setDeletingTxId(null);
    }
  }

  if (isLoading) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>;

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatTile
          label="帳上可用"
          value={formatCurrency(summary.balanceTWD)}
          tone={summary.balanceTWD < 0 ? 'bad' : 'plain'}
          hint={summary.outstandingTWD > 0 ? `實際現金 ${formatCurrency(summary.cashTWD)}（含待撥還 ${formatCurrency(summary.outstandingTWD)}）` : '已扣掉所有公基金負擔的支出'}
        />
        <StatTile label="累計存入" value={formatCurrency(summary.contributionsTWD)} tone="good" hint={`${entries.length} 筆`} />
        <StatTile label="已支付共同支出" value={formatCurrency(summary.expensesTWD)} hint={`${fundExpenses.length} 筆`} />
        <StatTile
          label="本月從公基金支出"
          value={formatCurrency(monthSpend)}
          hint={`${formatTW(monthRange.start, 'M/d')} – ${formatTW(monthRange.end, 'M/d')}`}
        />
      </StatGrid>

      <HouseholdFundTransfersCard household={household} />

      <HouseholdFundPlanCard household={household} onOpenTx={setDetail} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <PiggyBank className="size-4" style={{ color: HOUSEHOLD_FUND_COLOR }} /> 誰存了多少
          </CardTitle>
          <Button size="sm" onClick={() => setEntryOpen(true)} disabled={!canContribute}>
            <Plus className="size-4" /> 存入
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {household.memberIds.map((id) => {
            const amount = summary.byContributor[id] ?? 0;
            const pct = (amount / contributionTotal) * 100;
            return (
              <div key={id}>
                <div className="flex items-center justify-between text-xs">
                  <MemberChip member={household.members[id]} suffix={id === myUid ? '（我）' : ''} className="text-xs" />
                  <span className="tabular-nums">
                    {formatCurrency(amount)}
                    <span className="ml-1 text-muted-foreground">({Math.round(pct)}%)</span>
                  </span>
                </div>
                <Progress
                  value={pct}
                  className="mt-1 h-1.5"
                  indicatorStyle={{ backgroundColor: memberColor(household, id) }}
                />
              </div>
            );
          })}
          <p className="pt-1 text-[11px] text-muted-foreground">
            存入只增加共同餘額，不會自動扣個人帳戶；公基金支付的共同支出不列入成員之間的「誰欠誰」，但仍計入共同月預算。
          </p>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <DataTableToolbar table={table} searchPlaceholder="搜尋備註或類別…" />
        {table.totalFiltered === 0 ? (
          <EmptyState icon={PiggyBank} title="沒有符合的紀錄" description="換個篩選條件，或先按「存入」建立第一筆公基金" />
        ) : (
          <ul className="divide-y rounded-xl border">
            {table.rows.map((row) => {
              const category = row.categoryKey ? catMap[row.categoryKey] : undefined;
              const Icon = row.categoryKey
                ? resolveIcon(category?.icon)
                : row.direction === 'in' ? ArrowDownLeft : ArrowUpRight;
              const canManageEntry = Boolean(row.entry)
                && (row.createdBy === myUid || household.ownerId === myUid);
              const canOpen = Boolean(row.tx) || canManageEntry;
              return (
                <li key={row.key} className="flex items-center gap-1 pr-2 text-sm">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
                    disabled={!canOpen}
                    onClick={() => {
                      if (row.tx) setDetail(row.tx);
                      else if (row.entry && canManageEntry) setEditingEntry(row.entry);
                    }}
                    aria-label={row.tx ? '查看或修改公基金支出' : '修改公基金存入'}
                  >
                  <span className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-full',
                    row.direction === 'in' ? 'bg-success/10 text-success' : 'bg-muted',
                  )}>
                    <Icon className="size-4" style={row.categoryKey ? { color: category?.color } : undefined} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {row.categoryKey
                        ? (category?.name ?? row.categoryKey)
                        : row.reimbursement
                          ? `撥還給 ${household.members[row.memberUid ?? '']?.displayName ?? '成員'}`
                          : `${household.members[row.memberUid ?? '']?.displayName ?? '成員'} 存入`}
                      {row.note ? <span className="ml-1 text-xs font-normal text-muted-foreground">· {row.note}</span> : null}
                    </div>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {formatTW(row.date, 'yyyy/MM/dd')}
                      {row.tx?.fundAdvancedBy ? ` · ${household.members[row.tx.fundAdvancedBy]?.displayName ?? '成員'}先墊` : ''}
                      {row.reimbursement ? ' · 現金轉出，帳上可用不變' : ` · 餘額 ${formatCurrency(row.balanceAfter)}`}
                    </div>
                  </div>
                  <span className={cn('shrink-0 font-semibold tabular-nums', row.direction === 'in' && 'text-success', row.reimbursement && 'text-muted-foreground')}>
                    {row.direction === 'in' ? '+' : '−'}{formatCurrency(row.amountTWD)}
                  </span>
                  {row.tx ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" /> : canManageEntry ? <Pencil className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                  </button>
                  {canManageEntry && row.entry ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="刪除公基金紀錄"
                      onClick={() => void handleDelete(row.entry as HouseholdFundEntry)}
                      disabled={deleteEntry.isPending}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : <span className="w-8 shrink-0" />}
                </li>
              );
            })}
          </ul>
        )}
        <DataTablePagination table={table} pageSizes={[10, 25, 50, 100]} />
      </div>

      <HouseholdFundEntryDialog household={household} open={entryOpen} onOpenChange={setEntryOpen} />
      <HouseholdFundEntryDialog
        household={household}
        open={Boolean(editingEntry)}
        onOpenChange={(next) => { if (!next) setEditingEntry(null); }}
        entry={editingEntry}
      />
      <HouseholdTxDetailDialog
        household={household}
        tx={detail}
        open={Boolean(detail)}
        onOpenChange={(next) => { if (!next) setDetail(null); }}
        onEdit={(tx) => { setDetail(null); setEditingTx(tx); }}
        onEditSplit={(tx) => { setDetail(null); setSplitTx(tx); }}
        onDelete={(tx) => void handleDeleteExpense(tx)}
        deleting={deletingTxId === detail?.id}
      />
      <ShareEditDialog tx={splitTx} onClose={() => setSplitTx(null)} />
      <HouseholdEntryDialog
        household={household}
        open={Boolean(editingTx)}
        onOpenChange={(next) => { if (!next) setEditingTx(null); }}
        tx={editingTx}
      />
    </div>
  );
}
