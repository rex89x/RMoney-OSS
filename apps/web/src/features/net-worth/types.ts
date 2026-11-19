/**
 * Net worth — 手動維護的非投資資產 / 負債 / 現金帳戶。
 *
 * Collections:
 *   accounts/{id}          — 主帳戶資料（cash / bank / e_wallet_balance / investment_cash = 流動資產；
 *                            loan = 負債；credit_card = 未繳卡費），見 features/accounts
 *   manual_assets/{id}     — 房產 / 車子 / 收藏品等手動資產
 *   cash_accounts / liabilities — legacy，保留到 2027-01-05（REFACTOR_ACCOUNTS_PLAN.md），已遷移的不重複計
 *
 * 淨值公式（前端 useNetWorthNow 與 Apps Script snapshotNetWorthMonthly 同口徑）：
 *   liquid               = sum(asset-like accounts 現值；外幣帳戶以當日 fx_rates 重估)
 *   investment           = portfolio_snapshots latest .totalValueTWD
 *   manual               = sum(manual_assets.valueTWD)
 *   insurancePension     = sum(insurance accounts cashValueTWD) + sum(pension accounts 現值)
 *   rentalUnrecovered    = sum(active rentals max(0, 成本 − 累積收款))（pitfall #24）
 *   liabilities          = sum(loan accounts)
 *   creditCardOutstanding = sum(credit_card accounts)，fallback 未繳帳單
 *   installmentRemaining = sum(active installment_plans 尚未入帳的期數金額)（features/installments）
 *   netWorth = liquid + investment + manual + insurancePension + rentalUnrecovered − liabilities − creditCardOutstanding − installmentRemaining
 */

import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
import type { Currency } from '@/types/global';

export type CashAccountType = 'checking' | 'savings' | 'time_deposit' | 'cash' | 'other';

export interface CashAccount {
  id: string;
  name: string;
  type: CashAccountType;
  bank?: string | null;
  currency: Currency;
  amount: number;
  /** 換算後 TWD（手動更新時前端算好寫入，凍結時點匯率） */
  amountTWD: number;
  fxRate: number;
  /** 是否計入應急基金水位 */
  countsAsEmergencyFund?: boolean;
  note?: string | null;
  archivedAt?: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

export type ManualAssetType = 'real_estate' | 'vehicle' | 'collectible' | 'other';

export interface ManualAsset {
  id: string;
  name: string;
  type: ManualAssetType;
  valueTWD: number;
  /** 取得日 / 估價日 */
  asOf: Date;
  note?: string | null;
  archivedAt?: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

export type LiabilityType = 'mortgage' | 'car_loan' | 'personal_loan' | 'student_loan' | 'other';

export interface Liability {
  id: string;
  name: string;
  type: LiabilityType;
  /** 剩餘本金（TWD） */
  balanceTWD: number;
  /** 利率（%）— 選填，未來計息用 */
  interestRate?: number | null;
  /** 每月還款（TWD）— 選填 */
  monthlyPayment?: number | null;
  asOf: Date;
  note?: string | null;
  archivedAt?: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

/**
 * 淨值每月快照 — doc id = YYYY-MM。
 * 由 Apps Script 月初寫入；前端可手動觸發補回。
 */
export interface NetWorthSnapshot {
  id: string;
  month: string;
  liquidTWD: number;
  investmentTWD: number;
  manualAssetsTWD: number;
  /**
   * 租賃未回收成本（虛擬資產）— sum(active rentals max(0, 成本 − 累積收款))。
   * 用來抵銷購入時從現金 / 銀行扣掉的那筆，避免雙重扣減。
   * 舊 snapshot 沒寫這個欄位，預設讀 0（向前相容）。
   */
  rentalUnrecoveredTWD: number;
  /**
   * 保險解約金（insurance.cashValueTWD）+ 退休帳戶餘額（pension）。
   * 2026-11 F9 新增，舊 snapshot 讀 0。
   */
  insurancePensionTWD: number;
  liabilitiesTWD: number;
  creditCardOutstandingTWD: number;
  /**
   * 信用卡分期尚未入帳的期數總額（還沒進卡片餘額的未來負債）。
   * 舊 snapshot 沒寫這個欄位，預設讀 0（向前相容）。
   */
  installmentRemainingTWD: number;
  netWorthTWD: number;
  createdAt: Date;
}

// ---------- converters ----------

const stripUndefined = (out: Record<string, unknown>) => {
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
};

export const cashAccountConverter: FirestoreDataConverter<CashAccount> = {
  toFirestore: (a) => {
    const { id: _id, ...rest } = a as CashAccount;
    void _id;
    return stripUndefined({
      ...rest,
      countsAsEmergencyFund: rest.countsAsEmergencyFund ?? false,
      archivedAt: rest.archivedAt ? Timestamp.fromDate(rest.archivedAt) : null,
      updatedAt: Timestamp.fromDate(rest.updatedAt),
      createdAt: Timestamp.fromDate(rest.createdAt),
    });
  },
  fromFirestore: (snap: QueryDocumentSnapshot): CashAccount => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      name: d.name ?? '',
      type: (d.type as CashAccountType) ?? 'savings',
      bank: d.bank ?? null,
      currency: d.currency ?? 'TWD',
      amount: d.amount ?? 0,
      amountTWD: d.amountTWD ?? d.amount ?? 0,
      fxRate: d.fxRate ?? 1,
      countsAsEmergencyFund: d.countsAsEmergencyFund === true,
      note: d.note ?? null,
      archivedAt: tsToDate(d.archivedAt),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
      createdAt: tsToDate(d.createdAt) ?? new Date(),
    };
  },
};

export const manualAssetConverter: FirestoreDataConverter<ManualAsset> = {
  toFirestore: (a) => {
    const { id: _id, ...rest } = a as ManualAsset;
    void _id;
    return stripUndefined({
      ...rest,
      asOf: Timestamp.fromDate(rest.asOf),
      archivedAt: rest.archivedAt ? Timestamp.fromDate(rest.archivedAt) : null,
      updatedAt: Timestamp.fromDate(rest.updatedAt),
      createdAt: Timestamp.fromDate(rest.createdAt),
    });
  },
  fromFirestore: (snap: QueryDocumentSnapshot): ManualAsset => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      name: d.name ?? '',
      type: (d.type as ManualAssetType) ?? 'other',
      valueTWD: d.valueTWD ?? 0,
      asOf: tsToDate(d.asOf) ?? new Date(),
      note: d.note ?? null,
      archivedAt: tsToDate(d.archivedAt),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
      createdAt: tsToDate(d.createdAt) ?? new Date(),
    };
  },
};

