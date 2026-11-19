import { upsertDay, upsertItem, updateItem } from '@/features/itinerary/api';
import type { ItineraryItemType } from '@/features/itinerary/types';
import { upsertItinerary } from '@/features/itinerary/api';
import { callAppsScript } from '@/lib/apps-script';
import { formatDateInput, formatTWDateInput, parseDateInput } from '@/lib/tz';
import type { ItineraryItemKind, TemplateItem, TripTemplate } from './templates';

export interface WrittenItem {
  dayId: string;
  itemId: string;
  query: string;
  /** transport 類別預設不 geocode，避免「桃園機場 → 成田機場」這種箭頭字串 */
  skipGeocode: boolean;
}

interface GeocodeResp {
  ok: boolean;
  result?: {
    placeId?: string;
    name?: string;
    address?: string;
    lat?: number;
    lng?: number;
    photoUrl?: string;
  };
}

/**
 * 把 TripTemplate 展開成 itinerary + days + items，寫進既有 itinerary schema：
 *   itineraries/{tripId}/days/{YYYY-MM-DD}/items/{autoId}
 *
 * 套用後在背景非阻擋地補座標 — applyTemplate 本身只 await「結構建立」，
 * geocode 失敗不會讓行程建立失敗。
 */
export async function applyTemplate(params: {
  tripId: string;
  userId: string;
  template: TripTemplate;
  startDate: Date;
}): Promise<void> {
  const { tripId, userId, template, startDate } = params;
  const startDay = formatTWDateInput(startDate);

  await upsertItinerary(tripId, {
    tripId,
    userId,
    title: template.name,
    summary: template.description,
    destination: template.destinations.join(', '),
    startDate: startDay,
    endDate: addDaysToDateInput(startDay, template.days - 1),
  });

  const written: WrittenItem[] = [];

  for (const day of template.dayPlan) {
    const dayId = addDaysToDateInput(startDay, day.dayIndex - 1);
    await upsertDay(tripId, {
      id: dayId,
      date: dayId,
      theme: day.title ?? `Day ${day.dayIndex}`,
    });

    for (let i = 0; i < day.items.length; i++) {
      const it = day.items[i];
      if (!it) continue;
      const itemId = await upsertItem(tripId, dayId, {
        id: '',
        order: i + 1,
        startTime: it.time,
        title: it.title,
        type: mapKind(it.kind),
        notes: it.note,
        estimatedCost: it.estimatedCostTWD,
        currency: 'TWD',
        status: 'planned',
      });
      written.push({
        dayId,
        itemId,
        query: buildGeocodeQuery(it, template.destinations),
        skipGeocode: it.kind === 'transport' || it.kind === 'other',
      });
    }
  }

  // 背景非阻擋 geocode：寫完 items 後立即返回，後端慢慢補座標
  void backgroundGeocode(tripId, written);
}

/** 逐筆補座標（Apps Script geocode、限速）；套用模板與從巧明日常匯入共用。 */
export async function backgroundGeocode(tripId: string, items: WrittenItem[]) {
  for (const w of items) {
    if (w.skipGeocode || !w.query) continue;
    try {
      const resp = (await callAppsScript('geocode', undefined, { q: w.query })) as GeocodeResp;
      if (!resp.ok || !resp.result || resp.result.lat == null || resp.result.lng == null) continue;
      const r = resp.result;
      const mapsUrl = r.lat != null && r.lng != null
        ? `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`
        : undefined;
      await updateItem(tripId, w.dayId, w.itemId, {
        placeId: r.placeId ?? undefined,
        placeName: r.name ?? undefined,
        address: r.address ?? undefined,
        lat: r.lat,
        lng: r.lng,
        photoUrl: r.photoUrl ?? undefined,
        mapsUrl,
      });
    } catch (err) {
      console.warn('[applyTemplate background geocode]', w.query, err);
    }
    // 限速：避免 Places API 連打 + 不阻擋使用者操作
    await new Promise((r) => setTimeout(r, 350));
  }
}

function buildGeocodeQuery(it: TemplateItem, destinations: string[]): string {
  const base = it.placeName?.trim() || it.title.trim();
  if (!base) return '';
  // 移除模板裡常見的副資訊（括號、逗號後的描述）
  const cleaned = base
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[、,].*$/g, '')
    .trim();
  const region = destinations[0] ?? '';
  return region ? `${cleaned} ${region}` : cleaned;
}

function mapKind(kind: ItineraryItemKind): ItineraryItemType {
  switch (kind) {
    case 'transport': return 'transport';
    case 'food': return 'meal';
    case 'accommodation': return 'accommodation';
    case 'shopping': return 'shopping';
    case 'attraction':
    case 'other':
    default:
      return 'activity';
  }
}

function addDaysToDateInput(value: string, n: number): string {
  const x = parseDateInput(value);
  if (!x) throw new Error(`Invalid date input: ${value}`);
  x.setDate(x.getDate() + n);
  return formatDateInput(x);
}
