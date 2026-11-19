import { z } from 'zod';
import { sha256Hex } from '@/features/ledger/paste-transfer-format';
import type { ItineraryItemType } from '@/features/itinerary/types';
import type { TripStatus } from './types';

/**
 * 「從巧明日常匯入」行程的剪貼簿格式（巧明日常 `src/lib/rmoney-trip-transfer.ts` 產生）。
 * 只有行程本身：旅程名稱、日期與停留點；費用走記帳的「貼上匯入」，兩者互不相干。
 * 這個檔案只做解析與規劃（純函式、可測試），寫入 Firestore 在 `apply-chiauming-import.ts`。
 */
export const CHIAUMING_TRIP_FORMAT = 'chiauming-trip';
export const MAX_CHIAUMING_STOPS = 300;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stopSchema = z.object({
  sourceId: z.string().min(10).max(300).regex(/^chiauming-100:[^\s]+$/),
  title: z.string().min(1).max(200).refine((value) => value.trim().length > 0),
  date: dateSchema,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  place: z.string().max(200).optional(),
  address: z.string().max(300).optional(),
  note: z.string().max(2000).optional(),
  mapQuery: z.string().max(300).optional(),
}).strict();
const transferSchema = z.object({
  format: z.literal(CHIAUMING_TRIP_FORMAT),
  version: z.literal(1),
  trip: z.object({
    sourceTripKey: z.string().min(1).max(160).regex(/^[^\s:]+$/),
    title: z.string().min(1).max(160),
    destination: z.string().max(160).optional(),
    startDate: dateSchema.optional(),
    endDate: dateSchema.optional(),
  }).strict(),
  stops: z.array(stopSchema).max(MAX_CHIAUMING_STOPS),
}).strict();

export type ChiaumingTripTransfer = z.infer<typeof transferSchema>;
export type ChiaumingStop = z.infer<typeof stopSchema>;

