import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit as qLimit,
  orderBy,
  query,
  runTransaction,
  Timestamp,
  type Transaction as FirestoreTransaction,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Currency } from '@/types/global';
import type { Account, AccountType } from '@/features/accounts';
import { currencyToTwdRate } from '@/features/accounts/valuation';
import { accountConverter } from '@/features/accounts/types';
import { listFxRates } from '@/features/fx/api';
import type { FxRate } from '@/features/fx/types';
import {
  Budget,
  budgetConverter,
  Category,
  categoryConverter,
  encodeAttachments,
  Recurring,
  recurringConverter,
  Transaction,
  transactionConverter,
  TransactionInput,
} from './types';
import { legacyPhotoUrlFor, MAX_TX_ATTACHMENTS } from './attachments';

export const txCol = () => collection(db, 'transactions').withConverter(transactionConverter);
export const catCol = () => collection(db, 'categories').withConverter(categoryConverter);
export const budgetCol = () => collection(db, 'budgets').withConverter(budgetConverter);
export const recurringCol = () => collection(db, 'recurring').withConverter(recurringConverter);

export function createTransactionId(): string {
  return doc(collection(db, 'transactions')).id;
}

type AccountDirection = 'in' | 'out';

interface AccountAdjustment {
  accountId: string;
  direction: AccountDirection;
  amount: number;
  currency: Currency;
  amountTWD: number;
}

interface AccountAdjustmentEntry {
  adjustment: AccountAdjustment;
  multiplier: 1 | -1;
}

function stripUndefinedFields<T extends Record<string, unknown>>(input: T): T {
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) delete input[key];
  }
  return input;
}

function isDebtAccount(type: AccountType): boolean {
  return type === 'credit_card' || type === 'loan';
}

function signedAccountDelta(type: AccountType, direction: AccountDirection, amountTWD: number): number {
  if (isDebtAccount(type)) return direction === 'in' ? -amountTWD : amountTWD;
  return direction === 'in' ? amountTWD : -amountTWD;
}

function accountBalanceDelta(
  account: Account,
  adj: AccountAdjustment,
  signedTWD: number,
  fxRates: FxRate[],
): number {
  if (account.currency === adj.currency) {
    return signedTWD >= 0 ? Math.abs(adj.amount) : -Math.abs(adj.amount);
  }
  if (account.currency === 'TWD') return signedTWD;
  const rate = currencyToTwdRate(account.currency, fxRates);
  return rate > 0 ? signedTWD / rate : 0;
}

function adjustmentsForTransaction(tx: Pick<Transaction, 'type' | 'amount' | 'currency' | 'amountTWD' | 'fromAccountId' | 'toAccountId'>): AccountAdjustment[] {
  const rows: AccountAdjustment[] = [];
  const base = {
    amount: tx.amount,
    currency: tx.currency,
    amountTWD: tx.amountTWD,
  };
  if ((tx.type === 'expense' || tx.type === 'transfer') && tx.fromAccountId) {
    rows.push({ ...base, accountId: tx.fromAccountId, direction: 'out' });
  }
  if ((tx.type === 'income' || tx.type === 'transfer') && tx.toAccountId) {
    rows.push({ ...base, accountId: tx.toAccountId, direction: 'in' });
  }
  return rows;
}

/**
 * 匯率只在「真的要動到帳戶餘額」時才讀。
 * `fx_rates` 的 rules 限 owner，共同帳本的 member 改／刪自己那筆共同支出時
 * （沒有帳戶、不會產生 adjustment）若無條件讀就會 permission-denied。
 * 回傳的 loader 會 memoize，runTransaction retry 時不會重打。
 */
function lazyFxRates(): () => Promise<FxRate[]> {
  let cached: Promise<FxRate[]> | null = null;
  return () => {
    cached ??= listFxRates();
    return cached;
  };
}

