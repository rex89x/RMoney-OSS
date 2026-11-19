import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import type { Currency } from '@/types/global';
import { tsToDate } from '@/lib/converters';
import { decodeAttachments, type TxAttachment } from './attachments';

export type { TxAttachment } from './attachments';

export type TxType = 'expense' | 'income' | 'transfer';
/** 記帳表單可選的幣別（快速記帳與編輯交易共用） */
export const TX_CURRENCIES: Currency[] = ['TWD', 'USD', 'JPY', 'EUR', 'IDR'];
export type CategoryType = 'expense' | 'income';
/** `paidByUid` 保留值：共同支出由 household 公基金支付。 */
export const HOUSEHOLD_FUND_PAYER_ID = '__household_fund__';

/**
 * 一筆交易的分攤明細（旅程 / 共同帳本共用同一份）。
 * - `memberId`：有帳號的成員用 uid，純旅伴用名字
 * - `amountTWD`：結算一律用這個（會再按 settledAmountTWD 等比例縮放）
 * - `amount`：原幣金額（選填；非台幣交易用原幣輸入時寫入，省得使用者自己換算）
 */
export interface TxShare {
  memberId: string;
  amountTWD: number;
  amount?: number;
}

/** 誰付的：共同帳本的 paidByUid 優先，再來是旅程的 payerId，最後是建立者 */
export function txPayerId(tx: Pick<Transaction, 'paidByUid' | 'payerId' | 'userId'>): string {
  return tx.paidByUid ?? tx.payerId ?? tx.userId;
}

/** 這筆有沒有「明確的分攤明細」（任何人改過分攤後 myShareTWD 就是建立者那份） */
export function hasExplicitSplit(tx: Pick<Transaction, 'householdId' | 'tripId' | 'customShares' | 'shareType'>): boolean {
  return Boolean(tx.householdId || (tx.tripId && (tx.shareType || (tx.customShares && tx.customShares.length > 0))));
}

export interface TransferGroup {
  role: 'leg';
  pairedTxId?: string;
}

/**
 * 交易明細子項（line item）。一筆 tx 可選擇性列出組成品項，
 * 用於更精細的分攤：例如聚餐有人吃素只分擔素菜部分。
 */
export interface TxLineItem {
  /** 本地 uid，前端 generate */
  id: string;
  name: string;
  amountTWD: number;
  category?: string;
  /** 由哪些 member 名字分攤這項；空陣列代表「所有 trip members 均分」 */
  paidFor?: string[];
  note?: string;
}

/**
 * 實際入帳 TWD — 若有 settledAmountTWD 用它（已結算的真實值），否則 fallback amountTWD（估算）。
 */
export function effectiveAmountTWD(tx: { amountTWD: number; settledAmountTWD?: number | null }): number {
  return tx.settledAmountTWD ?? tx.amountTWD;
}

/**
 * 我自己應負擔的金額（給 dashboard 彙總 / 個人花費用）。
 * - 'self': effective amount
 * - 'i-paid-others' / 'they-paid-mine': myShareTWD（若有），否則 effective
 */
export function personalShareTWD(tx: {
  amountTWD: number;
  settledAmountTWD?: number | null;
  splitMode?: 'self' | 'i-paid-others' | 'they-paid-mine' | null;
  myShareTWD?: number | null;
  householdId?: string | null;
  paidByUid?: string | null;
  tripId?: string | null;
}): number {
  const eff = effectiveAmountTWD(tx);
  if (tx.householdId && tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID) return 0;
  if (tx.splitMode && tx.splitMode !== 'self' && tx.myShareTWD != null) return tx.myShareTWD;
  // 共同帳本 / 旅程分攤：建立者的那份存在 myShareTWD（任何人改分攤時都會重算這個欄位，
  // 所以 ledger / dashboard / Apps Script 看到的「我負擔多少」永遠一致）
  if ((tx.householdId || tx.tripId) && tx.myShareTWD != null) return tx.myShareTWD;
  return eff;
}

