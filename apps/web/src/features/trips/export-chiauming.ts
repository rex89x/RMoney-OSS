import { formatTWDateInput } from '@/lib/tz';
import type { ItineraryItem, ItineraryItemType } from '@/features/itinerary/types';
import type { Transaction } from '@/features/ledger/types';
import type { SettlementTransactionDetail } from './settlement';
import type { TripMember } from './types';

/**
 * 「複製到巧明日常」的剪貼簿格式（`rmoney-trip` v1）：RMoney → 巧明日常單向。
 * 行程與花費放在同一份；巧明日常的 `src/lib/rmoney-trip-import.ts` 解析並套用。改格式兩邊要一起改。
 *
 * 防止來回重複：
 *  - 從巧明日常匯入的行程項目（sourceId = chiauming-100:{tripKey}:{stopId}）帶 `originId`，
 *    巧明日常會更新原本那個停留點，不會多一個。
 *  - 從巧明日常貼上匯入的交易（importSourceId = chiauming-100:…）不匯出——巧明日常本來就有。
 *  - 巧明日常收到的花費會標記來自 RMoney，不會再被「複製到 RMoney」匯回來。
 *
 * 不放任何帳戶、餘額、uid、email；人只用「巧 / 明」表示。
 */
export const RMONEY_TRIP_FORMAT = 'rmoney-trip';
export const RMONEY_TRIP_VERSION = 1;

export type ChiaumingPerson = 'chiau' | 'ming';
export type PersonChoice = ChiaumingPerson | 'other';
export type ChiaumingCategory = 'transport' | 'food' | 'stay' | 'ticket' | 'shopping' | 'other';

export interface RMoneyTripStop {
  sourceId: string;
  /** 原本就是巧明日常的停留點時，它在巧明日常的 id。 */
  originId?: string;
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  type?: ItineraryItemType;
  place?: string;
  address?: string;
  note?: string;
  mapQuery?: string;
  mapsUrl?: string;
  lat?: number;
  lng?: number;
  estimatedCost?: number;
  currency?: string;
}

export interface RMoneyTripExpense {
  sourceId: string;
  date: string;
  title: string;
  /** 巧明兩人負擔的部分（TWD，整數）。其他旅伴的份不算。 */
  amount: number;
  currency: 'TWD';
  category: ChiaumingCategory;
  paidBy: ChiaumingPerson;
  participants: ChiaumingPerson[];
  shares: { personId: ChiaumingPerson; amount: number }[];
  /** 原幣資訊，給巧明日常顯示用。 */
  originalAmount?: number;
  originalCurrency?: string;
}

export interface RMoneyTripBundle {
  format: typeof RMONEY_TRIP_FORMAT;
  version: typeof RMONEY_TRIP_VERSION;
  trip: {
    sourceTripKey: string;
    title: string;
    destination: string;
    startDate: string;
    endDate: string;
    /** 這趟原本是從巧明日常匯入的話，它在巧明日常的旅程 id。 */
    chiaumingTripKey?: string;
  };
  stops: RMoneyTripStop[];
  expenses: RMoneyTripExpense[];
}

const CHIAUMING_SOURCE = /^chiauming-100:([^\s:]+):([^\s:]+)$/;

/** 從巧明日常匯入的項目 → { tripKey, stopId }。 */
export function chiaumingOrigin(sourceId: string | undefined): { tripKey: string; stopId: string } | null {
  const m = sourceId ? CHIAUMING_SOURCE.exec(sourceId) : null;
  return m ? { tripKey: m[1] as string, stopId: m[2] as string } : null;
}

function isOwnSearchUrl(url: string): boolean {
  return /\/maps\/search\/\?api=1&query=/.test(url) && !/query=-?\d+(\.\d+)?,-?\d+(\.\d+)?/.test(url);
}

export function itemToStop(tripId: string, dayId: string, item: ItineraryItem): RMoneyTripStop {
  const origin = chiaumingOrigin(item.sourceId);
  const hasCoords = typeof item.lat === 'number' && typeof item.lng === 'number';
  // 連結：使用者給的地點連結優先；沒有但已定位 → 座標連結（比文字搜尋準）；文字搜尋連結不傳，巧明日常自己會組
  const mapsUrl = item.mapsUrl && !isOwnSearchUrl(item.mapsUrl)
    ? item.mapsUrl
    : hasCoords ? `https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lng}` : undefined;
  const mapQuery = item.sourcePlaceQuery?.trim() || undefined;
  const stop: RMoneyTripStop = {
    sourceId: `rmoney:${tripId}:${item.id}`,
    title: item.title.trim() || item.placeName?.trim() || '未命名',
    date: dayId,
  };
  if (origin) stop.originId = origin.stopId;
  if (item.startTime) stop.time = item.startTime;
  if (item.endTime) stop.endTime = item.endTime;
  if (item.type) stop.type = item.type;
  if (item.placeName?.trim()) stop.place = item.placeName.trim();
  if (item.address?.trim()) stop.address = item.address.trim();
  if (item.notes?.trim()) stop.note = item.notes.trim();
  if (mapQuery) stop.mapQuery = mapQuery;
  if (mapsUrl) stop.mapsUrl = mapsUrl;
  if (hasCoords) { stop.lat = item.lat; stop.lng = item.lng; }
  if (typeof item.estimatedCost === 'number' && item.estimatedCost > 0) {
    stop.estimatedCost = item.estimatedCost;
    stop.currency = item.currency || 'TWD';
  }
  return stop;
}

