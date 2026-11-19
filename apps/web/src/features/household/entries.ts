import type { Transaction } from '@/features/ledger/types';
import { householdPortionTWD, sharesOfTx } from './balance';
import {
  HOUSEHOLD_FUND_PAYER_ID, MEMBER_COLORS,
  type Household, type HouseholdFundEntry, type Settlement,
} from './types';

/**
 * 共同帳本的統一時間軸。
 * 交易分頁、月報、公基金分頁都吃這個型別，才不會「支出看得到、存入看不到」。
 */
export type HouseholdEntryKind = 'expense' | 'contribution' | 'reimbursement' | 'settlement';

export const HOUSEHOLD_ENTRY_LABEL: Record<HouseholdEntryKind, string> = {
  expense: '共同支出',
  contribution: '公基金存入',
  reimbursement: '公基金撥還',
  settlement: '結算轉帳',
};

export interface HouseholdEntryRow {
  /** `${kind}:${原始 id}`，同一個列表裡不會撞 key */
  key: string;
  id: string;
  kind: HouseholdEntryKind;
  date: Date;
  /** 一律正數 */
  amountTWD: number;
  /** 我應負擔的金額；只有 expense 有意義（公基金付款 = 0） */
  myShareTWD: number;
  categoryKey: string | null;
  note: string | null;
  /** expense: 付款人（可能是 HOUSEHOLD_FUND_PAYER_ID）；contribution: 存入者；settlement: 付款人 */
  fromUid: string | null;
  /** settlement 的收款人；其他為 null */
  toUid: string | null;
  paymentMethod: string | null;
  /** 誰記的（只有這個人能改 / 刪） */
  createdBy: string;
  tx?: Transaction;
  fundEntry?: HouseholdFundEntry;
  settlement?: Settlement;
}

export interface BuildEntriesInput {
  household: Household;
  myUid: string;
  txs: Transaction[];
  fundEntries: HouseholdFundEntry[];
  settlements: Settlement[];
  kinds?: HouseholdEntryKind[];
}

/** 合併成一條新到舊的時間軸 */
export function buildHouseholdEntries(input: BuildEntriesInput): HouseholdEntryRow[] {
  const { household, myUid, txs, fundEntries, settlements } = input;
  const kinds = input.kinds ?? ['expense', 'contribution', 'reimbursement', 'settlement'];
  const rows: HouseholdEntryRow[] = [];

  if (kinds.includes('expense')) {
    for (const tx of txs) {
      rows.push({
        key: `expense:${tx.id}`,
        id: tx.id,
        kind: 'expense',
        date: tx.date,
        // 同時歸入旅程的交易只算共同帳本成員那部分；全額在 tx.amountTWD
        amountTWD: householdPortionTWD(tx, household.memberIds),
        myShareTWD: sharesOfTx(tx, household.memberIds)[myUid] ?? 0,
        categoryKey: tx.category,
        note: tx.note ?? null,
        fromUid: tx.paidByUid ?? tx.userId,
        toUid: null,
        paymentMethod: tx.paymentMethod || null,
        createdBy: tx.userId,
        tx,
      });
    }
  }

  if (kinds.includes('contribution')) {
    for (const entry of fundEntries) {
      if (entry.type === 'reimbursement') continue;
      rows.push({
        key: `contribution:${entry.id}`,
        id: entry.id,
        kind: 'contribution',
        date: entry.date,
        amountTWD: Math.abs(entry.amountTWD),
        myShareTWD: 0,
        categoryKey: null,
        note: entry.note ?? null,
        fromUid: entry.contributorUid,
        toUid: null,
        paymentMethod: null,
        createdBy: entry.createdBy,
        fundEntry: entry,
      });
    }
  }

  if (kinds.includes('reimbursement')) {
    for (const entry of fundEntries) {
      if (entry.type !== 'reimbursement') continue;
      rows.push({
        key: `reimbursement:${entry.id}`,
        id: entry.id,
        kind: 'reimbursement',
        date: entry.date,
        amountTWD: Math.abs(entry.amountTWD),
        myShareTWD: 0,
        categoryKey: null,
        note: entry.note ?? null,
        fromUid: HOUSEHOLD_FUND_PAYER_ID,
        toUid: entry.contributorUid,
        paymentMethod: null,
        createdBy: entry.createdBy,
        fundEntry: entry,
      });
    }
  }

  if (kinds.includes('settlement')) {
    for (const settlement of settlements) {
      rows.push({
        key: `settlement:${settlement.id}`,
        id: settlement.id,
        kind: 'settlement',
        date: settlement.date,
        amountTWD: settlement.amountTWD,
        myShareTWD: 0,
        categoryKey: null,
        note: settlement.note ?? null,
        fromUid: settlement.fromUid,
        toUid: settlement.toUid,
        paymentMethod: null,
        createdBy: settlement.createdBy,
        settlement,
      });
    }
  }

  return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/**
 * 成員的固定顏色 — 圖表與 chip 共用。
 * 顏色跟著人走（不是跟著排名），所以篩選後其他人的顏色不會被重新指派。
 */
export function memberColor(household: Household, uid: string): string {
  const explicit = household.members[uid]?.color;
  if (explicit) return explicit;
  const index = household.memberIds.indexOf(uid);
  return MEMBER_COLORS[(index < 0 ? 0 : index) % MEMBER_COLORS.length] ?? MEMBER_COLORS[0] ?? '#3b82f6';
}

/**
 * 公基金在圖表 / chip 上的固定色（不屬於任何成員）。
 * 用 #d97706 而不是 warning 的 #f59e0b：後者在深色底的亮度超出 dataviz 的可讀區間。
 */
export const HOUSEHOLD_FUND_COLOR = '#d97706';

export function entryPayerColor(household: Household, uid: string | null): string {
  if (!uid) return '#6b7280';
  return uid === HOUSEHOLD_FUND_PAYER_ID ? HOUSEHOLD_FUND_COLOR : memberColor(household, uid);
}
