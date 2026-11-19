import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

export type ItineraryItemType = 'transport' | 'meal' | 'activity' | 'accommodation' | 'shopping';
export type ItineraryItemStatus = 'planned' | 'done' | 'skipped';

export interface ItineraryDoc {
  id: string;
  userId?: string;
  tripId?: string;
  title: string;
  summary?: string;
  tips?: string[];
  /** 自由 markdown 筆記（使用者編輯 / LLM 生成） */
  notes?: string;
  notesUpdatedAt?: Date;
  generatedByLLM?: boolean;
  llmModel?: string;
  destination?: string;
  startDate?: string;
  endDate?: string;
}

export interface ItineraryDay {
  id: string;
  date: string;
  theme?: string;
}

/** Google Places legacy `opening_hours.periods[].open/close`：day 0 = 週日，time = 'HHmm'（地點當地時間） */
export interface OpeningPeriodPoint {
  day: number;
  time: string;
}

export interface OpeningPeriod {
  open: OpeningPeriodPoint;
  /** 沒有 close = 24 小時營業 */
  close?: OpeningPeriodPoint;
}

export type PlaceBusinessStatus = 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';

/** Apps Script `placeDetails` 抓回來後存到 item 上，避免每次打開都重抓 */
export interface ItemOpeningHours {
  /** 抓營業時間時的 placeId；和 item.placeId 不同代表地點換了，要重抓 */
  placeId?: string;
  /** Google weekday_text（zh-TW），index 0 = 星期一 */
  weekdayText: string[];
  periods?: OpeningPeriod[];
  /** 地點所在時區相對 UTC 的分鐘數（日本 540）；periods 都是這個時區的牆上時間 */
  utcOffsetMinutes?: number;
  businessStatus?: PlaceBusinessStatus;
  /** Google 地圖上的地點頁 */
  url?: string;
  /** Google 沒有提供營業時間（例如車站、街道） */
  noHours?: boolean;
  fetchedAt: Date;
}

export interface ItineraryItem {
  id: string;
  order: number;
  startTime?: string;
  endTime?: string;
  type?: ItineraryItemType;
  title: string;
  placeId?: string;
  placeName?: string;
  address?: string;
  lat?: number;
  lng?: number;
  photoUrl?: string;
  /** Google Maps 分享連結（解析後保存原始 URL 或展開後的長網址） */
  mapsUrl?: string;
  estimatedCost?: number;
  actualCost?: number;
  currency?: string;
  linkedTxId?: string;
  notes?: string;
  status?: ItineraryItemStatus;
  /** 從巧明日常匯入的項目才有：`chiauming-100:{tripKey}:{stopId}`，重新匯入時靠它更新而非重複新增 */
  sourceId?: string;
  /** 匯入當下用來定位的地點字串；變了才重新 geocode，沒變就保留已補上的座標 */
  sourcePlaceQuery?: string;
  /** 營業時間（有 placeId 才會抓） */
  openingHours?: ItemOpeningHours;
}

const BUSINESS_STATUSES: PlaceBusinessStatus[] = ['OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY'];

function parsePeriodPoint(v: unknown): OpeningPeriodPoint | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.day !== 'number' || typeof o.time !== 'string' || !/^\d{4}$/.test(o.time)) return null;
  return { day: o.day, time: o.time };
}

export function parseOpeningHours(v: unknown): ItemOpeningHours | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const fetchedAt = tsToDate(o.fetchedAt);
  if (!fetchedAt) return undefined;
  const periods: OpeningPeriod[] = [];
  if (Array.isArray(o.periods)) {
    for (const p of o.periods as Array<Record<string, unknown> | null>) {
      const open = parsePeriodPoint(p?.open);
      if (!open) continue;
      const close = parsePeriodPoint(p?.close);
      periods.push(close ? { open, close } : { open });
    }
  }
  const status = typeof o.businessStatus === 'string' && (BUSINESS_STATUSES as string[]).includes(o.businessStatus)
    ? (o.businessStatus as PlaceBusinessStatus)
    : undefined;
  return {
    placeId: typeof o.placeId === 'string' ? o.placeId : undefined,
    weekdayText: Array.isArray(o.weekdayText) ? o.weekdayText.filter((x): x is string => typeof x === 'string') : [],
    periods,
    utcOffsetMinutes: typeof o.utcOffsetMinutes === 'number' ? o.utcOffsetMinutes : undefined,
    businessStatus: status,
    url: typeof o.url === 'string' ? o.url : undefined,
    noHours: o.noHours === true ? true : undefined,
    fetchedAt,
  };
}

