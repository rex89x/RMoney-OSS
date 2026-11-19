/**
 * 租賃 / 出租資產：先有一筆大支出買入，後續每月變動金額收回。
 *
 * collection: rentals/{id}
 * incomes 用 embedded array（每月最多一筆，array 不會爆量）。
 * 連動 ledger：
 *   - 建立時：transfer from purchaseAccount → targetAccountId
 *     （targetAccountId 通常是收租帳戶，但租金是慢慢進來、不是建立當下；
 *      所以實際上建立時的 transfer 對方是「manual asset 抽屜」式的虛擬位置——
 *      改用：建立時只寫 expense from purchaseAccount + 額外把 purchaseAmountTWD 紀錄為「資產」。
 *      但這樣 dashboard 月支出會多算一筆——不對。）
 *   - 結論：建立 Rental 時不自動寫 ledger TX，由 user 自己決定要不要寫
 *     （或之後加一個 toggle）；recordIncome 才會寫 income TX。
 */

import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
import { addTWCalendarMonths } from '@/lib/tz';

export type RentalAssetType = 'equipment' | 'vehicle' | 'real_estate' | 'other';

export const RENTAL_ASSET_TYPE_LABEL: Record<RentalAssetType, string> = {
  equipment: '設備 / 機器',
  vehicle: '車輛',
  real_estate: '不動產',
  other: '其他',
};

export interface RentalIncome {
  id: string;
  /** YYYY-MM-DD（記在哪個收款月份） */
  monthKey: string;
  date: Date;
  amountTWD: number;
  /** 連動到 transactions/{id} 的 income TX id */
  txId?: string | null;
  /** 對方 / 承租人（選填） */
  payerName?: string | null;
  note?: string | null;
  createdAt: Date;
}

export interface Rental {
  id: string;
  ownerId: string;
  name: string;
  assetType: RentalAssetType;
  startDate: Date;
  /** 取得成本 TWD */
  purchaseAmountTWD: number;
  /** 預計每月可收金額（顯示參考用） */
  expectedMonthlyIncome: number;
  /** 預期租期月數（選填） */
  expectedMonths?: number | null;
  /** 預設收款進到哪個 account（cash / bank） */
  defaultIncomeAccountId?: string | null;
  status: 'active' | 'closed';
  closedAt?: Date | null;
  note?: string | null;
  /** 每月實收紀錄（最多 N 筆，按 monthKey 反序顯示） */
  incomes: RentalIncome[];
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date | null;
}

export const rentalConverter: FirestoreDataConverter<Rental> = {
  toFirestore: (r) => {
    const { id: _id, ...rest } = r as Rental;
    void _id;
    const out: Record<string, unknown> = {
      ownerId: rest.ownerId,
      name: rest.name,
      assetType: rest.assetType,
      startDate: Timestamp.fromDate(rest.startDate),
      purchaseAmountTWD: rest.purchaseAmountTWD,
      expectedMonthlyIncome: rest.expectedMonthlyIncome,
      expectedMonths: rest.expectedMonths ?? null,
      defaultIncomeAccountId: rest.defaultIncomeAccountId ?? null,
      status: rest.status,
      closedAt: rest.closedAt ? Timestamp.fromDate(rest.closedAt) : null,
      note: rest.note ?? null,
      incomes: (rest.incomes ?? []).map((inc) => ({
        id: inc.id,
        monthKey: inc.monthKey,
        date: Timestamp.fromDate(inc.date),
        amountTWD: inc.amountTWD,
        txId: inc.txId ?? null,
        payerName: inc.payerName ?? null,
        note: inc.note ?? null,
        createdAt: Timestamp.fromDate(inc.createdAt),
      })),
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
      archivedAt: rest.archivedAt ? Timestamp.fromDate(rest.archivedAt) : null,
    };
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): Rental => {
    const d = snap.data() as DocumentData;
    const rawIncomes: unknown = d.incomes;
    return {
      id: snap.id,
      ownerId: d.ownerId ?? '',
      name: d.name ?? '',
      assetType: (d.assetType as RentalAssetType) ?? 'other',
      startDate: tsToDate(d.startDate) ?? new Date(),
      purchaseAmountTWD: Number(d.purchaseAmountTWD ?? 0),
      expectedMonthlyIncome: Number(d.expectedMonthlyIncome ?? 0),
      expectedMonths: typeof d.expectedMonths === 'number' ? d.expectedMonths : null,
      defaultIncomeAccountId: d.defaultIncomeAccountId ?? null,
      status: d.status === 'closed' ? 'closed' : 'active',
      closedAt: tsToDate(d.closedAt),
      note: d.note ?? null,
      incomes: Array.isArray(rawIncomes)
        ? (rawIncomes as DocumentData[]).map((inc) => ({
            id: String(inc.id ?? Math.random().toString(36).slice(2, 10)),
            monthKey: String(inc.monthKey ?? ''),
            date: tsToDate(inc.date) ?? new Date(),
            amountTWD: Number(inc.amountTWD ?? 0),
            txId: inc.txId ?? null,
            payerName: inc.payerName ?? null,
            note: inc.note ?? null,
            createdAt: tsToDate(inc.createdAt) ?? new Date(),
          }))
        : [],
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
      archivedAt: tsToDate(d.archivedAt),
    };
  },
};

