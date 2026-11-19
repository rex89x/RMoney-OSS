/**
 * 營業時間判斷（純函式，測試：apps/web/tests/itinerary-hours.test.cjs）。
 *
 * Google periods 是「地點當地」的牆上時間（day 0 = 週日，time = 'HHmm'），
 * 行程項目的日期（day id `yyyy-MM-dd`）與 startTime 也是當地時間。
 * 要拿一個 Date（瞬間）來問「那時有沒有開」時，一律先用地點的 utc_offset_minutes 換回當地時間，
 * 不要用 Asia/Taipei 或主機時區（東京 09:00 = 台北 08:00）。
 */
import type { ItemOpeningHours, ItineraryItem, OpeningPeriod } from './types';

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;
/** 沒有 utc_offset 時的預設：台北 UTC+8 */
export const DEFAULT_UTC_OFFSET_MINUTES = 8 * 60;
/** 營業時間存在 item 上超過這麼多天就重抓 */
export const OPENING_HOURS_MAX_AGE_DAYS = 14;

const WEEKDAY_LABEL = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function hhmmToMinutes(time: string): number | null {
  const m = /^(\d{2})(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 24 || mm > 59) return null;
  return h * 60 + mm;
}

function hhColonMmToMinutes(time: string | undefined): number | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** 沒有 close 的 period = 24 小時營業 */
export function isAlwaysOpen(periods: OpeningPeriod[]): boolean {
  return periods.some((p) => !p.close);
}

/** 以「一週第幾分鐘」判斷；跨夜（週五 18:00 → 週六 02:00）與跨週（週六 → 週日）都會處理 */
export function isOpenAtWeekMinute(periods: OpeningPeriod[], weekMinute: number): boolean {
  const t = ((weekMinute % WEEK_MINUTES) + WEEK_MINUTES) % WEEK_MINUTES;
  for (const p of periods) {
    if (!p.close) return true;
    const om = hhmmToMinutes(p.open.time);
    const cm = hhmmToMinutes(p.close.time);
    if (om == null || cm == null) continue;
    const o = p.open.day * DAY_MINUTES + om;
    let c = p.close.day * DAY_MINUTES + cm;
    if (c <= o) c += WEEK_MINUTES;
    if ((t >= o && t < c) || (t + WEEK_MINUTES >= o && t + WEEK_MINUTES < c)) return true;
  }
  return false;
}

/**
 * 某個瞬間這個地點有沒有開。periods 空 = 不知道（null）。
 * @param utcOffsetMinutes 地點所在時區（Place Details `utc_offset_minutes`），預設台北
 */
export function isOpenAt(
  periods: OpeningPeriod[] | undefined,
  date: Date,
  utcOffsetMinutes: number = DEFAULT_UTC_OFFSET_MINUTES,
): boolean | null {
  if (!periods || periods.length === 0) return null;
  const local = new Date(date.getTime() + utcOffsetMinutes * 60_000);
  const weekMinute = local.getUTCDay() * DAY_MINUTES + local.getUTCHours() * 60 + local.getUTCMinutes();
  return isOpenAtWeekMinute(periods, weekMinute);
}

/** `yyyy-MM-dd` + `HH:mm`（地點當地時間）→ Date 瞬間 */
export function placeLocalInstant(
  dateInput: string,
  time: string,
  utcOffsetMinutes: number = DEFAULT_UTC_OFFSET_MINUTES,
): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  const minutes = hhColonMmToMinutes(time);
  if (!d || minutes == null) return null;
  const utc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), 0, minutes);
  return new Date(utc - utcOffsetMinutes * 60_000);
}

/** `yyyy-MM-dd` 是星期幾（0 = 週日），與主機時區無關 */
export function dayOfWeekForDateInput(dateInput: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  if (!d) return null;
  return new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))).getUTCDay();
}

/** 那天有沒有任何時段開門（跨夜從前一天延續過來的不算） */
export function isOpenOnDay(periods: OpeningPeriod[], dayOfWeek: number): boolean {
  if (isAlwaysOpen(periods)) return true;
  return periods.some((p) => p.open.day === dayOfWeek);
}

/** Google weekday_text 從星期一開始；回傳去掉「星期一:」前綴的那天營業時間 */
export function weekdayHoursText(weekdayText: string[], dayOfWeek: number): string | null {
  const line = weekdayText[(dayOfWeek + 6) % 7];
  if (!line) return null;
  // 只去掉開頭的「星期一:」/「Monday:」，不碰時間裡的冒號
  return line.replace(/^[^:：\d]+[:：]\s*/, '').trim() || null;
}

