/**
 * 「路線」：把一天的停留點依序組成 Google Maps 路線連結（Maps URLs，免費、不用 Directions API）。
 * 純函式，測試：apps/web/tests/itinerary-hours.test.cjs。
 *
 * https://developers.google.com/maps/documentation/urls/get-started#directions-action
 * - 一個連結 = origin + 最多 9 個 waypoints + destination；超過就切成多段，下一段從上一段終點出發。
 * - 手機 App / 行動瀏覽器實際只吃 3 個 waypoints（UI 在觸控裝置傳 maxWaypoints = 3）。
 * - 大眾運輸（transit）不支援 waypoints：每一段只有起訖兩點。
 * - 有 place_id 就帶 origin_place_id / destination_place_id；waypoint_place_ids 必須和 waypoints 一一對應，
 *   所以只有「每個 waypoint 都有 place_id」時才帶。
 */
import type { ItineraryItem } from './types';

export type TravelMode = 'transit' | 'walking' | 'driving' | 'bicycling';

export const TRAVEL_MODE_LABEL: Record<TravelMode, string> = {
  transit: '大眾運輸',
  walking: '步行',
  driving: '開車',
  bicycling: '單車',
};

export const MAX_URL_WAYPOINTS = 9;
export const MOBILE_URL_WAYPOINTS = 3;

export interface RouteStop {
  label: string;
  /** 給 Google 的文字位置（座標 `lat,lng` 或地名 / 地址） */
  query: string;
  placeId?: string;
}

export interface DirectionsLink {
  url: string;
  from: string;
  to: string;
  /** 這段包含的停留點數（含起訖） */
  stopCount: number;
}

type StopSource = Pick<ItineraryItem, 'title' | 'placeId' | 'placeName' | 'address' | 'lat' | 'lng'>;

function hasCoords(it: StopSource): it is StopSource & { lat: number; lng: number } {
  return typeof it.lat === 'number' && typeof it.lng === 'number'
    && Number.isFinite(it.lat) && Number.isFinite(it.lng);
}

/**
 * 行程項目 → 路線停留點。沒有 placeId / 座標 / 地址的項目（例如「自由活動」）略過。
 * 有 placeId 時文字用地名（Google 以 place_id 為準，地名只是備援與顯示）；否則座標優先，最準。
 */
export function itemsToRouteStops(items: StopSource[]): RouteStop[] {
  const out: RouteStop[] = [];
  for (const it of items) {
    const label = (it.placeName || it.title || it.address || '').trim();
    const coords = hasCoords(it) ? `${it.lat},${it.lng}` : '';
    const address = (it.address ?? '').trim();
    if (it.placeId) {
      out.push({ label: label || '地點', query: label || coords || address, placeId: it.placeId });
    } else if (coords) {
      out.push({ label: label || coords, query: coords });
    } else if (address) {
      out.push({ label: label || address, query: address });
    }
  }
  // 連續同一點（例如同一間飯店的退房 / 寄放行李）只留一個
  return out.filter((s, i) => {
    const prev = out[i - 1];
    if (!prev) return true;
    return !(s.query === prev.query && (s.placeId ?? '') === (prev.placeId ?? ''));
  });
}

function buildUrl(segment: RouteStop[], mode: TravelMode): string {
  const origin = segment[0];
  const destination = segment[segment.length - 1];
  if (!origin || !destination) return '';
  const waypoints = segment.slice(1, -1);
  const params = new URLSearchParams();
  params.set('api', '1');
  params.set('origin', origin.query);
  if (origin.placeId) params.set('origin_place_id', origin.placeId);
  params.set('destination', destination.query);
  if (destination.placeId) params.set('destination_place_id', destination.placeId);
  if (waypoints.length > 0) {
    params.set('waypoints', waypoints.map((w) => w.query).join('|'));
    if (waypoints.every((w) => w.placeId)) {
      params.set('waypoint_place_ids', waypoints.map((w) => w.placeId).join('|'));
    }
  }
  params.set('travelmode', mode);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** 依序把停留點切成多個 Google Maps 路線連結；少於 2 點回空陣列 */
export function buildDirectionsLinks(
  stops: RouteStop[],
  mode: TravelMode,
  maxWaypoints: number = MAX_URL_WAYPOINTS,
): DirectionsLink[] {
  if (stops.length < 2) return [];
  const perLink = mode === 'transit' ? 0 : Math.max(0, Math.min(MAX_URL_WAYPOINTS, Math.floor(maxWaypoints)));
  const step = perLink + 1;
  const links: DirectionsLink[] = [];
  for (let i = 0; i < stops.length - 1; i += step) {
    const segment = stops.slice(i, Math.min(i + step, stops.length - 1) + 1);
    const first = segment[0];
    const last = segment[segment.length - 1];
    if (!first || !last) continue;
    links.push({ url: buildUrl(segment, mode), from: first.label, to: last.label, stopCount: segment.length });
  }
  return links;
}
