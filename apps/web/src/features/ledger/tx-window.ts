/**
 * 交易「共用視窗」：把各卡片 / 頁面對 `transactions` 的日期區間查詢收斂成一份快取。
 *
 * 之前首頁同一批交易會以約 10 個不同的 `{ startDate, endDate, limit }` 各讀一次 Firestore
 * （本月、上月、近 7 天、近 6 個月、近 12 個月…），每記一筆帳又全部重讀。
 * 現在只讀一次「近 12 個完整月份 + 本月（含未來日期）」，其他查詢在前端切片。
 *
 * 純函式（不碰 Firestore / React），測試：`apps/web/tests/tx-window.test.cjs`。
 */
import type { Transaction } from './types';

/** 視窗往回涵蓋幾個完整月份（另加本月） */
export const TX_WINDOW_MONTHS = 12;
/** 視窗一次最多讀幾筆；超過時只有「已讀到的最舊一筆之後」的區間可以用視窗回答 */
export const TX_WINDOW_LIMIT = 6000;

export interface TxSliceFilters {
  startDate?: Date;
  endDate?: Date;
  tripId?: string | null;
  category?: string;
  type?: Transaction['type'];
  scope?: 'personal' | 'household';
  limit?: number;
}

/** 視窗起點的台北牆上時間：12 個月前那個月的 1 號 00:00（呼叫端再用 `fromTW` 轉成 UTC instant） */
export function txWindowStartTW(todayTW: Date): Date {
  return new Date(todayTW.getFullYear(), todayTW.getMonth() - TX_WINDOW_MONTHS, 1, 0, 0, 0, 0);
}

/**
 * 視窗實際涵蓋到多早（ms）。
 * - 沒讀滿 limit：整個視窗都完整 → 視窗起點
 * - 讀滿了：比最舊一筆更早的資料可能被截掉 → 只保證「晚於最舊一筆」的區間
 */
export function txWindowCoverageFloor(windowStart: Date, fetchedCount: number, oldestFetched: Date | null, limit = TX_WINDOW_LIMIT): number {
  if (fetchedCount < limit || !oldestFetched) return windowStart.getTime();
  return oldestFetched.getTime();
}

function matches(t: Transaction, f: TxSliceFilters, startMs: number | null, endMs: number | null): boolean {
  const ms = t.date.getTime();
  if (startMs != null && ms < startMs) return false;
  if (endMs != null && ms > endMs) return false;
  if (f.category && t.category !== f.category) return false;
  if (f.type && t.type !== f.type) return false;
  if (f.scope && (t.scope ?? 'personal') !== f.scope) return false;
  return true;
}

/**
 * 用視窗資料回答一個查詢；回 `null` 代表視窗答不了（呼叫端改打 Firestore）。
 *
 * @param rows 視窗資料（date desc，已濾掉軟刪）
 * @param windowStart 視窗起點
 * @param coverageFloor `txWindowCoverageFloor()` 的結果
 */
export function sliceTxWindow(
  rows: Transaction[],
  f: TxSliceFilters,
  windowStart: Date,
  coverageFloor: number,
): Transaction[] | null {
  // tripId 查詢可能包含別人記的花費（被分享的旅程），不在「我的交易」視窗裡
  if (f.tripId) return null;
  const limit = f.limit ?? 200;
  const startMs = f.startDate ? f.startDate.getTime() : null;
  const endMs = f.endDate ? f.endDate.getTime() : null;
  const truncated = coverageFloor > windowStart.getTime();

  if (startMs != null) {
    // 截斷時用「嚴格大於」：最舊那個 timestamp 可能還有同時間的資料沒讀到
    if (truncated ? startMs <= coverageFloor : startMs < coverageFloor) return null;
    return rows.filter((t) => matches(t, f, startMs, endMs)).slice(0, limit);
  }

  // 沒有起始日（「最近 N 筆」）：視窗裡湊得滿 N 筆才算數，否則更舊的資料可能該補進來
  const hit = rows.filter((t) => matches(t, f, null, endMs));
  return hit.length >= limit ? hit.slice(0, limit) : null;
}

/** 讓 `select` 的 identity 只在查詢條件真的變了才換（呼叫端常傳 inline object） */
export function txSliceKey(f: TxSliceFilters): string {
  return [
    f.startDate?.getTime() ?? '', f.endDate?.getTime() ?? '', f.tripId ?? '',
    f.category ?? '', f.type ?? '', f.scope ?? '', f.limit ?? '',
  ].join('|');
}
