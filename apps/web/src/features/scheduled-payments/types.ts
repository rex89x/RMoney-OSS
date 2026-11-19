/**
 * Scheduled payments — 重大支出排程：保險年費、稅金、學費、計畫性大額支出
 *
 * 比 subscriptions 更不規則（年費、不定期），但需要提前提醒。
 */

import {
  Timestamp, type DocumentData, type FirestoreDataConverter, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
import { addTWCalendarMonths, addTWCalendarYears } from '@/lib/tz';

export type PaymentRecurrence = 'one-time' | 'monthly' | 'quarterly' | 'yearly';

export const RECUR_LABEL: Record<PaymentRecurrence, string> = {
  'one-time': '單次',
  monthly: '每月',
  quarterly: '每季',
  yearly: '每年',
};

export interface ScheduledPayment {
  id: string;
  name: string;
  amountTWD: number;
  /** 下次 / 唯一一次 due 日期 */
  dueDate: Date;
  recurrence: PaymentRecurrence;
  category?: string | null;
  /** 提前 N 天提醒（預設 7） */
  remindBeforeDays: number;
  /** 已標記繳費完成的最近一次日期（recurring 時代表本期已完成） */
  paidAt?: Date | null;
  note?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const scheduledPaymentConverter: FirestoreDataConverter<ScheduledPayment> = {
  toFirestore: (s) => {
    const { id: _id, ...rest } = s as ScheduledPayment;
    void _id;
    const out: Record<string, unknown> = {
      ...rest,
      dueDate: Timestamp.fromDate(rest.dueDate),
      paidAt: rest.paidAt ? Timestamp.fromDate(rest.paidAt) : null,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): ScheduledPayment => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      name: d.name ?? '',
      amountTWD: d.amountTWD ?? 0,
      dueDate: tsToDate(d.dueDate) ?? new Date(),
      recurrence: (d.recurrence as PaymentRecurrence) ?? 'yearly',
      category: d.category ?? null,
      remindBeforeDays: typeof d.remindBeforeDays === 'number' ? d.remindBeforeDays : 7,
      paidAt: tsToDate(d.paidAt),
      note: d.note ?? null,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};

/** 標記本期已繳費後，自動算出下次 dueDate（recurrence != one-time）*/
export function nextDueDate(p: Pick<ScheduledPayment, 'dueDate' | 'recurrence'>): Date {
  if (p.recurrence === 'monthly') return addTWCalendarMonths(p.dueDate, 1);
  if (p.recurrence === 'quarterly') return addTWCalendarMonths(p.dueDate, 3);
  if (p.recurrence === 'yearly') return addTWCalendarYears(p.dueDate, 1);
  return p.dueDate;
}
