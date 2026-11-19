/**
 * 信用卡分期付款計畫（installment_plans，owner-only）。
 *
 * 每期在「首期日 + (i − 1) 個月」由 Apps Script `runInstallmentPlans`（tick_daily_0100）
 * 入帳一筆 expense 到信用卡帳戶（tx id `inst_{planId}_{i}`，冪等）。前端只負責建立 / 取消 / 顯示。
 */
import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

export type InstallmentStatus = 'active' | 'completed' | 'cancelled';

export const INSTALLMENT_STATUS_LABEL: Record<InstallmentStatus, string> = {
  active: '進行中',
  completed: '已繳完',
  cancelled: '已取消',
};

/** 常見期數（表單快捷選項） */
export const INSTALLMENT_PERIOD_OPTIONS = [3, 6, 12, 24] as const;

/** 分期交易固定掛的標籤（GAS 入帳時寫入） */
export const INSTALLMENT_TAG = '分期';

export interface InstallmentPlan {
  id: string;
  ownerId: string;
  title: string;
  /** 商品總價（不含手續費） */
  totalAmountTWD: number;
  periods: number;
  /** 每期金額 = floor((totalAmountTWD + feeTWD) / periods)；最後一期吸收尾差 */
  perPeriodTWD: number;
  /** 手續費 / 利息總額（0% 分期為 0），平均攤入各期 */
  feeTWD: number;
  /** accounts/{id}，type = credit_card */
  cardAccountId: string;
  category: string;
  /** 第 1 期入帳日（台北日期） */
  startDate: Date;
  /** 已入帳期數（GAS 推進） */
  paidPeriods: number;
  status: InstallmentStatus;
  note?: string | null;
  lastPostedAt?: Date | null;
  cancelledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InstallmentPlanInput {
  ownerId: string;
  title: string;
  totalAmountTWD: number;
  periods: number;
  feeTWD: number;
  cardAccountId: string;
  category: string;
  startDate: Date;
  note?: string | null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export const installmentPlanConverter: FirestoreDataConverter<InstallmentPlan> = {
  toFirestore: (plan) => {
    const { id: _id, ...rest } = plan as InstallmentPlan;
    void _id;
    const out: Record<string, unknown> = {
      ...rest,
      note: rest.note ?? null,
      startDate: Timestamp.fromDate(rest.startDate),
      lastPostedAt: rest.lastPostedAt ? Timestamp.fromDate(rest.lastPostedAt) : null,
      cancelledAt: rest.cancelledAt ? Timestamp.fromDate(rest.cancelledAt) : null,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): InstallmentPlan => {
    const d = snap.data() as DocumentData;
    const periods = Math.max(1, Math.round(numberOr(d.periods, 1)));
    const status: InstallmentStatus = d.status === 'completed' || d.status === 'cancelled' ? d.status : 'active';
    return {
      id: snap.id,
      ownerId: d.ownerId ?? '',
      title: d.title ?? '',
      totalAmountTWD: numberOr(d.totalAmountTWD, 0),
      periods,
      perPeriodTWD: numberOr(d.perPeriodTWD, -1),
      feeTWD: numberOr(d.feeTWD, 0),
      cardAccountId: d.cardAccountId ?? '',
      category: d.category ?? 'other',
      startDate: tsToDate(d.startDate) ?? new Date(),
      paidPeriods: Math.max(0, Math.min(periods, Math.round(numberOr(d.paidPeriods, 0)))),
      status,
      note: d.note ?? null,
      lastPostedAt: tsToDate(d.lastPostedAt),
      cancelledAt: tsToDate(d.cancelledAt),
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};
