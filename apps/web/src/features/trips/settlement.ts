import { HOUSEHOLD_FUND_PAYER_ID, effectiveAmountTWD, type Transaction } from '@/features/ledger/types';
import type { TripMember } from './types';

export interface MemberBalance {
  /** member identifier: 優先用 uid，沒有就用 name */
  id: string;
  name: string;
  paid: number;       // 代墊 TWD
  share: number;      // 應付 TWD
  net: number;        // paid - share；正值表示該成員多付、該被還錢
  paidPct: number;    // 代墊佔總支出比例
  sharePct: number;   // 應付佔總支出比例
  txCount: number;    // 有分攤到的支出筆數
  categories: MemberCategoryTotal[];
  details: MemberExpenseDetail[];
}

export interface MemberCategoryTotal {
  category: string;
  amountTWD: number;
  pctOfMemberShare: number;
}

export interface MemberExpenseDetail {
  txId: string;
  date: Date;
  category: string;
  note?: string;
  totalTWD: number;
  paidTWD: number;
  shareTWD: number;
  sharePctOfTx: number;
  payerId: string;
  payerName: string;
  shareLabel: string;
}

export interface SettlementTransactionShare {
  memberId: string;
  memberName: string;
  amountTWD: number;
  pctOfTx: number;
}

export interface SettlementTransactionDetail {
  txId: string;
  date: Date;
  category: string;
  note?: string;
  amountTWD: number;
  payerId: string;
  payerName: string;
  shareLabel: string;
  shares: SettlementTransactionShare[];
}

export interface SettlementTransfer {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  amount: number; // TWD
}

export interface SettlementResult {
  balances: MemberBalance[];
  transactionDetails: SettlementTransactionDetail[];
  transfers: SettlementTransfer[];
  totalSpent: number;
  totalSettled: number;
  totalEstimated: number;
}

function memberKey(m: TripMember): string {
  return m.uid ?? m.name;
}

/**
 * 根據 trip members + 該 trip 所有 txs，計算每人的淨額與最少轉帳建議。
 * 分攤規則：
 *   - shareType='payer' 或 tx 沒 payerId → 該筆歸 payer 自己，不分攤
 *   - shareType='equal' 或 undefined → 按 members 均分
 *   - 支出：付款人 paid += amount；所有被分攤的 member share += per-head
 *   - 收入：反向，視為「付給 trip」的收入，通常不列入分攤（略過）
 */
export interface SettlementOptions {
  /**
   * 共同帳本成員 uid。同時歸入共同帳本的交易：成員彼此之間的錢在共同帳本結，
   * 所以這裡把「共同帳本成員」的份全部併到付款人身上，只留對外（其他旅伴）的欠款。
   * 沒給的話沿用舊行為：有 householdId 的交易只算進總額、不算欠款。
   */
  householdMemberIds?: string[];
}

