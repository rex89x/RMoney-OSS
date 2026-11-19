import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import {
  archiveCategory,
  bulkSettle,
  createRecurring,
  createTransaction,
  createTransactionId,
  deleteRecurring,
  getBudget,
  getLatestFxRate,
  hardDeleteTransaction,
  listCategories,
  listDeletedTransactions,
  listRecurring,
  listTransactions,
  listTransactionsWindow,
  restoreTransaction,
  softDeleteTransaction,
  updateRecurring,
  updateTransaction,
  upsertBudget,
  upsertCategory,
  type ListTxFilters,
  type TransactionPatch,
} from './api';
import { withSaveConfirmationTimeout } from './save-confirmation';
import { definedOnly, optimisticUpdate, patchById } from '@/lib/optimistic';
import type { Budget, Category, Recurring, Transaction, TransactionInput } from './types';
import type { Currency } from '@/types/global';
import { requireUid } from '@/lib/assert';
import { formatTWMonthKey, fromTW } from '@/lib/tz';
import {
  sliceTxWindow, txSliceKey, txWindowCoverageFloor, txWindowStartTW, TX_WINDOW_LIMIT,
} from './tx-window';

/** uid → 視窗實際涵蓋到多早（ms）。queryFn 在回傳資料前寫入，`select` 讀取時一定已是最新值 */
const windowCoverageFloor = new Map<string, number>();

/**
 * 我的交易查詢。日期區間落在「共用視窗」（近 12 個月 + 本月）內的查詢全部共用同一份快取、在前端切片，
 * 只有視窗答不了的（更早的區間、tripId、視窗被截斷）才各自打 Firestore。
 * 所以新的卡片直接 `useTransactions({ startDate, endDate, ... })` 就好，不會多一次讀取。
 */
export function useTransactions(
  filters: Omit<ListTxFilters, 'userId'>,
  options?: { enabled?: boolean },
): UseQueryResult<Transaction[]> {
  const { user } = useAuth();
  const uid = user?.uid;
  const enabled = Boolean(uid) && (options?.enabled ?? true);
  // 只在跨月時改變：query key 穩定
  const monthKey = formatTWMonthKey(new Date());
  const windowStart = useMemo(() => {
    const [y, m] = monthKey.split('-').map(Number) as [number, number];
    return fromTW(txWindowStartTW(new Date(y, m - 1, 1)));
  }, [monthKey]);
  const windowEligible = !filters.tripId;
  const sliceKey = txSliceKey(filters);

  const select = useMemo(
    () => (rows: Transaction[]): Transaction[] | null =>
      sliceTxWindow(rows, filters, windowStart, windowCoverageFloor.get(uid ?? '') ?? windowStart.getTime()),
    // filters 以 sliceKey 代表（呼叫端常傳 inline object，identity 每次 render 都不同）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sliceKey, windowStart, uid],
  );

  const windowQ = useQuery({
    queryKey: ['transactions', uid, 'window', monthKey],
    queryFn: async () => {
      const id = requireUid(user);
      const res = await listTransactionsWindow(id, windowStart, TX_WINDOW_LIMIT);
      windowCoverageFloor.set(id, txWindowCoverageFloor(windowStart, res.fetchedCount, res.oldest));
      return res.rows;
    },
    enabled: enabled && windowEligible,
    staleTime: 30 * 1000,
    select,
  });
  // 視窗有資料但答不了這個查詢（select 回 null）才退回獨立查詢
  const needDirect = !windowEligible || windowQ.data === null || windowQ.isError;
  const directQ = useQuery<Transaction[]>({
    queryKey: ['transactions', uid, filters],
    queryFn: () => listTransactions({ ...filters, userId: requireUid(user) }),
    enabled: enabled && needDirect,
    staleTime: 30 * 1000,
  });
  // needDirect 為 false 時 windowQ.data 不會是 null（undefined = 載入中 / 停用）
  return needDirect ? directQ : (windowQ as UseQueryResult<Transaction[]>);
}

/** `silentSuccess`：呼叫端自己顯示成功 toast（例如快速記帳要附預算資訊） */
export function useCreateTransaction(options?: { silentSuccess?: boolean }) {
  const qc = useQueryClient();
  const silentSuccess = options?.silentSuccess ?? false;
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ clientRequestId, ...input }: Omit<TransactionInput, 'userId'> & { clientRequestId?: string }) => {
      if (!user) throw new Error('Not logged in');
      const id = await withSaveConfirmationTimeout(
        createTransaction({ ...input, userId: user.uid }, clientRequestId ?? createTransactionId()),
      );
      // Audit is non-critical. Do not keep the form pending after the transaction
      // itself has already been confirmed by Firestore.
      void import('@/features/audit').then(({ writeAudit }) =>
        writeAudit({
          scope: 'transaction', action: 'create', entityId: id,
          summary: `${input.type === 'income' ? '+' : input.type === 'transfer' ? '↔' : '-'}${Math.round(input.amountTWD)} ${input.category}${input.note ? ' · ' + input.note : ''}`,
        }),
      ).catch((err: unknown) => console.warn('audit', err));
      return id;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      if (!silentSuccess) toast.success('已新增');
    },
    onError: (err) => {
      console.error('[createTransaction]', err);
      toast.error(err instanceof Error ? err.message : '新增失敗');
    },
  });
}

