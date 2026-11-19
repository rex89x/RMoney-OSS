import type { Household } from '@/features/household/types';
import { memberCan, canEditLedgerOf } from '@/features/household/types';
import type { Trip, TripMember } from '@/features/trips/types';
import type { Currency } from '@/types/global';
import type { TransactionPatch } from './api';
import {
  computeSplit, customFromTxShares, toTxShares,
  type SplitInput, type SplitMember, type SplitShare, type SplitState,
} from './components/split-editor';
import { HOUSEHOLD_FUND_PAYER_ID, txPayerId, type Transaction } from './types';

/**
 * 一筆交易的「分攤情境」：成員是誰、能不能選公基金、能不能依比例分。
 * 旅程與共同帳本可以同時存在：成員 = 旅程成員 ∪ 共同帳本成員（共同成員會標示）。
 */
export interface SplitContext {
  members: SplitMember[];
  allowFund: boolean;
  showRatio: boolean;
  ratio?: Record<string, number>;
}

export function buildSplitContext(params: {
  trip?: Trip | null;
  household?: Household | null;
  /** 這筆有沒有記進共同帳本 */
  includeHousehold: boolean;
  /** 沒有任何成員資料時的兜底（建立者自己） */
  fallback: { id: string; name: string };
}): SplitContext {
  const { trip, household, includeHousehold, fallback } = params;
  const hh = includeHousehold ? household ?? null : null;
  // 標「共同」用全部的共同帳本成員（就算沒勾共同分攤也標），名單才看得出誰是伴侶
  const householdIds = new Set(household?.memberIds ?? []);
  const members: SplitMember[] = [];
  const seen = new Set<string>();
  const push = (m: SplitMember) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    members.push(m);
  };
  for (const m of trip?.members ?? []) {
    const id = m.uid ?? m.name;
    push({ id, name: m.name, household: householdIds.has(id) });
  }
  // 被分享這趟旅程的共同帳本成員 = 同行的人：就算還沒進 trip.members 也算旅伴
  if (trip && household) {
    for (const uid of trip.sharedWith ?? []) {
      if (!householdIds.has(uid)) continue;
      push({ id: uid, name: household.members[uid]?.displayName ?? uid, household: true });
    }
  }
  if (hh) {
    for (const id of hh.memberIds) push({ id, name: hh.members[id]?.displayName ?? id, household: true });
  }
  // 建立者一定在名單裡（旅程還沒加自己、或伴侶替對方記帳時）
  if (!seen.has(fallback.id)) push({ ...fallback, household: householdIds.has(fallback.id) });
  const allHousehold = Boolean(hh) && members.every((m) => m.household);
  return {
    members,
    allowFund: Boolean(hh) && !trip,
    showRatio: allHousehold,
    ratio: allHousehold ? hh?.splitRatio : undefined,
  };
}

/** 從既有交易還原編輯狀態（既有分攤一律當自訂金額帶入，避免比例 / 成員改過後金額跳動） */
export function initialSplitState(tx: Transaction, members: SplitMember[], currency: Currency, fxRate: number): SplitState {
  const ids = members.map((m) => m.id);
  const payer = txPayerId(tx);
  const payerId = payer === HOUSEHOLD_FUND_PAYER_ID || ids.includes(payer) ? payer : (ids[0] ?? tx.userId);
  const hasCustom = Array.isArray(tx.customShares) && tx.customShares.length > 0;
  const mode = hasCustom ? 'custom' : tx.shareType === 'payer' ? 'payer' : 'equal';
  const custom = hasCustom ? customFromTxShares(tx.customShares, currency, fxRate, ids) : Object.fromEntries(ids.map((id) => [id, '']));
  const fundAdvancedBy = payerId === HOUSEHOLD_FUND_PAYER_ID && tx.fundAdvancedBy && ids.includes(tx.fundAdvancedBy)
    ? tx.fundAdvancedBy
    : '';
  const state: SplitState = { payerId, mode, custom, fundAdvancedBy };
  if (mode !== 'custom' || payerId === HOUSEHOLD_FUND_PAYER_ID) return state;
  // 既有分攤剛好等於「各付一半」或「代墊」就還原成那個模式，編輯時記帳方式才會選在對的選項上
  const base = { members, amount: tx.amount, currency, fxRate };
  const parsed = Object.fromEntries(ids.map((id) => [id, parseFloat(custom[id] ?? '') || 0]));
  const tolerance = currency === 'TWD' ? 0.5 : 0.005;
  const matches = (candidate: SplitState) => {
    const shares = computeSplit({ ...base, state: candidate });
    return ids.every((id) => Math.abs((shares[id]?.amount ?? 0) - (parsed[id] ?? 0)) <= tolerance);
  };
  if (ids.length >= 2 && matches({ payerId, mode: 'equal', custom })) return { payerId, mode: 'equal', custom };
  if (ids.length >= 2 && matches({ payerId, mode: 'others', custom })) return { payerId, mode: 'others', custom };
  return state;
}

