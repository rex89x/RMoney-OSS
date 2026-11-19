import { format, parseISO } from 'date-fns';
import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz';

export const TW_TZ = 'Asia/Taipei';

export function formatTW(value: Date | number | string, pattern: string): string {
  const d = typeof value === 'string' ? parseISO(value) : new Date(value);
  return formatInTimeZone(d, TW_TZ, pattern);
}

export function toTW(d: Date): Date {
  return toZonedTime(d, TW_TZ);
}

export function fromTW(d: Date): Date {
  return fromZonedTime(d, TW_TZ);
}

export function nowTW(): Date {
  return toZonedTime(new Date(), TW_TZ);
}

export function todayTWRange(): { start: Date; end: Date } {
  const tw = nowTW();
  const start = new Date(tw);
  start.setHours(0, 0, 0, 0);
  const end = new Date(tw);
  end.setHours(23, 59, 59, 999);
  return { start: fromTW(start), end: fromTW(end) };
}

export function monthTWRange(year: number, month: number): { start: Date; end: Date } {
  // month is 1-12
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start: fromTW(start), end: fromTW(end) };
}

export function isoDay(d: Date): string {
  return format(toZonedTime(d, TW_TZ), 'yyyy-MM-dd');
}

export function formatDateInput(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

export function formatTWDateInput(value: Date | number | string): string {
  return formatTW(value, 'yyyy-MM-dd');
}

export function formatTWMonthKey(value: Date | number | string): string {
  return formatTW(value, 'yyyy-MM');
}

export function parseDateInput(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const d = new Date(y, month - 1, day, 0, 0, 0, 0);
  if (d.getFullYear() !== y || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

export function dateInputToTWDate(value: string | null | undefined): Date | null {
  const d = parseDateInput(value);
  return d ? fromTW(d) : null;
}

export function dateInputToTWBoundary(
  value: string | null | undefined,
  boundary: 'start' | 'end',
): Date | null {
  const d = parseDateInput(value);
  if (!d) return null;
  if (boundary === 'start') d.setHours(0, 0, 0, 0);
  else d.setHours(23, 59, 59, 999);
  return fromTW(d);
}

export function startOfTWDay(value: Date | number | string = new Date()): Date {
  const tw = toZonedTime(typeof value === 'string' ? parseISO(value) : new Date(value), TW_TZ);
  tw.setHours(0, 0, 0, 0);
  return fromTW(tw);
}

export function daysBetweenTWDates(from: Date | number | string, to: Date | number | string): number {
  return Math.round((startOfTWDay(to).getTime() - startOfTWDay(from).getTime()) / 86400000);
}

/**
 * 台北固定 UTC+8、沒有日光節約時間，所以「台北牆上時間」可以直接用 UTC 欄位表示：
 * 先加 8 小時，用 getUTC* / Date.UTC 做日曆運算，再減回 8 小時。
 * 以前用主機本地時區的 new Date(y, m, d, h…) 暫存牆上時間，主機若在 DST 時區（如 New York），
 * 落在跳躍缺口的時間會多一小時。
 */
const TW_OFFSET_MS = 8 * 60 * 60 * 1000;

function addTWCalendar(value: Date, months: number): Date {
  const wall = new Date(value.getTime() + TW_OFFSET_MS);
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth() + months;
  // 目標月份最後一天：Date.UTC 的 day 0 = 上個月最後一天（月底 clamp，pitfall #23）
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const target = Date.UTC(
    y,
    m,
    Math.min(wall.getUTCDate(), lastDay),
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    wall.getUTCSeconds(),
    wall.getUTCMilliseconds(),
  );
  return new Date(target - TW_OFFSET_MS);
}

export function addTWCalendarMonths(value: Date, months: number): Date {
  return addTWCalendar(value, months);
}

export function addTWCalendarYears(value: Date, years: number): Date {
  return addTWCalendar(value, years * 12);
}
