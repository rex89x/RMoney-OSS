import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

export type FlightCabin = 'economy' | 'premium_economy' | 'business' | 'first';
export type FlightPriceConfidence = 'low' | 'medium' | 'high';
export type FlightAirlineFilter = 'all' | 'include' | 'exclude';
export type FlightPriceAdvice = 'buy_now' | 'watch' | 'wait';
/** roundtrip 來回 / oneway 單程 / openjaw 多點進出（A 進 B 出：去程 origin→destination，回程 returnOrigin→returnDestination） */
export type FlightTripType = 'roundtrip' | 'oneway' | 'openjaw';
/** 購票方式：single 一張票、separate 兩張單程拼起來、both 兩種都查取較便宜 */
export type FlightTicketSearch = 'single' | 'separate' | 'both';
export type FlightTicketing = 'single' | 'separate';
export type FlightScanFrequency = 'daily' | 'weekdays' | 'weekly';
/** claude_api：Apps Script 呼叫 Claude API + web search；claude：外部 Claude 排程推送 */
export type FlightScanProvider = 'duffel' | 'claude_api' | 'claude';

export interface FlightPriceSource {
  title: string;
  url: string;
}

export interface FlightPriceEstimate {
  minPriceTWD: number;
  typicalPriceTWD: number;
  maxPriceTWD: number;
  confidence: FlightPriceConfidence;
  summary: string;
  advice: FlightPriceAdvice;
  adviceReason: string;
  cabinEstimates: FlightCabinEstimate[];
  travelWindows: FlightTravelWindow[];
  sources: FlightPriceSource[];
  /** 只有 Claude 排程推送的結果會帶；Duffel / Claude API / 舊 Gemini 資料為 undefined */
  provider?: FlightScanProvider;
  checkedAt: Date;
}

export interface FlightCabinEstimate {
  cabin: FlightCabin;
  minPriceTWD: number;
  typicalPriceTWD: number;
  maxPriceTWD: number;
  bestAirline: string;
}

export interface FlightTravelWindow {
  departureDate: string;
  /** 單程為空字串 */
  returnDate: string;
  cabin: FlightCabin;
  priceTWD: number;
  airline: string;
  stops: number;
  reason: string;
  /** single = 一張票（來回 / 多城市）、separate = 拼單程（兩張單程）；舊資料沒有 = 一張票 */
  ticketing?: FlightTicketing;
  /** 拼單程時各段價格（所有旅客合計 TWD），priceTWD = 兩者相加 */
  outboundPriceTWD?: number;
  returnPriceTWD?: number;
  /** 拼單程時回程的航空公司（airline 是去程） */
  returnAirline?: string;
  /** 以下為選填航班細節（當地時間 HH:mm）；來源查不到時不存在 */
  departureTime?: string;
  arrivalTime?: string;
  durationMinutes?: number;
  flightNumber?: string;
  returnDepartureTime?: string;
  returnArrivalTime?: string;
}

export interface FlightPriceSnapshot extends FlightPriceEstimate {
  id: string;
}

