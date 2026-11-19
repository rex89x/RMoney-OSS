import { addTWCalendarMonths, formatTWMonthKey, startOfTWDay } from '@/lib/tz';

/** 最近 n 個月（台北），由新到舊；第一個是本月 */
export function recentTWMonths(n: number, now: Date = new Date()): string[] {
  const base = startOfTWDay(now);
  return Array.from({ length: n }, (_, i) => formatTWMonthKey(addTWCalendarMonths(base, -i)));
}

/** 預設分析上個月（本月資料還不完整） */
export function defaultReviewMonth(now: Date = new Date()): string {
  return recentTWMonths(2, now)[1] ?? formatTWMonthKey(now);
}
