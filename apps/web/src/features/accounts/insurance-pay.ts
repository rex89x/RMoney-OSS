/**
 * 保單「已繳保費」：
 *   1. 確保 `insurance` 類別存在（不存在就從 DEFAULT_CATEGORIES 補上，同 reconcile.ts 的做法）
 *   2. 走既有 createTransaction 建一筆 expense（fromAccountId = 扣款帳戶），帳戶餘額由 account adjustment 同步
 *   3. nextPremiumDate 依繳費頻率往後推（addTWCalendarMonths，月底 clamp）
 *
 * 交易 id 用「保單 id + 本期繳費日」決定：createTransaction 對同一個 id 是冪等的，
 * 第 3 步失敗後重按也不會重複扣款。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { createTransaction, upsertCategory } from '@/features/ledger/api';
import type { Category } from '@/features/ledger/types';
import { DEFAULT_CATEGORIES } from '@/lib/seed-data';
import { formatTW } from '@/lib/tz';
import { updateAccount } from './api';
import { advancePremiumDate } from './insurance';
import type { Account } from './types';

export const INSURANCE_CATEGORY = 'insurance';

export interface PayInsurancePremiumInput {
  account: Account;
  sourceAccount: Account;
  amountTWD: number;
  date: Date;
  existingCategoryKeys: string[];
}

async function ensureInsuranceCategory(existing: string[]): Promise<void> {
  if (existing.includes(INSURANCE_CATEGORY)) return;
  const seed = DEFAULT_CATEGORIES.find((c) => c.key === INSURANCE_CATEGORY);
  if (!seed) return;
  const cat: Omit<Category, 'id'> = {
    key: seed.key, name: seed.name, type: seed.type, icon: seed.icon, color: seed.color, order: seed.order,
  };
  await upsertCategory(cat);
}

export async function payInsurancePremium(uid: string, input: PayInsurancePremiumInput): Promise<Date> {
  const { account, sourceAccount, amountTWD, date, existingCategoryKeys } = input;
  const details = account.insurance;
  if (!details) throw new Error('此帳戶沒有保單資料');
  if (!(amountTWD > 0)) throw new Error('請輸入保費金額');
  await ensureInsuranceCategory(existingCategoryKeys);
  const period = formatTW(details.nextPremiumDate, 'yyyyMMdd');
  await createTransaction({
    userId: uid,
    type: 'expense',
    amount: amountTWD,
    currency: 'TWD',
    amountTWD,
    fxRate: 1,
    category: INSURANCE_CATEGORY,
    paymentMethod: sourceAccount.legacyPaymentMethod ?? sourceAccount.name,
    fromAccountId: sourceAccount.id,
    toAccountId: null,
    note: `${account.name} 保費（${formatTW(details.nextPremiumDate, 'yyyy/MM/dd')} 期）`,
    date,
    tripId: null,
  }, `insurance-${account.id}-${period}`);
  const nextPremiumDate = advancePremiumDate(details.nextPremiumDate, details.premiumFrequency);
  await updateAccount(account.id, { insurance: { ...details, nextPremiumDate } });
  return nextPremiumDate;
}

export function usePayInsurancePremium() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (input: PayInsurancePremiumInput) => {
      if (!user) throw new Error('Not logged in');
      return payInsurancePremium(user.uid, input);
    },
    onSuccess: (next) => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success(`已記錄保費，下次繳費日 ${formatTW(next, 'yyyy/MM/dd')}`);
    },
    onError: (err) => {
      console.error('[payInsurancePremium]', err);
      toast.error(err instanceof Error ? err.message : '記錄保費失敗');
    },
  });
}