async function applyAccountAdjustments(
  txRunner: FirestoreTransaction,
  entries: AccountAdjustmentEntry[],
  loadFxRates: () => Promise<FxRate[]>,
  requiredOwnerId?: string,
): Promise<void> {
  if (entries.length === 0) return;
  const byAccount = new Map<string, AccountAdjustmentEntry[]>();
  for (const entry of entries) {
    const rows = byAccount.get(entry.adjustment.accountId) ?? [];
    rows.push(entry);
    byAccount.set(entry.adjustment.accountId, rows);
  }

  const snapshots: Array<{
    ref: ReturnType<typeof doc>;
    account: Account;
    entries: AccountAdjustmentEntry[];
  }> = [];
  for (const [accountId, accountEntries] of byAccount.entries()) {
    const accountRef = doc(db, 'accounts', accountId);
    // 走 accountConverter：Timestamp → Date、餘額欄位正規化（以前直接 `.data() as Account`，稽核 H2）
    const accountSnap = await txRunner.get(accountRef.withConverter(accountConverter));
    const account = accountSnap.data();
    if (!account) {
      if (requiredOwnerId) throw new Error('付款帳戶不存在');
      continue;
    }
    if (requiredOwnerId && (account.ownerId !== requiredOwnerId || account.active === false || account.archivedAt)) {
      throw new Error('付款帳戶不屬於目前使用者或已停用');
    }
    snapshots.push({
      ref: accountRef,
      account,
      entries: accountEntries,
    });
  }

  if (snapshots.length === 0) return;
  // 匯率只在外幣帳戶才用得到（accountBalanceDelta / balanceTWD）；台幣帳戶不再每筆多打一次 fx_rates 查詢。
  const needsFx = snapshots.some((row) => row.account.currency !== 'TWD');
  const fxRates = needsFx ? await loadFxRates() : [];

  for (const row of snapshots) {
    const raw = row.account;
    const accountType = (raw.type ?? 'cash') as AccountType;
    const currentBalance = typeof raw.balance === 'number' ? raw.balance : 0;
    let balanceDelta = 0;
    for (const entry of row.entries) {
      const adj = entry.adjustment;
      const signedTWD = signedAccountDelta(accountType, adj.direction, adj.amountTWD) * entry.multiplier;
      balanceDelta += accountBalanceDelta(raw, adj, signedTWD, fxRates);
    }
    const nextBalance = currentBalance + balanceDelta;
    const nextBalanceTWD = raw.currency === 'TWD'
      ? nextBalance
      : nextBalance * currencyToTwdRate(raw.currency, fxRates);
    txRunner.update(row.ref, {
      balance: nextBalance,
      balanceTWD: nextBalanceTWD,
      balanceUpdatedAt: Timestamp.fromDate(new Date()),
      updatedAt: Timestamp.fromDate(new Date()),
    });
  }
}

// ------- Transactions -------

export interface ListTxFilters {
  userId: string;
  startDate?: Date;
  endDate?: Date;
  tripId?: string | null;
  category?: string;
  type?: Transaction['type'];
  /** 'personal' | 'household'；trip 範疇用 tripId 過濾即可 */
  scope?: 'personal' | 'household';
  limit?: number;
}

export async function listTransactions(f: ListTxFilters): Promise<Transaction[]> {
  const constraints = [];
  if (f.tripId) {
    // 查 trip 花費：不一定是自己的 userId（可能是被分享 trip 的主人花的）
    constraints.push(where('tripId', '==', f.tripId));
  } else {
    constraints.push(where('userId', '==', f.userId));
  }
  if (f.category) constraints.push(where('category', '==', f.category));
  if (f.type) constraints.push(where('type', '==', f.type));
  if (f.startDate) constraints.push(where('date', '>=', Timestamp.fromDate(f.startDate)));
  if (f.endDate) constraints.push(where('date', '<=', Timestamp.fromDate(f.endDate)));
  const q = query(
    txCol(),
    ...constraints,
    orderBy('date', 'desc'),
    qLimit(f.limit ?? 200),
  );
  const snap = await getDocs(q);
  let rows = snap.docs.map((d) => d.data()).filter((t) => !t.deletedAt);
  if (f.scope) {
    rows = rows.filter((t) => (t.scope ?? 'personal') === f.scope);
  }
  return rows;
}

/**
 * 「共用視窗」查詢：某個日期之後我的全部交易（date desc）。
 * 回傳原始筆數與最舊一筆的日期，讓呼叫端判斷視窗是否被 limit 截斷（見 `tx-window.ts`）。
 */
