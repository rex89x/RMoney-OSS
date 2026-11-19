/**
 * 信用卡帳單周期紀錄。
 *
 * Doc ID 用 `${paymentMethodId}__${cycleMonth}` 確保 idempotent；
 * cycleMonth = 該期繳款截止日所屬的 YYYY-MM。
 *
 * 提醒邏輯：Apps Script 每日 09:00 掃描所有 billingEnabled 的信用卡，
 *   - 計算「最近一個 dueDate ≤ today」的 cycle
 *   - 若該 cycle 的 bill doc 不存在或 paidAt 為 null → 送 Telegram 提醒
 *   - paidAt 設值即停止提醒
 */

import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
import { formatTWMonthKey, fromTW, toTW } from '@/lib/tz';

export interface CreditCardBill {
  id: string;
  paymentMethodId: string;
  /** Phase 2: linked accounts/{type:'credit_card'} id. Legacy paymentMethodId remains during migration. */
  accountId?: string | null;
  /** 該期所屬月份 YYYY-MM（以 dueDate 月份為準） */
  cycleMonth: string;
  /** 結帳日（可選，紀錄當下解析的實際日期） */
  statementDate?: Date | null;
  /** 繳款截止日（依 pm.dueDay 推算的「原始」截止日，永遠保留為比較基準） */
  dueDate: Date;
  /**
   * 本期一次性調整後的繳款截止日（連假延期等）。null = 未調整，沿用 dueDate。
   * 此 override 僅作用於該期 bill doc，不會影響下期或未來 cycle 的計算。
   */
  dueDateOverride?: Date | null;
  /** 調整原因（連假、出差…），UI 顯示用 */
  overrideReason?: string | null;
  /** 已繳費時間，null = 未繳 */
  paidAt?: Date | null;
  paidFromAccountId?: string | null;
  paidViaTransferId?: string | null;
  /** 帳單金額（選填） */
  amount?: number | null;
  /** 備註 */
  note?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CreditCardBillInput = Omit<CreditCardBill, 'id' | 'createdAt' | 'updatedAt'>;

/** 取「實際生效」的截止日：override 優先，否則用原始 dueDate */
export function effectiveDueDate(bill: Pick<CreditCardBill, 'dueDate' | 'dueDateOverride'>): Date {
  return bill.dueDateOverride ?? bill.dueDate;
}

export const creditCardBillConverter: FirestoreDataConverter<CreditCardBill> = {
  toFirestore: (b) => {
    const { id: _id, ...rest } = b as CreditCardBill;
    void _id;
    const out: Record<string, unknown> = {
      paymentMethodId: rest.paymentMethodId,
      accountId: rest.accountId ?? null,
      cycleMonth: rest.cycleMonth,
      statementDate: rest.statementDate ? Timestamp.fromDate(rest.statementDate) : null,
      dueDate: Timestamp.fromDate(rest.dueDate),
      dueDateOverride: rest.dueDateOverride ? Timestamp.fromDate(rest.dueDateOverride) : null,
      overrideReason: rest.overrideReason ?? null,
      paidAt: rest.paidAt ? Timestamp.fromDate(rest.paidAt) : null,
      paidFromAccountId: rest.paidFromAccountId ?? null,
      paidViaTransferId: rest.paidViaTransferId ?? null,
      amount: rest.amount ?? null,
      note: rest.note ?? null,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): CreditCardBill => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      paymentMethodId: d.paymentMethodId ?? '',
      accountId: d.accountId ?? null,
      cycleMonth: d.cycleMonth ?? '',
      statementDate: tsToDate(d.statementDate),
      dueDate: tsToDate(d.dueDate) ?? new Date(),
      dueDateOverride: tsToDate(d.dueDateOverride),
      overrideReason: d.overrideReason ?? null,
      paidAt: tsToDate(d.paidAt),
      paidFromAccountId: d.paidFromAccountId ?? null,
      paidViaTransferId: d.paidViaTransferId ?? null,
      amount: typeof d.amount === 'number' ? d.amount : null,
      note: d.note ?? null,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};

/** 把 1–31 的 day-of-month clamp 到目標月份的合法天數（避免 2 月 31 號這種無效日期） */
export function clampDayToMonth(year: number, monthIndex: number, day: number): number {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return Math.max(1, Math.min(day, lastDay));
}

/**
 * 給定信用卡 dueDay 與一個基準日期，計算「最近一個 ≤ baseDate 的繳款截止日」。
 * 用於：今天有沒有未繳的本期帳單。
 */
export function currentDueDate(dueDay: number, baseDate: Date = new Date()): Date {
  const tw = toTW(baseDate);
  const y = tw.getFullYear();
  const m = tw.getMonth();
  const d = tw.getDate();
  const thisMonthDue = clampDayToMonth(y, m, dueDay);
  if (d >= thisMonthDue) {
    return fromTW(new Date(y, m, thisMonthDue));
  }
  // 上個月的繳款日
  const prev = new Date(y, m - 1, 1);
  const prevDue = clampDayToMonth(prev.getFullYear(), prev.getMonth(), dueDay);
  return fromTW(new Date(prev.getFullYear(), prev.getMonth(), prevDue));
}

/**
 * 根據 dueDate 與 statementDay 推算該期結帳日。statementDay 可能在 dueDay 之前
 * （同月 5 結 → 25 繳）或之後（25 結 → 下月 15 繳），無法 100% 推得 100%；
 * 採規則：若 statementDay < dueDay → 同月；否則上個月。
 */
export function deriveStatementDate(
  dueDate: Date,
  statementDay: number | null | undefined,
): Date | null {
  if (statementDay == null) return null;
  const twDueDate = toTW(dueDate);
  const dueDay = twDueDate.getDate();
  if (statementDay < dueDay) {
    const day = clampDayToMonth(twDueDate.getFullYear(), twDueDate.getMonth(), statementDay);
    return fromTW(new Date(twDueDate.getFullYear(), twDueDate.getMonth(), day));
  }
  const prev = new Date(twDueDate.getFullYear(), twDueDate.getMonth() - 1, 1);
  const day = clampDayToMonth(prev.getFullYear(), prev.getMonth(), statementDay);
  return fromTW(new Date(prev.getFullYear(), prev.getMonth(), day));
}

export function cycleMonthKey(d: Date): string {
  return formatTWMonthKey(d);
}

export function billDocId(paymentMethodId: string, cycleMonth: string): string {
  return `${paymentMethodId}__${cycleMonth}`;
}