export function useUpdateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TransactionPatch }) =>
      withSaveConfirmationTimeout(updateTransaction(id, patch)),
    // 樂觀更新：清單上的那筆立刻換成新值（改類別 / 備註 / 金額不用等伺服器回應），失敗再還原
    onMutate: async ({ id, patch }) => {
      const rollback = await optimisticUpdate<Transaction[]>(qc, ['transactions'], (rows) =>
        patchById(rows, id, { ...(definedOnly(patch as Record<string, unknown>) as Partial<Transaction>), updatedAt: new Date() }));
      return { rollback };
    },
    onSuccess: () => {
      toast.success('已更新');
    },
    onError: (err, _vars, ctx) => {
      ctx?.rollback();
      console.error('[updateTransaction]', err);
      toast.error(err instanceof Error ? err.message : '更新失敗');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useBulkSettle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      txIds: string[];
      totalSettledTWD: number;
      settledAt: Date;
      txs: Array<{ id: string; amount: number; fxRate: number }>;
    }) => bulkSettle(params),
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      toast.success(`已結算 ${n} 筆`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '結算失敗'),
  });
}

export function useSoftDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    // 樂觀更新：先從清單拿掉，失敗再放回
    onMutate: async (id: string) => {
      const rollback = await optimisticUpdate<Transaction[]>(qc, ['transactions'], (rows) => rows.filter((r) => r.id !== id));
      return { rollback };
    },
    // 錯誤 toast 由呼叫端處理（各呼叫端都有 try/catch），這裡只還原 cache
    onError: (err, _id, ctx) => {
      ctx?.rollback();
      console.error('[softDeleteTransaction]', err);
    },
    mutationFn: async (id: string) => {
      await softDeleteTransaction(id);
      // audit log（lazy import 避免循環依賴）
      try {
        const { writeAudit } = await import('@/features/audit');
        await writeAudit({ scope: 'transaction', action: 'delete', entityId: id, summary: '軟刪除交易' });
      } catch (err) { console.warn('audit', err); }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['transactions-deleted'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useHardDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await hardDeleteTransaction(id);
      try {
        const { writeAudit } = await import('@/features/audit');
        await writeAudit({ scope: 'transaction', action: 'delete', entityId: id, summary: '永久刪除交易（trash）' });
      } catch (err) { console.warn('audit', err); }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['transactions-deleted'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useRestoreTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreTransaction(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['transactions-deleted'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('已復原');
    },
  });
}

export function useDeletedTransactions(days = 7) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['transactions-deleted', user?.uid, days],
    queryFn: () => listDeletedTransactions(requireUid(user), days),
    enabled: Boolean(user?.uid),
    staleTime: 30 * 1000,
  });
}

// ----- categories -----

export function useCategories() {
  return useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: listCategories,
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpsertCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: Omit<Category, 'id'>) => upsertCategory(c),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success('已儲存類別');
    },
  });
}

export function useArchiveCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveCategory(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success('已封存類別');
    },
  });
}

// ----- budget -----

export function useBudget(month: string) {
  const { user } = useAuth();
  return useQuery<Budget | null>({
    queryKey: ['budget', user?.uid, month],
    queryFn: () => getBudget(requireUid(user), month),
    enabled: Boolean(user?.uid),
  });
}

export function useUpsertBudget() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ budget, id }: { budget: Omit<Budget, 'id' | 'userId'>; id?: string }) => {
      if (!user) throw new Error('Not logged in');
      return upsertBudget({ ...budget, userId: user.uid }, id);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['budget'] });
      toast.success('已儲存預算');
    },
  });
}

// ----- recurring -----

export function useRecurring() {
  const { user } = useAuth();
  return useQuery<Recurring[]>({
    queryKey: ['recurring', user?.uid],
    queryFn: () => listRecurring(requireUid(user)),
    enabled: Boolean(user?.uid),
  });
}

export function useCreateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (r: Omit<Recurring, 'id'>) => createRecurring(r),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring'] });
      toast.success('已新增週期性交易');
    },
  });
}

export function useUpdateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Recurring> }) =>
      updateRecurring(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring'] });
    },
  });
}

export function useDeleteRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRecurring(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring'] });
    },
  });
}

// ----- FX -----

export function useFxRate(base: Currency) {
  return useQuery<number>({
    queryKey: ['fx', base],
    queryFn: () => getLatestFxRate(base),
    staleTime: 60 * 1000,
  });
}
