import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
export { HOUSEHOLD_FUND_PAYER_ID } from '@/features/ledger/types';

/**
 * Household（共同帳本）— 兩人（或多人）共用的分帳空間。
 *
 * - 交易仍存在 `transactions`（各自 userId），只多帶 `householdId` / `paidByUid` / `customShares`
 * - 誰欠誰 = Σ(付款人墊付 − 自己那份) − 已結算金額（settlements 子集合）
 * - 成員以 email 邀請：Apps Script `inviteHouseholdMember` 把 email 加進白名單 + `pendingInvites`，
 *   對方首次登入時 `acceptPendingInvites` 把 uid 加進 `memberIds`
 */

/** 成員權限（owner 永遠全開；沒設定 = 預設值） */
export type MemberPermissionKey = 'canAddExpense' | 'canSettle' | 'canManageFund' | 'canManageGoals' | 'canManageInvestments' | 'canEditSettings';
export type MemberPermissions = Partial<Record<MemberPermissionKey, boolean>>;

export const MEMBER_PERMISSION_DEFAULT: Record<MemberPermissionKey, boolean> = {
  canAddExpense: true,
  canSettle: true,
  canManageFund: true,
  canManageGoals: true,
  canManageInvestments: true,
  canEditSettings: false,
};

export const MEMBER_PERMISSION_LABEL: Record<MemberPermissionKey, { label: string; hint: string }> = {
  canAddExpense: { label: '新增共同支出／公基金', hint: '可以記共同支出、存入公基金（只能刪改自己記的）' },
  canSettle: { label: '結算', hint: '可以記錄結算 / 刪除自己建立的結算' },
  canManageFund: { label: '公基金管理', hint: '可以看到並記錄「公基金撥還代墊」、調整每月計畫、指定公基金保管人' },
  canManageGoals: { label: '共同目標', hint: '可以新增 / 存入共同目標' },
  canManageInvestments: { label: '共同投資', hint: '可以記錄共同持有的股票、修改共同投資計畫（自己的個人持股永遠可以改）' },
  canEditSettings: { label: '修改設定', hint: '可以改名稱、分攤比例、共同預算與成員顏色' },
};

export interface HouseholdMember {
  uid: string;
  displayName: string;
  email?: string | null;
  color?: string | null;
  permissions?: MemberPermissions | null;
}

/** 成員能不能做某件事：owner 永遠可以；其他人看 permissions，沒設就用預設 */
export function memberCan(household: Household | null | undefined, uid: string | null | undefined, key: MemberPermissionKey): boolean {
  if (!household || !uid) return false;
  if (household.ownerId === uid) return true;
  if (!household.memberIds.includes(uid)) return false;
  const v = household.members[uid]?.permissions?.[key];
  return v == null ? MEMBER_PERMISSION_DEFAULT[key] : v;
}

export type HouseholdReportFrequency = 'daily' | 'weekly' | 'monthly';

/** 共同帳本獨立 Telegram 報告（Apps Script runHouseholdReports，每天 21:00 依頻率判斷） */
export interface HouseholdReportSettings {
  enabled: boolean;
  frequency: HouseholdReportFrequency;
  includeLedger: boolean;
  includeInvestments: boolean;
}

export const HOUSEHOLD_REPORT_DEFAULT: HouseholdReportSettings = {
  enabled: false,
  frequency: 'weekly',
  includeLedger: true,
  includeInvestments: true,
};

export const HOUSEHOLD_REPORT_FREQUENCY_LABEL: Record<HouseholdReportFrequency, string> = {
  daily: '每天 21:00',
  weekly: '每週日 21:00',
  monthly: '每月 1 號 21:00',
};

/** 共同投資計畫（household.investmentPlan） */
export interface JointInvestmentPlan {
  name: string;
  targetAmountTWD: number;
  targetDate: Date | null;
  expectedAnnualReturnPct: number;
  /** 每人每月預計投入（TWD），key = uid */
  monthlyContributionTWD: Record<string, number>;
}

