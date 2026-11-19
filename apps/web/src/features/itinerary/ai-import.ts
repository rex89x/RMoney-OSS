import { repairJson } from '@/features/import/json-repair';
import { sha256Hex } from '@/features/ledger/paste-transfer-format';
import { guessItemType } from '@/features/trips/import-chiauming';
import { isMapsUrl, isShortMapsUrl, parseGoogleMapsUrl } from '@/lib/google-maps-url';
import type { ItineraryItemType } from './types';

/**
 * 文字 → 行程的 AI 匯入（純函式、可測試；寫入在 `apply-ai-import.ts`）。
 *
 * 和巧明日常 `src/lib/trip-ai-import.ts` 是**同一份契約**：JSON 形狀
 * `{ trip?, stops[], warnings[] }`、同一套整理規則與「重複 / 時段衝突 / 超出日期」分類。
 * 這邊多了幾個選填欄位（type / endTime / address / estimatedCost / currency / mapsUrl），
 * 巧明日常的解析器會略過它不認識的欄位，所以同一份 AI 輸出兩邊都能貼。改格式時兩邊一起改。
 *
 * 兩條路：
 *  - 站內 Claude（Apps Script `parseItineraryText`）：不要求 mapsUrl——模型沒有查證能力，編出來的連結比沒有更糟，
 *    位置改由套用後的 Places 搜尋補上。
 *  - 外部 AI（Claude / ChatGPT，可上網查）：提示詞要求附 Google Maps 連結，查不到就省略。
 */

export const AI_IMPORT_MIN_INPUT_CHARS = 10;
export const AI_IMPORT_MAX_INPUT_CHARS = 20_000;

const TITLE_MAX = 80;
const PLACE_MAX = 120;
const ADDRESS_MAX = 200;
const NOTE_MAX = 500;
const MAP_QUERY_MAX = 160;
const MAPS_URL_MAX = 2_000;
const MAX_STOPS = 120;
const MAX_WARNINGS = 12;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const ITEM_TYPES: readonly ItineraryItemType[] = ['transport', 'meal', 'activity', 'accommodation', 'shopping'];
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export type AiImportMode = 'builtin' | 'external';
export type ProposedStopStatus = 'new' | 'duplicate' | 'conflict' | 'out-of-range';

export interface ProposedStop {
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  type: ItineraryItemType;
  place: string;
  mapQuery?: string;
  address?: string;
  note?: string;
  /** 只收 Google Maps 網域的連結；其他網址一律丟掉。 */
  mapsUrl?: string;
  estimatedCost?: number;
  currency?: string;
}

export interface ClassifiedStop extends ProposedStop {
  status: ProposedStopStatus;
  reason?: string;
}

export interface ProposedTrip {
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
}

export interface ItineraryProposal {
  trip?: ProposedTrip;
  stops: ProposedStop[];
  warnings: string[];
  /** 被丟掉的筆數（缺標題、日期不合法），UI 要誠實告訴使用者。 */
  discarded: number;
}

export interface ExistingStopRef {
  date: string;
  time?: string;
  title: string;
}

export interface PromptContext {
  /** 台北今天，解釋「明天」這類相對說法。 */
  today: string;
  trip?: { title: string; destination: string; startDate: string; endDate: string };
  existingStops?: ExistingStopRef[];
}

/* ------------------------------------------------------------------ */
/* 輸入驗證                                                            */
/* ------------------------------------------------------------------ */

