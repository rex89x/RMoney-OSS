import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
import type { Currency } from '@/types/global';

export type AccountType =
  | 'cash'
  | 'bank'
  | 'credit_card'
  | 'e_wallet_balance'
  | 'investment_cash'
  | 'loan'
  | 'insurance'
  | 'pension';

export interface CreditCardAccountDetails {
  closingDay: number;
  dueDay: number;
  cardLast4?: string;
  creditLimit?: number;
  linkedSettlementAccountId?: string;
}

export interface LoanAccountDetails {
  principalTWD: number;
  interestRate?: number;
  monthlyPayment: number;
  nextDueDate: Date;
  termMonths?: number;
  linkedSettlementAccountId?: string;
}

export interface EWalletAccountDetails {
  provider: 'jko' | 'linepay' | 'easycard' | 'other';
  autoTopUp?: {
    enabled: boolean;
    sourceAccountId: string;
    thresholdTWD: number;
    topUpAmountTWD: number;
  };
}

export type InsuranceKind = 'life' | 'health' | 'accident' | 'property' | 'savings' | 'other';
export type PremiumFrequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

/**
 * 保單（type = insurance）。
 * 淨值只計 `cashValueTWD`（解約金 / 保單價值）；純保障型沒有現金價值 → 貢獻 0。
 * `balance` 對保單沒有意義（一律 0），不參與帳戶餘額加總。
 */
export interface InsuranceAccountDetails {
  insurer: string;
  policyNo?: string;
  kind: InsuranceKind;
  premiumTWD: number;
  premiumFrequency: PremiumFrequency;
  nextPremiumDate: Date;
  maturityDate?: Date;
  coverageTWD?: number;
  cashValueTWD?: number;
}

/**
 * 退休帳戶（type = pension）：勞退個人專戶 / 自提 / IRA 類。以 `balance` 計入淨值。
 * `monthlySalaryTWD`（月提繳工資）× (雇主 + 自提 %) = 每月提繳，用於退休試算。
 */
export interface PensionAccountDetails {
  provider: string;
  employerContributionPct?: number;
  selfContributionPct?: number;
  monthlySalaryTWD?: number;
  expectedReturnPct?: number;
  retirementAge?: number;
  birthYear?: number;
}

