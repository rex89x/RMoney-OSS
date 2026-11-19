import { useCallback, useMemo } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useTrips } from '@/features/trips/hooks';
import {
  HOUSEHOLD_FUND_PAYER_ID, effectiveAmountTWD, myExpenseShareTWD, txPayerId, type Transaction,
} from './types';

/**
 * 一筆支出對「我」的三個數字（所有畫面都用這一份，不要各自再算）：
 * - totalTWD：整筆（旅程總花費 / 共同帳本總額用）
 * - paidTWD：我墊付（付款人是我才有；公基金 / 對方付 = 0）
 * - shareTWD：我負擔（分攤後我那份 —— 「我實際花了多少」一律用這個）
 * - netTWD：paidTWD − shareTWD，正 = 待收、負 = 待付
 */
export interface ExpenseBreakdown {
  totalTWD: number;
  paidTWD: number;
  shareTWD: number;
  netTWD: number;
  /** 有多人分攤（旅程 / 共同 / 代墊）：列表以 shareTWD 當主數字 */
  split: boolean;
}

export type TxScope = 'personal' | 'household' | 'trip' | 'loan';

export const TX_SCOPE_LABEL: Record<TxScope, string> = {
  personal: '個人',
  household: '共同',
  trip: '出遊',
  loan: '代墊',
};

/** 一筆交易屬於哪些範疇（可同時是共同 + 出遊；都不是就是個人） */
export function txScopes(tx: Pick<Transaction, 'householdId' | 'tripId' | 'splitMode'>): TxScope[] {
  const out: TxScope[] = [];
  if (tx.householdId) out.push('household');
  if (tx.tripId) out.push('trip');
  if (tx.splitMode && tx.splitMode !== 'self') out.push('loan');
  return out.length > 0 ? out : ['personal'];
}

function hasSplitContext(tx: Transaction): boolean {
  return Boolean(tx.householdId || tx.tripId || (tx.splitMode && tx.splitMode !== 'self'));
}

/**
 * 「我」在各趟旅程裡的身分：旅程成員可能沒有 uid（純名字），先比 uid → email → displayName。
 * 建議旅程成員加入時名字直接填本人在這趟的稱呼，後續分攤才對得起來。
 */
function useTripIdentity() {
  const { user, profile } = useAuth();
  const { data: trips = [] } = useTrips();
  return useMemo(() => {
    const m = new Map<string, { ids: string[]; myAlias: string | null }>();
    const myUid = user?.uid;
    const myDisplayName = profile?.displayName ?? null;
    const myEmail = profile?.email ?? null;
    for (const t of trips) {
      const members = t.members ?? [];
      const ids = members.map((mem) => mem.uid ?? mem.name);
      let myAlias: string | null = null;
      if (myUid) {
        const byUid = members.find((mm) => mm.uid === myUid);
        if (byUid) myAlias = byUid.uid ?? byUid.name;
      }
      if (!myAlias && myEmail) {
        const byEmail = members.find((mm) => mm.email === myEmail);
        if (byEmail) myAlias = byEmail.uid ?? byEmail.name;
      }
      if (!myAlias && myDisplayName) {
        const byName = members.find((mm) => mm.name === myDisplayName);
        if (byName) myAlias = byName.uid ?? byName.name;
      }
      m.set(t.id, { ids, myAlias });
    }
    return m;
  }, [trips, user?.uid, profile?.displayName, profile?.email]);
}

/**
 * 取得「給定 tx 對我的三個數字」。
 * 我負擔的來源優先序：
 *  1. 自己建立、且有分攤情境的交易 → 存好的 `myShareTWD`（任何人改分攤都會重算這個欄位，與 Apps Script 同口徑）
 *  2. 其他（別人建立的共同 / 旅程支出、舊資料）→ 由 customShares / lineItems / 均分推算（`myExpenseShareTWD`）
 */
export function useExpenseBreakdown() {
  const { user } = useAuth();
  const tripsById = useTripIdentity();
  const myUid = user?.uid ?? null;

  return useCallback((tx: Transaction): ExpenseBreakdown => {
    const total = effectiveAmountTWD(tx);
    if (tx.type !== 'expense') return { totalTWD: total, paidTWD: total, shareTWD: total, netTWD: 0, split: false };
    const ctx = tx.tripId ? tripsById.get(tx.tripId) : undefined;
    const myIds = new Set<string>([myUid, ctx?.myAlias].filter((v): v is string => Boolean(v)));
    const fundPaid = tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID;
    const split = hasSplitContext(tx);

    let share: number;
    if (fundPaid) share = 0;
    else if (tx.userId === myUid && tx.myShareTWD != null && split) share = tx.myShareTWD;
    else share = myExpenseShareTWD(tx, ctx?.myAlias ?? myUid, ctx?.ids ?? []);

    let paid: number;
    if (fundPaid) paid = 0;
    else if (tx.splitMode === 'they-paid-mine') paid = 0;
    else paid = myIds.has(txPayerId(tx)) ? total : 0;

    return { totalTWD: total, paidTWD: paid, shareTWD: share, netTWD: paid - share, split };
  }, [tripsById, myUid]);
}

/** 只要「我負擔」的簡化版（大多數彙總用這個） */
export function useMyExpenseShare() {
  const breakdown = useExpenseBreakdown();
  return useCallback((tx: Transaction): number => breakdown(tx).shareTWD, [breakdown]);
}