export function validateSourceText(value: string): string | null {
  const text = value.trim();
  if (text.length < AI_IMPORT_MIN_INPUT_CHARS) return `請至少貼上 ${AI_IMPORT_MIN_INPUT_CHARS} 個字的行程描述。`;
  if (text.length > AI_IMPORT_MAX_INPUT_CHARS) {
    return `文字太長了（${text.length} 字），上限是 ${AI_IMPORT_MAX_INPUT_CHARS} 字，請分段匯入。`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 提示詞                                                              */
/* ------------------------------------------------------------------ */

/** 整理規則（兩條路共用；與巧明日常 `buildSystemInstruction` 對齊）。 */
export function buildRules(context: PromptContext, mode: AiImportMode): string[] {
  const lines = [
    '你是行程整理助手。把使用者提供的文字整理成結構化的旅行停留點。',
    '',
    '輸出規則：',
    '- date 一律 YYYY-MM-DD，time / endTime 一律 24 小時制 HH:MM。',
    `- 今天是 ${context.today}。原文用「明天」「後天」這種相對說法時以此為基準。`,
    '- 原文沒寫年份時，挑最接近今天的合理年份，並在 warnings 說明你的假設。',
    '- 原文只寫「早上」「傍晚」這種模糊時間時，給一個合理的具體時間，並在 warnings 說明。',
    '- title 要簡潔，**20 個字以內**，細節放 note。不要把好幾件事塞進同一個 title。',
    '- 一個停留點只做一件事。「抵達機場、搭車進市區、寄放行李」要拆成不同的停留點。',
    '- type 只能是 transport（交通）、meal（餐飲）、activity（景點活動）、accommodation（住宿）、shopping（購物）其中之一。',
    '- place 填可以在 Google Maps 搜到的地點名稱；mapQuery 填更精確的搜尋字串（可含當地語言、分店名、城市）。',
    '- 原文有寫地址才填 address；原文有寫價錢才填 estimatedCost（數字）與 currency（ISO 代碼，例如 JPY、TWD）。',
    '- 不要發明原文沒有的行程。原文沒提到的就不要生出來。',
    '- warnings 用繁體中文，每條一句話，最多 12 條。',
  ];
  if (mode === 'external') {
    lines.push(
      '- 如果你能上網查證，mapsUrl 填該地點的 Google Maps 連結（https://maps.app.goo.gl/… 或 https://www.google.com/maps/place/…，有座標最好）。',
      '  **查不到或不確定就省略 mapsUrl，絕對不要自己編造連結**；交通移動（A → B）不用填。',
    );
  }

  if (context.trip) {
    lines.push(
      '',
      '這些停留點要加進一趟既有的旅程：',
      `- 旅程名稱：${context.trip.title}`,
      `- 目的地：${context.trip.destination || '未填'}`,
      `- 日期範圍：${context.trip.startDate} 至 ${context.trip.endDate}`,
      '- 盡量把停留點安排在這個日期範圍內。原文明確指出範圍外的日期時照實填，不要硬改。',
    );
  }

  if (context.existingStops && context.existingStops.length > 0) {
    lines.push(
      '',
      '這趟旅程已經有下列停留點，不要重複產生：',
      ...context.existingStops.slice(0, 80).map((stop) => `- ${stop.date} ${stop.time ?? '--:--'} ${stop.title}`),
    );
  }
  return lines;
}

const JSON_RULES = [
  'JSON 寫法：',
  '- key 與字串只能用半形直的雙引號 "。不可用單引號、彎引號 “ ” 或全形標點當結構符號。',
  '- 字串內容本身若有引號，改用「」。不要尾逗號、不要註解；沒有的選填欄位直接省略，不要填 null。',
  '- 數字直接寫數字，不要加引號、千分位或貨幣符號。',
];

function exampleJson(includeTrip: boolean, mode: AiImportMode): string {
  const stop: Record<string, unknown> = {
    title: '築地市場吃壽司',
    date: '2026-10-02',
    time: '07:00',
    endTime: '08:30',
    type: 'meal',
    place: '築地場外市場',
    mapQuery: '築地場外市場 東京',
    note: '人少要早去',
    estimatedCost: 3000,
    currency: 'JPY',
  };
  if (mode === 'external') stop.mapsUrl = 'https://www.google.com/maps/place/築地場外市場/@35.6655,139.7707,17z';
  const body: Record<string, unknown> = {
    stops: [stop],
    warnings: ['原文未寫年份，已假設 2026 年。'],
  };
  if (includeTrip) {
    return JSON.stringify({
      trip: { title: '東京五日自由行', destination: '日本東京', startDate: '2026-10-01', endDate: '2026-10-05' },
      ...body,
    }, null, 2);
  }
  return JSON.stringify(body, null, 2);
}

/**
 * 站內 Claude 用的指示（只回 JSON、不要圍欄）。原始文字由 Apps Script 接在後面。
 */
export function buildBuiltinInstruction(context: PromptContext): string {
  const includeTrip = !context.trip;
  return [
    ...buildRules(context, 'builtin'),
    '',
    ...JSON_RULES,
    '',
    '只回傳 JSON 本體，不要任何說明文字、不要 Markdown 圍欄。',
    includeTrip ? '格式如下（trip 必填、stops 至少一筆）：' : '格式如下（不要輸出 trip 欄位、stops 至少一筆）：',
    exampleJson(includeTrip, 'builtin'),
    '',
    '---',
    '要整理的行程文字：',
  ].join('\n');
}

/**
 * 複製給 Claude / ChatGPT 的完整提示詞（自包含：規則 + 範例 + 原文）。
 * 要求包 ```json 圍欄：聊天介面才有複製鍵，也不會把引號渲染成彎引號。
 */
export function buildExternalPrompt(context: PromptContext & { sourceText: string }): string {
  const includeTrip = !context.trip;
  const source = context.sourceText.trim();
  return [
    ...buildRules(context, 'external'),
    '',
    ...JSON_RULES,
    '',
    '請只輸出一個 ```json 圍欄包住的 JSON，圍欄前後不要任何說明文字。',
    includeTrip ? '格式如下（trip 必填、stops 至少一筆、warnings 可為空陣列）：' : '格式如下（不要輸出 trip 欄位、stops 至少一筆、warnings 可為空陣列）：',
    '',
    '```json',
    exampleJson(includeTrip, 'external'),
    '```',
    '',
    '---',
    '',
    '要整理的行程文字：',
    '',
    source || '（我會在下一則訊息貼上）',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/**
 * 從貼回來的文字挖出 JSON：容忍 ```json 圍欄、前後廢話；標準 parse 失敗才走 `repairJson`
 * （彎引號、單引號、尾逗號…，見 CLAUDE.md pitfall #25）。
 */
export function extractProposalJson(text: string): { data: unknown; repaired: boolean } {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('請先貼上 AI 回傳的結果。');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const candidates = [body];
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(body.slice(first, last + 1));
  else if (first >= 0) candidates.push(body.slice(first));

  for (const candidate of candidates) {
    try { return { data: JSON.parse(candidate), repaired: false }; } catch { /* 換下一個 */ }
  }
  for (const candidate of candidates) {
    try { return { data: JSON.parse(repairJson(candidate).text), repaired: true }; } catch { /* 換下一個 */ }
  }
  throw new Error('看不懂貼上的內容，請確認複製的是完整的 JSON。');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 「9:00」補成「09:00」；不合法就回空字串。 */
function normalizeTime(value: unknown): string {
  const raw = asString(value);
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return '';
  const padded = `${m[1]!.padStart(2, '0')}:${m[2]}`; // 非空：regex 已匹配，群組一定存在
  return TIME_PATTERN.test(padded) ? padded : '';
}

/**
 * 只收 Google Maps 網域的 https 連結。貼進來的內容是不可信輸入：
 * 不是地圖的網址（含 javascript:、追蹤連結）一律丟掉，連結不會被當成 HTML 渲染。
 */
export function sanitizeMapsUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw || raw.length > MAPS_URL_MAX) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const ok = host === 'maps.app.goo.gl'
    || (host === 'goo.gl' && path.startsWith('/maps'))
    || /^maps\.google\.[a-z.]+$/.test(host)
    || (/^(www\.)?google\.[a-z.]+$/.test(host) && path.startsWith('/maps'));
  if (!ok) return undefined;
  url.protocol = 'https:';
  return url.toString();
}

function normalizeCost(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/[,\s]/g, '')) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : undefined;
}

/** 單筆停留點收斂成可信任的形狀；缺標題或日期不合法回 null（寧可少一筆也不要壞資料）。 */
export function normalizeProposedStop(raw: unknown): ProposedStop | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const title = clamp(asString(s.title), TITLE_MAX);
  const date = asString(s.date);
  if (!title || !isValidDate(date)) return null;

  const time = normalizeTime(s.time);
  const endTime = normalizeTime(s.endTime);
  const place = clamp(asString(s.place), PLACE_MAX);
  const mapQuery = clamp(asString(s.mapQuery), MAP_QUERY_MAX);
  const address = clamp(asString(s.address), ADDRESS_MAX);
  const note = clamp(asString(s.note), NOTE_MAX);
  const rawType = asString(s.type) as ItineraryItemType;
  const type = ITEM_TYPES.includes(rawType) ? rawType : guessItemType({ title, place });
  const estimatedCost = normalizeCost(s.estimatedCost);
  const currency = asString(s.currency).toUpperCase();
  const mapsUrl = sanitizeMapsUrl(s.mapsUrl);

  return {
    title,
    date,
    ...(time ? { time } : {}),
    ...(endTime && (!time || endTime > time) ? { endTime } : {}),
    type,
    // place 漏掉時用 title 當後備，至少搜尋地圖還有東西
    place: place || title,
    ...(mapQuery ? { mapQuery } : {}),
    ...(address ? { address } : {}),
    ...(note ? { note } : {}),
    ...(mapsUrl ? { mapsUrl } : {}),
    ...(estimatedCost != null ? { estimatedCost, currency: CURRENCY_PATTERN.test(currency) ? currency : 'TWD' } : {}),
  };
}