export function totalReceivedTWD(r: Rental): number {
  return r.incomes.reduce((s, inc) => s + (inc.amountTWD || 0), 0);
}

export function netPnLTWD(r: Rental): number {
  return totalReceivedTWD(r) - r.purchaseAmountTWD;
}

/**
 * 尚未從租金回收的成本：每筆 active rental 的 max(0, 成本 − 累積收款)。
 * 這個值會被當成「虛擬資產」計入淨值，用來抵銷購入時從現金 / 銀行扣掉的那筆，
 * 避免 dashboard 上「總資產被一筆購入打成負的」的雙重扣減。
 * 已 closed / archived 的 rental 不算。
 */
export function unrecoveredCostTWD(r: Rental): number {
  if (r.status !== 'active') return 0;
  return Math.max(0, r.purchaseAmountTWD - totalReceivedTWD(r));
}

export function totalUnrecoveredCostTWD(rentals: Rental[]): number {
  return rentals.reduce((s, r) => s + unrecoveredCostTWD(r), 0);
}

export function projectedTotalRecoverableTWD(r: Rental): number {
  if (r.status !== 'active') return totalReceivedTWD(r);
  const plannedTotal = r.expectedMonths && r.expectedMonths > 0
    ? r.expectedMonthlyIncome * r.expectedMonths
    : r.purchaseAmountTWD;
  return Math.max(totalReceivedTWD(r), plannedTotal);
}

export function projectedRemainingRecoverableTWD(r: Rental): number {
  if (r.status !== 'active') return 0;
  return Math.max(0, projectedTotalRecoverableTWD(r) - totalReceivedTWD(r));
}

export function totalProjectedRecoverableTWD(rentals: Rental[]): number {
  return rentals.reduce((s, r) => s + projectedTotalRecoverableTWD(r), 0);
}

export function totalProjectedRemainingRecoverableTWD(rentals: Rental[]): number {
  return rentals.reduce((s, r) => s + projectedRemainingRecoverableTWD(r), 0);
}

export function avgMonthlyIncomeTWD(r: Rental): number {
  if (r.incomes.length === 0) return 0;
  return totalReceivedTWD(r) / r.incomes.length;
}

export function paybackProgressPct(r: Rental): number {
  if (r.purchaseAmountTWD <= 0) return 100;
  return Math.min(100, (totalReceivedTWD(r) / r.purchaseAmountTWD) * 100);
}

/**
 * 推估還需要幾個月回本。
 * 給定 monthlyAssumption（預設 = 已收的 avg；不傳就用 expectedMonthlyIncome）；若 ≤ 0 → null（無法估）。
 * 若已回本 → 回 0。
 */
export function estimateMonthsToPayback(
  r: Rental,
  monthlyAssumption?: number,
): number | null {
  const remaining = r.purchaseAmountTWD - totalReceivedTWD(r);
  if (remaining <= 0) return 0;
  const monthly = monthlyAssumption ?? avgMonthlyIncomeTWD(r) ?? r.expectedMonthlyIncome;
  if (!monthly || monthly <= 0) return null;
  return remaining / monthly;
}

export function projectedPaybackDate(
  r: Rental,
  monthlyAssumption?: number,
  baseDate: Date = new Date(),
): Date | null {
  const months = estimateMonthsToPayback(r, monthlyAssumption);
  if (months == null) return null;
  if (months === 0) return baseDate;
  const whole = Math.floor(months);
  const target = addTWCalendarMonths(baseDate, whole);
  const fracDays = Math.round((months - whole) * 30);
  target.setDate(target.getDate() + fracDays);
  return target;
}