export async function listTransactionsWindow(
  userId: string,
  start: Date,
  max: number,
): Promise<{ rows: Transaction[]; fetchedCount: number; oldest: Date | null }> {
  const snap = await getDocs(query(
    txCol(),
    where('userId', '==', userId),
    where('date', '>=', Timestamp.fromDate(start)),
    orderBy('date', 'desc'),
    qLimit(max),
  ));
  const all = snap.docs.map((d) => d.data());
  return {
    rows: all.filter((t) => !t.deletedAt),
    fetchedCount: all.length,
    oldest: all[all.length - 1]?.date ?? null,
  };
}

export async function getTransaction(id: string): Promise<Transaction | null> {
  const snap = await getDoc(doc(db, 'transactions', id).withConverter(transactionConverter));
  return snap.exists() ? snap.data() : null;
}

/**
 * 批次匯入（設定 → 資料 → CSV 匯入）。
 * - 有 fromAccountId / toAccountId 的列會在「同一個 Firestore transaction」裡調整帳戶餘額，
 *   與 createTransaction 同一套規則（以前直接 writeBatch，匯入後帳戶餘額不動，稽核 D5）。
 * - 每個 transaction 400 筆（tx 寫入 + 帳戶更新不超過 500 上限）。
 * - 去重在呼叫端用 dedupeImportRows 先做（需要先查既有交易）。
 */
export async function bulkCreateTransactions(inputs: TransactionInput[], ownerId?: string): Promise<number> {
  let created = 0;
  const loadFxRates = lazyFxRates();
  for (let i = 0; i < inputs.length; i += 400) {
    const slice = inputs.slice(i, i + 400);
    const now = new Date();
    const rows = slice.map((input) => ({ ref: doc(collection(db, 'transactions')), input }));
    const entries: AccountAdjustmentEntry[] = rows.flatMap(({ input }) =>
      adjustmentsForTransaction({
        type: input.type,
        amount: input.amount,
        currency: input.currency,
        amountTWD: input.amountTWD,
        fromAccountId: input.fromAccountId ?? null,
        toAccountId: input.toAccountId ?? null,
      }).map((adjustment) => ({ adjustment, multiplier: 1 as const })),
    );
    await runTransaction(db, async (t) => {
      // 讀（帳戶）一定要在寫之前：applyAccountAdjustments 先 get 再 update，tx set 放最後
      await applyAccountAdjustments(t, entries, loadFxRates, ownerId);
      for (const { ref, input } of rows) {
        t.set(ref, stripUndefinedFields({
          userId: input.userId,
          type: input.type,
          amount: input.amount,
          currency: input.currency,
          amountTWD: input.amountTWD,
          fxRate: input.fxRate,
          category: input.category,
          subCategory: input.subCategory,
          paymentMethod: input.paymentMethod,
          fromAccountId: input.fromAccountId ?? null,
          toAccountId: input.toAccountId ?? null,
          transferGroup: input.transferGroup ?? null,
          note: input.note,
          photoUrl: input.photoUrl,
          date: Timestamp.fromDate(input.date),
          createdAt: Timestamp.fromDate(now),
          updatedAt: Timestamp.fromDate(now),
          tripId: input.tripId ?? null,
          tags: input.tags ?? [],
          recurringId: input.recurringId ?? null,
          deletedAt: null,
          scope: input.scope ?? null,
          importSourceHash: input.importSourceHash ?? null,
        }));
      }
    });
    created += slice.length;
  }
  return created;
}

/**
 * @param extraWrites 選填：同一個 Firestore transaction 裡要一起寫的其他文件（只能寫、不能讀）。
 *   例：租賃購入 / 收租要「交易 + rental 文件」同時成功或同時失敗（CLAUDE.md §5.4）。
 */
