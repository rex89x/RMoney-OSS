import type { Transaction } from '@/features/ledger/types';
import { effectiveAmountTWD, txPayerId } from '@/features/ledger/types';
import {
  HOUSEHOLD_FUND_PAYER_ID,
  type Household,
  type HouseholdFundEntry,
  type HouseholdSplitMode,
  type Settlement,
} from './types';

/**
 * 純函式：分攤計算與餘額結算。與 Firestore 無關，方便測試。
 */

/** 把總額依比例（%）拆給各成員；四捨五入到整數，餘數補給第一個成員（避免總和不等） */
export function splitByRatio(totalTWD: number, ratio: Record<string, number>, memberIds: string[]): Record<string, number> {
  const ids = memberIds.filter((id) => (ratio[id] ?? 0) > 0);
  const sumRatio = ids.reduce((s, id) => s + (ratio[id] ?? 0), 0);
  const out: Record<string, number> = {};
  if (ids.length === 0 || sumRatio <= 0) return splitEqual(totalTWD, memberIds);
  let allocated = 0;
  ids.forEach((id, i) => {
    const share = i === ids.length - 1
      ? totalTWD - allocated
      : Math.round((totalTWD * (ratio[id] ?? 0)) / sumRatio);
    out[id] = share;
    allocated += share;
  });
  return out;
}

