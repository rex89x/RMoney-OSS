import { createTransaction, upsertCategory } from '@/features/ledger/api';
import type { Category } from '@/features/ledger/types';
import { DEFAULT_CATEGORIES } from '@/lib/seed-data';
import { createHouseholdFundEntry, createSettlement } from './api';
import {
  HOUSEHOLD_SETTLEMENT_CATEGORY, HOUSEHOLD_SETTLEMENT_INCOME_CATEGORY, type Household, type SettlementInput,
} from './types';

/**
 * 結算：寫一筆 settlements；owner 可選擇同時在自己的帳本記一筆收款 / 付款（會動帳戶餘額）。
 * member 沒有帳戶，只寫 settlement。
 */
export interface SettleParams {
  household: Household;
  myUid: string;
  fromUid: string;
  toUid: string;
  amountTWD: number;
  date: Date;
  note?: string;
  /** owner 才有：記到哪個帳戶（null = 不記） */
  ledger?: { accountId: string | null; paymentMethod: string; existingCategoryKeys: string[] } | null;
}

async function ensureSettlementCategories(existing: string[]): Promise<void> {
  const missing = DEFAULT_CATEGORIES.filter(
    (c) => (c.key === HOUSEHOLD_SETTLEMENT_CATEGORY || c.key === HOUSEHOLD_SETTLEMENT_INCOME_CATEGORY) && !existing.includes(c.key),
  );
  for (const c of missing) {
    const cat: Omit<Category, 'id'> = { key: c.key, name: c.name, type: c.type, icon: c.icon, color: c.color, order: c.order };
    await upsertCategory(cat);
  }
}

export async function settleHousehold(params: SettleParams): Promise<string> {
  const { household, myUid, fromUid, toUid, amountTWD, date, note, ledger } = params;
  const amount = Math.round(amountTWD);
  if (amount <= 0) throw new Error('金額需大於 0');
  if (fromUid === toUid) throw new Error('付款人與收款人不能相同');

  let linkedTxId: string | null = null;
  if (ledger && (fromUid === myUid || toUid === myUid)) {
    await ensureSettlementCategories(ledger.existingCategoryKeys);
    const receiving = toUid === myUid;
    const other = household.members[receiving ? fromUid : toUid]?.displayName ?? '對方';
    linkedTxId = await createTransaction({
      userId: myUid,
      type: receiving ? 'income' : 'expense',
      amount,
      currency: 'TWD',
      amountTWD: amount,
      fxRate: 1,
      category: receiving ? HOUSEHOLD_SETTLEMENT_INCOME_CATEGORY : HOUSEHOLD_SETTLEMENT_CATEGORY,
      paymentMethod: ledger.paymentMethod || '共同帳',
      fromAccountId: receiving ? null : ledger.accountId,
      toAccountId: receiving ? ledger.accountId : null,
      note: `${household.name} 結算 · ${receiving ? `${other} 付給我` : `我付給 ${other}`}${note ? ` · ${note}` : ''}`,
      date,
      tripId: null,
      scope: 'household',
    });
  }

  const input: SettlementInput = {
    fromUid,
    toUid,
    amountTWD: amount,
    date,
    note: note?.trim() || null,
    createdBy: myUid,
    linkedTxId,
  };
  return createSettlement(household.id, input);
}

/**
 * 公基金撥還：先墊付的成員拿回代墊的錢（公基金 → 成員）。
 * 寫一筆 fund_entries（type 'reimbursement'，contributorUid = 收款人），只動「實際現金」，帳上可用不變。
 * 收款人是 owner 本人時，可以同時在自己的帳本記一筆「共同帳結算」收入（帳戶餘額增加，統計排除），
 * 與先墊時從他帳戶扣的那筆相抵。
 */
export interface ReimburseParams {
  household: Household;
  myUid: string;
  toUid: string;
  amountTWD: number;
  date: Date;
  note?: string;
  ledger?: { accountId: string | null; paymentMethod: string; existingCategoryKeys: string[] } | null;
}

export async function reimburseFromFund(params: ReimburseParams): Promise<string> {
  const { household, myUid, toUid, amountTWD, date, note, ledger } = params;
  const amount = Math.round(amountTWD);
  if (amount <= 0) throw new Error('金額需大於 0');
  if (!household.memberIds.includes(toUid)) throw new Error('收款人不在共同帳本裡');

  if (ledger && toUid === myUid) {
    await ensureSettlementCategories(ledger.existingCategoryKeys);
    await createTransaction({
      userId: myUid,
      type: 'income',
      amount,
      currency: 'TWD',
      amountTWD: amount,
      fxRate: 1,
      category: HOUSEHOLD_SETTLEMENT_INCOME_CATEGORY,
      paymentMethod: ledger.paymentMethod || '共同帳',
      fromAccountId: null,
      toAccountId: ledger.accountId,
      note: `${household.name} 公基金撥還代墊${note ? ` · ${note}` : ''}`,
      date,
      tripId: null,
      scope: 'household',
    });
  }

  return createHouseholdFundEntry(household.id, {
    type: 'reimbursement',
    amountTWD: amount,
    contributorUid: toUid,
    note: note?.trim() || null,
    date,
    createdBy: myUid,
    planMonth: null,
    source: 'manual',
  });
}
