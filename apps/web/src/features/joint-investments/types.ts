import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
import type {
  Agg, HoldingBucket, HoldingLike, HoldingLot, JointCurrency, JointMarket,
} from './calc';

export type { Agg, HoldingBucket, HoldingLot, JointCurrency, JointMarket } from './calc';

/**
 * households/{hid}/investment_holdings/{id}
 * - bucket 'joint'：兩人共同持有，依 jointShares（%）歸屬；null = 跟著 household.splitRatio
 * - bucket 'personal'：ownerUid 自己的
 * - source 'portfolio'：owner 從自己的投資組合「連結」進來，股數與均價由 portfolio/{sourcePositionId} 同步，
 *   lots 只是一筆合成的買進紀錄；不能在這裡手動加減碼
 */
export type HoldingSource = 'manual' | 'portfolio';

export interface JointHolding extends HoldingLike {
  source: HoldingSource;
  sourcePositionId: string | null;
  /** 連結的 portfolio 部位已被刪除 */
  sourceMissing: boolean;
  note: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  syncedAt: Date | null;
}

export type JointHoldingInput = Omit<JointHolding, 'id' | 'createdAt' | 'updatedAt' | 'syncedAt' | 'sourceMissing'>;

/** households/{hid}/investment_snapshots/{YYYY-MM-DD}（Apps Script 每日寫，前端唯讀） */
export interface JointInvestmentSnapshot extends Agg {
  id: string;
  date: string;
  byBucket: Record<string, Agg>;
  byMember: Record<string, Agg>;
}

/** telegram_links/{uid}（Apps Script 寫，本人唯讀） */
export interface TelegramLink {
  uid: string;
  chatId: string;
  householdId: string | null;
  username: string;
  firstName: string;
  linkedAt: Date | null;
}

export const HOLDING_BUCKET_LABEL: Record<HoldingBucket, string> = {
  joint: '共同持有',
  personal: '個人',
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function lotFromFirestore(raw: unknown): HoldingLot | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const date = tsToDate(d.date);
  if (!date) return null;
  return {
    side: d.side === 'sell' ? 'sell' : 'buy',
    date,
    shares: num(d.shares),
    price: num(d.price),
    fee: num(d.fee),
  };
}

function numberMap(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export const jointHoldingConverter: FirestoreDataConverter<JointHolding> = {
  toFirestore: (h) => {
    const { id: _id, ...rest } = h as JointHolding;
    void _id;
    return {
      ...rest,
      name: rest.name || rest.symbol,
      ownerUid: rest.bucket === 'personal' ? rest.ownerUid : null,
      jointShares: rest.bucket === 'joint' ? (rest.jointShares ?? null) : null,
      sourcePositionId: rest.sourcePositionId ?? null,
      sourceMissing: rest.sourceMissing === true,
      note: rest.note ?? null,
      lots: rest.lots.map((l) => ({
        side: l.side, date: Timestamp.fromDate(l.date), shares: l.shares, price: l.price, fee: l.fee,
      })),
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
      syncedAt: rest.syncedAt ? Timestamp.fromDate(rest.syncedAt) : null,
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): JointHolding => {
    const d = snap.data() as DocumentData;
    const bucket: HoldingBucket = d.bucket === 'personal' ? 'personal' : 'joint';
    const currency: JointCurrency = d.currency === 'USD' ? 'USD' : 'TWD';
    const market: JointMarket = d.market === 'US' || (d.market !== 'TW' && currency === 'USD') ? 'US' : 'TW';
    return {
      id: snap.id,
      symbol: typeof d.symbol === 'string' ? d.symbol : snap.id,
      name: typeof d.name === 'string' && d.name ? d.name : (d.symbol ?? snap.id),
      market,
      currency,
      bucket,
      ownerUid: bucket === 'personal' && typeof d.ownerUid === 'string' ? d.ownerUid : null,
      jointShares: bucket === 'joint' ? numberMap(d.jointShares) : null,
      lots: Array.isArray(d.lots) ? d.lots.map(lotFromFirestore).filter((l): l is HoldingLot => l !== null) : [],
      source: d.source === 'portfolio' ? 'portfolio' : 'manual',
      sourcePositionId: typeof d.sourcePositionId === 'string' ? d.sourcePositionId : null,
      sourceMissing: d.sourceMissing === true,
      note: typeof d.note === 'string' ? d.note : null,
      createdBy: typeof d.createdBy === 'string' ? d.createdBy : '',
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
      syncedAt: tsToDate(d.syncedAt),
    };
  },
};

function aggFrom(raw: unknown): Agg {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    valueTWD: num(d.valueTWD),
    costTWD: num(d.costTWD),
    unrealizedTWD: num(d.unrealizedTWD),
    realizedTWD: num(d.realizedTWD),
    dayChangeTWD: num(d.dayChangeTWD),
  };
}

function aggMap(raw: unknown): Record<string, Agg> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, aggFrom(v)]));
}

export const jointSnapshotConverter: FirestoreDataConverter<JointInvestmentSnapshot> = {
  // 前端不寫快照（rules write: false），toFirestore 只為滿足型別
  toFirestore: (s) => {
    const { id: _id, ...rest } = s as JointInvestmentSnapshot;
    void _id;
    return rest;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): JointInvestmentSnapshot => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      date: typeof d.date === 'string' ? d.date : snap.id,
      valueTWD: num(d.totalValueTWD),
      costTWD: num(d.totalCostTWD),
      unrealizedTWD: num(d.unrealizedTWD),
      realizedTWD: num(d.realizedTWD),
      dayChangeTWD: num(d.dayChangeTWD),
      byBucket: aggMap(d.byBucket),
      byMember: aggMap(d.byMember),
    };
  },
};

export const telegramLinkConverter: FirestoreDataConverter<TelegramLink> = {
  toFirestore: (l) => {
    const { uid: _uid, ...rest } = l as TelegramLink;
    void _uid;
    return rest;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): TelegramLink => {
    const d = snap.data() as DocumentData;
    return {
      uid: snap.id,
      chatId: String(d.chatId ?? ''),
      householdId: typeof d.householdId === 'string' ? d.householdId : null,
      username: typeof d.username === 'string' ? d.username : '',
      firstName: typeof d.firstName === 'string' ? d.firstName : '',
      linkedAt: tsToDate(d.linkedAt),
    };
  },
};