/**
 * 分攤結果 → 要寫進 tx 的欄位。所有入口（快速記帳 / 編輯交易 / 夥伴改分攤）都走這裡，
 * `myShareTWD` 一律 = 建立者那份，所以建立者的 ledger / dashboard / Apps Script 看到的數字跟分攤一致。
 */
export function splitPatch(params: {
  creatorUid: string;
  input: SplitInput;
  isHousehold: boolean;
  isTrip: boolean;
}): Pick<TransactionPatch, 'payerId' | 'paidByUid' | 'shareType' | 'customShares' | 'myShareTWD' | 'fundAdvancedBy'> {
  const { creatorUid, input, isHousehold, isTrip } = params;
  const shares: Record<string, SplitShare> = computeSplit(input);
  const ids = input.members.map((m) => m.id);
  const fund = input.state.payerId === HOUSEHOLD_FUND_PAYER_ID;
  const mode = input.state.mode;
  const creatorShare = shares[creatorUid];
  return {
    payerId: isTrip && !fund ? input.state.payerId : null,
    paidByUid: isHousehold ? input.state.payerId : null,
    // 共同帳本一律讀 customShares（shareType 'custom'）；純旅程保留原本的模式讓旅程結算顯示「均分」等標籤
    // 'others'（代墊）只是 UI 模式，存檔時一律寫成自訂金額，旅程結算 / 舊版程式都看得懂
    shareType: isHousehold || mode === 'ratio' || mode === 'others' ? 'custom' : mode,
    customShares: toTxShares(shares, input.currency, ids),
    myShareTWD: fund ? 0 : creatorShare ? creatorShare.amountTWD : (ids.includes(creatorUid) ? 0 : null),
    // 只有公基金負擔、而且先墊的人還在成員名單裡才保留；其他情況一律清掉，避免殘留「公基金欠某人」
    fundAdvancedBy: fund && input.state.fundAdvancedBy && ids.includes(input.state.fundAdvancedBy)
      ? input.state.fundAdvancedBy
      : null,
  };
}

/** 能不能改這筆的整體內容（金額 / 類別 / 帳戶…）：自己的，或對方開放「可編輯」給我 */
export function canFullEditTx(tx: Transaction, myUid: string, household: Household | null | undefined): boolean {
  return tx.userId === myUid || canEditLedgerOf(household, myUid, tx.userId);
}

/**
 * 能不能「只改分攤」：共同帳本成員（有 canAddExpense）改同一個共同帳本的支出，
 * 或被分享旅程的成員改該旅程的支出。viewer（只看行程的朋友）不行。rules 同一套條件。
 */
export function canEditSplitOnly(params: {
  tx: Transaction;
  myUid: string;
  isViewer: boolean;
  household: Household | null | undefined;
  trip: Trip | null | undefined;
}): boolean {
  const { tx, myUid, isViewer, household, trip } = params;
  if (!myUid || isViewer || tx.type !== 'expense') return false;
  if (tx.householdId && household && household.id === tx.householdId && memberCan(household, myUid, 'canAddExpense')) return true;
  if (tx.tripId && trip && trip.id === tx.tripId && (trip.sharedWith ?? []).includes(myUid)) return true;
  return false;
}

/**
 * 成員名單變了（切旅程 / 勾共同分攤）時校正分攤狀態：
 * 付款人不在名單就改成預設（我 / 第一位）、保留模式、自訂金額只留還在名單裡的人。
 */
export function reconcileSplitState(
  prev: SplitState,
  ids: string[],
  preferredPayer: string,
  defaultMode: SplitState['mode'],
  /** 這個情境能不能用公基金（歸入旅程就不行）；不能時公基金付款人會改回預設付款人 */
  allowFund = true,
): SplitState {
  const payerOk = (allowFund && prev.payerId === HOUSEHOLD_FUND_PAYER_ID) || ids.includes(prev.payerId);
  const fallbackPayer = preferredPayer === HOUSEHOLD_FUND_PAYER_ID && !allowFund ? '' : preferredPayer;
  const payerId = payerOk
    ? prev.payerId
    : (fallbackPayer === HOUSEHOLD_FUND_PAYER_ID || ids.includes(fallbackPayer) ? fallbackPayer : (ids[0] ?? fallbackPayer));
  const mode = prev.payerId === '' ? defaultMode : prev.mode;
  const custom: Record<string, string> = {};
  for (const id of ids) custom[id] = prev.custom[id] ?? '';
  if (payerId === prev.payerId && mode === prev.mode && Object.keys(prev.custom).length === ids.length
    && ids.every((id) => id in prev.custom)) {
    return prev;
  }
  return { payerId, mode, custom };
}

/** 共同支出歸入旅程時，還沒在旅程成員名單裡的共同帳本成員（帶 uid，結算才對得起來） */
export function missingHouseholdTripMembers(trip: Trip, household: Household): TripMember[] {
  const existing = new Set((trip.members ?? []).map((m) => m.uid ?? m.name));
  return household.memberIds
    .filter((uid) => !existing.has(uid))
    .map((uid) => {
      const m = household.members[uid];
      const member: TripMember = { uid, name: m?.displayName ?? uid };
      if (m?.email) member.email = m.email;
      if (m?.color) member.color = m.color;
      return member;
    });
}