export interface FlightWatch {
  id: string;
  userId: string;
  /**
   * 還有誰看得到（共同帳本的其他成員 uid）。rules：member 可讀 `userId == 自己` 或 `自己 in sharedWith`。
   * 由建立者那端的 `useSyncFlightWatchSharing()` 依目前共同帳本成員自動維護；只有建立者能改 / 刪 / 立即更新。
   */
  sharedWith: string[];
  /** 同一條航線的多個日期區段用來區分，例如「寒假」「春節」；空字串表示未命名 */
  segmentLabel: string;
  tripType: FlightTripType;
  /** Claude 排程群組（一個群組對應一個 Claude 排程任務）；空字串 = 預設群組 */
  claudeGroup: string;
  origin: string;
  destination: string;
  /** 只有 openjaw 使用：回程出發機場（B 出）；其他行程為空字串 */
  returnOrigin: string;
  /** 只有 openjaw 使用：回程抵達機場；預設回到 origin；其他行程為空字串 */
  returnDestination: string;
  /** 購票方式；null = 依行程預設（多點進出 both、來回 single），見 flightTicketSearch() */
  ticketSearch: FlightTicketSearch | null;
  departureStart: Date;
  departureEnd: Date;
  minNights: number;
  maxNights: number;
  adults: number;
  cabin: FlightCabin;
  selectedCabins: FlightCabin[];
  nonstopOnly: boolean;
  excludeLowCostCarriers: boolean;
  airlineFilter: FlightAirlineFilter;
  airlineCodes: string[];
  scanProvider: FlightScanProvider;
  scanFrequency: FlightScanFrequency;
  weeklyDay: number;
  notifyOnDeal: boolean;
  notifyOnEveryScan: boolean;
  priceDropPercent: number;
  maxPriceTWD: number | null;
  enabled: boolean;
  latestEstimate: FlightPriceEstimate | null;
  bestPriceTWD: number | null;
  lastError: string | null;
  lastCheckedAt: Date | null;
  /** 最近一次複製 Claude 排程提示詞時的 criteriaKey；與目前條件不同代表排程裡的提示詞過期了 */
  claudePromptKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function defaultTicketSearch(tripType: FlightTripType): FlightTicketSearch {
  return tripType === 'openjaw' ? 'both' : 'single';
}

/** 實際使用的購票方式（與 Apps Script flightTicketSearch_ 一致）；單程一律 single */
export function flightTicketSearch(watch: Pick<FlightWatch, 'tripType' | 'ticketSearch'>): FlightTicketSearch {
  if (watch.tripType === 'oneway') return 'single';
  return watch.ticketSearch ?? defaultTicketSearch(watch.tripType);
}

/** 有回程（來回或多點進出）：需要晚數、returnDate */
export function hasReturnLeg(tripType: FlightTripType): boolean {
  return tripType !== 'oneway';
}

/** 回程航段：來回 = destination → origin；多點進出 = returnOrigin → returnDestination；單程 = null */
export function flightReturnLeg(
  watch: Pick<FlightWatch, 'tripType' | 'origin' | 'destination' | 'returnOrigin' | 'returnDestination'>,
): { from: string; to: string } | null {
  if (watch.tripType === 'oneway') return null;
  if (watch.tripType === 'openjaw') {
    return { from: watch.returnOrigin || watch.destination, to: watch.returnDestination || watch.origin };
  }
  return { from: watch.destination, to: watch.origin };
}

function isCabin(value: unknown): value is FlightCabin {
  return value === 'economy' || value === 'premium_economy' || value === 'business' || value === 'first';
}

/** 2026-11 Gemini → Claude 遷移：舊的 'gemini' watch 改由 Claude API 搜尋（後端 flightProvider_ 同步） */
function parseScanProvider(value: unknown): FlightScanProvider {
  if (value === 'claude') return 'claude';
  if (value === 'claude_api' || value === 'gemini') return 'claude_api';
  return 'duffel';
}

function parseCabinEstimate(value: unknown): FlightCabinEstimate | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const prices = [Number(item.minPriceTWD), Number(item.typicalPriceTWD), Number(item.maxPriceTWD)];
  if (!isCabin(item.cabin) || !prices.every(Number.isFinite)) return null;
  return {
    cabin: item.cabin,
    minPriceTWD: prices[0] ?? 0,
    typicalPriceTWD: prices[1] ?? 0,
    maxPriceTWD: prices[2] ?? 0,
    bestAirline: typeof item.bestAirline === 'string' ? item.bestAirline : '',
  };
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function optionalTime(value: unknown): string | undefined {
  return typeof value === 'string' && TIME_PATTERN.test(value) ? value : undefined;
}

function travelWindowDetails(item: Record<string, unknown>): Partial<FlightTravelWindow> {
  const details: Partial<FlightTravelWindow> = {};
  const departureTime = optionalTime(item.departureTime);
  const arrivalTime = optionalTime(item.arrivalTime);
  const returnDepartureTime = optionalTime(item.returnDepartureTime);
  const returnArrivalTime = optionalTime(item.returnArrivalTime);
  const duration = Number(item.durationMinutes);
  if (departureTime) details.departureTime = departureTime;
  if (arrivalTime) details.arrivalTime = arrivalTime;
  if (returnDepartureTime) details.returnDepartureTime = returnDepartureTime;
  if (returnArrivalTime) details.returnArrivalTime = returnArrivalTime;
  if (Number.isFinite(duration) && duration > 0) details.durationMinutes = Math.round(duration);
  if (typeof item.flightNumber === 'string' && item.flightNumber) details.flightNumber = item.flightNumber;
  if (item.ticketing === 'separate' || item.ticketing === 'single') details.ticketing = item.ticketing;
  const outboundPrice = Number(item.outboundPriceTWD);
  const returnPrice = Number(item.returnPriceTWD);
  if (details.ticketing === 'separate' && Number.isFinite(outboundPrice) && Number.isFinite(returnPrice)) {
    details.outboundPriceTWD = outboundPrice;
    details.returnPriceTWD = returnPrice;
  }
  if (typeof item.returnAirline === 'string' && item.returnAirline) details.returnAirline = item.returnAirline;
  return details;
}

function parseTravelWindow(value: unknown): FlightTravelWindow | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const price = Number(item.priceTWD);
  if (!isCabin(item.cabin) || !Number.isFinite(price)) return null;
  return {
    ...travelWindowDetails(item),
    departureDate: typeof item.departureDate === 'string' ? item.departureDate : '',
    returnDate: typeof item.returnDate === 'string' ? item.returnDate : '',
    cabin: item.cabin,
    priceTWD: price,
    airline: typeof item.airline === 'string' ? item.airline : '',
    stops: Math.max(0, Number(item.stops) || 0),
    reason: typeof item.reason === 'string' ? item.reason : '',
  };
}