export async function createTransaction(
  input: TransactionInput,
  transactionId?: string,
  requireOwnedAccount = false,
  extraWrites?: (firestoreTx: FirestoreTransaction) => void,
): Promise<string> {
  const now = new Date();
  // 不要再用 navigator.onLine 攔截！
  // Firestore 已透過 persistentLocalCache 提供原生離線寫入；onLine 在 PWA / 行動網路常誤報 false，
  // 用它判斷會把線上交易也錯塞到 localStorage queue → 看起來像「新增成功但 Firestore 沒拿到」。
  const payload: Omit<Transaction, 'id'> = {
    userId: input.userId,
    type: input.type,
    amount: input.amount,
    currency: input.currency,
    amountTWD: input.amountTWD,
    fxRate: input.fxRate,
    category: input.category,
    subCategory: input.subCategory,
    paymentMethod: input.paymentMethod,
    fromAccountId: input.fromAccountId ?? null,
    toAccountId: input.toAccountId ?? null,
    transferGroup: input.transferGroup ?? null,
    note: input.note,
    // 舊欄位 photoUrl = 第一張圖片附件（沒有附件時沿用呼叫端給的 photoUrl）
    photoUrl: (input.attachments?.length ? legacyPhotoUrlFor(input.attachments) : input.photoUrl) ?? undefined,
    attachments: input.attachments?.length ? input.attachments.slice(0, MAX_TX_ATTACHMENTS) : undefined,
    date: input.date,
    createdAt: now,
    updatedAt: now,
    tripId: input.tripId ?? null,
    tags: input.tags ?? [],
    recurringId: input.recurringId ?? null,
    deletedAt: null,
    scope: input.scope ?? null,
    payerId: input.payerId ?? null,
    shareType: input.shareType ?? null,
    splitMode: input.splitMode ?? null,
    counterpartyName: input.counterpartyName ?? null,
    myShareTWD: input.myShareTWD ?? null,
    loanSettledAt: null,
    lineItems: input.lineItems && input.lineItems.length > 0 ? input.lineItems : undefined,
    customShares: input.customShares && input.customShares.length > 0 ? input.customShares : undefined,
    prepaid: input.prepaid === true,
    invoiceNumber: input.invoiceNumber ?? null,
    householdId: input.householdId ?? null,
    paidByUid: input.paidByUid ?? null,
    fundAdvancedBy: input.fundAdvancedBy ?? null,
    importSourceId: input.importSourceId ?? null,
    importSourceHash: input.importSourceHash ?? null,
  };
  const ref = transactionId
    ? doc(db, 'transactions', transactionId)
    : doc(collection(db, 'transactions'));
  const adjustments = adjustmentsForTransaction(payload as Transaction);
  const loadFxRates = lazyFxRates();
  await runTransaction(db, async (firestoreTx) => {
    // The caller keeps this id after an ambiguous timeout. Reading it inside
    // the transaction makes a retry safe even if the first attempt later wins.
    const existing = await firestoreTx.get(ref);
    if (existing.exists()) return;

    await applyAccountAdjustments(
      firestoreTx,
      adjustments.map((adjustment) => ({ adjustment, multiplier: 1 })),
      loadFxRates,
      requireOwnedAccount ? input.userId : undefined,
    );
    firestoreTx.set(ref, transactionConverter.toFirestore({ ...payload, id: ref.id } as Transaction));
    extraWrites?.(firestoreTx);
  });
  return ref.id;
}

/**
 * updateTransaction 的 patch：
 * - `undefined` 欄位會被忽略（不動）
 * - `customShares` / `lineItems` 給 `null` 代表「整個拿掉」（Firestore `deleteField()`），
 *   例如把共同分攤 / 出遊分攤取消時要清掉舊的分攤明細
 */
export type TransactionPatch = Partial<Omit<TransactionInput, 'customShares' | 'lineItems' | 'photoUrl'> & {
  /** null = 清掉舊 photoUrl（附件全部移除或只剩 PDF） */
  photoUrl?: string | null;
  customShares?: TransactionInput['customShares'] | null;
  lineItems?: TransactionInput['lineItems'] | null;
  settledAmountTWD?: number | null;
  settledFxRate?: number | null;
  settledAt?: Date | null;
  loanSettledAt?: Date | null;
}>;