/** 寫入 Firestore 用：fetchedAt → Timestamp、去掉 undefined */
export function openingHoursToFirestore(h: ItemOpeningHours): Record<string, unknown> {
  const out: Record<string, unknown> = {
    weekdayText: h.weekdayText,
    periods: (h.periods ?? []).map((p) => (p.close ? { open: p.open, close: p.close } : { open: p.open })),
    fetchedAt: Timestamp.fromDate(h.fetchedAt),
  };
  if (h.placeId) out.placeId = h.placeId;
  if (h.utcOffsetMinutes !== undefined) out.utcOffsetMinutes = h.utcOffsetMinutes;
  if (h.businessStatus) out.businessStatus = h.businessStatus;
  if (h.url) out.url = h.url;
  if (h.noHours) out.noHours = true;
  return out;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export const itineraryConverter: FirestoreDataConverter<ItineraryDoc> = {
  toFirestore: (i) => {
    const { id: _id, notesUpdatedAt, ...rest } = i as ItineraryDoc;
    void _id;
    const out: Record<string, unknown> = stripUndefined(rest) as Record<string, unknown>;
    if (notesUpdatedAt) out.notesUpdatedAt = Timestamp.fromDate(notesUpdatedAt);
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): ItineraryDoc => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId,
      tripId: d.tripId,
      title: d.title ?? '',
      summary: d.summary,
      tips: Array.isArray(d.tips) ? d.tips : undefined,
      notes: typeof d.notes === 'string' ? d.notes : undefined,
      notesUpdatedAt: tsToDate(d.notesUpdatedAt) ?? undefined,
      generatedByLLM: d.generatedByLLM,
      llmModel: d.llmModel,
      destination: d.destination,
      startDate: d.startDate,
      endDate: d.endDate,
    };
  },
};

export const itineraryDayConverter: FirestoreDataConverter<ItineraryDay> = {
  toFirestore: (d) => {
    const { id: _id, ...rest } = d as ItineraryDay;
    void _id;
    return stripUndefined(rest);
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      date: d.date ?? '',
      theme: d.theme,
    };
  },
};

export const itineraryItemConverter: FirestoreDataConverter<ItineraryItem> = {
  toFirestore: (i) => {
    const { id: _id, openingHours, ...rest } = i as ItineraryItem;
    void _id;
    const out: Record<string, unknown> = stripUndefined(rest) as Record<string, unknown>;
    if (openingHours) out.openingHours = openingHoursToFirestore(openingHours);
    return out;
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      order: d.order ?? 0,
      startTime: d.startTime,
      endTime: d.endTime,
      type: d.type,
      title: d.title ?? '',
      placeId: d.placeId,
      placeName: d.placeName,
      address: d.address,
      lat: d.lat,
      lng: d.lng,
      photoUrl: d.photoUrl,
      mapsUrl: d.mapsUrl,
      estimatedCost: d.estimatedCost,
      actualCost: d.actualCost,
      currency: d.currency,
      linkedTxId: d.linkedTxId,
      notes: d.notes,
      status: d.status,
      sourceId: typeof d.sourceId === 'string' ? d.sourceId : undefined,
      sourcePlaceQuery: typeof d.sourcePlaceQuery === 'string' ? d.sourcePlaceQuery : undefined,
      openingHours: parseOpeningHours(d.openingHours),
    };
  },
};