/**
 * 進階版：給「Trip context」的個人花費計算。
 *
 * 規則（依 priority）：
 *  1. 一般代墊（splitMode != 'self'） → myShareTWD（若有），否則 effective
 *  2. trip + lineItems：把 paidFor 包含 myId 的品項按人均算總和
 *  3. trip + members + shareType='equal'：effective ÷ members.length
 *  4. trip + members + shareType='payer'：若 payerId == myId → effective，否則 0
 *  5. 預設：effective
 */
export function myExpenseShareTWD(
  tx: Transaction,
  myId: string | null | undefined,
  tripMembersById: string[] = [],
): number {
  const eff = effectiveAmountTWD(tx);

  if (tx.householdId && tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID) return 0;

  if (tx.splitMode && tx.splitMode !== 'self') {
    return tx.myShareTWD ?? eff;
  }

  // 共同帳本分攤：customShares 以 uid 記，優先用；沒有就退回建立者的 myShareTWD
  if (tx.householdId) {
    if (myId && Array.isArray(tx.customShares) && tx.customShares.length > 0) {
      const csTotal = tx.customShares.reduce((s, c) => s + (c.amountTWD || 0), 0);
      const ratio = csTotal > 0 ? eff / csTotal : 1;
      const mine = tx.customShares.find((c) => c.memberId === myId);
      return mine ? (mine.amountTWD || 0) * ratio : 0;
    }
    return tx.myShareTWD ?? eff;
  }

  if (tx.tripId && myId) {
    // 優先序：shareType > lineItems > 預設均分
    if (tx.shareType === 'payer') {
      return tx.payerId === myId ? eff : 0;
    }
    if (tx.shareType === 'custom' && Array.isArray(tx.customShares) && tx.customShares.length > 0) {
      const csTotal = tx.customShares.reduce((s, c) => s + (c.amountTWD || 0), 0);
      const ratio = csTotal > 0 ? eff / csTotal : 1;
      const mineCs = tx.customShares.find((c) => c.memberId === myId);
      return mineCs ? (mineCs.amountTWD || 0) * ratio : 0;
    }
    if (tx.shareType === 'equal' && tripMembersById.length > 0) {
      return eff / tripMembersById.length;
    }
    if (tx.lineItems && tx.lineItems.length > 0) {
      const itemsTotal = tx.lineItems.reduce((s, it) => s + (it.amountTWD || 0), 0);
      const ratio = itemsTotal > 0 ? eff / itemsTotal : 1;
      let mine = 0;
      for (const li of tx.lineItems) {
        const liAmt = (li.amountTWD || 0) * ratio;
        const sharers = (li.paidFor && li.paidFor.length > 0) ? li.paidFor : tripMembersById;
        if (sharers.length > 0 && sharers.includes(myId)) {
          mine += liAmt / sharers.length;
        }
      }
      return mine;
    }
    if (tripMembersById.length > 0) {
      return eff / tripMembersById.length;
    }
  }

  return eff;
}

export function isSettled(tx: { settledAmountTWD?: number | null }): boolean {
  return tx.settledAmountTWD != null;
}

/** 借貸金額：正值=對方欠我，負值=我欠對方，0 = 不算借貸 */
export function loanDeltaTWD(tx: {
  amountTWD: number;
  settledAmountTWD?: number | null;
  splitMode?: 'self' | 'i-paid-others' | 'they-paid-mine' | null;
  myShareTWD?: number | null;
  loanSettledAt?: Date | null;
}): number {
  if (!tx.splitMode || tx.splitMode === 'self') return 0;
  if (tx.loanSettledAt) return 0;
  const eff = effectiveAmountTWD(tx);
  const myShare = tx.myShareTWD ?? 0;
  const owed = Math.max(0, eff - myShare);
  return tx.splitMode === 'i-paid-others' ? owed : -owed;
}

export type TxScope = 'personal' | 'household';