/** 公基金固定扣款（例：房租、水電、Netflix），每月到日由 Apps Script 從公基金建立一筆共同支出 */
export interface HouseholdFundFixedExpense {
  /** 穩定 id（交易 id 用它組成，改名不影響冪等） */
  id: string;
  name: string;
  amountTWD: number;
  categoryKey: string;
  /** 1–31；超過當月天數就用月底 */
  dayOfMonth: number;
  enabled: boolean;
}

/**
 * 公基金每月計畫（household.fundPlan）。兩人每月固定投入，部分支出固定從公基金扣款。
 * Apps Script `runHouseholdFundPlans`（每天 01:00）依此自動記錄；規則見 `fund-plan.ts`。
 */
export interface HouseholdFundPlan {
  enabled: boolean;
  /** 每月存入日（1–31，超過當月天數用月底） */
  dayOfMonth: number;
  /** 從哪個月開始（'yyyy-MM'）；之前的月份不回補 */
  startMonth: string;
  /** 到日自動替每位成員記一筆存入；關閉時只提醒、由本人按「記錄本月存入」 */
  autoRecord: boolean;
  /** 每位成員每月投入（TWD），key = uid */
  contributions: Record<string, number>;
  fixedExpenses: HouseholdFundFixedExpense[];
}

export interface Household {
  id: string;
  name: string;
  ownerId: string;
  memberIds: string[];
  members: Record<string, HouseholdMember>;
  /** 已邀請但尚未首次登入的 email（小寫） */
  pendingInvites: string[];
  /** 預設分攤比例（%），key = uid；沒列到的成員視為 0；總和應為 100 */
  splitRatio: Record<string, number>;
  /** 共同月預算（TWD），null = 未設定 */
  monthlyBudgetTWD?: number | null;
  /** 類別月預算（TWD），key = category key；沒列到 = 不設限 */
  categoryBudgets?: Record<string, number>;
  /** 邀請碼：對方用 /login?join=CODE 登入即可加入（不用先進白名單）；null = 未產生 */
  inviteCode?: string | null;
  /**
   * 邀請碼到期時間（產生後 24 小時；Apps Script joinHousehold 會拒絕過期碼，成功加入後也會清掉碼 → 單次使用）。
   * null = 舊資料沒有到期時間，視為已過期要重設（2026-11 稽核 S4）。
   */
  inviteCodeExpiresAt?: Date | null;
  /** 新建旅程自動分享給其他成員 */
  autoShareTrips?: boolean;
  /**
   * 個人支出分享：`ledgerSharing[分享者 uid] = [看得到的 uid]`。
   * 這裡只是給 UI 判斷要不要顯示分頁用的鏡像；rules 的判斷依據是
   * `users/{分享者 uid}.ledgerSharedWith`，兩者由 `setLedgerSharing()` 用 batch 一起寫。
   */
  ledgerSharing?: Record<string, string[]>;
  /**
   * 個人支出「可編輯」：`ledgerEditing[分享者 uid] = [可以編輯的 uid]`，一定是 ledgerSharing 的子集合。
   * 同樣只是 UI 鏡像；rules 看的是 `users/{分享者 uid}.ledgerEditors`。
   */
  ledgerEditing?: Record<string, string[]>;
  /** 共同投資計畫；null = 還沒設 */
  investmentPlan?: JointInvestmentPlan | null;
  /** 共同帳本 Telegram 報告設定；null = 沒設（視同關閉） */
  householdReport?: HouseholdReportSettings | null;
  /** 公基金保管人：公基金帳戶在誰手上（撥還代墊由他轉帳）；null = 未指定 */
  fundKeeperUid?: string | null;
  /** 公基金每月計畫；null = 還沒設 */
  fundPlan?: HouseholdFundPlan | null;
  /** Apps Script 自動存入的執行紀錄：`c:{uid}` → 最後處理的 'yyyy-MM'（前端唯讀） */
  fundPlanRuns?: Record<string, string>;
  /** 哪些成員已綁定 Telegram（Apps Script 寫的 UI 鏡像；真正的綁定在 telegram_links/{uid}） */
  telegramLinked?: Record<string, boolean>;
  createdAt: Date;
  updatedAt: Date;
}