function normalizeProposedTrip(raw: unknown): ProposedTrip | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  const title = clamp(asString(s.title), TITLE_MAX);
  const destination = clamp(asString(s.destination), PLACE_MAX);
  const startDate = asString(s.startDate);
  const endDate = asString(s.endDate);
  if (!title || !isValidDate(startDate) || !isValidDate(endDate)) return undefined;
  return startDate <= endDate
    ? { title, destination, startDate, endDate }
    : { title, destination, startDate: endDate, endDate: startDate };
}

/** 整包 JSON 收斂成提案；任何不合法的部分都降級而不是整包失敗。 */
export function parseItineraryProposal(raw: unknown): ItineraryProposal {
  const empty: ItineraryProposal = { stops: [], warnings: [], discarded: 0 };
  if (typeof raw !== 'object' || raw === null) return empty;
  const s = raw as Record<string, unknown>;
  // 有些模型會用 items 取代 stops
  const rawStops = Array.isArray(s.stops) ? s.stops : Array.isArray(s.items) ? s.items : [];
  const stops: ProposedStop[] = [];
  let discarded = 0;
  for (const candidate of rawStops.slice(0, MAX_STOPS)) {
    const stop = normalizeProposedStop(candidate);
    if (stop) stops.push(stop);
    else discarded += 1;
  }
  discarded += Math.max(0, rawStops.length - MAX_STOPS);
  const warnings = (Array.isArray(s.warnings) ? s.warnings : []).map(asString).filter(Boolean).slice(0, MAX_WARNINGS);
  return { trip: normalizeProposedTrip(s.trip), stops, warnings, discarded };
}

