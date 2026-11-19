import { formatInTimeZone } from 'date-fns-tz';

const TW_TZ = 'Asia/Taipei';
const US_TZ = 'America/New_York';

function hmNum(d: Date, tz: string): { hh: number; mm: number; dayOfWeek: number } {
  const h = parseInt(formatInTimeZone(d, tz, 'H'), 10);
  const m = parseInt(formatInTimeZone(d, tz, 'm'), 10);
  const dow = parseInt(formatInTimeZone(d, tz, 'i'), 10); // 1-7 Mon-Sun
  return { hh: h, mm: m, dayOfWeek: dow };
}

export function isTwMarketOpen(now: Date = new Date()): boolean {
  const { hh, mm, dayOfWeek } = hmNum(now, TW_TZ);
  if (dayOfWeek < 1 || dayOfWeek > 5) return false;
  const minutes = hh * 60 + mm;
  return minutes >= 9 * 60 && minutes <= 13 * 60 + 30;
}

export function isUsMarketOpen(now: Date = new Date()): boolean {
  const { hh, mm, dayOfWeek } = hmNum(now, US_TZ);
  if (dayOfWeek < 1 || dayOfWeek > 5) return false;
  const minutes = hh * 60 + mm;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export function marketStatus(symbol: string, market: 'TW' | 'US', now: Date = new Date()) {
  const isOpen = market === 'TW' ? isTwMarketOpen(now) : isUsMarketOpen(now);
  return { symbol, market, isOpen };
}