export async function updateTransaction(id: string, patch: TransactionPatch): Promise<void> {
  const ref = doc(db, 'transactions', id).withConverter(transactionConverter);
  const loadFxRates = lazyFxRates();
  const patchForMerge = stripUndefinedFields({ ...patch } as Record<string, unknown>);
  const p: Record<string, unknown> = { ...patchForMerge, updatedAt: Timestamp.fromDate(new Date()) };
  if (patch.date) p.date = Timestamp.fromDate(patch.date);
  if (patch.customShares === null) p.customShares = deleteField();
  if (patch.lineItems === null) p.lineItems = deleteField();
  if (patch.photoUrl === null) p.photoUrl = deleteField();
  if (patch.attachments) p.attachments = encodeAttachments(patch.attachments.slice(0, MAX_TX_ATTACHMENTS));
  if ('settledAt' in patch) {
    p.settledAt = patch.settledAt ? Timestamp.fromDate(patch.settledAt) : null;
  }
  if ('loanSettledAt' in patch) {
    p.loanSettledAt = patch.loanSettledAt ? Timestamp.fromDate(patch.loanSettledAt) : null;
  }
  // 只有這些欄位會動到帳戶餘額；只改分攤 / 類別 / 備註時完全不碰 accounts
  //（夥伴只有「改分攤」權限，沒有對方 accounts 的讀寫權，讀了就會 permission-denied）
  const touchesMoney = MONEY_FIELDS.some((key) => key in patchForMerge);
  await runTransaction(db, async (firestoreTx) => {
    const snap = await firestoreTx.get(ref);
    if (!snap.exists()) throw new Error('Transaction not found');
    if (touchesMoney) {
      const prev = snap.data();
      const next = { ...prev, ...patchForMerge, updatedAt: new Date() } as Transaction;
      const entries: AccountAdjustmentEntry[] = [];
      if (!prev.deletedAt) {
        entries.push(...adjustmentsForTransaction(prev).map((adjustment) => ({ adjustment, multiplier: -1 as const })));
      }
      if (!next.deletedAt) {
        entries.push(...adjustmentsForTransaction(next).map((adjustment) => ({ adjustment, multiplier: 1 as const })));
      }
      await applyAccountAdjustments(firestoreTx, entries, loadFxRates);
    }
    firestoreTx.update(ref, p);
  });
}

const MONEY_FIELDS = ['type', 'amount', 'amountTWD', 'currency', 'fromAccountId', 'toAccountId', 'deletedAt'] as const;

/**
 * 批次結算：給定 tx ids + 帳單總金額 TWD + 結算日期，按 amount×fxRate 的相對比例分攤。
 */
