/**
 * Savings goals — 目標儲蓄
 *
 * UX：
 *   - 設定目標金額、目標日期、icon
 *   - 每筆「存入」用 contributions 子集合（{date, amountTWD, note}）追蹤
 *   - 進度條 + ETA（依過去 90 天平均 contribution rate 推估）
 */

import {
  Timestamp, type DocumentData, type FirestoreDataConverter, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
import { addTWCalendarMonths } from '@/lib/tz';

export interface SavingsGoal {
  id: string;
  name: string;
  targetTWD: number;
  /** 已累計存入（contributions 之和；前端 derive 也可，但這裡同步存方便讀取） */
  currentTWD: number;
  targetDate?: Date | null;
  icon?: string | null;
  color?: string | null;
  archivedAt?: Date | null;
  /** 共同目標：所屬 household id（成員都能存入）；null = 個人目標 */
  householdId?: string | null;
  /** 每月計畫存入（TWD）；有設會顯示「本月已存 / 計畫」並用它估 ETA */
  monthlyPlanTWD?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalContribution {
  id: string;
  date: Date;
  amountTWD: number;
  note?: string | null;
  /** 誰存的（共同目標用；舊資料 / 個人目標為 null） */
  byUid?: string | null;
}

export const goalConverter: FirestoreDataConverter<SavingsGoal> = {
  toFirestore: (g) => {
    const { id: _id, ...rest } = g as SavingsGoal;
    void _id;
    const out: Record<string, unknown> = {
      ...rest,
      targetDate: rest.targetDate ? Timestamp.fromDate(rest.targetDate) : null,
      archivedAt: rest.archivedAt ? Timestamp.fromDate(rest.archivedAt) : null,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): SavingsGoal => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      name: d.name ?? '',
      targetTWD: d.targetTWD ?? 0,
      currentTWD: d.currentTWD ?? 0,
      targetDate: tsToDate(d.targetDate),
      icon: d.icon ?? null,
      color: d.color ?? null,
      archivedAt: tsToDate(d.archivedAt),
      householdId: d.householdId ?? null,
      monthlyPlanTWD: typeof d.monthlyPlanTWD === 'number' ? d.monthlyPlanTWD : null,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};

export const goalContributionConverter: FirestoreDataConverter<GoalContribution> = {
  toFirestore: (c) => {
    const { id: _id, ...rest } = c as GoalContribution;
    void _id;
    return {
      ...rest,
      date: Timestamp.fromDate(rest.date),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): GoalContribution => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      date: tsToDate(d.date) ?? new Date(),
      amountTWD: d.amountTWD ?? 0,
      note: d.note ?? null,
      byUid: d.byUid ?? null,
    };
  },
};

/** 估算 ETA：依過去 90 天平均每月貢獻速度推估剩餘月數；沒有紀錄但有月計畫 → 用月計畫 */
export function estimateGoalEta(g: SavingsGoal, monthlyRate: number): { monthsLeft: number; date: Date | null } {
  const remaining = Math.max(0, g.targetTWD - g.currentTWD);
  const rate = monthlyRate > 0 ? monthlyRate : (g.monthlyPlanTWD ?? 0);
  if (rate <= 0 || remaining === 0) return { monthsLeft: 0, date: null };
  const months = remaining / rate;
  const eta = addTWCalendarMonths(new Date(), Math.ceil(months));
  return { monthsLeft: months, date: eta };
}

/** 依目標日期倒推每月需要存多少（沒目標日期回 null） */
export function requiredMonthlyTWD(g: SavingsGoal, now = new Date()): number | null {
  if (!g.targetDate) return null;
  const remaining = Math.max(0, g.targetTWD - g.currentTWD);
  const months = (g.targetDate.getFullYear() - now.getFullYear()) * 12 + (g.targetDate.getMonth() - now.getMonth());
  if (months <= 0) return remaining;
  return Math.ceil(remaining / months);
}

