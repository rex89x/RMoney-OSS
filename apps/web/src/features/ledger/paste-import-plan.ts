import type { TransactionInput } from './types';
import type { PasteTransferItem } from './paste-transfer-format';

/**
 * 巧明日常貼上匯入的「決策」純邏輯：自動對應類別／旅程／成員、依來源分攤算出每人負擔，
 * 並把每一列轉成 createTransaction 的 input（或說明為什麼這列不能匯入）。
 * 不碰 Firestore、不碰 React，方便測試；元件只負責渲染與呼叫。
 */

export type SourcePerson = 'chiau' | 'ming';
/** 貼上匯入只有 owner 能用；owner 對應巧明日常的「明」。 */
export const SELF_PERSON: SourcePerson = 'ming';
export const PARTNER_PERSON: SourcePerson = 'chiau';
export const PERSON_NAME: Record<SourcePerson, string> = { chiau: '巧', ming: '明' };

/**
 * 只保留「兩人分攤時只記我那份」的兩種方式。曾經有的「旅程成員分攤」「全部算我的」
 * 會把整筆算進我的花費（旅程沒有成員時退回付款人全付），與分攤的本意不符，已移除。
 */
export type ImportMode = 'household' | 'loan';

export const IMPORT_MODE_LABEL: Record<ImportMode, string> = {
  household: '記到共同帳本',
  loan: '分攤・代墊',
};

export const CATEGORY_HINT_NAME: Record<PasteTransferItem['categoryHint'], string> = {
  transport: '交通', food: '餐飲', stay: '住宿', ticket: '票券', shopping: '購物', other: '其他',
};

interface CategoryLike { key: string; name: string }
interface TripMemberLike { uid?: string; name: string }
interface TripLike { id: string; name: string; members?: TripMemberLike[] }
interface HouseholdLike { id: string; memberIds: string[] }
interface AccountLike { id: string; name: string; legacyPaymentMethod?: string | null }

// 依序嘗試；旅程匯入時優先用 RMoney 的旅遊專用類別。
const CATEGORY_KEYS: Record<PasteTransferItem['categoryHint'], { trip: string[]; general: string[]; words: string[] }> = {
  transport: { trip: ['trip_local_transport', 'transport'], general: ['transport'], words: ['交通', '車'] },
  food: { trip: ['trip_food', 'food'], general: ['food'], words: ['餐', '食', '飲'] },
  stay: { trip: ['trip_hotel'], general: ['trip_hotel'], words: ['住宿', '飯店', '旅館'] },
  ticket: { trip: ['trip_ticket', 'entertainment'], general: ['entertainment', 'trip_ticket'], words: ['門票', '票', '娛樂'] },
  shopping: { trip: ['shopping', 'trip_souvenir'], general: ['shopping'], words: ['購物'] },
  other: { trip: ['other'], general: ['other'], words: ['其他'] },
};

/** 本站分類提示 → RMoney 啟用中的支出類別 key；找不到回傳空字串。 */
export function autoCategoryKey(
  hint: PasteTransferItem['categoryHint'],
  kind: 'trip' | 'general',
  categories: readonly CategoryLike[],
): string {
  const rule = CATEGORY_KEYS[hint];
  for (const key of rule[kind]) if (categories.some((category) => category.key === key)) return key;
  for (const word of rule.words) {
    const hit = categories.find((category) => category.name.includes(word));
    if (hit) return hit.key;
  }
  return '';
}

/** 旅程名稱完全相同（忽略空白與大小寫）且唯一時才預選；仍會顯示給使用者確認。 */
export function autoTripId(nameHint: string, trips: readonly TripLike[]): string {
  const norm = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  const target = norm(nameHint);
  if (!target) return '';
  const hits = trips.filter((trip) => norm(trip.name) === target);
  return hits.length === 1 && hits[0] ? hits[0].id : '';
}

export function tripMemberKey(member: TripMemberLike): string {
  return member.uid ?? member.name;
}

/** 自己 = uid 相同的成員；另一位只有在旅程剛好兩人時才自動對應。 */
export function autoMemberMap(trip: TripLike | null | undefined, myUid: string): Record<SourcePerson, string> {
  const members = trip?.members ?? [];
  const me = members.find((member) => member.uid === myUid);
  const others = members.filter((member) => member !== me);
  return {
    ming: me ? tripMemberKey(me) : '',
    chiau: me && others.length === 1 && others[0] ? tripMemberKey(others[0]) : '',
  };
}

/**
 * 來源每個人應負擔的整數金額。有自訂分攤就照用（合計必須等於金額），
 * 否則在參與者之間均分，除不盡的零頭給付款人（付款人沒參與就給第一位）。
 */
export function sourceShares(item: Pick<PasteTransferItem, 'amount' | 'paidByHint' | 'splitHint'>): Record<SourcePerson, number> {
  const out: Record<SourcePerson, number> = { chiau: 0, ming: 0 };
  if (item.splitHint.shares.length > 0) {
    for (const share of item.splitHint.shares) out[share.personId] += share.amount;
    if (Math.abs(out.chiau + out.ming - item.amount) > 0.5) throw new Error('來源自訂分攤合計與金額不符');
    return out;
  }
  const people = item.splitHint.participants;
  const base = Math.floor(item.amount / people.length);
  for (const person of people) out[person] = base;
  const remainderTo = people.includes(item.paidByHint) ? item.paidByHint : people[0];
  if (remainderTo) out[remainderTo] += item.amount - base * people.length;
  return out;
}

