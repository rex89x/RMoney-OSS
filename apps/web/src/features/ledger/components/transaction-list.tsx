import { useMemo, useState } from 'react';
import { Paperclip, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Timestamp } from 'firebase/firestore';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { resolveIcon } from '@/lib/icons';
import { formatCurrency, cn } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { db } from '@/lib/firebase';
import { doc, updateDoc } from 'firebase/firestore';
import { useQueryClient } from '@tanstack/react-query';
import { useQuickEntryStore } from '@/stores/quick-entry-store';
import { useConfirm } from '@/components/ui/confirm';
import { useSwipeToDelete } from '@/hooks/use-swipe-to-delete';
import {
  useCategories, useSoftDeleteTransaction, useTransactions,
} from '../hooks';
import { useExpenseBreakdown, type ExpenseBreakdown } from '../use-my-share';
import type { ListTxFilters } from '../api';
import { TransactionEditDialog } from './transaction-edit-dialog';
import { ShareEditDialog } from './share-edit-dialog';
import { canFullEditTx } from '../split-context';
import { useAuth } from '@/hooks/use-auth';
import { useHousehold } from '@/features/household/hooks';
import { HOUSEHOLD_FUND_PAYER_ID, isSettled, type Transaction } from '../types';

type Filters = Omit<ListTxFilters, 'userId'>;

const WEEKDAY_ZH = ['一', '二', '三', '四', '五', '六', '日'];

export interface DayTotal {
  /** 我負擔的支出合計 */
  expense: number;
  income: number;
  count: number;
}

/** 依台北日期（yyyy-MM-dd）彙總「我負擔」支出 / 收入；給列表日期標頭用 */
export function dayTotalsOf(
  rows: readonly Transaction[],
  breakdown: (tx: Transaction) => ExpenseBreakdown,
): Map<string, DayTotal> {
  const map = new Map<string, DayTotal>();
  for (const t of rows) {
    const k = formatTW(t.date, 'yyyy-MM-dd');
    const cur = map.get(k) ?? { expense: 0, income: 0, count: 0 };
    if (t.type === 'expense') cur.expense += breakdown(t).shareTWD;
    else if (t.type === 'income') cur.income += t.amountTWD;
    cur.count += 1;
    map.set(k, cur);
  }
  return map;
}