export type OpeningStatus =
  | 'open'
  | 'closed-at-time'
  | 'closes-before-end'
  | 'closed-all-day'
  | 'temporarily-closed'
  | 'permanently-closed'
  | 'unknown';

export interface ItemHoursEvaluation {
  status: OpeningStatus;
  /** 那天的營業時間文字（例如「11:00 – 21:00」） */
  dayText: string | null;
  /** 需要提醒時的訊息；正常營業為 null */
  warning: string | null;
}

/** 評估行程項目在排定日期 / 時間是否營業 */
export function evaluateItemHours(
  hours: ItemOpeningHours | undefined,
  dateInput: string,
  startTime?: string,
  endTime?: string,
): ItemHoursEvaluation {
  if (!hours) return { status: 'unknown', dayText: null, warning: null };
  const dow = dayOfWeekForDateInput(dateInput);
  const dayText = dow == null ? null : weekdayHoursText(hours.weekdayText, dow);
  if (hours.businessStatus === 'CLOSED_PERMANENTLY') {
    return { status: 'permanently-closed', dayText, warning: 'Google 顯示已永久歇業' };
  }
  if (hours.businessStatus === 'CLOSED_TEMPORARILY') {
    return { status: 'temporarily-closed', dayText, warning: 'Google 顯示暫停營業' };
  }
  const periods = hours.periods ?? [];
  if (periods.length === 0 || dow == null) return { status: 'unknown', dayText, warning: null };
  if (!isOpenOnDay(periods, dow)) {
    return { status: 'closed-all-day', dayText, warning: `${WEEKDAY_LABEL[dow] ?? ''}公休` };
  }
  const offset = hours.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES;
  const start = startTime ? placeLocalInstant(dateInput, startTime, offset) : null;
  if (!start) return { status: 'open', dayText, warning: null };
  if (isOpenAt(periods, start, offset) === false) {
    return { status: 'closed-at-time', dayText, warning: `${startTime} 不在營業時間內` };
  }
  const startMin = hhColonMmToMinutes(startTime);
  const endMin = hhColonMmToMinutes(endTime);
  if (startMin != null && endMin != null && endMin !== startMin) {
    // 結束時間比開始早 = 跨午夜
    const duration = endMin > startMin ? endMin - startMin : endMin + DAY_MINUTES - startMin;
    const lastMinute = new Date(start.getTime() + (duration - 1) * 60_000);
    if (isOpenAt(periods, lastMinute, offset) === false) {
      return { status: 'closes-before-end', dayText, warning: `可能在 ${endTime} 前就打烊` };
    }
  }
  return { status: 'open', dayText, warning: null };
}

/** Apps Script `placeDetails` 的 result 形狀（Itinerary.gs normalizePlaceDetails_） */
export interface PlaceDetailsResult {
  placeId?: string;
  businessStatus?: string | null;
  utcOffsetMinutes?: number | null;
  url?: string | null;
  weekdayText?: string[];
  periods?: OpeningPeriod[];
  hasHours?: boolean;
}

const BUSINESS_STATUS = ['OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY'] as const;

export function placeDetailsToOpeningHours(
  r: PlaceDetailsResult,
  requestedPlaceId: string,
  now: Date = new Date(),
): ItemOpeningHours {
  const status = BUSINESS_STATUS.find((s) => s === r.businessStatus);
  const out: ItemOpeningHours = {
    placeId: r.placeId || requestedPlaceId,
    weekdayText: Array.isArray(r.weekdayText) ? r.weekdayText.filter((x) => typeof x === 'string') : [],
    periods: Array.isArray(r.periods) ? r.periods : [],
    fetchedAt: now,
  };
  if (typeof r.utcOffsetMinutes === 'number') out.utcOffsetMinutes = r.utcOffsetMinutes;
  if (status) out.businessStatus = status;
  if (r.url) out.url = r.url;
  if (r.hasHours === false) out.noHours = true;
  return out;
}

/** 有 placeId、還沒抓過、地點換了、或超過 14 天 → 要重抓 */
export function needsOpeningHoursFetch(
  item: Pick<ItineraryItem, 'placeId' | 'openingHours'>,
  now: Date = new Date(),
  maxAgeDays: number = OPENING_HOURS_MAX_AGE_DAYS,
): boolean {
  if (!item.placeId) return false;
  const h = item.openingHours;
  if (!h) return true;
  if (h.placeId && h.placeId !== item.placeId) return true;
  return now.getTime() - h.fetchedAt.getTime() > maxAgeDays * DAY_MINUTES * 60_000;
}
