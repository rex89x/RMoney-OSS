import { formatTWDateInput } from '@/lib/tz';
import type { Transaction, TransactionInput } from './types';

/**
 * CSV 匯入去重（稽核 D5）。
 *
 * 比對鍵 = 台北日期 + 類型 + 金額（到分）+ 幣別 + 備註（去空白、小寫）。
 * 以「次數」比對而不是有無：既有 2 筆一樣的、CSV 有 3 筆 → 只匯入 1 筆。
 * 這樣同一份檔案重複匯入不會重複入帳，但同一天真的買了兩杯一樣的咖啡（CSV 本身就有兩列）也不會被吃掉。
 * 備註納入比對，避免手動記的「午餐 120」把 CSV 裡另一筆「便當 120」誤判成重複。
 */
export function importDedupeKey(
  tx: Pick<Transaction, 'date' | 'type' | 'amount' | 'currency'> & { note?: string | null },
): string {
  const amount = Math.round(Number(tx.amount) * 100) / 100;
  const note = String(tx.note ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [formatTWDateInput(tx.date), tx.type, amount.toFixed(2), tx.currency, note].join('|');
}

export interface DedupeResult {
  fresh: TransactionInput[];
  duplicates: TransactionInput[];
}

export function dedupeImportRows(
  rows: readonly TransactionInput[],
  existing: ReadonlyArray<Pick<Transaction, 'date' | 'type' | 'amount' | 'currency' | 'note' | 'deletedAt'>>,
): DedupeResult {
  const budget = new Map<string, number>();
  for (const tx of existing) {
    if (tx.deletedAt) continue;
    const key = importDedupeKey(tx);
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  const fresh: TransactionInput[] = [];
  const duplicates: TransactionInput[] = [];
  for (const row of rows) {
    const key = importDedupeKey(row);
    const left = budget.get(key) ?? 0;
    if (left > 0) {
      budget.set(key, left - 1);
      duplicates.push(row);
    } else {
      fresh.push({ ...row, importSourceHash: row.importSourceHash ?? `csv:${key}` });
    }
  }
  return { fresh, duplicates };
}
