import { useCallback, useMemo } from 'react';
import { DataTablePagination, DataTableToolbar, useDataTable, type FilterDef } from '@/components/data-table';
import { useCategories, useTransactions } from '@/features/ledger/hooks';
import { TransactionList, dayTotalsOf } from '@/features/ledger/components/transaction-list';
import { useExpenseBreakdown } from '@/features/ledger/use-my-share';
import type { Transaction } from '@/features/ledger/types';

/**
 * 出遊花費列表：搜尋 / 類別篩選 / 筆數分頁。
 * 直接丟 `<TransactionList filters={{ tripId }} />` 會把整趟的交易一次全部渲染出來，
 * 長天數的行程動輒上百筆。
 */
export function TripExpensesList({ tripId }: { tripId: string }) {
  const { data: txs = [], isLoading } = useTransactions({ tripId });
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c])), [categories]);

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
    { id: 'date', label: '日期', kind: 'dateRange' },
  ], [usedCategories]);

  const accessor = useCallback((tx: Transaction, id: string): unknown => {
    if (id === 'category') return tx.category;
    if (id === 'date') return tx.date;
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
    urlKey: 'tx',
  });
  const breakdown = useExpenseBreakdown();
  const dayTotals = useMemo(() => dayTotalsOf(table.filteredRows, breakdown), [table.filteredRows, breakdown]);

  return (
    <div className="space-y-3">
      <DataTableToolbar table={table} searchPlaceholder="搜尋備註 / 類別 / 付款方式…" />
      <TransactionList
        rows={table.rows}
        isLoading={isLoading}
        dayTotals={dayTotals}
        emptyHint={table.total > 0 ? '沒有符合條件的花費' : '在行程頁用 + 記一筆出遊花費'}
      />
      <DataTablePagination table={table} pageSizes={[10, 25, 50, 100]} />
    </div>
  );
}
