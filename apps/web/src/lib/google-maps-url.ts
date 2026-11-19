/**
 * Parse Google Maps share / place URLs into { lat, lng, name?, mapsUrl }.
 *
 * 支援的格式：
 *   https://www.google.com/maps/place/<name>/@<lat>,<lng>,<zoom>z/data=...
 *   https://www.google.com/maps/place/<name>/data=...!3d<lat>!4d<lng>...
 *   https://www.google.com/maps/search/?api=1&query=<lat>,<lng>
 *   https://www.google.com/maps/search/?api=1&query=<place_name>&query_place_id=ChIJ...
 *   https://www.google.com/maps?q=<lat>,<lng>
 *   https://www.google.com/maps?q=<place_name>
 *   https://maps.google.com/?q=<lat>,<lng>&ll=<lat>,<lng>
 *   https://goo.gl/maps/xxxx           ← 短網址，走後端展開
 *   https://maps.app.goo.gl/xxxx       ← 短網址，走後端展開
 *
 * 海外 (沒 Google 登入 cookie) 常見的 redirect 攔截 (consent.google.com) 由後端
 * `resolveGoogleMapsUrl` 處理；前端只負責能直接解的長網址。
 */

export interface ParsedMapsUrl {
  lat: number;
  lng: number;
  name?: string;
  placeId?: string;
  mapsUrl: string;
}

const COORD = /-?\d+(?:\.\d+)?/.source;

function isCoord(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' && typeof lng === 'number'
    && isFinite(lat) && isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  );
}

export function parseGoogleMapsUrl(input: string): ParsedMapsUrl | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  // 1. /maps/place/<name>/@lat,lng,zoom
  const placeAt = new RegExp(`/maps/place/([^/?]+)/@(${COORD}),(${COORD})`, 'i').exec(raw);
  if (placeAt) {
    const lat = Number(placeAt[2]);
    const lng = Number(placeAt[3]);
    if (isCoord(lat, lng)) {
      return { lat, lng, name: decodeNameSegment(placeAt[1] ?? ''), mapsUrl: raw };
    }
  }

  // 2. /maps/place/<name>/.../!3d<lat>!4d<lng>
  const placeData = new RegExp(`/maps/place/([^/?]+).*?!3d(${COORD})!4d(${COORD})`, 'i').exec(raw);
  if (placeData) {
    const lat = Number(placeData[2]);
    const lng = Number(placeData[3]);
    if (isCoord(lat, lng)) {
      return { lat, lng, name: decodeNameSegment(placeData[1] ?? ''), mapsUrl: raw };
    }
  }

  // 3. ?q= / ?ll= / ?center= / ?query= / ?destination= 等 query 帶 LAT,LNG
  const qll = new RegExp(`[?&](?:q|ll|center|query|destination|origin|viewpoint)=(${COORD}),(${COORD})`, 'i').exec(raw);
  if (qll) {
    const lat = Number(qll[1]);
    const lng = Number(qll[2]);
    if (isCoord(lat, lng)) {
      return { lat, lng, name: extractNameFromQuery(raw) ?? undefined, mapsUrl: raw };
    }
  }

  // 4. bare @lat,lng (URL 中段 fallback)
  const at = new RegExp(`@(${COORD}),(${COORD})`).exec(raw);
  if (at) {
    const lat = Number(at[1]);
    const lng = Number(at[2]);
    if (isCoord(lat, lng)) {
      return { lat, lng, name: extractNameFromQuery(raw) ?? undefined, mapsUrl: raw };
    }
  }

  return null;
}

function extractNameFromQuery(raw: string): string | null {
  const m = /[?&](?:q|query|destination|origin)=([^&]+)/i.exec(raw);
  if (!m) return null;
  const decoded = decodeNameSegment(m[1] ?? '');
  if (!decoded) return null;
  // 純座標、純 place_id 不算 name
  if (new RegExp(`^${COORD},\\s*${COORD}$`).test(decoded)) return null;
  if (/^place_id:/i.test(decoded)) return null;
  return decoded;
}

/** 短網址 / app universal link → 必須走後端展開 */
export function isShortMapsUrl(input: string): boolean {
  if (!input) return false;
  const s = input.trim().toLowerCase();
  return /^https?:\/\/(?:maps\.app\.goo\.gl|app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/.test(s);
}

/** 字串是否看起來像 Google Maps 連結 */
export function isMapsUrl(input: string): boolean {
  if (!input) return false;
  const s = input.trim().toLowerCase();
  return (
    s.startsWith('http') &&
    (s.includes('google.com/maps') ||
      s.includes('maps.google.') ||
      isShortMapsUrl(s))
  );
}

/** 從座標生出一個 maps.google.com 連結（解析不到 mapsUrl 時使用） */
export function buildMapsUrlFromCoords(lat: number, lng: number, name?: string): string {
  const base = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  if (name) return `${base}&query_place_id=${encodeURIComponent(name)}`;
  return base;
}

function decodeNameSegment(segment: string): string | undefined {
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment).replace(/\+/g, ' ').trim() || undefined;
  } catch {
    return segment.replace(/\+/g, ' ').trim() || undefined;
  }
}
