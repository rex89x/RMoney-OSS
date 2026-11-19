import { doc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { dateInputToTWDate, formatTWDateInput } from '@/lib/tz';
import { getItinerary, listDays, listItems, upsertItinerary } from '@/features/itinerary/api';
import { ChunkedBatch } from '@/features/itinerary/chunked-batch';
import { itineraryDayConverter, itineraryItemConverter, type ItineraryDay, type ItineraryItem } from '@/features/itinerary/types';
import { createTrip, updateTrip } from './api';
import { backgroundGeocode, type WrittenItem } from './apply-template';
import { itineraryItemIdFor, widenDateRange, type ChiaumingImportPlan, type PlannedItem } from './import-chiauming';
import type { Trip, TripStatus } from './types';

export type ChiaumingImportTarget =
  | { kind: 'new'; status: TripStatus; sharedWith?: string[] }
  | { kind: 'existing'; trip: Trip };

export interface ChiaumingImportResult {
  tripId: string;
  created: number;
  updated: number;
  removed: number;
}

/**
 * 只有巧明日常管的欄位每次都以來源為準（來源清掉備註，這邊也要清掉）；
 * 座標類欄位在地點字串沒變時保留，免得每次重新匯入都要重新 geocode、也保住 RMoney 端的花費與狀態。
 */
function mergeItem(id: string, planned: PlannedItem, prev: ItineraryItem | undefined): { item: ItineraryItem; needsGeocode: boolean } {
  const keepPlace = Boolean(prev && prev.sourcePlaceQuery === planned.placeQuery && prev.lat != null && prev.lng != null);
  const base: ItineraryItem = prev
    ? {
      ...prev,
      ...(keepPlace ? {} : { placeId: undefined, lat: undefined, lng: undefined, photoUrl: undefined, mapsUrl: undefined }),
    }
    : { id, order: planned.order, title: planned.title, status: 'planned' };
  const item: ItineraryItem = {
    ...base,
    id,
    order: planned.order,
    startTime: planned.startTime,
    type: planned.type,
    title: planned.title,
    placeName: planned.placeName ?? (keepPlace ? prev?.placeName : undefined),
    address: planned.address ?? (keepPlace ? prev?.address : undefined),
    notes: planned.notes,
    mapsUrl: keepPlace ? prev?.mapsUrl ?? planned.mapsUrl : planned.mapsUrl,
    sourceId: planned.sourceId,
    sourcePlaceQuery: planned.placeQuery,
  };
  return { item, needsGeocode: !keepPlace && !planned.skipGeocode };
}

/**
 * 把巧明日常的行程寫進 RMoney：旅程 → itineraries/{tripId} → days/{YYYY-MM-DD} → items/{cm100_…}。
 * 項目 ID 由來源 ID 推出，所以重複匯入是更新；巧明日常刪掉或改日期的停留點，舊位置的項目會被移除。
 * 不是從巧明日常來的項目（使用者在 RMoney 自己加的）一律不碰。
 */
export async function applyChiaumingImport(params: {
  plan: ChiaumingImportPlan;
  userId: string;
  target: ChiaumingImportTarget;
}): Promise<ChiaumingImportResult> {
  const { plan, userId, target } = params;
  const startDate = dateInputToTWDate(plan.startDate);
  const endDate = dateInputToTWDate(plan.endDate);
  if (!startDate || !endDate) throw new Error('旅程日期無效');

  let tripId: string;
  let range = { startDate: plan.startDate, endDate: plan.endDate };
  if (target.kind === 'new') {
    tripId = await createTrip({
      userId,
      createdAt: new Date(),
      name: plan.name,
      destination: plan.destination,
      startDate,
      endDate,
      baseCurrency: 'TWD',
      foreignCurrencies: [],
      budget: 0,
      status: target.status,
      notes: '從巧明日常匯入',
      ...(target.sharedWith && target.sharedWith.length > 0 ? { sharedWith: target.sharedWith } : {}),
    });
  } else {
    const trip = target.trip;
    tripId = trip.id;
    range = widenDateRange(
      { startDate: formatTWDateInput(trip.startDate), endDate: formatTWDateInput(trip.endDate) },
      range,
    );
    const patch: Partial<Trip> = {};
    const nextStart = dateInputToTWDate(range.startDate);
    const nextEnd = dateInputToTWDate(range.endDate);
    if (nextStart && nextStart.getTime() !== trip.startDate.getTime()) patch.startDate = nextStart;
    if (nextEnd && nextEnd.getTime() !== trip.endDate.getTime()) patch.endDate = nextEnd;
    if (trip.destination.length === 0 && plan.destination.length > 0) patch.destination = plan.destination;
    if (Object.keys(patch).length > 0) await updateTrip(tripId, patch);
  }

  // itinerary 文件不存在時才寫完整欄位；已存在就只同步日期，標題與 LLM 筆記等保持原樣。
  const existingItinerary = await getItinerary(tripId);
  await upsertItinerary(tripId, existingItinerary
    ? { title: existingItinerary.title, startDate: range.startDate, endDate: range.endDate }
    : { tripId, userId, title: plan.name, destination: plan.destination.join(', '), startDate: range.startDate, endDate: range.endDate });

  // 讀出目前所有「來自這趟巧明日常旅程」的項目，用來保留座標與找出要移除的舊項目。
  const sourcePrefix = `chiauming-100:${plan.sourceTripKey}:`;
  const existing = new Map<string, { dayId: string; item: ItineraryItem }>();
  const existingDays = target.kind === 'existing' || existingItinerary ? await listDays(tripId) : [];
  const dayItems = await Promise.all(existingDays.map(async (day) => ({ dayId: day.id, items: await listItems(tripId, day.id) })));
  for (const { dayId, items } of dayItems) {
    for (const item of items) {
      if (item.sourceId?.startsWith(sourcePrefix)) existing.set(item.id, { dayId, item });
    }
  }
  const existingDayIds = new Set(existingDays.map((day) => day.id));

  const batch = new ChunkedBatch();
  const written = new Set<string>();
  const toGeocode: WrittenItem[] = [];
  let created = 0;
  let updated = 0;
  for (const day of plan.days) {
    if (!existingDayIds.has(day.date)) {
      const dayRef = doc(db, 'itineraries', tripId, 'days', day.date).withConverter(itineraryDayConverter);
      const dayDoc: ItineraryDay = { id: day.date, date: day.date };
      batch.add((b) => b.set(dayRef, dayDoc, { merge: true }));
    }
    for (const planned of day.items) {
      const id = await itineraryItemIdFor(planned.sourceId);
      const prev = existing.get(id);
      const { item, needsGeocode } = mergeItem(id, planned, prev?.item);
      const itemRef = doc(db, 'itineraries', tripId, 'days', day.date, 'items', id).withConverter(itineraryItemConverter);
      batch.add((b) => b.set(itemRef, item));
      written.add(`${day.date}/${id}`);
      if (prev) updated += 1;
      else created += 1;
      if (needsGeocode) toGeocode.push({ dayId: day.date, itemId: id, query: planned.placeQuery, skipGeocode: false });
    }
  }
  let removed = 0;
  for (const [id, { dayId }] of existing) {
    if (written.has(`${dayId}/${id}`)) continue;
    const staleRef = doc(db, 'itineraries', tripId, 'days', dayId, 'items', id);
    batch.add((b) => b.delete(staleRef));
    // 只是改到別天的不算「移除」。
    if (![...written].some((key) => key.endsWith(`/${id}`))) removed += 1;
  }
  await batch.commit();

  // 背景補座標，不阻擋匯入完成；失敗只會少一個地圖標記。
  if (toGeocode.length > 0) void backgroundGeocode(tripId, toGeocode);

  return { tripId, created, updated, removed };
}
