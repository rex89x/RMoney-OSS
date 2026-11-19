/**
 * 機票雷達總覽的資料整理（純函式，元件只負責畫）。
 * 走勢圖一律聚合成「每個區段每天一點」（CLAUDE.md pitfall #13），顏色跟著區段走、不跟排名走。
 */
import { daysBetweenTWDates, formatTW } from '@/lib/tz';
import type { ClaudeWatchStatus } from './claude-schedule';
import { flightRouteKey } from './options';
import type { FlightCabin, FlightPriceSnapshot, FlightTravelWindow, FlightTripType, FlightWatch } from './types';

/** Claude 排程超過幾天沒推送就提醒 */
export const CLAUDE_STALE_DAYS = 3;

export type FlightAttentionKind = 'error' | 'stale-push' | 'prompt-stale' | 'prompt-new';

export interface FlightAttentionItem {
  kind: FlightAttentionKind;
  /** 錯誤與沒推送逐條列；提示詞相關的同類區段合併成一條，避免清單被洗版 */
  watches: FlightWatch[];
  message: string;
}

export interface FlightOverview {
  totalCount: number;
  activeCount: number;
  routeCount: number;
  belowTargetCount: number;
  buyNowCount: number;
  attention: FlightAttentionItem[];
}

export function isBelowTarget(watch: FlightWatch): boolean {
  const estimate = watch.latestEstimate;
  return Boolean(estimate && watch.maxPriceTWD && estimate.minPriceTWD <= watch.maxPriceTWD);
}

/** 依建立時間排序後的位置決定顏色，篩選或價格變動都不會讓同一個區段換色 */
export function stableSeriesIndex(watches: FlightWatch[]): Map<string, number> {
  return new Map(
    [...watches]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((watch, index) => [watch.id, index]),
  );
}

export function buildFlightAttention(
  watches: FlightWatch[],
  claudeStatuses: ClaudeWatchStatus[],
  now = new Date(),
): FlightAttentionItem[] {
  const items: FlightAttentionItem[] = [];
  watches.forEach((watch) => {
    if (!watch.enabled) return;
    if (watch.lastError) {
      items.push({ watches: [watch], kind: 'error', message: watch.lastError });
    }
    if (watch.scanProvider === 'claude') {
      const days = watch.lastCheckedAt ? daysBetweenTWDates(watch.lastCheckedAt, now) : null;
      if (days !== null && days >= CLAUDE_STALE_DAYS) {
        items.push({ watches: [watch], kind: 'stale-push', message: `已 ${days} 天沒有收到 Claude 排程推送` });
      }
    }
  });
  const stale = claudeStatuses.filter((status) => status.state === 'stale').map((status) => status.watch);
  const fresh = claudeStatuses.filter((status) => status.state === 'new').map((status) => status.watch);
  if (stale.length > 0) {
    items.push({ watches: stale, kind: 'prompt-stale', message: '搜尋條件改過，請重新複製提示詞並更新 Claude 排程任務' });
  }
  if (fresh.length > 0) {
    items.push({ watches: fresh, kind: 'prompt-new', message: '還沒加進任何 Claude 排程提示詞，排程不會查這些區段' });
  }
  return items;
}

export function buildFlightOverview(
  watches: FlightWatch[],
  claudeStatuses: ClaudeWatchStatus[],
  now = new Date(),
): FlightOverview {
  const active = watches.filter((watch) => watch.enabled);
  return {
    totalCount: watches.length,
    activeCount: active.length,
    routeCount: new Set(active.map(flightRouteKey)).size,
    belowTargetCount: active.filter(isBelowTarget).length,
    buyNowCount: active.filter((watch) => watch.latestEstimate?.advice === 'buy_now').length,
    attention: buildFlightAttention(watches, claudeStatuses, now),
  };
}

export interface PriceLadderRow {
  watch: FlightWatch;
  current: number;
  typical: number;
  best: number;
  target: number | null;
}