export type HouseholdInput = Omit<Household, 'id' | 'createdAt' | 'updatedAt'>;

export interface Settlement {
  id: string;
  /** 付錢的人 */
  fromUid: string;
  /** 收錢的人 */
  toUid: string;
  amountTWD: number;
  date: Date;
  note?: string | null;
  createdBy: string;
  /** 若同時在自己的帳本記了一筆收款 / 付款，這裡記 tx id 方便追蹤 */
  linkedTxId?: string | null;
  createdAt: Date;
}

/**
 * contribution = 成員存入；adjustment = 餘額調整（舊資料）；
 * reimbursement = 公基金撥還給先墊付的成員（contributorUid = 收款人），只動「實際現金」不動帳上可用餘額。
 */
export type HouseholdFundEntryType = 'contribution' | 'adjustment' | 'reimbursement';

/** 公基金入金／餘額調整。共同支出若由公基金付款，直接從 fund balance 扣除。 */
export interface HouseholdFundEntry {
  id: string;
  type: HouseholdFundEntryType;
  amountTWD: number;
  contributorUid: string | null;
  note: string | null;
  date: Date;
  /** 屬於哪個月的「每月固定存入」（'yyyy-MM'）；一般臨時存入為 null */
  planMonth?: string | null;
  /** 'plan' = Apps Script 依每月計畫自動記錄；'manual' 或 null = 手動 */
  source?: 'plan' | 'manual' | null;
  createdBy: string;
  createdAt: Date;
}

export type HouseholdFundEntryInput = Omit<HouseholdFundEntry, 'id' | 'createdAt'>;

export type SettlementInput = Omit<Settlement, 'id' | 'createdAt'>;

export const MEMBER_COLORS = ['#3b82f6', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'];

function normalizeLedgerSharing(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [sharerUid, viewers] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(viewers)) out[sharerUid] = viewers.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

/** 我（viewerUid）看得到誰的個人支出？回傳分享者 uid 清單（排除自己） */
export function ledgerSharersFor(household: Household | null | undefined, viewerUid: string | null | undefined): string[] {
  if (!household || !viewerUid) return [];
  return household.memberIds.filter(
    (uid) => uid !== viewerUid && (household.ledgerSharing?.[uid] ?? []).includes(viewerUid),
  );
}

/** 我（sharerUid）有沒有把個人支出分享給 viewerUid？ */
export function sharesLedgerWith(
  household: Household | null | undefined,
  sharerUid: string | null | undefined,
  viewerUid: string,
): boolean {
  if (!household || !sharerUid) return false;
  return (household.ledgerSharing?.[sharerUid] ?? []).includes(viewerUid);
}

/**
 * editorUid 能不能編輯 ownerUid 的個人支出？
 * 自己的永遠可以；別人的要對方同時開了「可看」與「可編輯」（鏡像值，真正擋關的是 rules）。
 */
export function canEditLedgerOf(
  household: Household | null | undefined,
  editorUid: string | null | undefined,
  ownerUid: string | null | undefined,
): boolean {
  if (!editorUid || !ownerUid) return false;
  if (editorUid === ownerUid) return true;
  if (!household) return false;
  return sharesLedgerWith(household, ownerUid, editorUid)
    && (household.ledgerEditing?.[ownerUid] ?? []).includes(editorUid);
}

function normalizeInvestmentPlan(raw: unknown): JointInvestmentPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const target = typeof d.targetAmountTWD === 'number' ? d.targetAmountTWD : 0;
  if (target <= 0) return null;
  const monthly: Record<string, number> = {};
  if (d.monthlyContributionTWD && typeof d.monthlyContributionTWD === 'object') {
    for (const [k, v] of Object.entries(d.monthlyContributionTWD as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) monthly[k] = v;
    }
  }
  return {
    name: typeof d.name === 'string' && d.name ? d.name : '共同投資目標',
    targetAmountTWD: target,
    targetDate: tsToDate(d.targetDate),
    expectedAnnualReturnPct: typeof d.expectedAnnualReturnPct === 'number' ? d.expectedAnnualReturnPct : 5,
    monthlyContributionTWD: monthly,
  };
}

