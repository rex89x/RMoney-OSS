import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { createTransaction, updateTransaction } from '@/features/ledger/api';
import { useCategories, useTransactions } from '@/features/ledger/hooks';
import type { Transaction } from '@/features/ledger/types';
import { startOfTWDay } from '@/lib/tz';
import { getIgnoredInvoices, ignoreInvoices } from './api';
import { matchInvoices, type InvoiceRow } from './match';
import { guessCategory } from './categorize';
import type { EInvoiceRecord } from './parser';
import { requireUid } from '@/lib/assert';

/** 比對範圍：近 120 天交易（發票匯出通常是近 1 到 2 個月） */
const MATCH_LOOKBACK_DAYS = 120;

export function useIgnoredInvoices() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['einvoice-ignored', user?.uid],
    queryFn: () => getIgnoredInvoices(requireUid(user)),
    enabled: Boolean(user?.uid),
    staleTime: 5 * 60 * 1000,
  });
}

export function useIgnoreInvoices() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (numbers: string[]) => {
      if (!user) throw new Error('Not logged in');
      return ignoreInvoices(user.uid, numbers);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['einvoice-ignored'] }),
    onError: (err) => {
      console.error('[ignoreInvoices]', err);
      toast.error(err instanceof Error ? err.message : '忽略失敗');
    },
  });
}

/** 把解析結果對上既有交易；回傳每列狀態與預設類別 */
export function useInvoiceRows(records: EInvoiceRecord[]): {
  rows: InvoiceRow[];
  defaultCategory: (r: EInvoiceRecord) => string;
  isLoading: boolean;
} {
  const start = useMemo(() => startOfTWDay(new Date(Date.now() - MATCH_LOOKBACK_DAYS * 86400000)), []);
  const { data: txs = [], isLoading } = useTransactions({ startDate: start, limit: 3000 }, { enabled: records.length > 0 });
  const { data: ignored = {} } = useIgnoredInvoices();
  const { data: categories = [] } = useCategories();
  const allowed = useMemo(
    () => new Set(categories.filter((c) => c.type === 'expense' && !c.archivedAt).map((c) => c.key)),
    [categories],
  );
  const rows = useMemo(() => matchInvoices(records, txs, ignored), [records, txs, ignored]);
  const defaultCategory = (r: EInvoiceRecord) => guessCategory(r.sellerName, r.items, allowed);
  return { rows, defaultCategory, isLoading: records.length > 0 && isLoading };
}

export interface ImportItem {
  record: EInvoiceRecord;
  category: string;
  paymentMethod: string;
  fromAccountId: string | null;
}

/** 建立交易（逐筆走 createTransaction，讓帳戶餘額調整與一般記帳一致） */
export function useImportInvoices() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (items: ImportItem[]) => {
      if (!user) throw new Error('Not logged in');
      let created = 0;
      const failed: string[] = [];
      for (const it of items) {
        try {
          await createTransaction({
            userId: user.uid,
            type: 'expense',
            amount: it.record.amount,
            currency: 'TWD',
            amountTWD: it.record.amount,
            fxRate: 1,
            category: it.category,
            paymentMethod: it.paymentMethod,
            fromAccountId: it.fromAccountId,
            toAccountId: null,
            note: it.record.sellerName || it.record.items[0] || '電子發票',
            date: it.record.date,
            tripId: null,
            invoiceNumber: it.record.invoiceNumber,
            lineItems: it.record.items.length > 1
              ? it.record.items.slice(0, 20).map((name, i) => ({ id: `inv-${i}`, name, amountTWD: 0 }))
              : undefined,
          });
          created += 1;
        } catch (err) {
          console.error('[importInvoice]', it.record.invoiceNumber, err);
          failed.push(it.record.invoiceNumber);
        }
      }
      return { created, failed };
    },
    onSuccess: ({ created, failed }) => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      if (failed.length) toast.warning(`已匯入 ${created} 筆，${failed.length} 筆失敗`);
      else toast.success(`已匯入 ${created} 筆發票`);
    },
    onError: (err) => {
      console.error('[importInvoices]', err);
      toast.error(err instanceof Error ? err.message : '匯入失敗');
    },
  });
}

/** 把發票號碼寫到既有交易（「這筆我已經記過了」） */
export function useLinkInvoices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (pairs: { tx: Transaction; invoiceNumber: string }[]) => {
      let n = 0;
      for (const p of pairs) {
        await updateTransaction(p.tx.id, { invoiceNumber: p.invoiceNumber });
        n += 1;
      }
      return n;
    },
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      toast.success(`已連結 ${n} 筆既有交易`);
    },
    onError: (err) => {
      console.error('[linkInvoices]', err);
      toast.error(err instanceof Error ? err.message : '連結失敗');
    },
  });
}