export function splitEqual(totalTWD: number, memberIds: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (memberIds.length === 0) return out;
  const base = Math.floor(totalTWD / memberIds.length);
  let remainder = Math.round(totalTWD - base * memberIds.length);
  for (const id of memberIds) {
    out[id] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return out;
}

/** 依模式產生各成員應負擔金額 */
export function computeShares(
  household: Household,
  totalTWD: number,
  mode: HouseholdSplitMode,
  paidByUid: string,
  custom?: Record<string, number>,
): Record<string, number> {
  const rounded = Math.round(totalTWD);
  switch (mode) {
    case 'equal':
      return splitEqual(rounded, household.memberIds);
    case 'payer':
      return Object.fromEntries(household.memberIds.map((id) => [id, id === paidByUid ? rounded : 0]));
    case 'custom': {
      const out: Record<string, number> = {};
      for (const id of household.memberIds) out[id] = Math.max(0, Math.round(custom?.[id] ?? 0));
      return out;
    }
    case 'ratio':
    default:
      return splitByRatio(rounded, household.splitRatio, household.memberIds);
  }
}

/**
 * 從 tx 取出「共同帳本成員」各自應負擔的金額（customShares 為主；缺就當付款人全付）。
 * 只回傳 memberIds 裡的人：同時歸入旅程的交易，外面旅伴那份不在這裡，由旅程結算處理。
 */
export function sharesOfTx(tx: Transaction, memberIds: string[]): Record<string, number> {
  const total = effectiveAmountTWD(tx);
  const out: Record<string, number> = {};
  for (const id of memberIds) out[id] = 0;
  if (tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID) return out;
  const cs = tx.customShares ?? [];
  if (cs.length > 0) {
    const csTotal = cs.reduce((s, c) => s + (c.amountTWD || 0), 0);
    const ratio = csTotal > 0 ? total / csTotal : 1;
    for (const c of cs) {
      if (!memberIds.includes(c.memberId)) continue;
      out[c.memberId] = (out[c.memberId] ?? 0) + (c.amountTWD || 0) * ratio;
    }
    return out;
  }
  const payer = txPayerId(tx);
  if (memberIds.includes(payer)) out[payer] = total;
  return out;
}

/**
 * 這筆交易「算進共同帳本」的金額：
 * - 一般共同支出 = 全額
 * - 同時歸入旅程 = 只有共同帳本成員那幾份的加總（外面旅伴的份走旅程結算，不重複算）
 */
export function householdPortionTWD(tx: Transaction, memberIds: string[]): number {
  if (!tx.tripId) return effectiveAmountTWD(tx);
  const shares = sharesOfTx(tx, memberIds);
  return Object.values(shares).reduce((s, v) => s + v, 0);
}

export interface MemberBalance {
  uid: string;
  /** 付出的總額（墊付） */
  paidTWD: number;
  /** 自己應負擔的總額 */
  shareTWD: number;
  /** 淨額：正 = 別人欠他；負 = 他欠別人（已扣除結算） */
  netTWD: number;
}

/**
 * 計算每個成員的淨額。
 * - 交易：付款人 +total，各成員 −自己那份
 * - 結算：from 付給 to → from +amount、to −amount
 */
export function computeBalances(
  household: Household,
  txs: Transaction[],
  settlements: Settlement[],
): Record<string, MemberBalance> {
  const out: Record<string, MemberBalance> = {};
  for (const id of household.memberIds) out[id] = { uid: id, paidTWD: 0, shareTWD: 0, netTWD: 0 };
  const ensure = (id: string) => {
    if (!out[id]) out[id] = { uid: id, paidTWD: 0, shareTWD: 0, netTWD: 0 };
    return out[id] as MemberBalance;
  };
  for (const tx of txs) {
    if (tx.deletedAt || tx.type !== 'expense') continue;
    // 公基金支出已由基金餘額負擔，不再形成成員彼此間的應收／應付。
    if (tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID) continue;
    const payer = txPayerId(tx);
    // 旅程交易由外面的旅伴付：成員各自欠他的錢走旅程結算，共同帳本內部沒有欠款。
    if (!household.memberIds.includes(payer)) continue;
    // 墊付只算「共同帳本成員那幾份」：外面旅伴那份由旅程結算向付款人還，不在這裡重複算。
    const total = householdPortionTWD(tx, household.memberIds);
    ensure(payer).paidTWD += total;
    ensure(payer).netTWD += total;
    const shares = sharesOfTx(tx, household.memberIds);
    for (const [id, share] of Object.entries(shares)) {
      ensure(id).shareTWD += share;
      ensure(id).netTWD -= share;
    }
  }
  for (const s of settlements) {
    ensure(s.fromUid).netTWD += s.amountTWD;
    ensure(s.toUid).netTWD -= s.amountTWD;
  }
  return out;
}

export interface HouseholdFundSummary {
  /** 帳上可用 = 累計存入 − 公基金負擔的支出（不管有沒有撥還給先墊的人） */
  balanceTWD: number;
  contributionsTWD: number;
  expensesTWD: number;
  byContributor: Record<string, number>;
  /** 每位成員：先墊付、由公基金負擔的金額 */
  advancedByMember: Record<string, number>;
  /** 每位成員：公基金已撥還的金額 */
  reimbursedByMember: Record<string, number>;
  /** 公基金還欠每位成員多少（先墊 − 已撥還；負數 = 撥多了，成員要退回公基金） */
  owedToMember: Record<string, number>;
  /** 待撥還總額（只加正數） */
  outstandingTWD: number;
  /** 實際現金 = 帳上可用 + 還沒撥還的代墊（錢還在公基金帳戶裡，只是已經有用途） */
  cashTWD: number;
}

export function summarizeHouseholdFund(
  entries: HouseholdFundEntry[],
  txs: Transaction[],
): HouseholdFundSummary {
  let contributionsTWD = 0;
  let expensesTWD = 0;
  const byContributor: Record<string, number> = {};
  const advancedByMember: Record<string, number> = {};
  const reimbursedByMember: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.type === 'reimbursement') {
      // 撥還只是把錢從公基金帳戶轉給先墊的人：義務在記支出時已扣過，帳上可用不再變動
      if (entry.contributorUid) {
        reimbursedByMember[entry.contributorUid] = (reimbursedByMember[entry.contributorUid] ?? 0) + entry.amountTWD;
      }
      continue;
    }
    contributionsTWD += entry.amountTWD;
    if (entry.contributorUid && entry.type === 'contribution') {
      byContributor[entry.contributorUid] = (byContributor[entry.contributorUid] ?? 0) + entry.amountTWD;
    }
  }
  for (const tx of txs) {
    if (tx.deletedAt || tx.type !== 'expense' || tx.paidByUid !== HOUSEHOLD_FUND_PAYER_ID) continue;
    const amount = effectiveAmountTWD(tx);
    expensesTWD += amount;
    if (tx.fundAdvancedBy) advancedByMember[tx.fundAdvancedBy] = (advancedByMember[tx.fundAdvancedBy] ?? 0) + amount;
  }
  const owedToMember: Record<string, number> = {};
  let netOwed = 0;
  let outstandingTWD = 0;
  for (const uid of new Set([...Object.keys(advancedByMember), ...Object.keys(reimbursedByMember)])) {
    const owed = Math.round((advancedByMember[uid] ?? 0) - (reimbursedByMember[uid] ?? 0));
    owedToMember[uid] = owed;
    netOwed += owed;
    if (owed > 0) outstandingTWD += owed;
  }
  const balanceTWD = contributionsTWD - expensesTWD;
  return {
    balanceTWD,
    contributionsTWD,
    expensesTWD,
    byContributor,
    advancedByMember,
    reimbursedByMember,
    owedToMember,
    outstandingTWD,
    cashTWD: balanceTWD + netOwed,
  };
}