export function computeSettlement(
  members: TripMember[],
  txs: Transaction[],
  options: SettlementOptions = {},
): SettlementResult {
  const householdIds = options.householdMemberIds ?? null;
  const balances = new Map<string, MemberBalance>();
  const detailsByMember = new Map<string, MemberExpenseDetail[]>();
  for (const m of members) {
    const id = memberKey(m);
    balances.set(id, emptyBalance(id, m.name));
    detailsByMember.set(id, []);
  }
  // Fallback: 若 tx 有 payerId 但不在 members 清單，把他加進去
  function ensure(id: string, name?: string): MemberBalance {
    const existing = balances.get(id);
    if (existing) return existing;
    const created = emptyBalance(id, name ?? id);
    balances.set(id, created);
    detailsByMember.set(id, []);
    return created;
  }

  let totalSpent = 0;
  let totalSettled = 0;
  let totalEstimated = 0;
  const transactionDetails: SettlementTransactionDetail[] = [];

  for (const t of txs) {
    if (t.deletedAt) continue;
    if (t.type !== 'expense') continue;
    const amt = effectiveAmountTWD(t);
    totalSpent += amt;
    if (t.settledAmountTWD != null) totalSettled += amt; else totalEstimated += amt;

    // 同時歸屬旅程與共同帳本的交易：支出算進旅程總額；欠款看有沒有共同帳本成員名單
    //  - 沒給名單（舊呼叫端）→ 整筆不算欠款（由共同帳本結）
    //  - 有名單 → 下面照常分攤，最後把成員的份併到付款人（成員間的錢在共同帳本結，對外的照算）
    if (t.householdId && !householdIds) continue;
    // 公基金付款沒有「人」可以收錢；UI 會擋掉「公基金 + 旅程」，這裡保險跳過
    if (t.paidByUid === HOUSEHOLD_FUND_PAYER_ID) continue;

    const payerId = (t.paidByUid ?? t.payerId) ?? (members[0] ? memberKey(members[0]) : null);
    if (!payerId) continue;
    const payer = ensure(payerId, memberName(payerId, members));
    payer.paid += amt;
    const allocations = new Map<string, number>();

    function addShare(memberId: string, memberName: string | undefined, share: number) {
      if (share <= 0) return;
      ensure(memberId, memberName);
      allocations.set(memberId, (allocations.get(memberId) ?? 0) + share);
    }

    const finish = (label: string) => {
      if (t.householdId && householdIds && householdIds.includes(payerId)) {
        // 把共同帳本其他成員的份併到付款人：他們之間在共同帳本結算
        for (const id of householdIds) {
          if (id === payerId) continue;
          const share = allocations.get(id);
          if (!share) continue;
          allocations.delete(id);
          allocations.set(payerId, (allocations.get(payerId) ?? 0) + share);
        }
      }
      applyTransaction(t, amt, payerId, payer.name, label, allocations, balances, detailsByMember, transactionDetails);
    };

    // 優先順序：shareType 顯式設定 > lineItems > 預設均分
    // 1. 不分攤（付款人自付）
    if (t.shareType === 'payer' || members.length <= 1) {
      addShare(payerId, payer.name, amt);
      finish('不分攤');
    } else if (t.shareType === 'custom' && Array.isArray(t.customShares) && t.customShares.length > 0) {
      // 2. 自訂分攤：把 customShares 直接套用；按比例 scale 到 effective amount
      const csTotal = t.customShares.reduce((s, c) => s + (c.amountTWD || 0), 0);
      const ratio = csTotal > 0 ? amt / csTotal : 1;
      for (const c of t.customShares) {
        addShare(c.memberId, memberName(c.memberId, members), (c.amountTWD || 0) * ratio);
      }
      finish(t.householdId ? '共同分攤' : '自訂分攤');
    } else if (t.shareType === 'equal') {
      // 3. 均分（顯式 'equal'）
      const activeMembers = members.length > 0 ? members : [{ name: payerId }];
      const per = amt / activeMembers.length;
      for (const m of activeMembers) {
        const id = memberKey(m);
        addShare(id, m.name, per);
      }
      finish('均分');
    } else if (t.lineItems && t.lineItems.length > 0) {
      // 4. shareType 沒設定 → fallback：lineItems > 預設均分
      const itemsTotal = t.lineItems.reduce((s, it) => s + (it.amountTWD || 0), 0);
      const ratio = itemsTotal > 0 ? amt / itemsTotal : 1;
      for (const li of t.lineItems) {
        const liAmt = (li.amountTWD || 0) * ratio;
        const sharers = (li.paidFor && li.paidFor.length > 0)
          ? li.paidFor
          : members.map((m) => memberKey(m));
        if (sharers.length === 0) continue;
        const per = liAmt / sharers.length;
        for (const name of sharers) {
          addShare(name, memberName(name, members), per);
        }
      }
      finish('依明細品項');
    } else {
      const activeMembers = members.length > 0 ? members : [{ name: payerId }];
      const per = amt / activeMembers.length;
      for (const m of activeMembers) {
        const id = memberKey(m);
        addShare(id, m.name, per);
      }
      finish('均分');
    }
  }

  const arr = Array.from(balances.values());
  for (const b of arr) {
    b.net = round2(b.paid - b.share);
    b.paid = round2(b.paid);
    b.share = round2(b.share);
    b.paidPct = totalSpent > 0 ? (b.paid / totalSpent) * 100 : 0;
    b.sharePct = totalSpent > 0 ? (b.share / totalSpent) * 100 : 0;
    b.details = (detailsByMember.get(b.id) ?? []).sort((a, c) => a.date.getTime() - c.date.getTime());
    b.txCount = b.details.length;
    b.categories = buildMemberCategories(b.details, b.share);
  }

  const transfers = minimizeTransfers(arr);
  return {
    balances: arr.sort((a, b) => b.net - a.net),
    transactionDetails: transactionDetails.sort((a, b) => a.date.getTime() - b.date.getTime()),
    transfers,
    totalSpent: round2(totalSpent),
    totalSettled: round2(totalSettled),
    totalEstimated: round2(totalEstimated),
  };
}

