/**
 * 統計期間（台北時間）與「比較期間」計算。純函式，`tw` 傳 `nowTW()`（wall-clock 已轉成台北）。
 *
 * 範圍都以台北日 00:00:00.000 – 23:59:59.999 為界；本月 / 上月與 `monthTWRange` 完全相同，
 * 讓各卡片的 TanStack Query key 一致、共用同一份快取。
 */
import { fromTW } from '@/lib/tz';

export type PeriodKey = 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'last30d' | 'last90d' | 'ytd';

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  thisMonth: '本月',
  lastMonth: '上月',
  thisQuarter: '本季',
  last30d: '近 30 天',
  last90d: '近 90 天',
  ytd: '今年',
};

export interface PeriodRange {
  start: Date;
  end: Date;
  /** yyyy-MM-dd（台北） */
  startKey: string;
  endKey: string;
  label: string;
}

export interface ComparisonRange extends PeriodRange {
  /**
   * 比較期間只算到這一天（含）。fetch 用 start/end 完整期間（共用快取），
   * 再用 `endKey` 篩「同期」——例如本月 10/29 比上月就只算 9/1–9/29。
   */
  cutoffKey: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 由年 / 月(0-based) / 日 組出台北日期；超出月份天數會自然進位，呼叫端負責 clamp */
function dayKey(y: number, m0: number, d: number): string {
  const dt = new Date(y, m0, d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function rangeFromKeys(startKey: string, endKey: string, label = ''): PeriodRange {
  const [sy, sm, sd] = startKey.split('-').map(Number) as [number, number, number];
  const [ey, em, ed] = endKey.split('-').map(Number) as [number, number, number];
  return {
    start: fromTW(new Date(sy, sm - 1, sd, 0, 0, 0, 0)),
    end: fromTW(new Date(ey, em - 1, ed, 23, 59, 59, 999)),
    startKey,
    endKey,
    label,
  };
}

function lastDayOfMonth(y: number, m0: number): number {
  return new Date(y, m0 + 1, 0).getDate();
}

function monthRangeKeys(y: number, m0: number): [string, string] {
  return [dayKey(y, m0, 1), dayKey(y, m0, lastDayOfMonth(y, m0))];
}

export function periodRange(key: PeriodKey, tw: Date): PeriodRange {
  const y = tw.getFullYear();
  const m = tw.getMonth();
  const d = tw.getDate();
  switch (key) {
    case 'thisMonth': {
      const [s, e] = monthRangeKeys(y, m);
      return rangeFromKeys(s, e, `${y}-${pad(m + 1)}`);
    }
    case 'lastMonth': {
      const pm = new Date(y, m - 1, 1);
      const [s, e] = monthRangeKeys(pm.getFullYear(), pm.getMonth());
      return rangeFromKeys(s, e, `${pm.getFullYear()}-${pad(pm.getMonth() + 1)}`);
    }
    case 'thisQuarter': {
      const q = Math.floor(m / 3);
      return rangeFromKeys(dayKey(y, q * 3, 1), dayKey(y, q * 3 + 2, lastDayOfMonth(y, q * 3 + 2)), `${y} Q${q + 1}`);
    }
    case 'last30d':
      return rangeFromKeys(dayKey(y, m, d - 29), dayKey(y, m, d), PERIOD_LABEL.last30d);
    case 'last90d':
      return rangeFromKeys(dayKey(y, m, d - 89), dayKey(y, m, d), PERIOD_LABEL.last90d);
    case 'ytd':
      return rangeFromKeys(dayKey(y, 0, 1), dayKey(y, 11, 31), `${y} YTD`);
  }
}

/** 與 `periodRange(key)` 對應的比較期間（進行中的期間只比「同期」） */
export function comparisonRange(key: PeriodKey, tw: Date): ComparisonRange {
  const y = tw.getFullYear();
  const m = tw.getMonth();
  const d = tw.getDate();
  switch (key) {
    case 'thisMonth': {
      const pm = new Date(y, m - 1, 1);
      const py = pm.getFullYear();
      const pm0 = pm.getMonth();
      const [s, e] = monthRangeKeys(py, pm0);
      return { ...rangeFromKeys(s, e, '上月同期'), cutoffKey: dayKey(py, pm0, Math.min(d, lastDayOfMonth(py, pm0))) };
    }
    case 'lastMonth': {
      const pm = new Date(y, m - 2, 1);
      const [s, e] = monthRangeKeys(pm.getFullYear(), pm.getMonth());
      return { ...rangeFromKeys(s, e, '前一個月'), cutoffKey: e };
    }
    case 'thisQuarter': {
      const q = Math.floor(m / 3);
      const qStart = new Date(y, q * 3, 1);
      const elapsed = Math.round((new Date(y, m, d).getTime() - qStart.getTime()) / 86400000);
      const pq = new Date(y, q * 3 - 3, 1);
      const py = pq.getFullYear();
      const pm0 = pq.getMonth();
      const e = dayKey(py, pm0 + 2, lastDayOfMonth(py, pm0 + 2));
      const cutoff = dayKey(py, pm0, 1 + elapsed);
      return { ...rangeFromKeys(dayKey(py, pm0, 1), e, '上季同期'), cutoffKey: cutoff < e ? cutoff : e };
    }
    case 'last30d': {
      const r = rangeFromKeys(dayKey(y, m, d - 59), dayKey(y, m, d - 30), '前 30 天');
      return { ...r, cutoffKey: r.endKey };
    }
    case 'last90d': {
      const r = rangeFromKeys(dayKey(y, m, d - 179), dayKey(y, m, d - 90), '前 90 天');
      return { ...r, cutoffKey: r.endKey };
    }
    case 'ytd': {
      const cutoff = dayKey(y - 1, m, Math.min(d, lastDayOfMonth(y - 1, m)));
      return { ...rangeFromKeys(dayKey(y - 1, 0, 1), dayKey(y - 1, 11, 31), '去年同期'), cutoffKey: cutoff };
    }
  }
}

/** 進行中的期間已經過幾天（含今天）；期間已結束就是整段天數 */
export function elapsedDays(r: Pick<PeriodRange, 'startKey' | 'endKey'>, tw: Date): number {
  const todayKey = dayKey(tw.getFullYear(), tw.getMonth(), tw.getDate());
  const end = todayKey < r.endKey ? todayKey : r.endKey;
  return Math.max(1, daysBetweenKeys(r.startKey, end) + 1);
}

export function daysBetweenKeys(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function todayKeyOf(tw: Date): string {
  return dayKey(tw.getFullYear(), tw.getMonth(), tw.getDate());
}

/** 近 n 個月（含本月）的 yyyy-MM，舊到新 */
export function recentMonthKeys(tw: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(tw.getFullYear(), tw.getMonth() - i, 1);
    out.push(`${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`);
  }
  return out;
}

/** 近 n 個月（含本月）的完整範圍 */
export function recentMonthsRange(tw: Date, n: number): PeriodRange {
  const first = new Date(tw.getFullYear(), tw.getMonth() - (n - 1), 1);
  const [, e] = monthRangeKeys(tw.getFullYear(), tw.getMonth());
  return rangeFromKeys(dayKey(first.getFullYear(), first.getMonth(), 1), e, `近 ${n} 個月`);
}

/** 本月以前的 n 個完整月份（不含本月） */
export function pastMonthsRange(tw: Date, n: number): PeriodRange {
  const first = new Date(tw.getFullYear(), tw.getMonth() - n, 1);
  const last = new Date(tw.getFullYear(), tw.getMonth() - 1, 1);
  const [, e] = monthRangeKeys(last.getFullYear(), last.getMonth());
  return rangeFromKeys(dayKey(first.getFullYear(), first.getMonth(), 1), e, `前 ${n} 個月`);
}

/** 本月資訊：每天固定，給 hook 當 memo key */
export function currentMonthInfo(tw: Date): { year: number; month: number; monthKey: string; day: number; daysInMonth: number } {
  const year = tw.getFullYear();
  const month = tw.getMonth() + 1;
  return {
    year,
    month,
    monthKey: `${year}-${pad(month)}`,
    day: tw.getDate(),
    daysInMonth: lastDayOfMonth(year, month - 1),
  };
}

/** 由 yyyy-MM-dd 還原「台北 wall-clock」日期（中午，避免邊界）；hook 以 todayKey 當 memo key 再還原 */
export function twDateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
