/**
 * Subscriptions — 訂閱費追蹤
 *
 * 兩種建立方式：
 *   1. 手動 — 使用者直接新增 (name, amountTWD, billingCycle)
 *   2. 自動偵測 — 從 transactions 找出規律性月扣（同名稱 + 相近金額 + 接近 30 天間隔）
 *      偵測在前端做（features/subscriptions/detector.ts）；偵測到的可一鍵 promote 為訂閱
 *
 * Doc 格式：
 *   subscriptions/{id}
 *     name             顯示名稱
 *     amountTWD        每期金額（TWD）
 *     billingCycle     'monthly' | 'yearly' | 'weekly' | 'biweekly'
 *     nextChargeDate?  下次扣款日（手動填，或從近 tx 推算）
 *     paymentMethod?   信用卡 key
 *     category?        類別 key（預設 'subscription' / 'entertainment'）
 *     vendor?          廠商（Netflix / Spotify…）
 *     active           true | false
 *     lastChargedAt?   最近一次偵測到 tx 的日期
 *     recurringId?     連結的週期交易（recurring/{id}）。有值 = 由 Apps Script 每期自動入帳；
 *                      沒有 = 只追蹤提醒，不自動記帳（2026-11 起以 recurring 為入帳主體，訂閱負責追蹤 / 偵測）
 *     note?
 *     createdAt / updatedAt
 */

import {
  Timestamp, type DocumentData, type FirestoreDataConverter, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

export type SubscriptionCycle = 'weekly' | 'biweekly' | 'monthly' | 'yearly';

export const CYCLE_LABEL: Record<SubscriptionCycle, string> = {
  weekly: '每週',
  biweekly: '雙週',
  monthly: '每月',
  yearly: '每年',
};

export interface Subscription {
  id: string;
  name: string;
  amountTWD: number;
  billingCycle: SubscriptionCycle;
  nextChargeDate?: Date | null;
  paymentMethod?: string | null;
  category?: string | null;
  vendor?: string | null;
  active: boolean;
  lastChargedAt?: Date | null;
  /** 連結的週期交易 id；有值代表每期會自動入帳（見 linkSubscriptionAutoPost） */
  recurringId?: string | null;
  note?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const subscriptionConverter: FirestoreDataConverter<Subscription> = {
  toFirestore: (s) => {
    const { id: _id, ...rest } = s as Subscription;
    void _id;
    const out: Record<string, unknown> = {
      ...rest,
      nextChargeDate: rest.nextChargeDate ? Timestamp.fromDate(rest.nextChargeDate) : null,
      lastChargedAt: rest.lastChargedAt ? Timestamp.fromDate(rest.lastChargedAt) : null,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): Subscription => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      name: d.name ?? '',
      amountTWD: d.amountTWD ?? 0,
      billingCycle: (d.billingCycle as SubscriptionCycle) ?? 'monthly',
      nextChargeDate: tsToDate(d.nextChargeDate),
      paymentMethod: d.paymentMethod ?? null,
      category: d.category ?? null,
      vendor: d.vendor ?? null,
      active: d.active !== false,
      lastChargedAt: tsToDate(d.lastChargedAt),
      recurringId: typeof d.recurringId === 'string' && d.recurringId ? d.recurringId : null,
      note: d.note ?? null,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};

/** 把訂閱換算成「平均每月 TWD」以便彙總 */
export function monthlyAmountTWD(s: Pick<Subscription, 'amountTWD' | 'billingCycle'>): number {
  switch (s.billingCycle) {
    case 'weekly': return (s.amountTWD * 52) / 12;
    case 'biweekly': return (s.amountTWD * 26) / 12;
    case 'yearly': return s.amountTWD / 12;
    case 'monthly':
    default: return s.amountTWD;
  }
}