export const liabilityConverter: FirestoreDataConverter<Liability> = {
  toFirestore: (l) => {
    const { id: _id, ...rest } = l as Liability;
    void _id;
    return stripUndefined({
      ...rest,
      asOf: Timestamp.fromDate(rest.asOf),
      archivedAt: rest.archivedAt ? Timestamp.fromDate(rest.archivedAt) : null,
      updatedAt: Timestamp.fromDate(rest.updatedAt),
      createdAt: Timestamp.fromDate(rest.createdAt),
    });
  },
  fromFirestore: (snap: QueryDocumentSnapshot): Liability => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      name: d.name ?? '',
      type: (d.type as LiabilityType) ?? 'other',
      balanceTWD: d.balanceTWD ?? 0,
      interestRate: typeof d.interestRate === 'number' ? d.interestRate : null,
      monthlyPayment: typeof d.monthlyPayment === 'number' ? d.monthlyPayment : null,
      asOf: tsToDate(d.asOf) ?? new Date(),
      note: d.note ?? null,
      archivedAt: tsToDate(d.archivedAt),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
      createdAt: tsToDate(d.createdAt) ?? new Date(),
    };
  },
};

export const netWorthSnapshotConverter: FirestoreDataConverter<NetWorthSnapshot> = {
  toFirestore: (s) => {
    const { id: _id, ...rest } = s as NetWorthSnapshot;
    void _id;
    return { ...rest, createdAt: Timestamp.fromDate(rest.createdAt) };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): NetWorthSnapshot => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      month: d.month ?? snap.id,
      liquidTWD: d.liquidTWD ?? 0,
      investmentTWD: d.investmentTWD ?? 0,
      manualAssetsTWD: d.manualAssetsTWD ?? 0,
      rentalUnrecoveredTWD: d.rentalUnrecoveredTWD ?? 0,
      insurancePensionTWD: d.insurancePensionTWD ?? 0,
      liabilitiesTWD: d.liabilitiesTWD ?? 0,
      creditCardOutstandingTWD: d.creditCardOutstandingTWD ?? 0,
      installmentRemainingTWD: d.installmentRemainingTWD ?? 0,
      netWorthTWD: d.netWorthTWD ?? 0,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
    };
  },
};

export const CASH_TYPE_LABEL: Record<CashAccountType, string> = {
  checking: '活期存款',
  savings: '儲蓄存款',
  time_deposit: '定存',
  cash: '現金',
  other: '其他',
};

export const ASSET_TYPE_LABEL: Record<ManualAssetType, string> = {
  real_estate: '不動產',
  vehicle: '車輛',
  collectible: '收藏品',
  other: '其他',
};

export const LIABILITY_TYPE_LABEL: Record<LiabilityType, string> = {
  mortgage: '房貸',
  car_loan: '車貸',
  personal_loan: '個人借款',
  student_loan: '學貸',
  other: '其他',
};
