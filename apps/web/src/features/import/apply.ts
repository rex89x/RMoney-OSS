import { createTransaction, getTransaction } from '@/features/ledger/api';
import { executePortfolioTrade } from '@/features/investments/api';
import type { ImportRow, ResolvedLedger, ResolvedTrade } from './normalize';

export type ImportOutcome = 'created' | 'skipped' | 'failed';

export interface ImportResult {
  key: string;
  outcome: ImportOutcome;
  message?: string;
}

/**
 * 逐筆寫入。
 * - 記帳：用 row.key 當 doc id（內容 hash），同一筆重貼第二次會被 createTransaction 的冪等檢查略過；
 *   這裡先 getTransaction 看存不存在，才回報「已存在略過」而不是假裝新增。
 * - 股票：executePortfolioTrade（同一個 runTransaction 更新持倉 + 交割帳戶餘額）。沒有冪等 id，
 *   所以 UI 會提醒不要重複匯入同一批成交。
 */
export async function applyImportRows(
  rows: ImportRow[],
  userId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  const selected = rows.filter((r) => r.selected && r.status !== 'error');
  let done = 0;
  for (const row of selected) {
    try {
      if (row.resolved.kind === 'trade') {
        results.push(await applyTrade(row.key, row.resolved, userId));
      } else {
        results.push(await applyLedger(row.key, row.resolved, userId, row.item.id));
      }
    } catch (err) {
      console.error('[applyImportRow]', row.key, err);
      results.push({ key: row.key, outcome: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
    done += 1;
    onProgress?.(done, selected.length);
  }
  return results;
}

async function applyLedger(key: string, r: ResolvedLedger, userId: string, sourceId: string | undefined): Promise<ImportResult> {
  const existing = await getTransaction(key);
  if (existing) return { key, outcome: 'skipped', message: '已匯入過（相同內容）' };
  await createTransaction({
    userId,
    type: r.kind,
    amount: r.amount,
    currency: r.currency,
    amountTWD: r.amountTWD,
    fxRate: r.fxRate,
    category: r.categoryKey,
    paymentMethod: r.paymentMethod,
    fromAccountId: r.kind === 'expense' ? r.accountId : null,
    toAccountId: r.kind === 'income' ? r.accountId : null,
    note: r.note || undefined,
    date: r.date,
    tags: ['ai-import', ...r.tags].slice(0, 10),
    importSourceId: sourceId ? `ai:${sourceId}` : key,
  }, key, Boolean(r.accountId));
  return { key, outcome: 'created' };
}

async function applyTrade(key: string, r: ResolvedTrade, userId: string): Promise<ImportResult> {
  if (!r.accountId) return { key, outcome: 'failed', message: '沒有交割帳戶' };
  await executePortfolioTrade({
    userId,
    side: r.side,
    symbol: r.symbol,
    shares: r.shares,
    price: r.price,
    currency: r.currency,
    fxRate: r.fxRate,
    accountId: r.accountId,
    existingPositionId: r.existingPositionId ?? undefined,
    market: r.market,
    date: r.date,
    fee: r.fee,
    note: r.note || undefined,
  });
  return { key, outcome: 'created' };
}