/** 只有日期是 YYYY-MM-DD 的「天」才匯出（舊的 `day-1` 這類 id 用它的 date 欄位）。 */
export function buildStops(
  tripId: string,
  groups: readonly { dayId: string; date?: string; items: readonly ItineraryItem[] }[],
): RMoneyTripStop[] {
  const out: RMoneyTripStop[] = [];
  for (const group of groups) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(group.dayId) ? group.dayId : group.date ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const item of group.items) {
      if (item.status === 'skipped') continue;
      out.push(itemToStop(tripId, date, item));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 人                                                                  */
/* ------------------------------------------------------------------ */

export interface TripPerson {
  id: string;
  name: string;
}

/** 分攤明細裡出現過的人（付款人與分攤者），依出現順序。 */
export function peopleInDetails(details: readonly SettlementTransactionDetail[]): TripPerson[] {
  const seen = new Map<string, string>();
  for (const d of details) {
    if (!seen.has(d.payerId)) seen.set(d.payerId, d.payerName);
    for (const s of d.shares) if (!seen.has(s.memberId)) seen.set(s.memberId, s.memberName);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

/**
 * 預設對應：自己（RMoney 的 owner）= 明；共同帳本的另一位 = 巧；
 * 名字含「巧」或「明」照字面；其他旅伴不匯入他們的份。使用者可在對話框改。
 */
export function defaultPersonChoice(person: TripPerson, myUid: string, partnerUids: readonly string[]): PersonChoice {
  if (person.id === myUid) return 'ming';
  if (partnerUids.includes(person.id)) return 'chiau';
  if (person.name.includes('巧')) return 'chiau';
  if (person.name.includes('明')) return 'ming';
  return 'other';
}

/* ------------------------------------------------------------------ */
/* 花費                                                                */
/* ------------------------------------------------------------------ */

interface CategoryLike { key: string; name: string }

const CATEGORY_BY_KEY: Record<string, ChiaumingCategory> = {
  trip_local_transport: 'transport', transport: 'transport', trip_flight: 'transport',
  trip_food: 'food', food: 'food',
  trip_hotel: 'stay',
  trip_ticket: 'ticket', entertainment: 'ticket',
  shopping: 'shopping', trip_souvenir: 'shopping',
};
const CATEGORY_WORDS: [ChiaumingCategory, string[]][] = [
  ['transport', ['交通', '車', '機票', '航空', '油', '停車']],
  ['stay', ['住宿', '飯店', '旅館', '民宿']],
  ['food', ['餐', '食', '飲', '咖啡']],
  ['ticket', ['門票', '票', '娛樂', '活動']],
  ['shopping', ['購物', '紀念品', '伴手禮']],
];

export function chiaumingCategoryFor(key: string, categories: readonly CategoryLike[]): ChiaumingCategory {
  const direct = CATEGORY_BY_KEY[key];
  if (direct) return direct;
  const name = categories.find((c) => c.key === key)?.name ?? key;
  for (const [category, words] of CATEGORY_WORDS) if (words.some((w) => name.includes(w))) return category;
  return 'other';
}

export interface SkippedExpense {
  txId: string;
  title: string;
  reason: string;
}

export interface ExpenseBuildResult {
  expenses: RMoneyTripExpense[];
  skipped: SkippedExpense[];
}

function titleOf(detail: SettlementTransactionDetail, tx: Transaction | undefined, categories: readonly CategoryLike[]): string {
  const note = (tx?.note ?? detail.note ?? '').trim();
  if (note) return note.slice(0, 80);
  return categories.find((c) => c.key === detail.category)?.name ?? '旅程花費';
}

/**
 * 把分攤明細（`computeSettlement` 的 transactionDetails，與旅程結算同一套規則）轉成巧明日常的費用。
 * - 金額只算巧明兩人負擔的份，四捨五入到元；總額 = 兩人份相加
 * - 付款人不是巧或明（例如朋友先付）→ 略過，巧明日常無法表示「欠旅伴」
 * - 從巧明日常匯入的交易 → 略過（避免來回重複）
 */
export function buildExpenses(params: {
  details: readonly SettlementTransactionDetail[];
  txById: ReadonlyMap<string, Transaction>;
  choices: Readonly<Record<string, PersonChoice>>;
  categories: readonly CategoryLike[];
}): ExpenseBuildResult {
  const { details, txById, choices, categories } = params;
  const expenses: RMoneyTripExpense[] = [];
  const skipped: SkippedExpense[] = [];
  for (const detail of details) {
    const tx = txById.get(detail.txId);
    const title = titleOf(detail, tx, categories);
    if (tx?.importSourceId?.startsWith('chiauming-100:')) {
      skipped.push({ txId: detail.txId, title, reason: '從巧明日常匯入的，巧明日常已經有這筆' });
      continue;
    }
    const payer = choices[detail.payerId] ?? 'other';
    if (payer === 'other') {
      skipped.push({ txId: detail.txId, title, reason: `由${detail.payerName}付款，不是巧或明` });
      continue;
    }
    const sum: Record<ChiaumingPerson, number> = { chiau: 0, ming: 0 };
    for (const share of detail.shares) {
      const who = choices[share.memberId] ?? 'other';
      if (who !== 'other') sum[who] += share.amountTWD;
    }
    const shares = (['ming', 'chiau'] as const)
      .map((personId) => ({ personId, amount: Math.round(sum[personId]) }))
      .filter((share) => share.amount > 0);
    const amount = shares.reduce((total, share) => total + share.amount, 0);
    if (amount <= 0) {
      skipped.push({ txId: detail.txId, title, reason: '巧明兩人都沒有分擔這筆' });
      continue;
    }
    const expense: RMoneyTripExpense = {
      sourceId: `rmoney:tx:${detail.txId}`,
      date: formatTWDateInput(detail.date),
      title,
      amount,
      currency: 'TWD',
      category: chiaumingCategoryFor(detail.category, categories),
      paidBy: payer,
      participants: shares.map((share) => share.personId),
      shares,
    };
    if (tx && tx.currency !== 'TWD') {
      expense.originalAmount = tx.amount;
      expense.originalCurrency = tx.currency;
    }
    expenses.push(expense);
  }
  return { expenses, skipped };
}

export function buildRMoneyTripBundle(params: {
  trip: { id: string; name: string; destination: readonly string[]; startDate: Date; endDate: Date };
  stops: RMoneyTripStop[];
  expenses: RMoneyTripExpense[];
  /** 行程項目裡的巧明日常來源旅程 key（來自同一趟才帶）。 */
  chiaumingTripKey?: string;
}): RMoneyTripBundle {
  const { trip } = params;
  return {
    format: RMONEY_TRIP_FORMAT,
    version: RMONEY_TRIP_VERSION,
    trip: {
      sourceTripKey: trip.id,
      title: trip.name,
      destination: trip.destination.join('、'),
      startDate: formatTWDateInput(trip.startDate),
      endDate: formatTWDateInput(trip.endDate),
      ...(params.chiaumingTripKey ? { chiaumingTripKey: params.chiaumingTripKey } : {}),
    },
    stops: params.stops,
    expenses: params.expenses,
  };
}

/** 行程項目若全部來自巧明日常的同一趟，回傳那趟的 key。 */
export function commonChiaumingTripKey(items: readonly ItineraryItem[]): string | undefined {
  const keys = new Set(items.map((item) => chiaumingOrigin(item.sourceId)?.tripKey).filter((key): key is string => Boolean(key)));
  return keys.size === 1 ? [...keys][0] : undefined;
}

/**
 * 準備給 `computeSettlement` 的輸入：
 *  - 旅程沒設成員時，用「自己 + 共同帳本成員」當成員，否則 members ≤ 1 會整筆算付款人的
 *  - 共同帳本交易有 customShares 但沒標 shareType 時當成自訂分攤（共同帳本的分攤就存在那裡）
 * 呼叫端要帶 `householdMemberIds: []`：照常分攤、不把共同帳本成員的份併到付款人。
 */
export function settlementInputs(params: {
  members: readonly TripMember[] | undefined;
  txs: readonly Transaction[];
  myUid: string;
  partnerUids: readonly string[];
}): { members: TripMember[]; txs: Transaction[] } {
  const members = params.members && params.members.length > 0
    ? [...params.members]
    : [{ uid: params.myUid, name: '我' }, ...params.partnerUids.map((uid) => ({ uid, name: '共同帳本成員' }))];
  const txs = params.txs.map((tx) => (
    tx.householdId && !tx.shareType && tx.customShares && tx.customShares.length > 0 ? { ...tx, shareType: 'custom' as const } : tx
  ));
  return { members, txs };
}