function parseSource(value: unknown): FlightPriceSource | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (typeof source.url !== 'string' || !source.url.startsWith('http')) return null;
  return {
    title: typeof source.title === 'string' ? source.title : source.url,
    url: source.url,
  };
}

export function parseFlightPriceEstimate(value: unknown): FlightPriceEstimate | null {
  if (!value || typeof value !== 'object') return null;
  const estimate = value as Record<string, unknown>;
  const min = Number(estimate.minPriceTWD);
  const typical = Number(estimate.typicalPriceTWD);
  const max = Number(estimate.maxPriceTWD);
  const checkedAt = tsToDate(estimate.checkedAt);
  if (![min, typical, max].every(Number.isFinite) || !checkedAt) return null;
  const confidence = estimate.confidence;
  return {
    minPriceTWD: min,
    typicalPriceTWD: typical,
    maxPriceTWD: max,
    confidence: confidence === 'high' || confidence === 'medium' ? confidence : 'low',
    summary: typeof estimate.summary === 'string' ? estimate.summary : '',
    advice: estimate.advice === 'buy_now' || estimate.advice === 'wait' ? estimate.advice : 'watch',
    adviceReason: typeof estimate.adviceReason === 'string' ? estimate.adviceReason : '',
    cabinEstimates: Array.isArray(estimate.cabinEstimates)
      ? estimate.cabinEstimates.map(parseCabinEstimate).filter((item): item is FlightCabinEstimate => item !== null)
      : [],
    travelWindows: Array.isArray(estimate.travelWindows)
      ? estimate.travelWindows.map(parseTravelWindow).filter((item): item is FlightTravelWindow => item !== null)
      : [],
    sources: Array.isArray(estimate.sources)
      ? estimate.sources
          .map(parseSource)
          .filter((source): source is FlightPriceSource => source !== null)
      : [],
    ...(estimate.provider === 'claude' ? { provider: 'claude' as const } : {}),
    checkedAt,
  };
}

