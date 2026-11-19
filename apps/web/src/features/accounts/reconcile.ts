/**
 * 帳戶對帳：輸入實際餘額，差額自動建一筆「對帳調整」交易，並在帳戶標記 lastReconciledAt。
 *
 * - 差額 > 0（實際比帳面多）→ income / adjustment_income，toAccountId = 帳戶
 * - 差額 < 0（實際比帳面少）→ expense / adjustment，fromAccountId = 帳戶
 * - 信用卡 / 貸款是負債：balance 代表欠款；實際欠款比帳面多 → 視為支出（多花了沒記）
 * - 差額 0 → 只更新 lastReconciledAt
 * 交易走 createTransaction，帳戶餘額由既有的 account adjustment 機制同步。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { createTransaction, upsertCategory } from '@/features/ledger/api';
import type { Category } from '@/features/ledger/types';
import { DEFAULT_CATEGORIES } from '@/lib/seed-data';
import { updateAccount } from './api';
import type { Account } from './types';

export const ADJUSTMENT_EXPENSE_CATEGORY = 'adjustment';
export const ADJUSTMENT_INCOME_CATEGORY = 'adjustment_income';

const DEBT_TYPES: Account['type'][] = ['credit_card', 'loan'];

export interface ReconcileInput {
  account: Account;
  /** 實際餘額（原幣）；負債帳戶填實際欠款（正數） */
  actualBalance: number;
  /** 對帳日期 */
  date: Date;
  /** 原幣 → TWD 匯率 */
  fxRate: number;
  /** 既有類別 keys，用來判斷要不要補 seed */
  existingCategoryKeys: string[];
  note?: string;
}

export interface ReconcileResult {
  deltaNative: number;
  transactionId: string | null;
}

async function ensureAdjustmentCategories(existing: string[]): Promise<void> {
  const missing = DEFAULT_CATEGORIES.filter(
    (c) => (c.key === ADJUSTMENT_EXPENSE_CATEGORY || c.key === ADJUSTMENT_INCOME_CATEGORY) && !existing.includes(c.key),
  );
  for (const c of missing) {
    const cat: Omit<Category, 'id'> = { key: c.key, name: c.name, type: c.type, icon: c.icon, color: c.color, order: c.order };
    await upsertCategory(cat);
  }
}

export async function reconcileAccount(uid: string, input: ReconcileInput): Promise<ReconcileResult> {
  const { account, actualBalance, date, fxRate, existingCategoryKeys, note } = input;
  const isDebt = DEBT_TYPES.includes(account.type);
  // 負債：balance 是欠款；欠款變多 = 支出
  const bookNative = account.balance;
  const deltaNative = Math.round((actualBalance - bookNative) * 100) / 100;
  let transactionId: string | null = null;

  if (Math.abs(deltaNative) >= 0.01) {
    await ensureAdjustmentCategories(existingCategoryKeys);
    const moneyIn = isDebt ? deltaNative < 0 : deltaNative > 0;
    const amount = Math.abs(deltaNative);
    const amountTWD = Math.round(amount * fxRate * 100) / 100;
    const label = `對帳調整（帳面 ${bookNative.toLocaleString()} → 實際 ${actualBalance.toLocaleString()} ${account.currency}）`;
    transactionId = await createTransaction({
      userId: uid,
      type: moneyIn ? 'income' : 'expense',
      amount,
      currency: account.currency,
      amountTWD,
      fxRate,
      category: moneyIn ? ADJUSTMENT_INCOME_CATEGORY : ADJUSTMENT_EXPENSE_CATEGORY,
      paymentMethod: account.legacyPaymentMethod ?? account.name,
      fromAccountId: moneyIn ? null : account.id,
      toAccountId: moneyIn ? account.id : null,
      note: note?.trim() ? `${label} · ${note.trim()}` : label,
      date,
      tripId: null,
    });
  }

  await updateAccount(account.id, { lastReconciledAt: date });
  return { deltaNative, transactionId };
}

export function useReconcileAccount() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (input: ReconcileInput) => {
      if (!user) throw new Error('Not logged in');
      return reconcileAccount(user.uid, input);
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['categories'] });
      if (res.transactionId) toast.success(`已對帳，建立調整 ${res.deltaNative > 0 ? '+' : ''}${res.deltaNative.toLocaleString()}`);
      else toast.success('已對帳，餘額相符');
    },
    onError: (err) => {
      console.error('[reconcileAccount]', err);
      toast.error(err instanceof Error ? err.message : '對帳失敗');
    },
  });
}