export interface Transaction {
  id: string;
  userId: string;
  type: TxType;
  amount: number;
  currency: Currency;
  amountTWD: number;
  fxRate: number;
  category: string;
  subCategory?: string;
  paymentMethod: string;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  transferGroup?: TransferGroup | null;
  note?: string;
  /** 舊欄位：第一張圖片附件的 URL（存檔時由 attachments 推導，保留給只認 photoUrl 的舊程式碼） */
  photoUrl?: string;
  /** 附件（最多 5 個：圖片 WebP ≤ 500KB / PDF ≤ 5MB）。舊交易只有 photoUrl 時 converter 會映射成 attachments[0] */
  attachments?: TxAttachment[];
  date: Date;
  createdAt: Date;
  updatedAt: Date;
  tripId?: string | null;
  tags?: string[];
  recurringId?: string | null;
  deletedAt?: Date | null;
  /** 家庭共支 vs 個人。trip 自動視為 trip 範疇 */
  scope?: TxScope | null;
  /** 實際結算金額（信用卡帳單入帳後回填）。若有值，展示/彙總用此值 fallback `amountTWD` */
  settledAmountTWD?: number | null;
  /** 結算匯率 = settledAmountTWD / amount */
  settledFxRate?: number | null;
  /** 帳單結算日期 */
  settledAt?: Date | null;
  /** 出遊分攤：誰先付。值可以是 member.uid 或 member.name */
  payerId?: string | null;
  /** 分攤方式 */
  shareType?: 'equal' | 'payer' | 'custom' | null;

  /** 一般記帳的代墊紀錄。
   *  'self'              — 自己付自己用（預設）
   *  'i-paid-others'     — 我先付，對方欠我（counterpartyName + myShareTWD）
   *  'they-paid-mine'    — 對方先付，我欠對方（counterpartyName + myShareTWD）
   */
  splitMode?: 'self' | 'i-paid-others' | 'they-paid-mine' | null;
  /** 對方姓名（自由文字；可同名累計） */
  counterpartyName?: string | null;
  /** 我自己應負擔的 TWD 金額。剩下的（amountTWD - myShareTWD）就是借貸金額 */
  myShareTWD?: number | null;
  /** 借貸已結清日期（收到/還清） */
  loanSettledAt?: Date | null;
  /** 明細品項（可選）。若有，會覆蓋 trip 分攤的計算。 */
  lineItems?: TxLineItem[];
  /** 分攤明細（旅程 / 共同帳本共用）。memberId = uid 或 name；amountTWD 是該成員應付的 TWD，amount 是原幣。
   *  總和應該等於 amountTWD（結算時會按比例縮放到 effectiveAmountTWD）。 */
  customShares?: TxShare[];
  /**
   * 預付款：trip 開始前就付的款（機票 / 簽證 / 接送 / 訂房…）。
   * 這是給 trip detail「預付款」分頁過濾用，不影響 amountTWD 等彙總邏輯。
   * 舊資料沒此欄 → 視為 false。
   */
  prepaid?: boolean;
  /** 電子發票號碼（由發票匯入建立或連結時寫入；匯入去重用） */
  invoiceNumber?: string | null;
  /** 共同帳本 id（features/household）；有值代表這筆是兩人分攤的共同支出 */
  householdId?: string | null;
  /** 共同支出的付款人 uid（預設 = userId）；分攤金額存 customShares（memberId = uid） */
  paidByUid?: string | null;
  /**
   * 公基金負擔、但由某位成員先墊付時的 uid（paidByUid = __household_fund__ 才有意義）。
   * 公基金欠這位成員這筆錢，直到記錄「撥還」（fund_entries type 'reimbursement'）。null = 公基金直接付。
   */
  fundAdvancedBy?: string | null;
  /** 從巧明日常貼上匯入時的穩定來源 ID 與原始內容 hash。 */
  importSourceId?: string | null;
  importSourceHash?: string | null;
}