function normalizeReportSettings(raw: unknown): HouseholdReportSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  return {
    enabled: d.enabled === true,
    frequency: d.frequency === 'daily' || d.frequency === 'monthly' ? d.frequency : 'weekly',
    includeLedger: d.includeLedger !== false,
    includeInvestments: d.includeInvestments !== false,
  };
}

function normalizeFundPlan(raw: unknown): HouseholdFundPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const clampDay = (value: unknown) => Math.min(31, Math.max(1, Math.round(Number(value) || 1)));
  const contributions: Record<string, number> = {};
  if (d.contributions && typeof d.contributions === 'object') {
    for (const [uid, value] of Object.entries(d.contributions as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) contributions[uid] = Math.round(value);
    }
  }
  const fixedExpenses: HouseholdFundFixedExpense[] = Array.isArray(d.fixedExpenses)
    ? (d.fixedExpenses as unknown[]).flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const e = item as Record<string, unknown>;
        const amount = Number(e.amountTWD);
        if (typeof e.id !== 'string' || !e.id || !Number.isFinite(amount) || amount <= 0 || typeof e.categoryKey !== 'string') return [];
        return [{
          id: e.id,
          name: typeof e.name === 'string' ? e.name : '',
          amountTWD: Math.round(amount),
          categoryKey: e.categoryKey,
          dayOfMonth: clampDay(e.dayOfMonth),
          enabled: e.enabled !== false,
        }];
      })
    : [];
  return {
    enabled: d.enabled === true,
    dayOfMonth: clampDay(d.dayOfMonth),
    startMonth: typeof d.startMonth === 'string' && /^\d{4}-\d{2}$/.test(d.startMonth) ? d.startMonth : '',
    autoRecord: d.autoRecord === true,
    contributions,
    fixedExpenses,
  };
}

function normalizePositiveMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.round(v);
  }
  return out;
}

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

function normalizeBoolMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v === true) out[k] = true;
  return out;
}

