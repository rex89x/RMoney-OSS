import { doc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { dateInputToTWDate, formatTWDateInput } from '@/lib/tz';
import { createTrip, updateTrip } from '@/features/trips/api';
import type { Trip, TripStatus } from '@/features/trips/types';
import { getItinerary, listDays, listItems, upsertItinerary } from './api';
import { aiItemIdFor, planAiImport, widenRange, type ProposedStop, type ProposedTrip } from './ai-import';
import { ChunkedBatch } from './chunked-batch';
import { backgroundLocate, type LocateTask } from './locate';
import { itineraryDayConverter, itineraryItemConverter, type ItineraryItem } from './types';

export type AiImportTarget =
  | { kind: 'new'; trip: ProposedTrip; status: TripStatus; sharedWith?: string[] }
  | { kind: 'existing'; trip: Trip };

export interface AiImportResult {
  tripId: string;
  created: number;
  updated: number;
  /** 背景定位中的筆數（寫入完成後才開始跑）。 */
  locating: number;
  /** 連結本身就有座標、寫入時就定位好的筆數。 */
  locatedNow: number;
}

/**
 * 把勾選的 AI 提案寫進 itineraries/{tripId}/days/{YYYY-MM-DD}/items/{ai_…}。
 * - 項目 ID 由「日期 + 時間 + 標題」推出：重貼同一份結果是更新，不會重複。
 * - 已存在的項目只覆蓋 AI 管的欄位，保留 RMoney 端的實際花費、狀態、連結的交易。
 * - 旅程日期只往外擴；其他項目（手動、模板、巧明日常匯入）一律不碰。
 * - 寫入完成後在背景補座標，不阻擋匯入。
 */
export async function applyAiImport(params: {
  stops: readonly ProposedStop[];
  userId: string;
  target: AiImportTarget;
  onLocateDone?: (result: { located: number; failed: number }) => void;
}): Promise<AiImportResult> {
  const { stops, userId, target } = params;
  if (stops.length === 0) throw new Error('沒有勾選任何停留點');
  const dates = stops.map((stop) => stop.date);

  let tripId: string;
  let destination: string;
  let range: { startDate: string; endDate: string };
  let title: string;
  if (target.kind === 'new') {
    range = widenRange({ startDate: target.trip.startDate, endDate: target.trip.endDate }, dates);
    const startDate = dateInputToTWDate(range.startDate);
    const endDate = dateInputToTWDate(range.endDate);
    if (!startDate || !endDate) throw new Error('旅程日期無效');
    destination = target.trip.destination;
    title = target.trip.title;
    tripId = await createTrip({
      userId,
      createdAt: new Date(),
      name: target.trip.title,
      destination: destination.split(/[,，、]/).map((value) => value.trim()).filter(Boolean),
      startDate,
      endDate,
      baseCurrency: 'TWD',
      foreignCurrencies: [],
      budget: 0,
      status: target.status,
      notes: 'AI 匯入行程',
      ...(target.sharedWith && target.sharedWith.length > 0 ? { sharedWith: target.sharedWith } : {}),
    });
  } else {
    const trip = target.trip;
    tripId = trip.id;
    destination = trip.destination.join(', ');
    title = trip.name;
    const current = { startDate: formatTWDateInput(trip.startDate), endDate: formatTWDateInput(trip.endDate) };
    range = widenRange(current, dates);
    const patch: Partial<Trip> = {};
    if (range.startDate !== current.startDate) patch.startDate = dateInputToTWDate(range.startDate) ?? trip.startDate;
    if (range.endDate !== current.endDate) patch.endDate = dateInputToTWDate(range.endDate) ?? trip.endDate;
    if (Object.keys(patch).length > 0) await updateTrip(tripId, patch);
  }

  const existingItinerary = await getItinerary(tripId);
  await upsertItinerary(tripId, existingItinerary
    ? { title: existingItinerary.title, startDate: range.startDate, endDate: range.endDate }
    : { tripId, userId, title, destination, startDate: range.startDate, endDate: range.endDate });

  const plan = planAiImport(stops, destination);
  const existingDays = existingItinerary ? await listDays(tripId) : [];
  const existingDayIds = new Set(existingDays.map((day) => day.id));
  const existingByDay = new Map<string, ItineraryItem[]>();
  await Promise.all(plan.filter((day) => existingDayIds.has(day.date)).map(async (day) => {
    existingByDay.set(day.date, await listItems(tripId, day.date));
  }));

  const batch = new ChunkedBatch();
  const tasks: LocateTask[] = [];
  let created = 0;
  let updated = 0;
  let locatedNow = 0;
  for (const day of plan) {
    if (!existingDayIds.has(day.date)) {
      const dayRef = doc(db, 'itineraries', tripId, 'days', day.date).withConverter(itineraryDayConverter);
      batch.add((b) => b.set(dayRef, { id: day.date, date: day.date }, { merge: true }));
    }
    const dayItems = existingByDay.get(day.date) ?? [];
    let nextOrder = dayItems.reduce((max, item) => Math.max(max, item.order ?? 0), 0) + 1;
    for (const planned of day.items) {
      const { stop, locate } = planned;
      const id = await aiItemIdFor(stop);
      const prev = dayItems.find((item) => item.id === id);
      // 地點沒變而且已定位過 → 保留座標，不重新定位
      const keepPlace = Boolean(prev && prev.sourcePlaceQuery === planned.placeQuery && prev.lat != null && prev.lng != null
        && (!stop.mapsUrl || prev.mapsUrl === stop.mapsUrl));
      const base: ItineraryItem = prev
        ? (keepPlace ? prev : { ...prev, placeId: undefined, lat: undefined, lng: undefined, photoUrl: undefined })
        : { id, order: nextOrder++, title: stop.title, status: 'planned' };
      const item: ItineraryItem = {
        ...base,
        id,
        title: stop.title,
        startTime: stop.time,
        endTime: stop.endTime,
        type: stop.type,
        placeName: stop.place,
        address: stop.address ?? (keepPlace ? prev?.address : undefined),
        notes: stop.note,
        estimatedCost: stop.estimatedCost ?? prev?.estimatedCost,
        currency: stop.estimatedCost != null ? stop.currency : prev?.currency,
        mapsUrl: keepPlace ? prev?.mapsUrl : planned.mapsUrl,
        sourcePlaceQuery: planned.placeQuery,
      };
      if (!keepPlace && locate.kind === 'coords') {
        item.lat = locate.lat;
        item.lng = locate.lng;
        locatedNow += 1;
      }
      const itemRef = doc(db, 'itineraries', tripId, 'days', day.date, 'items', id).withConverter(itineraryItemConverter);
      batch.add((b) => b.set(itemRef, item));
      if (prev) updated += 1;
      else created += 1;
      if (!keepPlace && locate.kind === 'resolve') tasks.push({ dayId: day.date, itemId: id, kind: 'resolve', url: locate.url });
      if (!keepPlace && locate.kind === 'search') tasks.push({ dayId: day.date, itemId: id, kind: 'search', query: locate.query });
    }
  }
  await batch.commit();

  if (tasks.length > 0) {
    void backgroundLocate(tripId, tasks).then((result) => params.onLocateDone?.(result));
  }
  return { tripId, created, updated, locating: tasks.length, locatedNow };
}