export interface PairDebt {
  fromUid: string;
  toUid: string;
  amountTWD: number;
}

/** 把淨額壓成「誰付給誰多少」（貪婪配對，兩人時只會有一筆） */
export function simplifyDebts(balances: Record<string, MemberBalance>): PairDebt[] {
  const creditors = Object.values(balances).filter((b) => b.netTWD > 0.5).map((b) => ({ uid: b.uid, amt: b.netTWD }))
    .sort((a, b) => b.amt - a.amt);
  const debtors = Object.values(balances).filter((b) => b.netTWD < -0.5).map((b) => ({ uid: b.uid, amt: -b.netTWD }))
    .sort((a, b) => b.amt - a.amt);
  const out: PairDebt[] = [];
  let i = 0;
  let j = 0;
  while (i < creditors.length && j < debtors.length) {
    const c = creditors[i];
    const d = debtors[j];
    if (!c || !d) break;
    const amt = Math.min(c.amt, d.amt);
    out.push({ fromUid: d.uid, toUid: c.uid, amountTWD: Math.round(amt) });
    c.amt -= amt;
    d.amt -= amt;
    if (c.amt <= 0.5) i += 1;
    if (d.amt <= 0.5) j += 1;
  }
  return out;
}

export interface MonthlyHouseholdSummary {
  totalTWD: number;
  byCategory: { key: string; totalTWD: number }[];
  byPayer: Record<string, number>;
  count: number;
}

/** 本月共同支出彙總。給 memberIds 時，同時歸入旅程的交易只算共同帳本成員那部分。 */
export function summarizeHouseholdTxs(txs: Transaction[], memberIds?: string[]): MonthlyHouseholdSummary {
  let total = 0;
  const byCat = new Map<string, number>();
  const byPayer: Record<string, number> = {};
  let count = 0;
  for (const tx of txs) {
    if (tx.deletedAt || tx.type !== 'expense') continue;
    const amt = memberIds ? householdPortionTWD(tx, memberIds) : effectiveAmountTWD(tx);
    total += amt;
    count += 1;
    byCat.set(tx.category, (byCat.get(tx.category) ?? 0) + amt);
    const payer = txPayerId(tx);
    byPayer[payer] = (byPayer[payer] ?? 0) + amt;
  }
  return {
    totalTWD: total,
    byCategory: Array.from(byCat.entries()).map(([key, totalTWD]) => ({ key, totalTWD })).sort((a, b) => b.totalTWD - a.totalTWD),
    byPayer,
    count,
  };
}

/**
 * 「存入改成撥還」時列出可能對應的公基金支出：公基金負擔、還沒標誰先墊、
 * 日期在這筆撥還之前 90 天內（含之後 1 天，容許同日先記撥還）。新到舊。
 */
export function reimbursementCandidateTxs(txs: Transaction[], reimburseDate: Date, lookbackDays = 90): Transaction[] {
  const DAY = 24 * 60 * 60 * 1000;
  const from = reimburseDate.getTime() - lookbackDays * DAY;
  const to = reimburseDate.getTime() + DAY;
  return txs
    .filter((tx) => !tx.deletedAt && tx.type === 'expense' && tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID && !tx.fundAdvancedBy)
    .filter((tx) => tx.date.getTime() >= from && tx.date.getTime() <= to)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

/**
 * 從候選支出裡找「金額剛好加總等於撥還金額」的組合（最多 3 筆，只看最近 25 筆），
 * 給對話框預先勾選；找不到回空陣列，讓使用者自己勾。偏好筆數少、日期近的組合。
 */
export function findExactExpenseMatch(candidates: Transaction[], amountTWD: number, maxItems = 3): string[] {
  const target = Math.round(amountTWD);
  if (target <= 0) return [];
  const pool = candidates.slice(0, 25).map((tx) => ({ id: tx.id, amount: Math.round(effectiveAmountTWD(tx)) }));
  for (let size = 1; size <= maxItems; size += 1) {
    const found = searchSubset(pool, target, size, 0, []);
    if (found) return found;
  }
  return [];
}

function searchSubset(
  pool: { id: string; amount: number }[],
  remaining: number,
  size: number,
  start: number,
  picked: string[],
): string[] | null {
  if (size === 0) return remaining === 0 ? picked : null;
  for (let i = start; i < pool.length; i += 1) {
    const item = pool[i];
    if (!item || item.amount > remaining) continue;
    const found = searchSubset(pool, remaining - item.amount, size - 1, i + 1, [...picked, item.id]);
    if (found) return found;
  }
  return null;
}