/** 依提案的停留點推出旅程（模型漏給 trip 時的後備）。 */
export function fallbackTrip(proposal: ItineraryProposal): ProposedTrip | undefined {
  if (proposal.trip) return proposal.trip;
  const dates = proposal.stops.map((stop) => stop.date).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return undefined;
  return { title: `${first.slice(5).replace('-', '/')} 的旅程`, destination: '', startDate: first, endDate: last };
}

/* ------------------------------------------------------------------ */
/* 去重與衝突（與巧明日常 classifyProposedStops 同規則）                 */
/* ------------------------------------------------------------------ */

export function normalizeTitleForMatch(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-TW')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,。.、・·「」『』()（）[\]【】!！?？:：;；~～\-–—_/\\]/g, '');
}

export interface ClassifyOptions {
  existingStops: readonly ExistingStopRef[];
  tripRange?: { startDate: string; endDate: string };
}

/** 重複優先於衝突，超出日期範圍最後才看；衝突與超出範圍只是提醒，不擋。 */
export function classifyProposedStops(proposed: readonly ProposedStop[], options: ClassifyOptions): ClassifiedStop[] {
  const byDateTitle = new Set<string>();
  const byDateTime = new Map<string, string>();
  for (const existing of options.existingStops) {
    byDateTitle.add(`${existing.date}|${normalizeTitleForMatch(existing.title)}`);
    if (existing.time) byDateTime.set(`${existing.date}|${existing.time}`, existing.title);
  }
  const seenInBatch = new Set<string>();
  return proposed.map((stop): ClassifiedStop => {
    const titleKey = `${stop.date}|${normalizeTitleForMatch(stop.title)}`;
    if (byDateTitle.has(titleKey)) return { ...stop, status: 'duplicate', reason: '這趟旅程已經有同一天同名的行程' };
    if (seenInBatch.has(titleKey)) return { ...stop, status: 'duplicate', reason: '這次匯入的結果裡出現了兩次' };
    seenInBatch.add(titleKey);
    const clash = stop.time ? byDateTime.get(`${stop.date}|${stop.time}`) : undefined;
    if (clash) return { ...stop, status: 'conflict', reason: `這個時段已經有「${clash}」` };
    const range = options.tripRange;
    if (range && (stop.date < range.startDate || stop.date > range.endDate)) {
      return { ...stop, status: 'out-of-range', reason: `不在旅程日期 ${range.startDate} ～ ${range.endDate} 之內，會把旅程日期往外擴` };
    }
    return { ...stop, status: 'new' };
  });
}

export function defaultSelected(status: ProposedStopStatus): boolean {
  return status !== 'duplicate';
}

/* ------------------------------------------------------------------ */
/* 地圖定位策略                                                        */
/* ------------------------------------------------------------------ */

/**
 * 每一筆怎麼拿到座標（優先序）：
 *  1. coords：連結本身帶座標（@lat,lng / !3d!4d / ?q=lat,lng）→ 寫入時直接帶上，不花 API
 *  2. resolve：短網址或沒座標的連結 → Apps Script `resolveGoogleMapsUrl` 展開
 *  3. search：沒連結 → Places 搜尋「mapQuery 或 place + 目的地」
 *  4. none：交通移動且沒連結（「桃園機場 → 成田機場」搜了只會猜錯）
 */