function dayLabel(key: string, todayKey: string, yesterdayKey: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAY_ZH[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
  const base = `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}（${weekday}）`;
  if (key === todayKey) return `今天 · ${base}`;
  if (key === yesterdayKey) return `昨天 · ${base}`;
  return key.slice(0, 4) === todayKey.slice(0, 4) ? base : `${y}/${base}`;
}

/**
 * 顯示傳入的 transaction list（已經過篩選/分頁）。
 * 若沒傳 `rows`，則自己透過 hook 抓 + 顯示全部。
 */
export function TransactionList({
  filters,
  rows,
  isLoading: loadingProp,
  emptyHint = '點右下角 + 按鈕快速新增',
  dayTotals: dayTotalsProp,
}: {
  filters?: Filters;
  rows?: Transaction[];
  isLoading?: boolean;
  emptyHint?: string;
  /** 全部篩選結果（不只當頁）的每日小計；沒給就用當頁資料算 */
  dayTotals?: Map<string, DayTotal>;
}) {
  const queryEnabled = rows === undefined;
  const { data: fetched = [], isLoading: loadingQuery } = useTransactions(
    filters ?? {},
    { enabled: queryEnabled },
  );
  const txs = rows ?? fetched;
  const isLoading = loadingProp ?? (queryEnabled ? loadingQuery : false);

  const { data: categories = [] } = useCategories();
  const softDelete = useSoftDeleteTransaction();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [shareTx, setShareTx] = useState<Transaction | null>(null);
  const breakdown = useExpenseBreakdown();
  const { user } = useAuth();
  const { household } = useHousehold();
  const myUid = user?.uid ?? '';

  /** 自己的 / 對方開放可編輯 → 完整編輯；別人的旅程 / 共同支出 → 只能改分攤 */
  function openTx(tx: Transaction) {
    if (canFullEditTx(tx, myUid, household)) setEditingTx(tx);
    else if (tx.type === 'expense' && (tx.tripId || tx.householdId)) setShareTx(tx);
  }

  async function handleSoftDelete(tx: Transaction) {
    const cat = categories.find((c) => c.key === tx.category);
    const ok = await confirm({
      title: '刪除這筆交易？',
      description: `${cat?.name ?? tx.category} ${tx.type === 'income' ? '+' : '-'}${Math.round(tx.amountTWD)} TWD${tx.note ? ` · ${tx.note}` : ''}`,
      confirmText: '刪除',
    });
    if (!ok) return;
    await softDelete.mutateAsync(tx.id);
    toast.success('已刪除', {
      action: {
        label: '復原',
        onClick: async () => {
          try {
            await updateDoc(doc(db, 'transactions', tx.id), {
              deletedAt: null,
              updatedAt: Timestamp.fromDate(new Date()),
            });
            void qc.invalidateQueries({ queryKey: ['transactions'] });
            toast.success('已復原');
          } catch (err) {
            toast.error(err instanceof Error ? err.message : '復原失敗');
          }
        },
      },
    });
  }

  const catMap = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.key, c])),
    [categories],
  );

  // 依台北日期分組（CLAUDE.md §11：列表預設 group by TW 日期）
  const groups = useMemo(() => {
    const out: Array<{ key: string; rows: Transaction[] }> = [];
    for (const tx of txs) {
      const key = formatTW(tx.date, 'yyyy-MM-dd');
      const last = out[out.length - 1];
      if (last && last.key === key) last.rows.push(tx);
      else out.push({ key, rows: [tx] });
    }
    return out;
  }, [txs]);
  const dayTotals = useMemo(
    () => dayTotalsProp ?? dayTotalsOf(txs, breakdown),
    [dayTotalsProp, txs, breakdown],
  );
  const now = new Date();
  const todayKey = formatTW(now, 'yyyy-MM-dd');
  const yesterdayKey = formatTW(new Date(now.getTime() - 86400000), 'yyyy-MM-dd');

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (txs.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="尚無交易紀錄"
        description={emptyHint}
        action={
          <button
            type="button"
            onClick={() => useQuickEntryStore.getState().openDialog('expense')}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            快速新增第一筆
          </button>
        }
      />
    );
  }

  return (
    <>
      <div className="space-y-3">
        {groups.map((g) => {
          const total = dayTotals.get(g.key);
          return (
            <section key={g.key}>
              <div className="mb-1 flex items-baseline justify-between gap-2 px-1 text-xs">
                <span className="font-medium text-muted-foreground">{dayLabel(g.key, todayKey, yesterdayKey)}</span>
                {total ? (
                  <span className="flex gap-2 tabular-nums text-muted-foreground">
                    {total.expense > 0 ? <span>支出 {formatCurrency(total.expense)}</span> : null}
                    {total.income > 0 ? <span className="text-success">收入 {formatCurrency(total.income)}</span> : null}
                  </span>
                ) : null}
              </div>
              <ul className="space-y-1.5">
                {g.rows.map((tx) => (
                  <TxRow
                    key={tx.id}
                    tx={tx}
                    category={catMap[tx.category]}
                    breakdown={breakdown(tx)}
                    onEdit={() => openTx(tx)}
                    onDelete={() => void handleSoftDelete(tx)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <TransactionEditDialog tx={editingTx} onClose={() => setEditingTx(null)} />
      <ShareEditDialog tx={shareTx} onClose={() => setShareTx(null)} />
    </>
  );
}

interface Category {
  color?: string;
  icon?: string;
  name?: string;
}

function TxRow({
  tx,
  category,
  breakdown,
  onEdit,
  onDelete,
}: {
  tx: Transaction;
  category: Category | undefined;
  breakdown: ExpenseBreakdown;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const Icon = resolveIcon(category?.icon);
  const color = category?.color ?? '#6B7280';
  const swipe = useSwipeToDelete({ onDelete, maxOffset: -80 });
  const swipeX = swipe.offset;

  return (
    <li className="group relative overflow-hidden rounded-xl">
      {/* Red delete background revealed by swipe (mobile) */}
      <div
        className={cn(
          'absolute inset-0 flex items-center justify-end bg-destructive px-4 transition-opacity',
          swipeX < -10 ? 'opacity-100' : 'opacity-0',
        )}
      >
        <Trash2 className="size-5 text-destructive-foreground" />
      </div>

      {/* Desktop hover delete button — top-right of card */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        aria-label="刪除"
        className="absolute right-2 top-2 z-10 hidden rounded-md bg-background/90 p-1 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-destructive group-hover:opacity-100 lg:block"
      >
        <Trash2 className="size-4" />
      </button>

      <button
        type="button"
        onClick={swipe.guardClick(onEdit)}
        {...swipe.handlers}
        className={cn(
          'relative flex w-full touch-pan-y flex-col gap-1 border bg-card p-3 text-left text-sm active:bg-muted/50',
          // 手指拖曳中不要套 transition，不然列會跟不上手指；放開時才彈回
          swipeX === 0 && 'transition-transform',
        )}
        style={{ transform: `translateX(${swipeX}px)` }}
      >
        {/* 分攤明細獨立一行全寬顯示，不跟備註搶寬度（手機上備註才不會被擠成「c...」） */}
        <div className="flex w-full items-center gap-3">
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-full"
            style={{ backgroundColor: color + '20', color }}
          >
            <Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{category?.name ?? tx.category}</span>
              {tx.tripId ? <Badge variant="secondary" className="shrink-0">出遊</Badge> : null}
              {tx.lineItems && tx.lineItems.length > 0 ? <Badge variant="outline" className="shrink-0">{tx.lineItems.length} 項</Badge> : null}
              {tx.recurringId ? <Badge variant="outline" className="shrink-0">週期</Badge> : null}
              {tx.attachments && tx.attachments.length > 0 ? (
                <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground" title={`${tx.attachments.length} 個附件`}>
                  <Paperclip className="size-3" aria-hidden />
                  {tx.attachments.length}
                </span>
              ) : null}
              {(tx.tags ?? []).slice(0, 3).map((tag) => (
                <Badge key={tag} variant="outline" className="shrink-0 font-normal">#{tag}</Badge>
              ))}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {formatTW(tx.date, 'HH:mm')} · {tx.paymentMethod}
              {tx.note ? ` · ${tx.note}` : ''}
            </div>
          </div>
          <div className="shrink-0 text-right">
            {(() => {
              // 有分攤的支出：主數字 = 我負擔（我實際花的），整筆 / 墊付 / 待收待付縮成小字
              const primary = tx.type === 'expense' && breakdown.split ? breakdown.shareTWD : breakdown.totalTWD;
              return (
                <div
                  className={cn(
                    'font-semibold tabular-nums',
                    tx.type === 'income' && 'text-success',
                  )}
                >
                  {tx.type === 'expense' ? '-' : '+'}
                  {formatCurrency(primary, 'TWD')}
                </div>
              );
            })()}
            <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
              {tx.currency !== 'TWD' ? (
                <span title={`當時匯率 ${tx.currency}/TWD = ${tx.fxRate.toFixed(4)}${tx.settledFxRate ? ` · 結算 ${tx.settledFxRate.toFixed(4)}` : ''}`}>
                  {tx.amount} {tx.currency}
                </span>
              ) : null}
              {isSettled(tx) ? (
                <Badge variant="success" className="h-4 text-[9px]">已結算</Badge>
              ) : tx.currency !== 'TWD' ? (
                <Badge variant="outline" className="h-4 text-[9px]">估算</Badge>
              ) : null}
              {tx.splitMode === 'i-paid-others' ? (
                <Badge variant="secondary" className="h-4 text-[9px]">代墊</Badge>
              ) : tx.splitMode === 'they-paid-mine' ? (
                <Badge variant="outline" className="h-4 text-[9px]">借款</Badge>
              ) : tx.householdId ? (
                <Badge variant="secondary" className="h-4 text-[9px]">共同</Badge>
              ) : null}
            </div>
          </div>
        </div>
        {tx.type === 'expense' && breakdown.split ? (
          <div className="w-full pl-[3.25rem] text-right text-[10px] text-muted-foreground tabular-nums">
            整筆 {formatCurrency(breakdown.totalTWD, 'TWD')}
            {tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID
              ? ' · 公基金付'
              : breakdown.paidTWD > 0 ? ` · 我墊付 ${formatCurrency(breakdown.paidTWD, 'TWD')}` : ' · 對方付'}
            {tx.loanSettledAt
              ? ' · 已結清'
              : breakdown.netTWD > 0.5
                ? ` · 待收 ${formatCurrency(breakdown.netTWD, 'TWD')}`
                : breakdown.netTWD < -0.5
                  ? ` · 待付 ${formatCurrency(-breakdown.netTWD, 'TWD')}`
                  : ''}
          </div>
        ) : null}
      </button>
    </li>
  );
}