export async function bulkSettle(params: {
  txIds: string[];
  totalSettledTWD: number;
  settledAt: Date;
  txs: Array<{ id: string; amount: number; fxRate: number }>;
}): Promise<number> {
  const { txIds, totalSettledTWD, settledAt, txs } = params;
  const selected = txs.filter((t) => txIds.includes(t.id));
  if (selected.length === 0) return 0;
  const weights = selected.map((t) => Math.abs(t.amount * t.fxRate) || 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const batch = writeBatch(db);
  const now = new Date();
  selected.forEach((t, i) => {
    const share = (weights[i] ?? 0) / total;
    const settledAmountTWD = Math.round(totalSettledTWD * share * 100) / 100;
    const settledFxRate = t.amount > 0 ? settledAmountTWD / t.amount : 0;
    batch.update(doc(db, 'transactions', t.id), {
      settledAmountTWD,
      settledFxRate,
      settledAt: Timestamp.fromDate(settledAt),
      updatedAt: Timestamp.fromDate(now),
    });
  });
  await batch.commit();
  return selected.length;
}

/** Soft delete — 七天內可復原；過 7 天由 Apps Script 永久刪除 */
export async function softDeleteTransaction(id: string): Promise<void> {
  const ref = doc(db, 'transactions', id).withConverter(transactionConverter);
  const loadFxRates = lazyFxRates();
  await runTransaction(db, async (firestoreTx) => {
    const snap = await firestoreTx.get(ref);
    if (!snap.exists()) throw new Error('Transaction not found');
    const tx = snap.data();
    if (!tx.deletedAt) {
      await applyAccountAdjustments(
        firestoreTx,
        adjustmentsForTransaction(tx).map((adjustment) => ({ adjustment, multiplier: -1 })),
        loadFxRates,
      );
    }
    firestoreTx.update(ref, {
      deletedAt: Timestamp.fromDate(new Date()),
      updatedAt: Timestamp.fromDate(new Date()),
    });
  });
}

export async function restoreTransaction(id: string): Promise<void> {
  const ref = doc(db, 'transactions', id).withConverter(transactionConverter);
  const loadFxRates = lazyFxRates();
  await runTransaction(db, async (firestoreTx) => {
    const snap = await firestoreTx.get(ref);
    if (!snap.exists()) throw new Error('Transaction not found');
    const tx = snap.data();
    if (tx.deletedAt) {
      await applyAccountAdjustments(
        firestoreTx,
        adjustmentsForTransaction(tx).map((adjustment) => ({ adjustment, multiplier: 1 })),
        loadFxRates,
      );
    }
    firestoreTx.update(ref, {
      deletedAt: null,
      updatedAt: Timestamp.fromDate(new Date()),
    });
  });
}

export async function hardDeleteTransaction(id: string): Promise<void> {
  await deleteDoc(doc(db, 'transactions', id));
}

/** 列出 N 天內被軟刪除的 transactions（給回收筒使用） */
export async function listDeletedTransactions(userId: string, days = 7): Promise<Transaction[]> {
  const cutoff = new Date(Date.now() - days * 86400000);
  const q = query(
    txCol(),
    where('userId', '==', userId),
    where('deletedAt', '>', Timestamp.fromDate(cutoff)),
    orderBy('deletedAt', 'desc'),
    qLimit(200),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

// ------- Categories -------

export async function listCategories(): Promise<Category[]> {
  const snap = await getDocs(query(catCol(), orderBy('order', 'asc')));
  return snap.docs.map((d) => d.data()).filter((c) => !c.archivedAt);
}

export async function upsertCategory(cat: Omit<Category, 'id'>): Promise<void> {
  const ref = doc(db, 'categories', cat.key).withConverter(categoryConverter);
  // upsert by key
  await (await import('firebase/firestore')).setDoc(ref, {
    ...cat,
    id: cat.key,
  } as Category, { merge: true });
}

export async function archiveCategory(id: string): Promise<void> {
  await updateDoc(doc(db, 'categories', id), {
    archivedAt: Timestamp.fromDate(new Date()),
  });
}

// ------- Budgets -------

export async function getBudget(userId: string, month: string): Promise<Budget | null> {
  const q = query(
    budgetCol(),
    where('userId', '==', userId),
    where('month', '==', month),
    qLimit(1),
  );
  const snap = await getDocs(q);
  const first = snap.docs[0];
  return first ? first.data() : null;
}

export async function upsertBudget(b: Omit<Budget, 'id'>, existingId?: string): Promise<string> {
  if (existingId) {
    await (await import('firebase/firestore')).setDoc(
      doc(db, 'budgets', existingId).withConverter(budgetConverter),
      { ...b, id: existingId } as Budget,
      { merge: true },
    );
    return existingId;
  }
  const ref = await addDoc(budgetCol(), b as unknown as Budget);
  return ref.id;
}

// ------- Recurring -------

export async function listRecurring(userId: string): Promise<Recurring[]> {
  const q = query(recurringCol(), where('userId', '==', userId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function createRecurring(r: Omit<Recurring, 'id'>): Promise<string> {
  const ref = await addDoc(recurringCol(), r as unknown as Recurring);
  return ref.id;
}

export async function updateRecurring(id: string, patch: Partial<Recurring>): Promise<void> {
  await updateDoc(doc(db, 'recurring', id), patch as Record<string, unknown>);
}

export async function deleteRecurring(id: string): Promise<void> {
  await deleteDoc(doc(db, 'recurring', id));
}

// ------- FX helper -------

export async function getLatestFxRate(base: Currency): Promise<number> {
  if (base === 'TWD') return 1;
  const snap = await getDoc(doc(db, 'fx_rates', `${base}_TWD`));
  if (!snap.exists()) return 1;
  const data = snap.data() as { rate?: number };
  return data.rate ?? 1;
}
