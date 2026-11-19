/**
 * Inbox — 集中所有「需要使用者處理」的事項。
 *
 * 純前端聚合：不建新 collection，每個 item 從既有 feature 的資料推導。
 * 使用者可以「處理」（呼叫該 feature 的 mutation）或「略過」（寫到
 * users/{uid}.preferences.inbox.dismissed[itemId] = ISO string）。
 *
 * itemId 設計為「同一件事同一個 id、下一期會變新 id」，例如信用卡帳單
 * 帶 cycleMonth、排程支出帶 dueDate，略過後下一期會再出現。
 */

import type { Transaction } from '@/features/ledger/types';

export type InboxKind =
  | 'manual'
  | 'uncategorized-tx'
  | 'unsettled-loan'
  | 'payout-unpaid'
  | 'subscription-candidate'
  | 'credit-card-due'
  | 'scheduled-payment-due'
  | 'budget-warn'
  | 'insurance'
  | 'household';

export type InboxSeverity = 'info' | 'warn' | 'urgent';

export interface InboxItem {
  id: string;
  kind: InboxKind;
  severity: InboxSeverity;
  title: string;
  detail?: string;
  amountTWD?: number;
  /** 排序用：越小越前面（逾期天數負值、到期天數正值） */
  sortKey: number;
  /** 點「前往」的連結 */
  href?: string;
  /** 交易類 item 帶原始 tx 以便直接開編輯 dialog */
  tx?: Transaction;
  /** feature 專屬 payload（處理動作用） */
  payload?: Record<string, unknown>;
}

export interface InboxGroupDef {
  kind: InboxKind;
  label: string;
}

export const INBOX_GROUPS: InboxGroupDef[] = [
  { kind: 'manual', label: '待辦' },
  { kind: 'credit-card-due', label: '信用卡帳單' },
  { kind: 'scheduled-payment-due', label: '排程支出到期' },
  { kind: 'insurance', label: '保單' },
  { kind: 'budget-warn', label: '預算警示' },
  { kind: 'household', label: '共同帳' },
  { kind: 'unsettled-loan', label: '未結清代墊' },
  { kind: 'payout-unpaid', label: '墊付團未收齊' },
  { kind: 'subscription-candidate', label: '疑似訂閱' },
  { kind: 'uncategorized-tx', label: '待整理交易' },
];

export type InboxDismissedMap = Record<string, string>;

/** 手動待辦：存在 users/{uid}.preferences.inbox.todos[]（array），完成即移除 */
export interface InboxTodo {
  id: string;
  title: string;
  detail?: string | null;
  href?: string | null;
  createdAt: string; // ISO
}
