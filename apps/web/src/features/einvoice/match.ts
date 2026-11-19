import type { Transaction } from '@/features/ledger/types';
import { effectiveAmountTWD } from '@/features/ledger/types';
import { formatTWDateInput } from '@/lib/tz';
import type { EInvoiceRecord } from './parser';

export type InvoiceRowStatus =
  | 'new'        // 沒有對應交易 → 可匯入
  | 'linked'     // 已有交易帶同一個發票號碼
  | 'likely'     // 同日同金額的既有交易，可能已手動記過 → 建議連結
  | 'void'       // 作廢
  | 'ignored';   // 使用者曾按忽略

export interface InvoiceRow {
  record: EInvoiceRecord;
  status: InvoiceRowStatus;
  /** likely / linked 時對應的交易 */
  matchTx?: Transaction;
}

export function matchInvoices(
  records: EInvoiceRecord[],
  txs: Transaction[],
  ignored: Record<string, string>,
): InvoiceRow[] {
  const byInvoice = new Map<string, Transaction>();
  const byDayAmount = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (t.deletedAt) continue;
    if (t.invoiceNumber) byInvoice.set(t.invoiceNumber.toUpperCase(), t);
    if (t.type !== 'expense') continue;
    const key = `${formatTWDateInput(t.date)}|${Math.round(effectiveAmountTWD(t))}`;
    const arr = byDayAmount.get(key) ?? [];
    arr.push(t);
    byDayAmount.set(key, arr);
  }
  return records.map((record) => {
    if (record.status === 'void') return { record, status: 'void' };
    const linked = byInvoice.get(record.invoiceNumber);
    if (linked) return { record, status: 'linked', matchTx: linked };
    if (ignored[record.invoiceNumber]) return { record, status: 'ignored' };
    const candidates = byDayAmount.get(`${record.dateKey}|${Math.round(record.amount)}`) ?? [];
    const free = candidates.find((t) => !t.invoiceNumber);
    if (free) return { record, status: 'likely', matchTx: free };
    return { record, status: 'new' };
  });
}
