import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

export interface FxRate {
  id: string; // pair e.g. USD_TWD
  base: string;
  quote: string;
  rate: number;
  source?: string;
  updatedAt: Date | null;
}

export interface FxCandle {
  id: string;
  date: string;
  rate: number;
  source?: string;
}

export interface FxPair {
  id: string;       // BASE_QUOTE
  base: string;
  quote: string;
  enabled: boolean;
  createdAt: Date;
}

export const fxPairConverter: FirestoreDataConverter<FxPair> = {
  toFirestore: (p) => {
    const { id: _id, ...rest } = p as FxPair;
    void _id;
    return {
      ...rest,
      createdAt: Timestamp.fromDate(rest.createdAt),
    };
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      base: d.base ?? '',
      quote: d.quote ?? '',
      enabled: d.enabled !== false,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
    };
  },
};

export type AlertType = 'fx' | 'stock';
export type AlertDirection = 'above' | 'below';
/**
 * 觸發指標（stock 專用除了 price）：
 *   price    現價 vs threshold
 *   rsi14    14 日 RSI vs threshold（0–100）
 *   ma       現價 vs N 日均線；threshold = N（20 / 60 / 120 / 200），above = 站上、below = 跌破
 *   high52w  創 52 週新高（threshold 不用）
 *   low52w   創 52 週新低（threshold 不用）
 *   vsCost   現價相對持倉平均成本的 %；threshold = 百分比（例如 -10 或 20）
 *   weight   該檔佔投資組合市值的 %；threshold = 百分比
 */
export type AlertMetric = 'price' | 'rsi14' | 'ma' | 'high52w' | 'low52w' | 'vsCost' | 'weight';

export const ALERT_METRIC_LABEL: Record<AlertMetric, string> = {
  price: '現價',
  rsi14: 'RSI(14)',
  ma: '均線',
  high52w: '52 週新高',
  low52w: '52 週新低',
  vsCost: '距成本 %',
  weight: '持倉佔比 %',
};

/** 這些指標的 threshold 沒有意義（觸發條件固定） */
export const ALERT_METRICS_WITHOUT_THRESHOLD: AlertMetric[] = ['high52w', 'low52w'];

export function describeAlert(a: Pick<Alert, 'target' | 'metric' | 'direction' | 'threshold'>): string {
  const m = a.metric ?? 'price';
  const cmp = a.direction === 'above' ? '≥' : '≤';
  switch (m) {
    case 'ma': return `${a.target} ${a.direction === 'above' ? '站上' : '跌破'} ${a.threshold} 日均線`;
    case 'high52w': return `${a.target} 創 52 週新高`;
    case 'low52w': return `${a.target} 創 52 週新低`;
    case 'vsCost': return `${a.target} 距成本 ${cmp} ${a.threshold}%`;
    case 'weight': return `${a.target} 佔比 ${cmp} ${a.threshold}%`;
    case 'rsi14': return `${a.target} RSI(14) ${cmp} ${a.threshold}`;
    default: return `${a.target} 現價 ${cmp} ${a.threshold}`;
  }
}

export interface Alert {
  id: string;
  userId: string;
  type: AlertType;
  target: string; // "USD_TWD" or "2330"
  direction: AlertDirection;
  threshold: number;
  /** 觸發指標。預設 'price' 以保持回溯相容 */
  metric?: AlertMetric;
  active: boolean;
  cooldownMinutes: number;
  /** 一次性警報：觸發一次後 Apps Script 自動把 active 設為 false（SPEC §5.3.1） */
  oneShot?: boolean;
  lastTriggeredAt: Date | null;
  createdAt: Date;
  notes?: string;
}

export interface AlertLog {
  id: string;
  alertId: string;
  triggeredAt: Date;
  triggerValue: number;
  notificationSent: boolean;
  channel: 'telegram' | 'none';
}

export const fxConverter: FirestoreDataConverter<FxRate> = {
  toFirestore: (r) => {
    const { id: _id, ...rest } = r as FxRate;
    void _id;
    return {
      ...rest,
      updatedAt: rest.updatedAt ? Timestamp.fromDate(rest.updatedAt) : null,
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): FxRate => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      base: d.base ?? '',
      quote: d.quote ?? '',
      rate: d.rate ?? 0,
      source: d.source,
      updatedAt: tsToDate(d.updatedAt),
    };
  },
};

export const fxCandleConverter: FirestoreDataConverter<FxCandle> = {
  toFirestore: (c) => {
    const { id: _id, ...rest } = c as FxCandle;
    void _id;
    return rest;
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      date: d.date ?? snap.id,
      rate: d.rate ?? 0,
      source: d.source,
    };
  },
};

export const alertConverter: FirestoreDataConverter<Alert> = {
  toFirestore: (a) => {
    const { id: _id, ...rest } = a as Alert;
    void _id;
    return {
      ...rest,
      createdAt: Timestamp.fromDate(rest.createdAt),
      lastTriggeredAt: rest.lastTriggeredAt ? Timestamp.fromDate(rest.lastTriggeredAt) : null,
    };
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      type: (d.type as AlertType) ?? 'fx',
      target: d.target ?? '',
      direction: (d.direction as AlertDirection) ?? 'above',
      threshold: d.threshold ?? 0,
      metric: (d.metric as AlertMetric) ?? 'price',
      active: d.active ?? true,
      cooldownMinutes: d.cooldownMinutes ?? 60,
      oneShot: d.oneShot === true,
      lastTriggeredAt: tsToDate(d.lastTriggeredAt),
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      notes: d.notes,
    };
  },
};

export const alertLogConverter: FirestoreDataConverter<AlertLog> = {
  toFirestore: (log) => {
    const { id: _id, ...rest } = log as AlertLog;
    void _id;
    return {
      ...rest,
      triggeredAt: Timestamp.fromDate(rest.triggeredAt),
    };
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      alertId: d.alertId ?? '',
      triggeredAt: tsToDate(d.triggeredAt) ?? new Date(),
      triggerValue: d.triggerValue ?? 0,
      notificationSent: d.notificationSent ?? false,
      channel: (d.channel as 'telegram' | 'none') ?? 'telegram',
    };
  },
};