export interface PlanContext {
  uid: string;
  mode: ImportMode;
  targetKind: 'trip' | 'general';
  account: AccountLike | null;
  categoryKey: string;
  trip: TripLike | null;
  /** 使用者明確選了「不歸屬 RMoney 旅程」；旅程支出也照樣匯入，只是 tripId = null。 */
  noTrip?: boolean;
  memberMap: Record<SourcePerson, string>;
  household: HouseholdLike | null;
  /** 代墊對象的名字（RMoney「代墊」分頁以這個名字累計欠款）。 */
  counterpartyName?: string;
  date: Date;
}

export type RowPlan =
  | { ok: true; input: TransactionInput; chargedTWD: number; myShareTWD: number }
  /** skipped = 這個模式下本來就不匯入（例如巧付款但選了「全部算我的」），不是錯誤。 */
  | { ok: false; reason: string; skipped: boolean };

function fail(reason: string, skipped = false): RowPlan {
  return { ok: false, reason, skipped };
}

export function planRow(item: PasteTransferItem, ctx: PlanContext): RowPlan {
  const mine = item.paidByHint === SELF_PERSON;
  if (!ctx.categoryKey) return fail('請選擇 RMoney 類別');
  if (ctx.targetKind === 'trip' && !ctx.trip && !ctx.noTrip) return fail('請選擇 RMoney 旅程');
  if (mine && !ctx.account) return fail('請選擇付款帳戶');

  let shares: Record<SourcePerson, number>;
  try { shares = sourceShares(item); } catch (cause) { return fail(cause instanceof Error ? cause.message : '分攤資料不正確'); }

  const input: TransactionInput = {
    userId: ctx.uid,
    type: 'expense',
    amount: item.amount,
    currency: 'TWD',
    amountTWD: item.amount,
    fxRate: 1,
    category: ctx.categoryKey,
    paymentMethod: mine && ctx.account ? (ctx.account.legacyPaymentMethod || ctx.account.name) : '共同帳',
    fromAccountId: mine && ctx.account ? ctx.account.id : null,
    toAccountId: null,
    note: item.note,
    date: ctx.date,
    tripId: ctx.targetKind === 'trip' && ctx.trip && !ctx.noTrip ? ctx.trip.id : null,
    payerId: null,
    shareType: null,
  };

  if (ctx.mode === 'household') {
    const household = ctx.household;
    const partnerUid = household?.memberIds.find((id) => id !== ctx.uid);
    if (!household || household.memberIds.length !== 2 || !household.memberIds.includes(ctx.uid) || !partnerUid) {
      return fail('共同帳本尚未啟用（需要兩位成員）');
    }
    const byUid: Record<string, number> = { [ctx.uid]: shares.ming, [partnerUid]: shares.chiau };
    input.householdId = household.id;
    input.scope = 'household';
    input.paidByUid = mine ? ctx.uid : partnerUid;
    input.shareType = 'custom';
    input.customShares = household.memberIds.map((id) => ({ memberId: id, amountTWD: byUid[id] ?? 0 }));
    input.myShareTWD = shares.ming;
    // 旅程的欠款由共同帳本結算（computeSettlement 會略過 householdId），payerId 只作顯示。
    if (input.tripId) input.payerId = ctx.memberMap[item.paidByHint] || null;
    return { ok: true, input, chargedTWD: mine ? item.amount : 0, myShareTWD: shares.ming };
  }

  // loan：兩人分攤的列只把我那份記成我的花費，另一半變成代墊欠款。
  const counterparty = ctx.counterpartyName?.trim() ?? '';
  if (!counterparty) return fail('請填分攤對象的名字');
  if (!mine && shares.ming === 0) return fail(`${PERSON_NAME[item.paidByHint]}自己的花費，與你無關`, true);
  const owed = mine ? shares.chiau : shares.ming;
  if (owed > 0) {
    // 我先付：扣全額，對方欠我他那份；對方先付：不扣我的帳戶，我欠對方我那份。兩者都只把我那份算進我的花費。
    input.splitMode = mine ? 'i-paid-others' : 'they-paid-mine';
    input.counterpartyName = counterparty;
    input.myShareTWD = shares.ming;
  }
  if (!mine) input.paymentMethod = `${counterparty}先付`;
  // 欠款由「代墊」結清；旅程裡記成自付，避免旅程結算再算一次。
  if (input.tripId) {
    input.payerId = ctx.memberMap.ming || ctx.uid;
    input.shareType = 'payer';
  }
  return { ok: true, input, chargedTWD: mine ? item.amount : 0, myShareTWD: shares.ming };
}

/** 有共同帳本就預設記共同帳本；沒有就用代墊——兩人誰先付都能匯，而且只算你那份。 */
export function defaultImportMode(hasHousehold: boolean): ImportMode {
  return hasHousehold ? 'household' : 'loan';
}

export function availableModes(hasHousehold: boolean): ImportMode[] {
  return hasHousehold ? ['household', 'loan'] : ['loan'];
}

/** 選定的 RMoney 旅程日期範圍：用這組費用的最早與最晚日期。 */
export function dateRangeOf(items: readonly Pick<PasteTransferItem, 'date'>[]): { start: string; end: string } | null {
  const dates = items.map((item) => item.date).sort();
  const start = dates[0];
  const end = dates[dates.length - 1];
  return start && end ? { start, end } : null;
}