function emptyBalance(id: string, name: string): MemberBalance {
  return {
    id,
    name,
    paid: 0,
    share: 0,
    net: 0,
    paidPct: 0,
    sharePct: 0,
    txCount: 0,
    categories: [],
    details: [],
  };
}

function memberName(id: string, members: TripMember[]): string {
  return members.find((m) => memberKey(m) === id)?.name ?? id;
}

function applyTransaction(
  tx: Transaction,
  amountTWD: number,
  payerId: string,
  payerName: string,
  shareLabel: string,
  allocations: Map<string, number>,
  balances: Map<string, MemberBalance>,
  detailsByMember: Map<string, MemberExpenseDetail[]>,
  transactionDetails: SettlementTransactionDetail[],
) {
  const shares: SettlementTransactionShare[] = [];
  for (const [memberId, rawShare] of allocations.entries()) {
    const shareTWD = round2(rawShare);
    const balance = balances.get(memberId);
    if (!balance) continue;
    balance.share += shareTWD;
    const paidTWD = memberId === payerId ? amountTWD : 0;
    const detail: MemberExpenseDetail = {
      txId: tx.id,
      date: tx.date,
      category: tx.category,
      note: tx.note,
      totalTWD: amountTWD,
      paidTWD: round2(paidTWD),
      shareTWD,
      sharePctOfTx: amountTWD > 0 ? (shareTWD / amountTWD) * 100 : 0,
      payerId,
      payerName,
      shareLabel,
    };
    const memberDetails = detailsByMember.get(memberId);
    if (memberDetails) memberDetails.push(detail);
    shares.push({
      memberId,
      memberName: balance.name,
      amountTWD: shareTWD,
      pctOfTx: amountTWD > 0 ? (shareTWD / amountTWD) * 100 : 0,
    });
  }

  transactionDetails.push({
    txId: tx.id,
    date: tx.date,
    category: tx.category,
    note: tx.note,
    amountTWD: round2(amountTWD),
    payerId,
    payerName,
    shareLabel,
    shares: shares.sort((a, b) => b.amountTWD - a.amountTWD),
  });
}

function buildMemberCategories(
  details: MemberExpenseDetail[],
  memberShare: number,
): MemberCategoryTotal[] {
  const map = new Map<string, number>();
  for (const d of details) {
    map.set(d.category, (map.get(d.category) ?? 0) + d.shareTWD);
  }
  return Array.from(map.entries())
    .map(([category, amountTWD]) => ({
      category,
      amountTWD: round2(amountTWD),
      pctOfMemberShare: memberShare > 0 ? (amountTWD / memberShare) * 100 : 0,
    }))
    .sort((a, b) => b.amountTWD - a.amountTWD);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 簡單貪婪法：每次找最大 creditor (net > 0) 和最大 debtor (net < 0) 做一筆對抵。
 */
function minimizeTransfers(balances: MemberBalance[]): SettlementTransfer[] {
  const creditors = balances.filter((b) => b.net > 0.01).map((b) => ({ ...b, remaining: b.net })).sort((a, b) => b.remaining - a.remaining);
  const debtors = balances.filter((b) => b.net < -0.01).map((b) => ({ ...b, remaining: -b.net })).sort((a, b) => b.remaining - a.remaining);

  const transfers: SettlementTransfer[] = [];
  let ci = 0; let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci]!; // 非空：索引已做邊界 / 長度檢查
    const d = debtors[di]!; // 非空：索引已做邊界 / 長度檢查
    const pay = round2(Math.min(c.remaining, d.remaining));
    if (pay > 0.01) {
      transfers.push({
        fromId: d.id, fromName: d.name,
        toId: c.id, toName: c.name,
        amount: pay,
      });
      c.remaining = round2(c.remaining - pay);
      d.remaining = round2(d.remaining - pay);
    }
    if (c.remaining <= 0.01) ci++;
    if (d.remaining <= 0.01) di++;
  }
  return transfers;
}
