import {
  collection, deleteDoc, doc, getDoc, getDocs, limit as qLimit, onSnapshot, orderBy, query, Timestamp,
  setDoc, updateDoc, writeBatch, type Unsubscribe,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { callAppsScript } from '@/lib/apps-script';
import { stockConverter } from '@/features/investments/types';
import { fxConverter } from '@/features/fx/types';
import type { PortfolioPosition } from '@/features/investments/types';
import type { Quote } from './calc';
import {
  jointHoldingConverter, jointSnapshotConverter, telegramLinkConverter,
  type HoldingLot, type JointHolding, type JointHoldingInput, type JointInvestmentSnapshot, type TelegramLink,
} from './types';

const HOLDINGS_LIMIT = 200;

export const jointHoldingsCol = (householdId: string) =>
  collection(db, 'households', householdId, 'investment_holdings').withConverter(jointHoldingConverter);
export const jointSnapshotsCol = (householdId: string) =>
  collection(db, 'households', householdId, 'investment_snapshots').withConverter(jointSnapshotConverter);

function holdingsQuery(householdId: string) {
  return query(jointHoldingsCol(householdId), orderBy('createdAt', 'asc'), qLimit(HOLDINGS_LIMIT));
}

export async function listJointHoldings(householdId: string): Promise<JointHolding[]> {
  const snap = await getDocs(holdingsQuery(householdId));
  return snap.docs.map((d) => d.data());
}

export function subscribeJointHoldings(
  householdId: string,
  onData: (rows: JointHolding[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(holdingsQuery(householdId), (s) => onData(s.docs.map((d) => d.data())), onError);
}

export async function createJointHolding(householdId: string, input: JointHoldingInput): Promise<string> {
  const ref = doc(jointHoldingsCol(householdId));
  const now = new Date();
  await setDoc(ref, { ...input, id: ref.id, sourceMissing: false, createdAt: now, updatedAt: now, syncedAt: null });
  return ref.id;
}

function lotsForWrite(lots: HoldingLot[]) {
  return lots.map((l) => ({ side: l.side, date: Timestamp.fromDate(l.date), shares: l.shares, price: l.price, fee: l.fee }));
}

export type JointHoldingPatch = Partial<Pick<JointHolding, 'name' | 'lots' | 'jointShares' | 'note'>>;

export async function updateJointHolding(householdId: string, id: string, patch: JointHoldingPatch): Promise<void> {
  const { lots, ...rest } = patch;
  await updateDoc(doc(db, 'households', householdId, 'investment_holdings', id), {
    ...rest,
    ...(lots ? { lots: lotsForWrite(lots) } : {}),
    updatedAt: Timestamp.fromDate(new Date()),
  });
}

export async function deleteJointHolding(householdId: string, id: string): Promise<void> {
  await deleteDoc(doc(db, 'households', householdId, 'investment_holdings', id));
}

/**
 * 連結 / 同步 owner 自己投資組合的部位（一次寫多筆 → writeBatch）。
 * 已連結的部位更新股數與均價；新的建立一筆 source = 'portfolio' 的 personal 持股。
 */
export async function syncLinkedPositions(
  householdId: string,
  ownerUid: string,
  positions: readonly PortfolioPosition[],
  existing: readonly JointHolding[],
  names: Record<string, string>,
): Promise<number> {
  const batch = writeBatch(db);
  const now = new Date();
  let count = 0;
  for (const p of positions) {
    const lots: HoldingLot[] = p.shares > 0 ? [{ side: 'buy', date: now, shares: p.shares, price: p.avgCost, fee: 0 }] : [];
    const linked = existing.find((h) => h.source === 'portfolio' && h.sourcePositionId === p.id);
    if (linked) {
      batch.update(doc(db, 'households', householdId, 'investment_holdings', linked.id), {
        lots: lotsForWrite(lots),
        sourceMissing: false,
        syncedAt: Timestamp.fromDate(now),
        updatedAt: Timestamp.fromDate(now),
      });
    } else {
      const ref = doc(jointHoldingsCol(householdId));
      const market = p.currency === 'USD' ? 'US' : 'TW';
      batch.set(ref, {
        id: ref.id,
        symbol: p.symbol,
        name: names[p.symbol] ?? p.symbol,
        market,
        currency: p.currency,
        bucket: 'personal',
        ownerUid,
        jointShares: null,
        lots,
        source: 'portfolio',
        sourcePositionId: p.id,
        sourceMissing: false,
        note: null,
        createdBy: ownerUid,
        createdAt: now,
        updatedAt: now,
        syncedAt: now,
      });
    }
    count += 1;
  }
  if (count) await batch.commit();
  return count;
}

export async function listJointSnapshots(householdId: string, days = 180): Promise<JointInvestmentSnapshot[]> {
  const snap = await getDocs(query(jointSnapshotsCol(householdId), orderBy('date', 'desc'), qLimit(days)));
  return snap.docs.map((d) => d.data()).reverse();
}

/**
 * 報價：成員（伴侶）rules 只開 `stocks/{symbol}` 的 get（不能 list，避免看到 owner 的自選股清單），
 * 所以逐檔 getDoc。
 */
export async function getJointQuotes(symbols: readonly string[]): Promise<Record<string, Quote | null>> {
  const unique = Array.from(new Set(symbols));
  const entries = await Promise.all(unique.map(async (symbol) => {
    try {
      const snap = await getDoc(doc(db, 'stocks', symbol).withConverter(stockConverter));
      if (!snap.exists()) return [symbol, null] as const;
      const s = snap.data();
      return [symbol, { price: s.currentPrice, change: s.change, changePercent: s.changePercent, updatedAt: s.updatedAt }] as const;
    } catch (err) {
      console.error('[getJointQuotes]', symbol, err);
      return [symbol, null] as const;
    }
  }));
  return Object.fromEntries(entries);
}

export async function getFxToTWD(currencies: readonly string[]): Promise<Record<string, number | null>> {
  const unique = Array.from(new Set(currencies.filter((c) => c !== 'TWD')));
  const out: Record<string, number | null> = { TWD: 1 };
  await Promise.all(unique.map(async (ccy) => {
    try {
      const snap = await getDoc(doc(db, 'fx_rates', `${ccy}_TWD`).withConverter(fxConverter));
      out[ccy] = snap.exists() && snap.data().rate > 0 ? snap.data().rate : null;
    } catch (err) {
      console.error('[getFxToTWD]', ccy, err);
      out[ccy] = null;
    }
  }));
  return out;
}

export async function refreshHouseholdQuotes(householdId: string): Promise<{ updated: number; failed: string[] }> {
  const resp = await callAppsScript('refreshHouseholdQuotes', undefined, { householdId });
  if (!resp.ok) throw new Error(resp.error || '更新報價失敗');
  return {
    updated: typeof resp.updated === 'number' ? resp.updated : 0,
    failed: Array.isArray(resp.failed) ? (resp.failed as string[]) : [],
  };
}

// -------- Telegram --------

export async function getMyTelegramLink(uid: string): Promise<TelegramLink | null> {
  const snap = await getDoc(doc(db, 'telegram_links', uid).withConverter(telegramLinkConverter));
  return snap.exists() ? snap.data() : null;
}

export function subscribeMyTelegramLink(
  uid: string,
  onData: (link: TelegramLink | null) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, 'telegram_links', uid).withConverter(telegramLinkConverter),
    (snap) => onData(snap.exists() ? snap.data() : null),
    onError,
  );
}

export interface TelegramLinkResult {
  url: string;
  botUsername: string;
  expiresAt: Date;
}

export async function createTelegramLink(householdId: string, forUid?: string): Promise<TelegramLinkResult> {
  const resp = await callAppsScript('createTelegramLink', undefined, { householdId, forUid });
  if (!resp.ok || typeof resp.url !== 'string') throw new Error(resp.error || '產生連結失敗');
  // 只接受 t.me 連結，避免把任意 URL 丟給 window.open
  if (!/^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9]+$/.test(resp.url)) throw new Error('連結格式不正確');
  return {
    url: resp.url,
    botUsername: typeof resp.botUsername === 'string' ? resp.botUsername : '',
    expiresAt: typeof resp.expiresAt === 'string' ? new Date(resp.expiresAt) : new Date(Date.now() + 86400000),
  };
}

export async function unlinkTelegram(householdId: string, forUid?: string): Promise<void> {
  const resp = await callAppsScript('unlinkTelegram', undefined, { householdId, forUid });
  if (!resp.ok) throw new Error(resp.error || '解除失敗');
}

export async function sendHouseholdReportNow(householdId: string): Promise<void> {
  const resp = await callAppsScript('sendHouseholdReport', undefined, { householdId });
  if (!resp.ok) throw new Error(resp.error || '傳送失敗');
}