/** 目前較低價、常見價、歷史最低、理想價放在同一條 TWD 軸上比較；沒有價格的區段不列 */
export function buildPriceLadder(watches: FlightWatch[]): PriceLadderRow[] {
  return watches
    .flatMap((watch) => {
      const estimate = watch.latestEstimate;
      if (!estimate) return [];
      return [{
        watch,
        current: estimate.minPriceTWD,
        typical: estimate.typicalPriceTWD,
        best: Math.min(watch.bestPriceTWD ?? estimate.minPriceTWD, estimate.minPriceTWD),
        target: watch.maxPriceTWD,
      }];
    })
    .sort((a, b) => a.current - b.current);
}

export interface RankedTravelWindow {
  watch: FlightWatch;
  window: FlightTravelWindow;
}


export type TrendPoint = { date: string } & Record<string, number | string>;

/** 每個區段每天取最低一筆，合併成 Recharts 的寬表；缺資料的日子留空讓線段 connectNulls */
export function buildTrendRows(snapshotsByWatch: Map<string, FlightPriceSnapshot[]>): TrendPoint[] {
  const byDate = new Map<string, TrendPoint>();
  snapshotsByWatch.forEach((snapshots, watchId) => {
    snapshots.forEach((snapshot) => {
      const date = formatTW(snapshot.checkedAt, 'yyyy-MM-dd');
      const row = byDate.get(date) ?? { date };
      const previous = row[watchId];
      if (typeof previous !== 'number' || snapshot.minPriceTWD < previous) row[watchId] = snapshot.minPriceTWD;
      byDate.set(date, row);
    });
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- 篩選 ----------

export type TripTypeFilter = 'all' | FlightTripType;
export type CabinFilter = 'all' | FlightCabin;

export interface FlightRadarFilters {
  tripType: TripTypeFilter;
  cabin: CabinFilter;
  /** flightRouteKey；'all' = 全部航線 */
  route: string;
}

export const DEFAULT_FLIGHT_FILTERS: FlightRadarFilters = { tripType: 'all', cabin: 'all', route: 'all' };

export function isDefaultFilters(filters: FlightRadarFilters): boolean {
  return filters.tripType === 'all' && filters.cabin === 'all' && filters.route === 'all';
}

/** 依行程、航線篩區段；艙等篩「有比較這個艙等」的區段，圖表再各自只取該艙等的價格 */
export function applyFlightFilters(watches: FlightWatch[], filters: FlightRadarFilters): FlightWatch[] {
  return watches.filter((watch) =>
    (filters.tripType === 'all' || watch.tripType === filters.tripType)
    && (filters.route === 'all' || flightRouteKey(watch) === filters.route)
    && (filters.cabin === 'all' || watch.selectedCabins.includes(filters.cabin)));
}

export function allTravelWindows(watches: FlightWatch[], cabin: CabinFilter = 'all'): RankedTravelWindow[] {
  return watches.flatMap((watch) => (watch.latestEstimate?.travelWindows ?? [])
    .filter((window) => cabin === 'all' || window.cabin === cabin)
    .map((window) => ({ watch, window })));
}

/** 區段目前最便宜的一組日期（票卡用）；艙等篩選時只看該艙等 */
export function cheapestWindow(watch: FlightWatch, cabin: CabinFilter = 'all'): FlightTravelWindow | null {
  const windows = (watch.latestEstimate?.travelWindows ?? [])
    .filter((window) => cabin === 'all' || window.cabin === cabin)
    .sort((a, b) => a.priceTWD - b.priceTWD);
  return windows[0] ?? null;
}

// ---------- 格式 ----------

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 'yyyy-MM-dd' → 'M/d（週X）'；日期字串本身就是當地日期，不做時區換算 */
export function formatFlightDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value || '—';
  const weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return `${Number(match[2])}/${Number(match[3])}（${WEEKDAYS[weekday] ?? ''}）`;
}

export function formatFlightDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h${rest > 0 ? ` ${rest}m` : ''}` : `${rest}m`;
}

// ---------- 圖表資料 ----------

export const CABIN_ORDER: FlightCabin[] = ['economy', 'premium_economy', 'business', 'first'];

export type CabinComparisonRow = { name: string; watchId: string } & Partial<Record<FlightCabin, number>>;

/** 每個區段各艙等的較低價（cabinEstimates）；同一個艙等在不同區段的價差一眼可比 */
export function buildCabinComparison(watches: FlightWatch[], cabin: CabinFilter = 'all'): CabinComparisonRow[] {
  return watches.flatMap((watch) => {
    const estimates = (watch.latestEstimate?.cabinEstimates ?? [])
      .filter((item) => cabin === 'all' || item.cabin === cabin);
    if (estimates.length === 0) return [];
    const row: CabinComparisonRow = { name: shortTitle(watch), watchId: watch.id };
    estimates.forEach((item) => { row[item.cabin] = item.minPriceTWD; });
    return [row];
  });
}

export function cabinsPresent(rows: CabinComparisonRow[]): FlightCabin[] {
  return CABIN_ORDER.filter((cabin) => rows.some((row) => typeof row[cabin] === 'number'));
}

export interface DeparturePoint {
  /** 出發日 UTC 正午的 epoch ms，避免時區把日期推前一天 */
  x: number;
  price: number;
  cabin: FlightCabin;
  label: string;
  date: string;
}

export function buildDeparturePoints(watches: FlightWatch[], cabin: CabinFilter = 'all'): DeparturePoint[] {
  return allTravelWindows(watches, cabin).flatMap(({ watch, window }) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(window.departureDate);
    if (!match) return [];
    return [{
      x: Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12),
      price: window.priceTWD,
      cabin: window.cabin,
      label: shortTitle(watch),
      date: window.departureDate,
    }];
  });
}

export const TIME_BUCKETS = [
  { key: 'redeye', label: '深夜 0–6', from: 0, to: 6 },
  { key: 'morning', label: '上午 6–12', from: 6, to: 12 },
  { key: 'afternoon', label: '下午 12–18', from: 12, to: 18 },
  { key: 'evening', label: '晚上 18–24', from: 18, to: 24 },
] as const;

export interface TimeBucketRow {
  label: string;
  minPrice: number | null;
  count: number;
}

/** 去程出發時段的最低價；沒有 departureTime 的結果不列入 */
export function buildTimeOfDay(windows: RankedTravelWindow[]): { rows: TimeBucketRow[]; withTime: number } {
  const timed = windows.filter(({ window }) => window.departureTime);
  const rows = TIME_BUCKETS.map((bucket) => {
    const prices = timed
      .filter(({ window }) => {
        const hour = Number((window.departureTime ?? '').slice(0, 2));
        return hour >= bucket.from && hour < bucket.to;
      })
      .map(({ window }) => window.priceTWD);
    return { label: bucket.label, minPrice: prices.length > 0 ? Math.min(...prices) : null, count: prices.length };
  });
  return { rows, withTime: timed.length };
}

export interface AirlineRow {
  airline: string;
  minPrice: number;
  count: number;
}

export function buildAirlineRows(windows: RankedTravelWindow[], limit = 8): AirlineRow[] {
  const map = new Map<string, AirlineRow>();
  windows.forEach(({ window }) => {
    const airline = window.airline.trim() || '未標示';
    const current = map.get(airline);
    map.set(airline, current
      ? { airline, minPrice: Math.min(current.minPrice, window.priceTWD), count: current.count + 1 }
      : { airline, minPrice: window.priceTWD, count: 1 });
  });
  return [...map.values()].sort((a, b) => a.minPrice - b.minPrice).slice(0, limit);
}

export interface StopsSummary {
  directMin: number | null;
  connectingMin: number | null;
  directCount: number;
  connectingCount: number;
}

export function buildStopsSummary(windows: RankedTravelWindow[]): StopsSummary {
  const direct = windows.filter(({ window }) => window.stops === 0).map(({ window }) => window.priceTWD);
  const connecting = windows.filter(({ window }) => window.stops > 0).map(({ window }) => window.priceTWD);
  return {
    directMin: direct.length > 0 ? Math.min(...direct) : null,
    connectingMin: connecting.length > 0 ? Math.min(...connecting) : null,
    directCount: direct.length,
    connectingCount: connecting.length,
  };
}

/** 圖表軸上用的短名稱：「NRT 寒假」「KIX 單程」 */
function shortTitle(watch: FlightWatch): string {
  const suffix = watch.segmentLabel || (watch.tripType === 'oneway' ? '單程' : '');
  // 多點進出：「NRT/KIX 寒假」，一眼看出是哪兩個城市進出
  const place = watch.tripType === 'openjaw' && watch.returnOrigin && watch.returnOrigin !== watch.destination
    ? `${watch.destination}/${watch.returnOrigin}`
    : watch.destination;
  if (suffix) return `${place} ${suffix}`;
  return watch.tripType === 'openjaw' ? `${watch.origin}→${place}` : `${watch.origin}→${watch.destination}`;
}

// ---------- 出發時機與候選日期評估 ----------

function utcDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)) : null;
}

/** 只用在 utcDate() 產生的 UTC 正午日期上，不受本機時區影響（不是把當地時間轉成日期） */
function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface WeekBucket {
  /** 該週週一 yyyy-MM-dd */
  weekStart: string;
  label: string;
  minPrice: number;
  count: number;
  best: RankedTravelWindow;
  /** 1 = 最便宜的一週；用來畫顏色深淺與「推薦」標記 */
  rank: number;
}

/** 依出發日所在的週（週一起算）分組，每週取最低價；看「哪段時間出發便宜」 */
export function buildWeekBuckets(windows: RankedTravelWindow[]): WeekBucket[] {
  const map = new Map<string, Omit<WeekBucket, 'rank'>>();
  windows.forEach((item) => {
    const date = utcDate(item.window.departureDate);
    if (!date) return;
    const offset = (date.getUTCDay() + 6) % 7;
    const monday = new Date(date.getTime() - offset * 86_400_000);
    const key = utcDateKey(monday);
    const current = map.get(key);
    if (!current) {
      map.set(key, {
        weekStart: key,
        label: `${monday.getUTCMonth() + 1}/${monday.getUTCDate()} 週`,
        minPrice: item.window.priceTWD,
        count: 1,
        best: item,
      });
    } else {
      current.count += 1;
      if (item.window.priceTWD < current.minPrice) {
        current.minPrice = item.window.priceTWD;
        current.best = item;
      }
    }
  });
  const buckets = [...map.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const ranked = [...buckets].sort((a, b) => a.minPrice - b.minPrice);
  return buckets.map((bucket) => ({ ...bucket, rank: ranked.indexOf(bucket) + 1 }));
}

export interface PriceGroupRow {
  label: string;
  minPrice: number | null;
  count: number;
}

const WEEKDAY_LABELS = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];

/** 週幾出發的最低價 */
export function buildWeekdayRows(windows: RankedTravelWindow[]): PriceGroupRow[] {
  return WEEKDAY_LABELS.map((label, index) => {
    const prices = windows
      .filter(({ window }) => {
        const date = utcDate(window.departureDate);
        return date !== null && (date.getUTCDay() + 6) % 7 === index;
      })
      .map(({ window }) => window.priceTWD);
    return { label, minPrice: prices.length > 0 ? Math.min(...prices) : null, count: prices.length };
  });
}

export function windowNights(window: FlightTravelWindow): number | null {
  const departure = utcDate(window.departureDate);
  const returning = utcDate(window.returnDate);
  return departure && returning ? Math.round((returning.getTime() - departure.getTime()) / 86_400_000) : null;
}

/** 來回行程住幾晚的最低價（單程不列） */
export function buildNightsRows(windows: RankedTravelWindow[]): PriceGroupRow[] {
  const map = new Map<number, number[]>();
  windows.forEach(({ window }) => {
    const nights = windowNights(window);
    if (nights === null) return;
    map.set(nights, [...(map.get(nights) ?? []), window.priceTWD]);
  });
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([nights, prices]) => ({ label: `${nights} 晚`, minPrice: Math.min(...prices), count: prices.length }));
}

export type CandidateTag = 'cheapest' | 'weekend' | 'direct-cheapest' | 'below-target';

export interface CandidateRow extends RankedTravelWindow {
  nights: number | null;
  weekend: boolean;
  /** 比同一個區段最便宜的候選貴多少（同艙等） */
  diffFromBest: number;
  diffPercent: number;
  tags: CandidateTag[];
}

/** 候選日期評估：每一組日期跟同區段、同艙等的最低價比較，標出值得考慮的組合 */
export function buildCandidateRows(windows: RankedTravelWindow[]): CandidateRow[] {
  const bestByGroup = new Map<string, number>();
  const directBestByGroup = new Map<string, number>();
  windows.forEach(({ watch, window }) => {
    const key = `${watch.id}:${window.cabin}`;
    bestByGroup.set(key, Math.min(bestByGroup.get(key) ?? Number.POSITIVE_INFINITY, window.priceTWD));
    if (window.stops === 0) {
      directBestByGroup.set(key, Math.min(directBestByGroup.get(key) ?? Number.POSITIVE_INFINITY, window.priceTWD));
    }
  });
  return windows.map((item) => {
    const key = `${item.watch.id}:${item.window.cabin}`;
    const best = bestByGroup.get(key) ?? item.window.priceTWD;
    const date = utcDate(item.window.departureDate);
    const day = date ? date.getUTCDay() : -1;
    const weekend = day === 5 || day === 6;
    const tags: CandidateTag[] = [];
    if (item.window.priceTWD === best) tags.push('cheapest');
    if (item.window.stops === 0 && item.window.priceTWD === directBestByGroup.get(key)) tags.push('direct-cheapest');
    if (weekend) tags.push('weekend');
    if (item.watch.maxPriceTWD && item.window.priceTWD <= item.watch.maxPriceTWD) tags.push('below-target');
    return {
      ...item,
      nights: windowNights(item.window),
      weekend,
      diffFromBest: item.window.priceTWD - best,
      diffPercent: best > 0 ? ((item.window.priceTWD - best) / best) * 100 : 0,
      tags,
    };
  });
}

// ---------- 一張票 vs 拼單程 ----------

export function ticketingOf(window: FlightTravelWindow): 'single' | 'separate' {
  return window.ticketing === 'separate' ? 'separate' : 'single';
}

export interface TicketingComparison {
  single: FlightTravelWindow | null;
  separate: FlightTravelWindow | null;
  /** 拼單程比一張票便宜多少（正數 = 拼單程較便宜）；任一邊沒有資料為 null */
  savingTWD: number | null;
}

/** 同一區段（同艙等篩選下）一張票最低 vs 拼單程最低 */
export function compareTicketing(watch: FlightWatch, cabin: CabinFilter = 'all'): TicketingComparison {
  const windows = (watch.latestEstimate?.travelWindows ?? []).filter((window) => cabin === 'all' || window.cabin === cabin);
  const cheapest = (kind: 'single' | 'separate') => windows
    .filter((window) => ticketingOf(window) === kind)
    .sort((a, b) => a.priceTWD - b.priceTWD)[0] ?? null;
  const single = cheapest('single');
  const separate = cheapest('separate');
  return { single, separate, savingTWD: single && separate ? single.priceTWD - separate.priceTWD : null };
}