export type LocatePlan =
  | { kind: 'coords'; lat: number; lng: number; name?: string; mapsUrl: string }
  | { kind: 'resolve'; url: string }
  | { kind: 'search'; query: string }
  | { kind: 'none' };

export function searchQueryFor(stop: Pick<ProposedStop, 'mapQuery' | 'place' | 'address'>, destination = ''): string {
  const base = stop.mapQuery?.trim() || stop.place.trim() || stop.address?.trim() || '';
  if (!base) return '';
  const region = destination.split(/[,，、]/)[0]?.trim() ?? '';
  // mapQuery 通常已含城市；只有用 place 時才補目的地，避免同名分店搜到別的城市
  return region && !stop.mapQuery && !base.includes(region) ? `${base} ${region}` : base;
}

export function locatePlanFor(stop: ProposedStop, destination = ''): LocatePlan {
  if (stop.mapsUrl) {
    if (!isShortMapsUrl(stop.mapsUrl)) {
      const parsed = parseGoogleMapsUrl(stop.mapsUrl);
      if (parsed) return { kind: 'coords', lat: parsed.lat, lng: parsed.lng, name: parsed.name, mapsUrl: stop.mapsUrl };
    }
    if (isMapsUrl(stop.mapsUrl)) return { kind: 'resolve', url: stop.mapsUrl };
  }
  if (stop.type === 'transport') return { kind: 'none' };
  const query = searchQueryFor(stop, destination);
  return query ? { kind: 'search', query } : { kind: 'none' };
}

export function mapsSearchUrl(query: string): string | undefined {
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : undefined;
}

export interface LocateSummary {
  link: number;
  search: number;
  none: number;
}

export function summarizeLocate(stops: readonly ProposedStop[], destination = ''): LocateSummary {
  const out: LocateSummary = { link: 0, search: 0, none: 0 };
  for (const stop of stops) {
    const plan = locatePlanFor(stop, destination);
    if (plan.kind === 'coords' || plan.kind === 'resolve') out.link += 1;
    else if (plan.kind === 'search') out.search += 1;
    else out.none += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 規劃寫入                                                            */
/* ------------------------------------------------------------------ */

/** 同一天、同名、同時間 → 同一個 id；重貼同一份結果是覆蓋不是重複。 */
export async function aiItemIdFor(stop: Pick<ProposedStop, 'date' | 'time' | 'title'>): Promise<string> {
  const basis = `${stop.date}|${stop.time ?? ''}|${normalizeTitleForMatch(stop.title)}`;
  return `ai_${(await sha256Hex(basis)).slice(0, 40)}`;
}

export interface PlannedAiItem {
  stop: ProposedStop;
  locate: LocatePlan;
  /** 寫進 item 的 mapsUrl：使用者給的連結優先，否則是搜尋連結（讓「開地圖」至少能用）。 */
  mapsUrl?: string;
  placeQuery: string;
}

export interface PlannedAiDay {
  date: string;
  items: PlannedAiItem[];
}

/** 依日期分組、組內依時間排序（沒時間的維持原順序放後面）。 */
export function planAiImport(stops: readonly ProposedStop[], destination = ''): PlannedAiDay[] {
  const byDate = new Map<string, { stop: ProposedStop; index: number }[]>();
  stops.forEach((stop, index) => byDate.set(stop.date, [...(byDate.get(stop.date) ?? []), { stop, index }]));
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => ({
      date,
      items: entries
        .sort((a, b) => {
          if (a.stop.time && b.stop.time && a.stop.time !== b.stop.time) return a.stop.time.localeCompare(b.stop.time);
          if (Boolean(a.stop.time) !== Boolean(b.stop.time)) return a.stop.time ? -1 : 1;
          return a.index - b.index;
        })
        .map(({ stop }) => {
          const locate = locatePlanFor(stop, destination);
          const placeQuery = searchQueryFor(stop, destination);
          const mapsUrl = locate.kind === 'coords' ? locate.mapsUrl
            : locate.kind === 'resolve' ? locate.url
              : mapsSearchUrl(placeQuery);
          return { stop, locate, mapsUrl, placeQuery };
        }),
    }));
}

/** 旅程日期只往外擴、不縮小。 */
export function widenRange(
  current: { startDate: string; endDate: string },
  dates: readonly string[],
): { startDate: string; endDate: string } {
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    startDate: first && first < current.startDate ? first : current.startDate,
    endDate: last && last > current.endDate ? last : current.endDate,
  };
}