export const householdConverter: FirestoreDataConverter<Household> = {
  toFirestore: (h) => {
    const { id: _id, ...rest } = h as Household;
    void _id;
    return {
      ...rest,
      monthlyBudgetTWD: rest.monthlyBudgetTWD ?? null,
      categoryBudgets: rest.categoryBudgets ?? {},
      inviteCode: rest.inviteCode ?? null,
      inviteCodeExpiresAt: rest.inviteCodeExpiresAt ? Timestamp.fromDate(rest.inviteCodeExpiresAt) : null,
      autoShareTrips: rest.autoShareTrips === true,
      ledgerSharing: rest.ledgerSharing ?? {},
      ledgerEditing: rest.ledgerEditing ?? {},
      investmentPlan: rest.investmentPlan
        ? { ...rest.investmentPlan, targetDate: rest.investmentPlan.targetDate ? Timestamp.fromDate(rest.investmentPlan.targetDate) : null }
        : null,
      householdReport: rest.householdReport ?? null,
      telegramLinked: rest.telegramLinked ?? {},
      fundPlan: rest.fundPlan ?? null,
      fundKeeperUid: rest.fundKeeperUid ?? null,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): Household => {
    const d = snap.data() as DocumentData;
    const members = (d.members ?? {}) as Record<string, Partial<HouseholdMember>>;
    const memberIds = Array.isArray(d.memberIds) ? (d.memberIds as string[]) : [];
    const normalizedMembers: Record<string, HouseholdMember> = {};
    for (const uid of memberIds) {
      const m = members[uid] ?? {};
      normalizedMembers[uid] = {
        uid,
        displayName: m.displayName || m.email || uid.slice(0, 6),
        email: m.email ?? null,
        color: m.color ?? null,
        // 一律正規化成 {}；寫回去時才不會把 null 存進 Firestore（rules 會因此 runtime error，見 api.ts）
        permissions: (m.permissions as MemberPermissions | null | undefined) ?? {},
      };
    }
    return {
      id: snap.id,
      name: d.name ?? '共同帳本',
      ownerId: d.ownerId ?? '',
      memberIds,
      members: normalizedMembers,
      pendingInvites: Array.isArray(d.pendingInvites) ? (d.pendingInvites as string[]) : [],
      splitRatio: (d.splitRatio ?? {}) as Record<string, number>,
      monthlyBudgetTWD: typeof d.monthlyBudgetTWD === 'number' ? d.monthlyBudgetTWD : null,
      categoryBudgets: normalizePositiveMap(d.categoryBudgets),
      inviteCode: typeof d.inviteCode === 'string' && d.inviteCode ? d.inviteCode : null,
      inviteCodeExpiresAt: tsToDate(d.inviteCodeExpiresAt),
      autoShareTrips: d.autoShareTrips === true,
      ledgerSharing: normalizeLedgerSharing(d.ledgerSharing),
      ledgerEditing: normalizeLedgerSharing(d.ledgerEditing),
      investmentPlan: normalizeInvestmentPlan(d.investmentPlan),
      householdReport: normalizeReportSettings(d.householdReport),
      telegramLinked: normalizeBoolMap(d.telegramLinked),
      fundPlan: normalizeFundPlan(d.fundPlan),
      fundKeeperUid: typeof d.fundKeeperUid === 'string' && memberIds.includes(d.fundKeeperUid) ? d.fundKeeperUid : null,
      fundPlanRuns: normalizeStringMap(d.fundPlanRuns),
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};

export const settlementConverter: FirestoreDataConverter<Settlement> = {
  toFirestore: (s) => {
    const { id: _id, ...rest } = s as Settlement;
    void _id;
    return {
      ...rest,
      note: rest.note ?? null,
      linkedTxId: rest.linkedTxId ?? null,
      date: Timestamp.fromDate(rest.date),
      createdAt: Timestamp.fromDate(rest.createdAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): Settlement => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      fromUid: d.fromUid ?? '',
      toUid: d.toUid ?? '',
      amountTWD: typeof d.amountTWD === 'number' ? d.amountTWD : 0,
      date: tsToDate(d.date) ?? new Date(),
      note: d.note ?? null,
      createdBy: d.createdBy ?? '',
      linkedTxId: d.linkedTxId ?? null,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
    };
  },
};

export const householdFundEntryConverter: FirestoreDataConverter<HouseholdFundEntry> = {
  toFirestore: (entry) => {
    const { id: _id, ...rest } = entry as HouseholdFundEntry;
    void _id;
    return {
      ...rest,
      contributorUid: rest.contributorUid ?? null,
      note: rest.note ?? null,
      planMonth: rest.planMonth ?? null,
      source: rest.source ?? 'manual',
      date: Timestamp.fromDate(rest.date),
      createdAt: Timestamp.fromDate(rest.createdAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): HouseholdFundEntry => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      type: d.type === 'adjustment' || d.type === 'reimbursement' ? d.type : 'contribution',
      amountTWD: typeof d.amountTWD === 'number' ? d.amountTWD : 0,
      contributorUid: typeof d.contributorUid === 'string' ? d.contributorUid : null,
      note: typeof d.note === 'string' ? d.note : null,
      date: tsToDate(d.date) ?? new Date(),
      planMonth: typeof d.planMonth === 'string' ? d.planMonth : null,
      source: d.source === 'plan' ? 'plan' : 'manual',
      createdBy: typeof d.createdBy === 'string' ? d.createdBy : '',
      createdAt: tsToDate(d.createdAt) ?? new Date(),
    };
  },
};

/** 結算時可選的分攤方式 */
export type HouseholdSplitMode = 'ratio' | 'equal' | 'payer' | 'custom';

export const HOUSEHOLD_SPLIT_LABEL: Record<HouseholdSplitMode, string> = {
  ratio: '依預設比例',
  equal: '均分',
  payer: '全由付款人負擔',
  custom: '自訂金額',
};

/** 共同帳結算用的類別 key（記入自己帳本時用；forecast / 異常偵測排除） */
export const HOUSEHOLD_SETTLEMENT_CATEGORY = 'household_settlement';
export const HOUSEHOLD_SETTLEMENT_INCOME_CATEGORY = 'household_settlement_income';
