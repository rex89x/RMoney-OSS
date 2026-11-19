import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, EyeOff, Lock, Pencil, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { DataTablePagination, DataTableToolbar, useDataTable, type FilterDef } from '@/components/data-table';
import { useAuth } from '@/hooks/use-auth';
import { cn, formatCurrency } from '@/lib/utils';
import { formatTW, nowTW } from '@/lib/tz';
import { resolveIcon } from '@/lib/icons';
import { useCategories } from '@/features/ledger/hooks';
import { effectiveAmountTWD, type Transaction } from '@/features/ledger/types';
import { TransactionEditDialog } from '@/features/ledger/components/transaction-edit-dialog';
import { useSharedLedgerMonth } from '../hooks';
import { canEditLedgerOf, ledgerSharersFor, type Household } from '../types';
import { MemberChip } from './member-chip';

/** 伴侶分享出來的個人支出。對方另外開了「可編輯」時，點任一筆可以直接修改。多人分享時上方可切換要看誰的。 */
export function SharedLedgerPanel({ household }: { household: Household }) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const sharers = useMemo(() => ledgerSharersFor(household, myUid), [household, myUid]);
  const [selected, setSelected] = useState<string | null>(null);
  const sharerUid = selected && sharers.includes(selected) ? selected : sharers[0] ?? null;
  const canEdit = canEditLedgerOf(household, myUid, sharerUid);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  const [ym, setYm] = useState(() => {
    const n = nowTW();
    return { y: n.getFullYear(), m: n.getMonth() + 1 };
  });
  const { txs, range, isLoading, error } = useSharedLedgerMonth(sharerUid, ym.y, ym.m);
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c])), [categories]);

  const total = useMemo(() => txs.reduce((sum, tx) => sum + effectiveAmountTWD(tx), 0), [txs]);
  const byCategory = useMemo(() => {
    const map = new Map<string, { totalTWD: number; count: number }>();
    for (const tx of txs) {
      const prev = map.get(tx.category) ?? { totalTWD: 0, count: 0 };
      map.set(tx.category, { totalTWD: prev.totalTWD + effectiveAmountTWD(tx), count: prev.count + 1 });
    }
    return Array.from(map.entries())
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.totalTWD - a.totalTWD);
  }, [txs]);
  const usedCategories = useMemo(() => {
    const keys = new Set(txs.map((tx) => tx.category));
    return categories.filter((c) => keys.has(c.key));
  }, [txs, categories]);

  const filters = useMemo<FilterDef[]>(() => [
    {
      id: 'category',
      label: '類別',
      kind: 'select',
      includeAll: true,
      options: usedCategories.map((c) => ({ value: c.key, label: c.name })),
    },
  ], [usedCategories]);

  const accessor = useCallback((tx: Transaction, id: string): unknown => {
    if (id === 'category') return tx.category;
    if (id === 'note') return tx.note ?? '';
    if (id === 'categoryName') return catMap[tx.category]?.name ?? tx.category;
    if (id === 'paymentMethod') return tx.paymentMethod ?? '';
    return undefined;
  }, [catMap]);

  const table = useDataTable<Transaction>({
    data: txs,
    accessor,
    searchFields: ['note', 'categoryName', 'paymentMethod'],
    filters,
    pageSize: 25,
    urlKey: 'pl',
  });

  const isCurrentMonth = (() => {
    const n = nowTW();
    return n.getFullYear() === ym.y && n.getMonth() + 1 === ym.m;
  })();

  function shift(delta: number) {
    const d = new Date(ym.y, ym.m - 1 + delta, 1);
    setYm({ y: d.getFullYear(), m: d.getMonth() + 1 });
  }

  if (!sharerUid) {
    return (
      <EmptyState
        icon={EyeOff}
        title="還沒有人分享個人支出給你"
        description="對方要在「共同 → 設定 → 成員與權限」打開「可以看我的個人支出明細」。"
      />
    );
  }

  if (error) {
    const denied = /permission|insufficient/i.test(error.message);
    return (
      <div className="space-y-2">
        <EmptyState
          icon={Lock}
          title="看不到這份支出明細"
          description={denied
            ? '對方可能已經取消分享，或剛開放還沒生效。請他到「共同 → 設定 → 成員與權限」確認開關是開的，必要時按「重新同步」。'
            : '讀取失敗，請稍後再試一次。'}
        />
        <p className="px-1 text-[11px] text-muted-foreground">錯誤訊息：{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sharers.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {sharers.map((uid) => (
            <MemberChip
              key={uid}
              member={household.members[uid]}
              active={uid === sharerUid}
              onClick={() => setSelected(uid)}
            />
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" onClick={() => shift(-1)} aria-label="上個月"><ChevronLeft className="size-4" /></Button>
          <span className="min-w-[7rem] text-center font-medium tabular-nums">{ym.y} / {String(ym.m).padStart(2, '0')}</span>
          <Button size="icon-sm" variant="ghost" onClick={() => shift(1)} disabled={isCurrentMonth} aria-label="下個月"><ChevronRight className="size-4" /></Button>
        </div>
        <span className="text-xs text-muted-foreground">{formatTW(range.start, 'M/d')} – {formatTW(range.end, 'M/d')}</span>
      </div>

      {isLoading ? <Skeleton className="h-40" /> : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Wallet className="size-4" />
                <MemberChip member={household.members[sharerUid]} className="text-base" /> 的個人支出
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="text-2xl font-semibold tabular-nums">{formatCurrency(total, 'TWD')}</div>
                <p className="text-xs text-muted-foreground">{txs.length} 筆 · 不含共同支出</p>
              </div>
              {byCategory.length === 0 ? (
                <p className="text-sm text-muted-foreground">這個月沒有個人支出</p>
              ) : (
                <ul className="space-y-1.5">
                  {byCategory.map((row) => {
                    const cat = catMap[row.key];
                    const Icon = resolveIcon(cat?.icon);
                    const pct = total > 0 ? (row.totalTWD / total) * 100 : 0;
                    return (
                      <li key={row.key} className="text-xs">
                        <div className="flex items-center justify-between">
                          <span className="inline-flex items-center gap-1.5">
                            <Icon className="size-3.5" style={{ color: cat?.color }} />
                            {cat?.name ?? row.key}
                            <span className="text-muted-foreground">· {row.count} 筆</span>
                          </span>
                          <span className="tabular-nums">
                            {formatCurrency(row.totalTWD, 'TWD')}
                            <span className="ml-1 text-muted-foreground">({Math.round(pct)}%)</span>
                          </span>
                        </div>
                        <Progress value={pct} className="mt-0.5 h-1" />
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">明細</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <DataTableToolbar table={table} searchPlaceholder="搜尋備註 / 類別 / 付款方式…" />
              {table.totalFiltered === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">這個月沒有符合的個人支出</p>
              ) : (
                <ul className="divide-y rounded-xl border">
                  {table.rows.map((tx) => {
                    const cat = catMap[tx.category];
                    const Icon = resolveIcon(cat?.icon);
                    const body = (
                      <>
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                          <Icon className="size-4" style={{ color: cat?.color }} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {cat?.name ?? tx.category}
                            {tx.note ? <span className="ml-1 text-xs font-normal text-muted-foreground">· {tx.note}</span> : null}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {formatTW(tx.date, 'M/d (EEE)')} · {tx.paymentMethod || '—'}
                            {tx.tripId ? ' · 出遊' : ''}
                            {tx.splitMode && tx.splitMode !== 'self' ? ' · 代墊' : ''}
                          </div>
                        </div>
                        <span className={cn('shrink-0 font-semibold tabular-nums')}>
                          {formatCurrency(effectiveAmountTWD(tx), 'TWD')}
                        </span>
                        {canEdit ? <Pencil className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
                      </>
                    );
                    return (
                      <li key={tx.id}>
                        {canEdit ? (
                          <button
                            type="button"
                            onClick={() => setEditingTx(tx)}
                            className="flex w-full items-center gap-3 p-2.5 text-left text-sm transition-colors hover:bg-muted/50"
                            aria-label={`編輯 ${cat?.name ?? tx.category}`}
                          >
                            {body}
                          </button>
                        ) : (
                          <div className="flex items-center gap-3 p-2.5 text-sm">{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <DataTablePagination table={table} pageSizes={[10, 25, 50, 100]} />
            </CardContent>
          </Card>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        {canEdit
          ? '對方已開放你編輯：點任一筆可以改金額 / 類別 / 備註 / 日期、標成共同分攤或刪除；帳戶與支付方式維持對方原本的設定。'
          : '唯讀。'}
        只看得到對方的個人「支出」，收入、帳戶餘額、投資與淨值都不會分享。共同支出請看「交易」分頁。
      </p>

      {canEdit ? <TransactionEditDialog tx={editingTx} onClose={() => setEditingTx(null)} /> : null}
    </div>
  );
}