/** 台北中午換成 UTC 仍是同一天；拒絕 2/30 這類會被 JS 自動進位的日期。 */
function isRealDate(value: string): boolean {
  const date = new Date(`${value}T12:00:00+08:00`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 快速判斷剪貼簿內容是不是行程格式（貼錯成費用 JSON 時給比較準的提示）。 */
export function looksLikeChiaumingTrip(text: string): boolean {
  return text.includes(`"${CHIAUMING_TRIP_FORMAT}"`);
}

export function parseChiaumingTrip(text: string): ChiaumingTripTransfer {
  if (text.length > 400_000) throw new Error('匯入內容過大（最多 400 KB）。');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('請貼上巧明日常「複製到 RMoney」的完整內容。'); }
  if (raw && typeof raw === 'object' && (raw as { format?: unknown }).format === 'chiauming-expenses') {
    throw new Error('這是費用資料，請到「記帳 → 貼上匯入」貼上。');
  }
  const result = transferSchema.safeParse(raw);
  if (!result.success) throw new Error('匯入格式或版本不正確，請重新從巧明日常複製。');
  const transfer = result.data;
  const { startDate, endDate, sourceTripKey } = transfer.trip;
  if ((startDate && !isRealDate(startDate)) || (endDate && !isRealDate(endDate))) throw new Error('旅程日期不正確。');
  if (startDate && endDate && startDate > endDate) throw new Error('旅程的結束日早於開始日。');
  const ids = new Set<string>();
  for (const stop of transfer.stops) {
    if (!isRealDate(stop.date)) throw new Error(`「${stop.title}」的日期不正確。`);
    if (!stop.sourceId.startsWith(`chiauming-100:${sourceTripKey}:`)) throw new Error('來源 ID 與旅程不一致。');
    if (ids.has(stop.sourceId)) throw new Error('匯入資料含重複的停留點。');
    ids.add(stop.sourceId);
  }
  if (!startDate && !endDate && transfer.stops.length === 0) {
    throw new Error('這趟旅程沒有日期也沒有停留點，請先在巧明日常填上日期。');
  }
  return transfer;
}

const TYPE_RULES: { type: ItineraryItemType; words: string[] }[] = [
  { type: 'transport', words: ['機場', '航班', '班機', '起飛', '降落', '登機', '高鐵', '新幹線', '火車', '車站', '捷運', '地鐵', '巴士', '客運', '渡輪', '租車', '取車', '還車', '接駁', 'airport', 'flight', 'station', 'train'] },
  { type: 'accommodation', words: ['飯店', '酒店', '旅館', '民宿', '住宿', '入住', '退房', 'check-in', 'check in', 'checkout', 'check-out', 'hotel', 'hostel', 'airbnb'] },
  { type: 'meal', words: ['早餐', '早午餐', '午餐', '晚餐', '宵夜', '餐廳', '吃', '咖啡', '拉麵', '燒肉', '壽司', '小吃', '甜點', '居酒屋', '食堂', 'restaurant', 'cafe', 'lunch', 'dinner', 'breakfast'] },
  { type: 'shopping', words: ['購物', '逛街', 'outlet', '百貨', '商場', '市集', '超市', '藥妝', 'mall', 'shopping'] },
];

/** 巧明日常的停留點沒有分類，依標題與地點的關鍵字猜；猜不到就當景點活動。 */
export function guessItemType(stop: Pick<ChiaumingStop, 'title' | 'place'>): ItineraryItemType {
  const text = `${stop.title} ${stop.place ?? ''}`.toLowerCase();
  for (const rule of TYPE_RULES) {
    if (rule.words.some((word) => text.includes(word))) return rule.type;
  }
  return 'activity';
}

/** 地點搜尋字串：與巧明日常 `mapsQueryFor()` 相同的優先順序，再退到地址。 */
export function placeQueryFor(stop: Pick<ChiaumingStop, 'mapQuery' | 'place' | 'address'>): string {
  return stop.mapQuery?.trim() || stop.place?.trim() || stop.address?.trim() || '';
}

export function mapsSearchUrl(query: string): string | undefined {
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : undefined;
}

export async function itineraryItemIdFor(sourceId: string): Promise<string> {
  return `cm100_${(await sha256Hex(sourceId)).slice(0, 40)}`;
}

export interface PlannedItem {
  sourceId: string;
  order: number;
  startTime?: string;
  title: string;
  type: ItineraryItemType;
  placeName?: string;
  address?: string;
  notes?: string;
  mapsUrl?: string;
  placeQuery: string;
  /** 交通類常是「桃園機場 → 成田機場」這種字串，geocode 只會猜錯，跟套用模板時一樣跳過。 */
  skipGeocode: boolean;
}

export interface PlannedDay {
  date: string;
  items: PlannedItem[];
}

export interface ChiaumingImportPlan {
  sourceTripKey: string;
  name: string;
  destination: string[];
  startDate: string;
  endDate: string;
  days: PlannedDay[];
  stopCount: number;
}

/** 旅程日期以巧明日常填的為準，停留點超出範圍時往外擴，確保每一天都落在旅程裡。 */
export function planChiaumingImport(transfer: ChiaumingTripTransfer): ChiaumingImportPlan {
  const { trip } = transfer;
  const dates = transfer.stops.map((stop) => stop.date).sort();
  const candidatesStart = [trip.startDate, dates[0]].filter((value): value is string => Boolean(value)).sort();
  const candidatesEnd = [trip.endDate, dates[dates.length - 1]].filter((value): value is string => Boolean(value)).sort();
  const startDate = candidatesStart[0] ?? trip.endDate ?? '';
  const endDate = candidatesEnd[candidatesEnd.length - 1] ?? startDate;

  const byDate = new Map<string, ChiaumingStop[]>();
  for (const stop of transfer.stops) byDate.set(stop.date, [...(byDate.get(stop.date) ?? []), stop]);
  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, stops]): PlannedDay => ({
      date,
      // 巧明日常已依時間排好；這裡用穩定排序再保險一次，沒時間的維持原順序排在後面。
      items: stops
        .map((stop, index) => ({ stop, index }))
        .sort((a, b) => {
          if (a.stop.time && b.stop.time && a.stop.time !== b.stop.time) return a.stop.time.localeCompare(b.stop.time);
          if (Boolean(a.stop.time) !== Boolean(b.stop.time)) return a.stop.time ? -1 : 1;
          return a.index - b.index;
        })
        .map(({ stop }, index): PlannedItem => {
          const type = guessItemType(stop);
          const placeQuery = placeQueryFor(stop);
          const place = stop.place?.trim();
          return {
            sourceId: stop.sourceId,
            order: index + 1,
            startTime: stop.time,
            title: stop.title.trim(),
            type,
            placeName: place || undefined,
            address: stop.address?.trim() || undefined,
            notes: stop.note?.trim() || undefined,
            mapsUrl: mapsSearchUrl(placeQuery),
            placeQuery,
            skipGeocode: type === 'transport' || !placeQuery,
          };
        }),
    }));

  return {
    sourceTripKey: trip.sourceTripKey,
    name: trip.title.trim(),
    destination: (trip.destination ?? '').split(/[,，、]/).map((value) => value.trim()).filter(Boolean),
    startDate,
    endDate,
    days,
    stopCount: transfer.stops.length,
  };
}

/** 新建旅程的狀態依日期推算（巧明日常的狀態是手填標籤，常忘了改）。`today` 為台北日期字串。 */
export function statusForDates(startDate: string, endDate: string, today: string): TripStatus {
  if (endDate < today) return 'done';
  if (startDate <= today) return 'active';
  return 'planning';
}

/** 更新既有旅程時只擴大日期、不縮小，避免把使用者在 RMoney 手動延長的日期蓋掉。 */
export function widenDateRange(
  current: { startDate: string; endDate: string },
  incoming: { startDate: string; endDate: string },
): { startDate: string; endDate: string } {
  return {
    startDate: incoming.startDate && incoming.startDate < current.startDate ? incoming.startDate : current.startDate,
    endDate: incoming.endDate && incoming.endDate > current.endDate ? incoming.endDate : current.endDate,
  };
}

/** RMoney 旅程名稱完全相同（忽略空白與大小寫）且唯一時才預選更新。 */
export function matchTripByName<T extends { id: string; name: string }>(name: string, trips: readonly T[]): T | undefined {
  const norm = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  const target = norm(name);
  if (!target) return undefined;
  const hits = trips.filter((trip) => norm(trip.name) === target);
  return hits.length === 1 ? hits[0] : undefined;
}