export interface TransactionInput {
  userId: string;
  type: TxType;
  amount: number;
  currency: Currency;
  amountTWD: number;
  fxRate: number;
  category: string;
  subCategory?: string;
  paymentMethod: string;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  transferGroup?: TransferGroup | null;
  note?: string;
  photoUrl?: string;
  attachments?: TxAttachment[];
  date: Date;
  tripId?: string | null;
  tags?: string[];
  recurringId?: string | null;
  payerId?: string | null;
  shareType?: 'equal' | 'payer' | 'custom' | null;
  splitMode?: 'self' | 'i-paid-others' | 'they-paid-mine' | null;
  counterpartyName?: string | null;
  myShareTWD?: number | null;
  lineItems?: TxLineItem[];
  customShares?: TxShare[];
  scope?: TxScope | null;
  prepaid?: boolean;
  invoiceNumber?: string | null;
  /** 共同帳本 id（features/household）；有值代表這筆是兩人分攤的共同支出 */
  householdId?: string | null;
  /** 共同支出的付款人 uid（預設 = userId）；分攤金額存 customShares（memberId = uid） */
  paidByUid?: string | null;
  /**
   * 公基金負擔、但由某位成員先墊付時的 uid（paidByUid = __household_fund__ 才有意義）。
   * 公基金欠這位成員這筆錢，直到記錄「撥還」（fund_entries type 'reimbursement'）。null = 公基金直接付。
   */
  fundAdvancedBy?: string | null;
  importSourceId?: string | null;
  importSourceHash?: string | null;
}

export interface Category {
  id: string;
  key: string;
  name: string;
  type: CategoryType;
  icon: string;
  color: string;
  order: number;
  budget?: number;
  archivedAt?: Date | null;
}

export interface Budget {
  id: string;
  userId: string;
  month: string; // YYYY-MM
  total: number;
  byCategory: Record<string, number>;
}

export interface Recurring {
  id: string;
  userId: string;
  template: TransactionInput;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly';
  nextDue: Date;
  active: boolean;
  lastGeneratedAt?: Date | null;
  label?: string;
  /** 由訂閱一鍵建立時的來源 subscriptions/{id}（雙向連結，避免固定支出重複計算） */
  subscriptionId?: string | null;
}

/** TxAttachment[] → Firestore（uploadedAt Date → Timestamp）；createTransaction / updateTransaction 共用 */
export function encodeAttachments(attachments: TxAttachment[]): Record<string, unknown>[] {
  return attachments.map((att) => ({
    url: att.url,
    path: att.path,
    name: att.name,
    contentType: att.contentType,
    size: att.size,
    uploadedAt: Timestamp.fromDate(att.uploadedAt),
  }));
}