export interface Account {
  id: string;
  ownerId: string;
  name: string;
  type: AccountType;
  currency: Currency;
  active: boolean;
  archivedAt?: Date | null;
  iconKey?: string;
  colorKey?: string;
  note?: string;
  balance: number;
  balanceTWD: number;
  balanceUpdatedAt: Date;
  creditCard?: CreditCardAccountDetails;
  loan?: LoanAccountDetails;
  eWallet?: EWalletAccountDetails;
  insurance?: InsuranceAccountDetails;
  pension?: PensionAccountDetails;
  legacyPaymentMethod?: string | null;
  legacySource?: 'payment_methods' | 'cash_accounts' | 'liabilities' | 'manual' | null;
  /** 上次對帳（輸入實際餘額並自動建調整交易）的時間 */
  lastReconciledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AccountInput = Omit<Account, 'id' | 'createdAt' | 'updatedAt' | 'balanceUpdatedAt'> & {
  balanceUpdatedAt?: Date;
};

function stripUndefined(out: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function encodeCreditCard(details?: CreditCardAccountDetails): Record<string, unknown> | null {
  if (!details) return null;
  return stripUndefined({
    closingDay: details.closingDay,
    dueDay: details.dueDay,
    cardLast4: details.cardLast4,
    creditLimit: details.creditLimit,
    linkedSettlementAccountId: details.linkedSettlementAccountId,
  });
}

function encodeLoan(details?: LoanAccountDetails): Record<string, unknown> | null {
  if (!details) return null;
  return stripUndefined({
    principalTWD: details.principalTWD,
    interestRate: details.interestRate,
    monthlyPayment: details.monthlyPayment,
    nextDueDate: Timestamp.fromDate(details.nextDueDate),
    termMonths: details.termMonths,
    linkedSettlementAccountId: details.linkedSettlementAccountId,
  });
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function encodeInsurance(details?: InsuranceAccountDetails): Record<string, unknown> | null {
  if (!details) return null;
  return stripUndefined({
    insurer: details.insurer,
    policyNo: details.policyNo,
    kind: details.kind,
    premiumTWD: details.premiumTWD,
    premiumFrequency: details.premiumFrequency,
    nextPremiumDate: Timestamp.fromDate(details.nextPremiumDate),
    maturityDate: details.maturityDate ? Timestamp.fromDate(details.maturityDate) : undefined,
    coverageTWD: details.coverageTWD,
    cashValueTWD: details.cashValueTWD,
  });
}

function encodePension(details?: PensionAccountDetails): Record<string, unknown> | null {
  if (!details) return null;
  return stripUndefined({ ...details });
}

const INSURANCE_KINDS: InsuranceKind[] = ['life', 'health', 'accident', 'property', 'savings', 'other'];
const PREMIUM_FREQUENCIES: PremiumFrequency[] = ['monthly', 'quarterly', 'semiannual', 'annual'];

function decodeInsurance(raw: DocumentData | null | undefined): InsuranceAccountDetails | undefined {
  if (!raw) return undefined;
  const kind = INSURANCE_KINDS.includes(raw.kind as InsuranceKind) ? (raw.kind as InsuranceKind) : 'other';
  const premiumFrequency = PREMIUM_FREQUENCIES.includes(raw.premiumFrequency as PremiumFrequency)
    ? (raw.premiumFrequency as PremiumFrequency)
    : 'annual';
  return {
    insurer: typeof raw.insurer === 'string' ? raw.insurer : '',
    policyNo: typeof raw.policyNo === 'string' && raw.policyNo ? raw.policyNo : undefined,
    kind,
    premiumTWD: optionalNumber(raw.premiumTWD) ?? 0,
    premiumFrequency,
    nextPremiumDate: tsToDate(raw.nextPremiumDate) ?? new Date(),
    maturityDate: tsToDate(raw.maturityDate) ?? undefined,
    coverageTWD: optionalNumber(raw.coverageTWD),
    cashValueTWD: optionalNumber(raw.cashValueTWD),
  };
}

function decodePension(raw: DocumentData | null | undefined): PensionAccountDetails | undefined {
  if (!raw) return undefined;
  return {
    provider: typeof raw.provider === 'string' ? raw.provider : '',
    employerContributionPct: optionalNumber(raw.employerContributionPct),
    selfContributionPct: optionalNumber(raw.selfContributionPct),
    monthlySalaryTWD: optionalNumber(raw.monthlySalaryTWD),
    expectedReturnPct: optionalNumber(raw.expectedReturnPct),
    retirementAge: optionalNumber(raw.retirementAge),
    birthYear: optionalNumber(raw.birthYear),
  };
}

/** 給 updateAccount 的 partial patch 用：把 Date 轉 Timestamp（與 converter 同一套 encode） */
export function encodeAccountDetailsPatch(patch: {
  insurance?: InsuranceAccountDetails;
  pension?: PensionAccountDetails;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.insurance) out.insurance = encodeInsurance(patch.insurance);
  if (patch.pension) out.pension = encodePension(patch.pension);
  return out;
}

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  cash: '現金',
  bank: '銀行',
  credit_card: '信用卡',
  e_wallet_balance: '電子錢包',
  investment_cash: '交割帳戶',
  loan: '貸款',
  insurance: '保險',
  pension: '退休帳戶',
};

export const INSURANCE_KIND_LABEL: Record<InsuranceKind, string> = {
  life: '壽險',
  health: '醫療險',
  accident: '意外險',
  property: '產險',
  savings: '儲蓄 / 投資型',
  other: '其他',
};

export const PREMIUM_FREQUENCY_LABEL: Record<PremiumFrequency, string> = {
  monthly: '月繳',
  quarterly: '季繳',
  semiannual: '半年繳',
  annual: '年繳',
};

export const accountConverter: FirestoreDataConverter<Account> = {
  toFirestore: (account) => {
    const { id: _id, ...rest } = account as Account;
    void _id;
    return stripUndefined({
      ...rest,
      active: rest.active,
      archivedAt: rest.archivedAt ? Timestamp.fromDate(rest.archivedAt) : null,
      lastReconciledAt: rest.lastReconciledAt ? Timestamp.fromDate(rest.lastReconciledAt) : null,
      balanceUpdatedAt: Timestamp.fromDate(rest.balanceUpdatedAt),
      creditCard: encodeCreditCard(rest.creditCard),
      loan: encodeLoan(rest.loan),
      eWallet: rest.eWallet ?? null,
      insurance: encodeInsurance(rest.insurance),
      pension: encodePension(rest.pension),
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    });
  },
  fromFirestore: (snap: QueryDocumentSnapshot): Account => {
    const d = snap.data() as DocumentData;
    const loan = d.loan as DocumentData | null | undefined;
    const currency = d.currency ?? 'TWD';
    const storedBalance = numberOrNull(d.balance);
    const storedBalanceTWD = numberOrNull(d.balanceTWD);
    const balance = storedBalance ?? (currency === 'TWD' ? storedBalanceTWD ?? 0 : 0);
    return {
      id: snap.id,
      ownerId: d.ownerId ?? '',
      name: d.name ?? snap.id,
      type: (d.type as AccountType) ?? 'cash',
      currency,
      active: d.active !== false,
      archivedAt: tsToDate(d.archivedAt),
      iconKey: d.iconKey ?? undefined,
      colorKey: d.colorKey ?? undefined,
      note: d.note ?? undefined,
      balance,
      balanceTWD: storedBalanceTWD ?? (currency === 'TWD' ? balance : 0),
      balanceUpdatedAt: tsToDate(d.balanceUpdatedAt) ?? new Date(),
      creditCard: d.creditCard ?? undefined,
      loan: loan
        ? {
            principalTWD: loan.principalTWD ?? 0,
            interestRate: typeof loan.interestRate === 'number' ? loan.interestRate : undefined,
            monthlyPayment: loan.monthlyPayment ?? 0,
            nextDueDate: tsToDate(loan.nextDueDate) ?? new Date(),
            termMonths: typeof loan.termMonths === 'number' ? loan.termMonths : undefined,
            linkedSettlementAccountId: loan.linkedSettlementAccountId ?? undefined,
          }
        : undefined,
      eWallet: d.eWallet ?? undefined,
      insurance: decodeInsurance(d.insurance as DocumentData | null | undefined),
      pension: decodePension(d.pension as DocumentData | null | undefined),
      legacyPaymentMethod: d.legacyPaymentMethod ?? null,
      legacySource: d.legacySource ?? null,
      lastReconciledAt: tsToDate(d.lastReconciledAt),
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};