export const flightWatchConverter: FirestoreDataConverter<FlightWatch> = {
  toFirestore: (watch) => {
    const { id: _id, ...rest } = watch as FlightWatch;
    void _id;
    return {
      ...rest,
      departureStart: Timestamp.fromDate(rest.departureStart),
      departureEnd: Timestamp.fromDate(rest.departureEnd),
      lastCheckedAt: rest.lastCheckedAt ? Timestamp.fromDate(rest.lastCheckedAt) : null,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
      latestEstimate: rest.latestEstimate
        ? { ...rest.latestEstimate, checkedAt: Timestamp.fromDate(rest.latestEstimate.checkedAt) }
        : null,
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): FlightWatch => {
    const data = snap.data() as DocumentData;
    const savedCabins = Array.isArray(data.selectedCabins) ? data.selectedCabins.filter(isCabin) : [];
    const fallbackCabin = (data.cabin as FlightCabin | undefined) ?? 'economy';
    return {
      id: snap.id,
      userId: data.userId ?? '',
      sharedWith: Array.isArray(data.sharedWith) ? (data.sharedWith as unknown[]).filter((v): v is string => typeof v === 'string') : [],
      segmentLabel: typeof data.segmentLabel === 'string' ? data.segmentLabel : '',
      tripType: data.tripType === 'oneway' || data.tripType === 'openjaw' ? data.tripType : 'roundtrip',
      claudeGroup: typeof data.claudeGroup === 'string' ? data.claudeGroup : '',
      origin: data.origin ?? '',
      destination: data.destination ?? '',
      returnOrigin: data.tripType === 'openjaw' && typeof data.returnOrigin === 'string' ? data.returnOrigin : '',
      returnDestination: data.tripType === 'openjaw' && typeof data.returnDestination === 'string' ? data.returnDestination : '',
      ticketSearch: data.ticketSearch === 'single' || data.ticketSearch === 'separate' || data.ticketSearch === 'both' ? data.ticketSearch : null,
      departureStart: tsToDate(data.departureStart) ?? new Date(),
      departureEnd: tsToDate(data.departureEnd) ?? new Date(),
      minNights: Number(data.minNights) || 3,
      maxNights: Number(data.maxNights) || 7,
      adults: Number(data.adults) || 1,
      cabin: fallbackCabin,
      selectedCabins: savedCabins.length > 0 ? savedCabins : [fallbackCabin],
      nonstopOnly: data.nonstopOnly === true,
      excludeLowCostCarriers: data.excludeLowCostCarriers === true,
      airlineFilter: data.airlineFilter === 'include' || data.airlineFilter === 'exclude' ? data.airlineFilter : 'all',
      airlineCodes: Array.isArray(data.airlineCodes)
        ? data.airlineCodes.filter((value: unknown): value is string => typeof value === 'string')
        : [],
      scanProvider: parseScanProvider(data.scanProvider),
      scanFrequency: data.scanFrequency === 'weekdays' || data.scanFrequency === 'weekly' ? data.scanFrequency : 'daily',
      weeklyDay: Math.min(6, Math.max(0, Number(data.weeklyDay) || 0)),
      notifyOnDeal: data.notifyOnDeal !== false,
      notifyOnEveryScan: data.notifyOnEveryScan === true,
      priceDropPercent: Math.min(50, Math.max(1, Number(data.priceDropPercent) || 5)),
      maxPriceTWD: typeof data.maxPriceTWD === 'number' ? data.maxPriceTWD : null,
      enabled: data.enabled !== false,
      latestEstimate: parseFlightPriceEstimate(data.latestEstimate),
      bestPriceTWD: typeof data.bestPriceTWD === 'number' ? data.bestPriceTWD : null,
      lastError: typeof data.lastError === 'string' ? data.lastError : null,
      lastCheckedAt: tsToDate(data.lastCheckedAt),
      claudePromptKey: typeof data.claudePromptKey === 'string' ? data.claudePromptKey : null,
      createdAt: tsToDate(data.createdAt) ?? new Date(),
      updatedAt: tsToDate(data.updatedAt) ?? new Date(),
    };
  },
};