export const transactionConverter: FirestoreDataConverter<Transaction> = {
  toFirestore: (tx) => {
    const { id: _id, ...rest } = tx as Transaction;
    void _id;
    const out: Record<string, unknown> = {
      ...rest,
      date: Timestamp.fromDate(rest.date),
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
      deletedAt: rest.deletedAt ? Timestamp.fromDate(rest.deletedAt) : null,
      settledAt: rest.settledAt ? Timestamp.fromDate(rest.settledAt) : null,
      settledAmountTWD: rest.settledAmountTWD ?? null,
      settledFxRate: rest.settledFxRate ?? null,
      loanSettledAt: rest.loanSettledAt ? Timestamp.fromDate(rest.loanSettledAt) : null,
      attachments: rest.attachments ? encodeAttachments(rest.attachments) : undefined,
    };
    // Firestore 不接 undefined — 把任何 undefined 欄位移除
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): Transaction => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      type: d.type ?? 'expense',
      amount: d.amount ?? 0,
      currency: d.currency ?? 'TWD',
      amountTWD: d.amountTWD ?? 0,
      fxRate: d.fxRate ?? 1,
      category: d.category ?? 'other',
      subCategory: d.subCategory,
      paymentMethod: d.paymentMethod ?? '現金',
      fromAccountId: d.fromAccountId ?? null,
      toAccountId: d.toAccountId ?? null,
      transferGroup: d.transferGroup ?? null,
      note: d.note,
      photoUrl: typeof d.photoUrl === 'string' && d.photoUrl ? d.photoUrl : undefined,
      attachments: decodeAttachments(d.attachments, d.photoUrl, tsToDate(d.createdAt) ?? tsToDate(d.date) ?? new Date()),
      date: tsToDate(d.date) ?? new Date(),
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
      tripId: d.tripId ?? null,
      tags: d.tags ?? [],
      recurringId: d.recurringId ?? null,
      deletedAt: tsToDate(d.deletedAt),
      settledAmountTWD: d.settledAmountTWD ?? null,
      settledFxRate: d.settledFxRate ?? null,
      settledAt: tsToDate(d.settledAt),
      payerId: d.payerId ?? null,
      shareType: (d.shareType as Transaction['shareType']) ?? null,
      splitMode: (d.splitMode as Transaction['splitMode']) ?? null,
      counterpartyName: d.counterpartyName ?? null,
      myShareTWD: d.myShareTWD ?? null,
      loanSettledAt: tsToDate(d.loanSettledAt),
      lineItems: Array.isArray(d.lineItems) ? (d.lineItems as TxLineItem[]) : undefined,
      customShares: Array.isArray(d.customShares)
        ? (d.customShares as TxShare[]).map((c) => ({
            memberId: String(c.memberId),
            amountTWD: Number(c.amountTWD) || 0,
            ...(typeof c.amount === 'number' ? { amount: c.amount } : {}),
          }))
        : undefined,
      scope: (d.scope as TxScope | null | undefined) ?? null,
      prepaid: d.prepaid === true,
      invoiceNumber: d.invoiceNumber ?? null,
      householdId: d.householdId ?? null,
      paidByUid: d.paidByUid ?? null,
      fundAdvancedBy: typeof d.fundAdvancedBy === 'string' && d.fundAdvancedBy ? d.fundAdvancedBy : null,
      importSourceId: d.importSourceId ?? null,
      importSourceHash: d.importSourceHash ?? null,
    };
  },
};

export const categoryConverter: FirestoreDataConverter<Category> = {
  toFirestore: (c) => {
    const { id: _id, ...rest } = c as Category;
    void _id;
    return {
      ...rest,
      archivedAt: rest.archivedAt ? Timestamp.fromDate(rest.archivedAt) : null,
    };
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      key: d.key ?? snap.id,
      name: d.name ?? snap.id,
      type: d.type ?? 'expense',
      icon: d.icon ?? 'MoreHorizontal',
      color: d.color ?? '#6B7280',
      order: d.order ?? 999,
      budget: d.budget,
      archivedAt: tsToDate(d.archivedAt),
    };
  },
};

export const budgetConverter: FirestoreDataConverter<Budget> = {
  toFirestore: (b) => {
    const { id: _id, ...rest } = b as Budget;
    void _id;
    return rest;
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      month: d.month ?? '',
      total: d.total ?? 0,
      byCategory: d.byCategory ?? {},
    };
  },
};

export const recurringConverter: FirestoreDataConverter<Recurring> = {
  toFirestore: (r) => {
    const { id: _id, ...rest } = r as Recurring;
    void _id;
    return {
      ...rest,
      nextDue: Timestamp.fromDate(rest.nextDue),
      lastGeneratedAt: rest.lastGeneratedAt ? Timestamp.fromDate(rest.lastGeneratedAt) : null,
      template: {
        ...rest.template,
        date: Timestamp.fromDate(rest.template.date),
      },
    };
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    const tpl = d.template ?? {};
    return {
      id: snap.id,
      userId: d.userId ?? '',
      template: {
        ...tpl,
        date: tsToDate(tpl.date) ?? new Date(),
      } as TransactionInput,
      frequency: d.frequency ?? 'monthly',
      nextDue: tsToDate(d.nextDue) ?? new Date(),
      active: d.active ?? true,
      lastGeneratedAt: tsToDate(d.lastGeneratedAt),
      label: d.label,
      subscriptionId: typeof d.subscriptionId === 'string' && d.subscriptionId ? d.subscriptionId : null,
    };
  },
};
