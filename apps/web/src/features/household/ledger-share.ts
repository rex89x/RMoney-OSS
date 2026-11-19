import {
  collection, doc, getDoc, getDocs, limit as qLimit, onSnapshot, orderBy, query, Timestamp, where,
  writeBatch, type Unsubscribe,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { transactionConverter, type Transaction } from '@/features/ledger/types';
import type { Household } from './types';

/** 我開放給誰：viewers = 可看（rules: ledgerSharedWith）、editors = 可編輯（rules: ledgerEditors，⊆ viewers） */
export interface LedgerShareState {
  viewers: string[];
  editors: string[];
}

export type LedgerShareScope = 'view' | 'edit';

/**
 * 個人支出分享（owner → 伴侶）。
 *
 * 兩個地方要一起寫，所以一律走 `writeBatch`：
 *  1. `users/{sharerUid}.ledgerSharedWith` / `.ledgerEditors` — **rules 的唯一判斷依據**。
 *     只有本人寫得進來（分享的是自己的資料），rules 放行對方讀（與改）`type == 'expense'` 的 tx。
 *  2. `households/{hid}.ledgerSharing[sharerUid]` / `.ledgerEditing[sharerUid]` — 純 UI 鏡像。
 *     對方讀不到別人的 `users/{uid}`，要靠這裡才知道「有東西可以看 / 可以改」。
 *
 * 不變式：editors ⊆ viewers。
 *  - 關掉「可看」會一併拿掉「可編輯」；
 *  - 打開「可編輯」會順便補上「可看」（UI 上也只有可看時才顯示可編輯開關）。
 */
export async function setLedgerSharing(params: {
  household: Household;
  /** 分享者（= 目前登入者，只能改自己的） */
  sharerUid: string;
  viewerUid: string;
  enabled: boolean;
  /** 'view'（預設）= 可看；'edit' = 可編輯 */
  scope?: LedgerShareScope;
}): Promise<void> {
  const { household, sharerUid, viewerUid, enabled, scope = 'view' } = params;
  if (sharerUid === viewerUid) throw new Error('不能分享給自己');
  if (!household.memberIds.includes(viewerUid)) throw new Error('對方不是共同帳本成員');

  // 以權威來源（users/{uid}）為基準算出新名單，鏡像若之前寫歪了也會一併被修正
  const current = await getLedgerShareState(sharerUid);
  const next = nextLedgerShareState(current, viewerUid, enabled, scope);
  await writeLedgerShareState(household, sharerUid, next);
}

/** 純函式：依操作算出新的分享名單（維持 editors ⊆ viewers） */
export function nextLedgerShareState(
  current: LedgerShareState,
  targetUid: string,
  enabled: boolean,
  scope: LedgerShareScope,
): LedgerShareState {
  const without = (list: string[]) => list.filter((uid) => uid !== targetUid);
  const withUid = (list: string[]) => Array.from(new Set([...list, targetUid]));
  if (scope === 'edit') {
    return enabled
      ? { viewers: withUid(current.viewers), editors: withUid(current.editors) }
      : { viewers: current.viewers, editors: without(current.editors) };
  }
  return enabled
    ? { viewers: withUid(current.viewers), editors: current.editors }
    : { viewers: without(current.viewers), editors: without(current.editors) };
}

async function writeLedgerShareState(household: Household, sharerUid: string, state: LedgerShareState): Promise<void> {
  const editors = state.editors.filter((uid) => state.viewers.includes(uid));
  const batch = writeBatch(db);
  batch.update(doc(db, 'users', sharerUid), { ledgerSharedWith: state.viewers, ledgerEditors: editors });
  batch.update(doc(db, 'households', household.id), {
    [`ledgerSharing.${sharerUid}`]: state.viewers,
    [`ledgerEditing.${sharerUid}`]: editors,
    updatedAt: Timestamp.fromDate(new Date()),
  });
  await batch.commit();
}

/**
 * 我實際開放給誰（讀 `users/{uid}` 本人那份 —— rules 真正看的東西）。
 * households.ledgerSharing / ledgerEditing 只是鏡像，兩邊有可能因為部分失敗而不一致，
 * 所以 UI 的開關狀態一律以這個為準。
 */
export async function getLedgerShareState(uid: string): Promise<LedgerShareState> {
  const snapshot = await getDoc(doc(db, 'users', uid));
  const data = snapshot.data();
  const asList = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  const viewers = asList(data?.ledgerSharedWith);
  const editors = asList(data?.ledgerEditors).filter((v) => viewers.includes(v));
  return { viewers, editors };
}

export async function getLedgerSharedWith(uid: string): Promise<string[]> {
  return (await getLedgerShareState(uid)).viewers;
}

/** 用權威來源（users/{uid}）把 household 鏡像重寫一次，修掉不一致 */
export async function repairLedgerSharingMirror(household: Household, sharerUid: string): Promise<LedgerShareState> {
  const authoritative = await getLedgerShareState(sharerUid);
  await writeBatch(db)
    .update(doc(db, 'households', household.id), {
      [`ledgerSharing.${sharerUid}`]: authoritative.viewers,
      [`ledgerEditing.${sharerUid}`]: authoritative.editors,
      updatedAt: Timestamp.fromDate(new Date()),
    })
    .commit();
  return authoritative;
}

export interface SharedLedgerFilters {
  /** 分享者 uid（要看誰的支出） */
  sharerUid: string;
  startDate: Date;
  endDate: Date;
  limit?: number;
}

/**
 * 對方分享出來的個人支出。
 * 查詢一定要帶 `type == 'expense'`：rules 只放行支出，少了這個條件整個 query 會被拒。
 * 共同支出（有 householdId）在 `/shared` 的交易分頁已經看得到，這裡濾掉避免重複。
 */
function sharedLedgerQuery(f: SharedLedgerFilters) {
  return query(
    collection(db, 'transactions').withConverter(transactionConverter),
    where('userId', '==', f.sharerUid),
    where('type', '==', 'expense'),
    where('date', '>=', Timestamp.fromDate(f.startDate)),
    where('date', '<=', Timestamp.fromDate(f.endDate)),
    orderBy('date', 'desc'),
    qLimit(f.limit ?? 1000),
  );
}

function sharedLedgerRows(rows: Transaction[]): Transaction[] {
  return rows.filter((tx) => !tx.deletedAt && !tx.householdId);
}

export async function listSharedLedgerTransactions(f: SharedLedgerFilters): Promise<Transaction[]> {
  const snapshot = await getDocs(sharedLedgerQuery(f));
  return sharedLedgerRows(snapshot.docs.map((item) => item.data()));
}

export function subscribeSharedLedgerTransactions(
  f: SharedLedgerFilters,
  onData: (rows: Transaction[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    sharedLedgerQuery(f),
    (snapshot) => onData(sharedLedgerRows(snapshot.docs.map((item) => item.data()))),
    onError,
  );
}
