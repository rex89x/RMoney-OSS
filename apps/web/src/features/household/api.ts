import {
  addDoc, collection, deleteDoc, doc, getDocs, limit as qLimit, onSnapshot, orderBy, query,
  Timestamp, updateDoc, where, writeBatch, type Unsubscribe,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { callAppsScript } from '@/lib/apps-script';
import { transactionConverter, type Transaction } from '@/features/ledger/types';
import {
  householdConverter, householdFundEntryConverter, settlementConverter, MEMBER_COLORS,
  type Household, type HouseholdFundEntry, type HouseholdFundEntryInput, type HouseholdInput,
  type HouseholdMember, type Settlement, type SettlementInput,
} from './types';

export const householdsCol = () => collection(db, 'households').withConverter(householdConverter);
export const settlementsCol = (householdId: string) =>
  collection(db, 'households', householdId, 'settlements').withConverter(settlementConverter);
export const householdFundEntriesCol = (householdId: string) =>
  collection(db, 'households', householdId, 'fund_entries').withConverter(householdFundEntryConverter);

/** 使用者所屬的 household（目前 UI 只用第一個） */
export async function listMyHouseholds(uid: string): Promise<Household[]> {
  const snap = await getDocs(myHouseholdsQuery(uid));
  return householdRows(snap.docs.map((d) => d.data()));
}

function myHouseholdsQuery(uid: string) {
  return query(householdsCol(), where('memberIds', 'array-contains', uid));
}

function householdRows(rows: Household[]): Household[] {
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export function subscribeMyHouseholds(
  uid: string,
  onData: (rows: Household[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    myHouseholdsQuery(uid),
    (snapshot) => onData(householdRows(snapshot.docs.map((item) => item.data()))),
    onError,
  );
}

export async function createHousehold(owner: HouseholdMember, name: string): Promise<string> {
  const now = new Date();
  const input: HouseholdInput = {
    name: name.trim() || '共同帳本',
    ownerId: owner.uid,
    memberIds: [owner.uid],
    members: { [owner.uid]: { ...owner, color: owner.color ?? MEMBER_COLORS[0] ?? null } },
    pendingInvites: [],
    splitRatio: { [owner.uid]: 100 },
    monthlyBudgetTWD: null,
  };
  const ref = await addDoc(householdsCol(), { ...input, createdAt: now, updatedAt: now } as Household);
  return ref.id;
}

export type HouseholdPatch = Partial<Pick<Household,
  'name' | 'splitRatio' | 'monthlyBudgetTWD' | 'pendingInvites' | 'members' | 'memberIds' | 'inviteCode' | 'inviteCodeExpiresAt' | 'autoShareTrips'
  | 'investmentPlan' | 'householdReport' | 'fundPlan' | 'categoryBudgets' | 'fundKeeperUid'>>;

/** 邀請碼有效期：24 小時（Apps Script joinHousehold 同步檢查） */
export const INVITE_CODE_TTL_MS = 24 * 60 * 60 * 1000;

export function inviteCodeExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + INVITE_CODE_TTL_MS);
}

export function isInviteCodeActive(h: Pick<Household, 'inviteCode' | 'inviteCodeExpiresAt'>, now: Date = new Date()): boolean {
  return !!h.inviteCode && !!h.inviteCodeExpiresAt && h.inviteCodeExpiresAt.getTime() > now.getTime();
}

/** 產生 8 碼邀請碼（大寫英數，去掉易混淆字元） */
export function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** owner 移除成員：memberIds / members / splitRatio 一起清（rules 只允許 owner 改 memberIds） */
export async function removeHouseholdMember(household: Household, uid: string): Promise<void> {
  if (uid === household.ownerId) throw new Error('不能移除建立者');
  const memberIds = household.memberIds.filter((id) => id !== uid);
  const members = { ...household.members };
  delete members[uid];
  const splitRatio: Record<string, number> = {};
  for (const id of memberIds) splitRatio[id] = household.splitRatio[id] ?? 0;
  const sum = Object.values(splitRatio).reduce((s, v) => s + v, 0);
  if (memberIds.length === 1 || sum <= 0) {
    for (const id of memberIds) splitRatio[id] = memberIds.length === 1 ? 100 : Math.round(100 / memberIds.length);
  }
  await updateHousehold(household.id, { memberIds, members, splitRatio });
}

/**
 * 寫回 members 前的清理：`permissions` 一律寫 `{}`，絕對不要寫 `null`。
 *
 * Firestore rules 的 `.get('permissions', {})` 只有在 **key 不存在** 時才回 default；
 * key 存在但值是 null 時回的是 null，接著 `.get(key, def)` 會 runtime error，
 * 整條 rule 變成拒絕 → 成員的 canAddExpense / canSettle 全部失效
 *（症狀：UI 按得下去，存檔跳 "Missing or insufficient permissions."）。
 * rules 那邊也已經用 `is map` 擋住，這裡是不要再產生髒資料。
 */
function membersForWrite(members: Record<string, HouseholdMember>): Record<string, HouseholdMember> {
  const out: Record<string, HouseholdMember> = {};
  for (const [uid, member] of Object.entries(members)) {
    out[uid] = { ...member, permissions: member.permissions ?? {} };
  }
  return out;
}

export async function updateHousehold(id: string, patch: HouseholdPatch): Promise<void> {
  await updateDoc(doc(db, 'households', id), {
    ...patch,
    ...(patch.members ? { members: membersForWrite(patch.members) } : {}),
    updatedAt: Timestamp.fromDate(new Date()),
  });
}

export async function deleteHousehold(id: string): Promise<void> {
  await deleteDoc(doc(db, 'households', id));
}

/** 透過 Apps Script 邀請：加白名單 + pendingInvites（需 owner） */
export async function inviteHouseholdMember(householdId: string, email: string): Promise<void> {
  const resp = await callAppsScript('inviteHouseholdMember', undefined, { householdId, email: email.trim().toLowerCase() });
  if (!resp.ok) throw new Error(resp.error || '邀請失敗');
}

export interface HouseholdTxFilters {
  householdId: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}

/** 共同帳本交易（兩人的都會列出；rules 依 householdId 放行） */
export async function listHouseholdTransactions(f: HouseholdTxFilters): Promise<Transaction[]> {
  const snap = await getDocs(householdTransactionsQuery(f));
  return householdTransactionRows(snap.docs.map((d) => d.data()));
}

function householdTransactionsQuery(f: HouseholdTxFilters) {
  const constraints = [where('householdId', '==', f.householdId)];
  if (f.startDate) constraints.push(where('date', '>=', Timestamp.fromDate(f.startDate)));
  if (f.endDate) constraints.push(where('date', '<=', Timestamp.fromDate(f.endDate)));
  return query(
    collection(db, 'transactions').withConverter(transactionConverter),
    ...constraints,
    orderBy('date', 'desc'),
    qLimit(f.limit ?? 500),
  );
}

function householdTransactionRows(rows: Transaction[]): Transaction[] {
  return rows.filter((transaction) => !transaction.deletedAt);
}

export function subscribeHouseholdTransactions(
  filters: HouseholdTxFilters,
  onData: (rows: Transaction[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    householdTransactionsQuery(filters),
    (snapshot) => onData(householdTransactionRows(snapshot.docs.map((item) => item.data()))),
    onError,
  );
}

export async function listSettlements(householdId: string): Promise<Settlement[]> {
  const snap = await getDocs(settlementsQuery(householdId));
  return snap.docs.map((d) => d.data());
}

function settlementsQuery(householdId: string) {
  return query(settlementsCol(householdId), orderBy('date', 'desc'), qLimit(200));
}

export function subscribeSettlements(
  householdId: string,
  onData: (rows: Settlement[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    settlementsQuery(householdId),
    (snapshot) => onData(snapshot.docs.map((item) => item.data())),
    onError,
  );
}

export async function createSettlement(householdId: string, input: SettlementInput): Promise<string> {
  const ref = await addDoc(settlementsCol(householdId), { ...input, createdAt: new Date() } as Settlement);
  return ref.id;
}

export async function deleteSettlement(householdId: string, id: string): Promise<void> {
  await deleteDoc(doc(db, 'households', householdId, 'settlements', id));
}

export async function listHouseholdFundEntries(householdId: string): Promise<HouseholdFundEntry[]> {
  const snapshot = await getDocs(householdFundEntriesQuery(householdId));
  return snapshot.docs.map((item) => item.data());
}

function householdFundEntriesQuery(householdId: string) {
  return query(
    householdFundEntriesCol(householdId),
    orderBy('date', 'desc'),
    qLimit(1000),
  );
}

export function subscribeHouseholdFundEntries(
  householdId: string,
  onData: (rows: HouseholdFundEntry[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    householdFundEntriesQuery(householdId),
    (snapshot) => onData(snapshot.docs.map((item) => item.data())),
    onError,
  );
}

export async function createHouseholdFundEntry(
  householdId: string,
  input: HouseholdFundEntryInput,
): Promise<string> {
  const ref = await addDoc(
    householdFundEntriesCol(householdId),
    { ...input, createdAt: new Date() } as HouseholdFundEntry,
  );
  return ref.id;
}

/** 修改公基金存入：只能改金額 / 日期 / 備註（rules 鎖住 type / contributorUid / createdBy / planMonth） */
export type HouseholdFundEntryPatch = Pick<HouseholdFundEntry, 'amountTWD' | 'date' | 'note'>;

export async function updateHouseholdFundEntry(
  householdId: string,
  id: string,
  patch: HouseholdFundEntryPatch,
): Promise<void> {
  await updateDoc(doc(db, 'households', householdId, 'fund_entries', id), {
    amountTWD: patch.amountTWD,
    note: patch.note ?? null,
    date: Timestamp.fromDate(patch.date),
  });
}

export async function deleteHouseholdFundEntry(householdId: string, id: string): Promise<void> {
  await deleteDoc(doc(db, 'households', householdId, 'fund_entries', id));
}

/**
 * 把一筆記錯的「公基金存入」改成「公基金撥還」（公基金 → 先墊的成員）。
 *
 * 常見情境：成員先墊了一筆公基金負擔的支出，之後公基金把錢補給他，卻被記成「存入公基金」（+），
 * 帳上可用多算了兩倍。rules 不允許改 `type` / `contributorUid`，所以用同一個 batch：
 * 刪掉原本的存入 → 建一筆撥還（收款人 = 原存入者）→ 把對應的公基金支出標成「這位成員先墊」。
 * 沒有標先墊的話，撥還會變成「撥多了、對方欠公基金」。
 */
export interface ConvertToReimbursementInput {
  householdId: string;
  entry: HouseholdFundEntry;
  /** 誰記錄這次修正（= 撥還的 createdBy，rules 要求等於自己） */
  myUid: string;
  /** 收款人；預設是原本的存入者 */
  toUid: string;
  amountTWD: number;
  date: Date;
  note: string | null;
  /** 要標成「toUid 先墊」的公基金支出 id */
  advancedTxIds: string[];
}

export async function convertFundEntryToReimbursement(input: ConvertToReimbursementInput): Promise<string> {
  const amount = Math.round(input.amountTWD);
  if (amount <= 0) throw new Error('金額需大於 0');
  if (input.entry.type === 'reimbursement') throw new Error('這筆已經是撥還');
  const batch = writeBatch(db);
  batch.delete(doc(db, 'households', input.householdId, 'fund_entries', input.entry.id));
  const newRef = doc(householdFundEntriesCol(input.householdId));
  batch.set(newRef, {
    id: newRef.id,
    type: 'reimbursement',
    amountTWD: amount,
    contributorUid: input.toUid,
    note: input.note,
    date: input.date,
    planMonth: null,
    source: 'manual',
    createdBy: input.myUid,
    createdAt: new Date(),
  });
  const now = Timestamp.now();
  for (const txId of input.advancedTxIds) {
    // 只動 fundAdvancedBy + updatedAt：符合 rules 的 splitOnlyPatch()，伴侶也能標對方記的支出
    batch.update(doc(db, 'transactions', txId), { fundAdvancedBy: input.toUid, updatedAt: now });
  }
  await batch.commit();
  return newRef.id;
}
