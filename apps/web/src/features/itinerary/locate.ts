import { callAppsScript } from '@/lib/apps-script';
import { isMapsUrl, parseGoogleMapsUrl } from '@/lib/google-maps-url';
import { updateItem } from './api';
import type { ItineraryItem } from './types';

/**
 * 背景補座標：AI 匯入與「重新定位」共用。
 *  - resolve：Google Maps 連結（短網址、或沒座標的長網址）→ Apps Script `resolveGoogleMapsUrl`
 *  - search：地名 → Apps Script `geocode`（Places）
 * 一筆失敗不影響其他筆；失敗的項目只是少一個地圖標記，之後可再按「重新定位」或手動貼連結。
 */
export type LocateTask =
  | { dayId: string; itemId: string; kind: 'resolve'; url: string }
  | { dayId: string; itemId: string; kind: 'search'; query: string };

interface PlaceResult {
  placeId?: string | null;
  name?: string | null;
  address?: string | null;
  lat?: number;
  lng?: number;
  photoUrl?: string | null;
  mapsUrl?: string | null;
}

/** 搜尋得到的地點：連結用座標版（比文字搜尋準），名稱與地址只在原本沒有時才補。 */
function patchFromPlace(r: PlaceResult, keepUrl?: string): Partial<ItineraryItem> | null {
  if (r.lat == null || r.lng == null) return null;
  return {
    placeId: r.placeId ?? undefined,
    address: r.address ?? undefined,
    lat: r.lat,
    lng: r.lng,
    photoUrl: r.photoUrl ?? undefined,
    mapsUrl: keepUrl ?? r.mapsUrl ?? `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`,
  };
}

async function locateOne(task: LocateTask): Promise<Partial<ItineraryItem> | null> {
  if (task.kind === 'resolve') {
    const resp = (await callAppsScript('resolveGoogleMapsUrl', undefined, { url: task.url })) as { ok: boolean; result?: PlaceResult };
    return resp.ok && resp.result ? patchFromPlace(resp.result, task.url) : null;
  }
  const resp = (await callAppsScript('geocode', undefined, { q: task.query })) as { ok: boolean; result?: PlaceResult };
  return resp.ok && resp.result ? patchFromPlace(resp.result) : null;
}

export interface LocateResult {
  located: number;
  failed: number;
}

export async function backgroundLocate(
  tripId: string,
  tasks: readonly LocateTask[],
  onProgress?: (done: number, total: number) => void,
): Promise<LocateResult> {
  let located = 0;
  let failed = 0;
  for (const [index, task] of tasks.entries()) {
    try {
      const patch = await locateOne(task);
      if (patch) {
        await updateItem(tripId, task.dayId, task.itemId, patch);
        located += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      console.warn('[backgroundLocate]', task, err);
      failed += 1;
    }
    onProgress?.(index + 1, tasks.length);
    // 限速：避免 Places API 連打
    await new Promise((r) => setTimeout(r, 350));
  }
  return { located, failed };
}

/** 是不是我們自己產生的「文字搜尋」連結（不是使用者給的地點連結）。 */
export function isSearchUrl(url: string | undefined): boolean {
  return Boolean(url && /\/maps\/search\/\?api=1&query=/.test(url) && !parseGoogleMapsUrl(url));
}

/** 這個項目還沒有座標、但有辦法定位（交通類沒連結就不算）。 */
export function needsLocate(item: ItineraryItem): boolean {
  if (item.lat != null && item.lng != null) return false;
  if (item.mapsUrl && isMapsUrl(item.mapsUrl) && !isSearchUrl(item.mapsUrl)) return true;
  if (item.type === 'transport') return false;
  return Boolean(item.sourcePlaceQuery || item.placeName || item.address || item.title);
}

/** 「重新定位」：使用者給的連結優先，再來是匯入時的搜尋字串、地名、地址、標題。 */
export function relocateTaskFor(dayId: string, item: ItineraryItem, destination = ''): LocateTask | null {
  if (!needsLocate(item)) return null;
  if (item.mapsUrl && !isSearchUrl(item.mapsUrl)) return { dayId, itemId: item.id, kind: 'resolve', url: item.mapsUrl };
  const base = item.sourcePlaceQuery || item.placeName || item.address || item.title;
  const region = destination.split(/[,，、]/)[0]?.trim() ?? '';
  const query = region && !item.sourcePlaceQuery && !base.includes(region) ? `${base} ${region}` : base;
  return { dayId, itemId: item.id, kind: 'search', query };
}
