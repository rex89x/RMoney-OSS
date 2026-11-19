import { createTransaction, getTransaction } from './api';
import type { TransactionInput } from './types';
import { importedTransactionId, verifyTransferItem, type PasteTransferItem } from './paste-transfer-format';

export { parsePasteTransfer, verifyTransferItem } from './paste-transfer-format';
export type { PasteTransfer, PasteTransferItem } from './paste-transfer-format';

export interface PasteReceiptItem {
  sourceId: string;
  sourceHash: string;
  txId: string;
  targetKind: 'trip' | 'general';
  status: 'created' | 'already-imported';
}

function sameImportDecisions(existing: NonNullable<Awaited<ReturnType<typeof getTransaction>>>, input: TransactionInput): boolean {
  return existing.userId === input.userId && existing.type === 'expense' &&
    existing.amount === input.amount && existing.currency === input.currency &&
    existing.amountTWD === input.amountTWD && existing.category === input.category &&
    (existing.note ?? '') === (input.note ?? '') &&
    existing.paymentMethod === input.paymentMethod && existing.date.getTime() === input.date.getTime() &&
    existing.fromAccountId === input.fromAccountId && existing.tripId === input.tripId &&
    existing.householdId === (input.householdId ?? null) &&
    existing.scope === (input.scope ?? null) && existing.myShareTWD === (input.myShareTWD ?? null) &&
    existing.payerId === (input.payerId ?? null) && existing.shareType === (input.shareType ?? null) &&
    existing.paidByUid === (input.paidByUid ?? null) &&
    (existing.splitMode ?? null) === (input.splitMode ?? null) &&
    (existing.counterpartyName ?? null) === (input.counterpartyName ?? null) &&
    JSON.stringify(existing.customShares ?? []) === JSON.stringify(input.customShares ?? []);
}

/** 建立與帳戶調整由 createTransaction 的 Firestore transaction 一起提交。 */
export async function importPasteExpense(
  item: PasteTransferItem,
  input: TransactionInput,
): Promise<PasteReceiptItem> {
  await verifyTransferItem(item);
  // 自己付款一定要扣實際帳戶；對方先付的（共同帳本或代墊）沒有 owner 的帳戶可扣。
  const partnerPaid = Boolean(input.householdId && input.paidByUid && input.paidByUid !== input.userId) ||
    input.splitMode === 'they-paid-mine';
  if (!input.fromAccountId && !partnerPaid) throw new Error('貼上匯入必須選擇實際付款帳戶。');
  if (input.fromAccountId && partnerPaid) throw new Error('對方先付的費用不能扣你的帳戶。');
  const txId = await importedTransactionId(item.sourceId);
  const existing = await getTransaction(txId);
  if (existing) {
    if (existing.importSourceId !== item.sourceId || existing.importSourceHash !== item.sourceHash || existing.deletedAt || !sameImportDecisions(existing, input)) {
      throw new Error(`「${item.note}」與既有交易衝突，請人工檢查。`);
    }
    return { sourceId: item.sourceId, sourceHash: item.sourceHash, txId, targetKind: item.target.kind, status: 'already-imported' };
  }
  await createTransaction({
    ...input,
    importSourceId: item.sourceId,
    importSourceHash: item.sourceHash,
  }, txId, true);
  const committed = await getTransaction(txId);
  if (!committed || committed.importSourceId !== item.sourceId || committed.importSourceHash !== item.sourceHash || committed.deletedAt || !sameImportDecisions(committed, input)) {
    throw new Error(`「${item.note}」入帳結果無法確認，請先查 RMoney 交易再重試。`);
  }
  return { sourceId: item.sourceId, sourceHash: item.sourceHash, txId, targetKind: item.target.kind, status: 'created' };
}
