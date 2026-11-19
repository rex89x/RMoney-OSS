import type { Account } from '@/features/accounts';
import type { Category } from '@/features/ledger/types';
import { TYPE_LABEL, type PaymentMethod } from '@/features/ledger/payment-method-types';
import { DEFAULT_PAYMENT_METHODS } from '@/lib/seed-data';
import type { FxRate } from '@/features/fx/types';
import type { PortfolioPosition } from '@/features/investments/types';
import { normalizeStockSymbol } from '@/features/investments/symbol-utils';
import { sha256Hex } from '@/features/ledger/paste-transfer-format';
import { dateInputToTWDate } from '@/lib/tz';
import type { ImportItem, LedgerImportItem, TradeImportItem } from './schema';

export type ImportRowStatus = 'ready' | 'warn' | 'error';

/** 交割 / 付款可用的帳戶類型 */
export const TRADE_ACCOUNT_TYPES = ['bank', 'cash', 'investment_cash', 'e_wallet_balance'] as const;
export const LEDGER_ACCOUNT_TYPES = ['cash', 'bank', 'credit_card', 'e_wallet_balance', 'investment_cash'] as const;

export interface ResolvedLedger {
  kind: 'expense' | 'income';
  date: Date;
  amount: number;
  currency: string;
  fxRate: number;
  amountTWD: number;
  categoryKey: string;
  categoryGuessed: boolean;
  accountId: string | null;
  paymentMethod: string;
  /** 付款方式有對到帳戶 / 自訂支付方式 / 預設名單（false = 來源沒給或對不到，預覽時值得看一眼） */
  paymentMatched: boolean;
  note: string;
  tags: string[];
}

export interface ResolvedTrade {
  kind: 'trade';
  date: Date;
  market: 'TW' | 'US';
  symbol: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  currency: 'TWD' | 'USD';
  fee: number;
  fxRate: number;
  grossTWD: number;
  accountId: string | null;
  existingPositionId: string | null;
  note: string;
}

export interface ImportRow {
  /** 穩定 key（同一份 JSON 重貼也一樣） */
  key: string;
  index: number;
  item: ImportItem;
  resolved: ResolvedLedger | ResolvedTrade;
  status: ImportRowStatus;
  messages: string[];
  selected: boolean;
}

export interface NormalizeContext {
  categories: Category[];
  accounts: Account[];
  /** 自訂支付方式（設定 → 支付方式）；信用卡等沒建帳戶的付款方式靠這份對 */
  paymentMethods?: PaymentMethod[];
  fxRates: FxRate[];
  positions: PortfolioPosition[];
  /** 沒指定帳戶時的預設（記帳） */
  defaultLedgerAccountId?: string | null;
  /** 沒指定帳戶時的預設（交割） */
  defaultTradeAccountId?: string | null;
}

function lower(s: string | undefined | null): string {
  return (s ?? '').trim().toLowerCase();
}

/** 類別：key 完全相同 → 名稱完全相同 → 名稱 / key 包含 → other */
export function resolveCategory(raw: string | undefined, type: 'expense' | 'income', categories: Category[]): { key: string; guessed: boolean } {
  const pool = categories.filter((c) => c.type === type && !c.archivedAt);
  const q = lower(raw);
  const fallbackKeys = type === 'income' ? ['other_income', 'other'] : ['other'];
  const fallback = pool.find((c) => fallbackKeys.includes(c.key))?.key ?? pool[0]?.key ?? fallbackKeys[0] ?? 'other';
  if (!q) return { key: fallback, guessed: true };
  const exactKey = pool.find((c) => lower(c.key) === q);
  if (exactKey) return { key: exactKey.key, guessed: false };
  const exactName = pool.find((c) => lower(c.name) === q);
  if (exactName) return { key: exactName.key, guessed: false };
  const partial = pool.find((c) => lower(c.name).includes(q) || q.includes(lower(c.name)) || lower(c.key).includes(q));
  if (partial) return { key: partial.key, guessed: false };
  return { key: fallback, guessed: true };
}

/** 帳戶：id → 名稱完全相同 → legacyPaymentMethod → 名稱包含 */
export function resolveAccount(raw: string | undefined, accounts: Account[], allowedTypes: readonly string[]): Account | null {
  const q = lower(raw);
  if (!q) return null;
  const pool = accounts.filter((a) => a.active !== false && !a.archivedAt && allowedTypes.includes(a.type));
  return pool.find((a) => a.id === raw)
    ?? pool.find((a) => lower(a.name) === q)
    ?? pool.find((a) => lower(a.legacyPaymentMethod) === q)
    ?? pool.find((a) => lower(a.name).includes(q) || q.includes(lower(a.name)))
    ?? null;
}

export interface PaymentResolution {
  accountId: string | null;
  paymentMethod: string;
  matched: boolean;
}

/** 支付方式名稱對應到的帳戶（與 PaymentSelect 的 matchAccountsByPM 同一規則；剛好一個才自動帶） */
export function accountForPaymentMethod(paymentMethod: string, accounts: Account[], allowedTypes: readonly string[]): Account | null {
  const hits = accounts.filter((a) => a.active !== false && !a.archivedAt && allowedTypes.includes(a.type)
    && ((a.legacyPaymentMethod ?? a.name) === paymentMethod || a.name === paymentMethod));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * 付款方式：帳戶（名稱 / legacyPaymentMethod）→ 自訂支付方式（名稱 / key / 末四碼 / 類型名稱）→ 預設名單 → 對不到。
 * 對到自訂支付方式時，若剛好有一個帳戶綁同名支付方式就一起帶上（扣餘額）。
 */
export function resolvePayment(
  raw: string | undefined,
  ctx: Pick<NormalizeContext, 'accounts' | 'paymentMethods'>,
  allowedTypes: readonly string[],
): PaymentResolution {
  const q = lower(raw);
  const account = resolveAccount(raw, ctx.accounts, allowedTypes);
  if (account) return { accountId: account.id, paymentMethod: account.legacyPaymentMethod ?? account.name, matched: true };
  if (!q) return { accountId: null, paymentMethod: '', matched: false };
  const pms = (ctx.paymentMethods ?? []).filter((p) => !p.archivedAt);
  const pm = pms.find((p) => lower(p.name) === q || lower(p.key) === q)
    ?? pms.find((p) => lower(p.name).includes(q) || q.includes(lower(p.name)))
    ?? pms.find((p) => Boolean(p.last4) && /\d{4}$/.test(q) && q.endsWith(p.last4 ?? '__'))
    // 「信用卡」「行動支付」這種只講類型的：只有一個該類型的支付方式才敢對
    ?? (() => {
      const type = (Object.keys(TYPE_LABEL) as PaymentMethod['type'][]).find((t) => lower(TYPE_LABEL[t]) === q);
      const sameType = type ? pms.filter((p) => p.type === type) : [];
      return sameType.length === 1 ? sameType[0] : undefined;
    })();
  if (pm) {
    return { accountId: accountForPaymentMethod(pm.name, ctx.accounts, allowedTypes)?.id ?? null, paymentMethod: pm.name, matched: true };
  }
  const preset = DEFAULT_PAYMENT_METHODS.find((p) => lower(p) === q);
  if (preset) return { accountId: null, paymentMethod: preset, matched: true };
  return { accountId: null, paymentMethod: raw?.trim() ?? '', matched: false };
}

export function fxRateFor(currency: string, fxRates: FxRate[]): number | null {
  if (currency === 'TWD') return 1;
  const r = fxRates.find((x) => x.base === currency && (x.quote === 'TWD' || !x.quote));
  return r && r.rate > 0 ? r.rate : null;
}

/** 去重用 key：來源 id 優先，否則用內容 hash（同一筆重貼不會重複匯入） */
export async function importRowKey(item: ImportItem): Promise<string> {
  const basis = item.id
    ? `ai:id:${item.kind}:${item.id}`
    : item.kind === 'trade'
      ? `ai:trade:${item.date}:${item.symbol}:${item.side}:${item.shares}:${item.price}`
      : `ai:${item.kind}:${item.date}:${item.amount}:${item.currency}:${item.category ?? ''}:${item.note ?? item.merchant ?? ''}`;
  return `ai_${(await sha256Hex(basis)).slice(0, 40)}`;
}

function resolveLedger(item: LedgerImportItem, ctx: NormalizeContext): { resolved: ResolvedLedger; messages: string[]; status: ImportRowStatus } {
  const messages: string[] = [];
  let status: ImportRowStatus = 'ready';
  const date = dateInputToTWDate(item.date);
  if (!date) { messages.push('日期無效'); status = 'error'; }
  const currency = item.currency || 'TWD';
  let fxRate = item.fxRate ?? fxRateFor(currency, ctx.fxRates);
  if (fxRate == null) {
    messages.push(`沒有 ${currency} 匯率，先用 1`);
    fxRate = 1;
    status = status === 'error' ? status : 'warn';
  }
  const cat = resolveCategory(item.category, item.kind, ctx.categories);
  if (cat.guessed) {
    messages.push(item.category ? `類別「${item.category}」對不到，先放「其他」` : '沒給類別，先放「其他」');
    if (status === 'ready') status = 'warn';
  }
  const accountRaw = item.account ?? item.paymentMethod;
  const payment = resolvePayment(accountRaw, ctx, LEDGER_ACCOUNT_TYPES);
  if (!payment.matched) {
    const fallback = ctx.defaultLedgerAccountId ? ctx.accounts.find((a) => a.id === ctx.defaultLedgerAccountId) ?? null : null;
    if (fallback) {
      payment.accountId = fallback.id;
      payment.paymentMethod = fallback.legacyPaymentMethod ?? fallback.name;
    } else if (!payment.paymentMethod) {
      payment.paymentMethod = '現金';
    }
    if (accountRaw) {
      messages.push(`付款方式「${accountRaw}」對不到帳戶或支付方式，請在預覽選一個`);
      if (status === 'ready') status = 'warn';
    }
  }
  const note = [item.note, item.merchant].filter(Boolean).join(' · ').slice(0, 200);
  return {
    status,
    messages,
    resolved: {
      kind: item.kind,
      date: date ?? new Date(),
      amount: item.amount,
      currency,
      fxRate,
      amountTWD: Math.round(item.amount * fxRate * 100) / 100,
      categoryKey: cat.key,
      categoryGuessed: cat.guessed,
      accountId: payment.accountId,
      paymentMethod: payment.paymentMethod,
      paymentMatched: payment.matched,
      note,
      tags: item.tags ?? [],
    },
  };
}

function resolveTrade(item: TradeImportItem, ctx: NormalizeContext): { resolved: ResolvedTrade; messages: string[]; status: ImportRowStatus } {
  const messages: string[] = [];
  let status: ImportRowStatus = 'ready';
  const date = dateInputToTWDate(item.date);
  if (!date) { messages.push('日期無效'); status = 'error'; }
  const normalized = normalizeStockSymbol(item.symbol);
  let symbol = item.symbol.trim().toUpperCase();
  let market: 'TW' | 'US' = item.market ?? 'US';
  if (normalized.ok) {
    symbol = normalized.symbol;
    market = item.market ?? normalized.market;
  } else {
    messages.push(normalized.reason);
    status = 'error';
  }
  const currency: 'TWD' | 'USD' = item.currency ?? (market === 'US' ? 'USD' : 'TWD');
  let fxRate = item.fxRate ?? fxRateFor(currency, ctx.fxRates);
  if (fxRate == null) {
    messages.push(`沒有 ${currency} 匯率，先用 1`);
    fxRate = 1;
    if (status === 'ready') status = 'warn';
  }
  const fee = (item.fee ?? 0) + (item.tax ?? 0);
  const account = resolveAccount(item.account, ctx.accounts, TRADE_ACCOUNT_TYPES)
    ?? (ctx.defaultTradeAccountId ? ctx.accounts.find((a) => a.id === ctx.defaultTradeAccountId) ?? null : null);
  if (!account) {
    messages.push(item.account ? `交割帳戶「${item.account}」對不到，請選一個` : '請選交割帳戶');
    if (status === 'ready') status = 'warn';
  }
  const position = ctx.positions.find((p) => p.symbol === symbol) ?? null;
  if (item.side === 'sell') {
    if (!position) { messages.push(`沒有 ${symbol} 的持倉可賣`); status = 'error'; }
    else if (item.shares > position.shares) { messages.push(`賣出 ${item.shares} 股超過持有 ${position.shares} 股`); status = 'error'; }
  }
  return {
    status,
    messages,
    resolved: {
      kind: 'trade',
      date: date ?? new Date(),
      market,
      symbol,
      side: item.side,
      shares: item.shares,
      price: item.price,
      currency,
      fee,
      fxRate,
      grossTWD: Math.round(item.shares * item.price * fxRate),
      accountId: account?.id ?? null,
      existingPositionId: position?.id ?? null,
      note: item.note ?? '',
    },
  };
}

export async function normalizeImport(items: ImportItem[], ctx: NormalizeContext): Promise<ImportRow[]> {
  const rows: ImportRow[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const key = await importRowKey(item);
    const r = item.kind === 'trade' ? resolveTrade(item, ctx) : resolveLedger(item, ctx);
    rows.push({ key, index, item, resolved: r.resolved, status: r.status, messages: r.messages, selected: r.status !== 'error' });
  }
  // 同一份 JSON 內重複的筆（LLM 偶爾會重複輸出）
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.key)) {
      row.status = 'error';
      row.selected = false;
      row.messages.push('與上面某一筆重複');
    }
    seen.add(row.key);
  }
  return rows;
}

/** 使用者在預覽表手動改類別 / 付款方式（支付方式 + 帳戶）後重算 */
export function patchRow(
  row: ImportRow,
  patch: Partial<{ categoryKey: string; accountId: string | null; paymentMethod: string }>,
  ctx: NormalizeContext,
): ImportRow {
  if (row.resolved.kind === 'trade') {
    const accountId = patch.accountId !== undefined ? patch.accountId : row.resolved.accountId;
    const messages = row.messages.filter((m) => !m.includes('交割帳戶'));
    const status: ImportRowStatus = row.messages.some((m) => !m.includes('交割帳戶') && !m.includes('匯率')) && row.status === 'error'
      ? 'error'
      : accountId ? (messages.length > 0 ? 'warn' : 'ready') : 'warn';
    if (!accountId) messages.push('請選交割帳戶');
    return { ...row, resolved: { ...row.resolved, accountId }, status, messages, selected: status !== 'error' && row.selected };
  }
  const categoryKey = patch.categoryKey ?? row.resolved.categoryKey;
  const accountId = patch.accountId !== undefined ? patch.accountId : row.resolved.accountId;
  const account = accountId ? ctx.accounts.find((a) => a.id === accountId) ?? null : null;
  const paymentTouched = patch.accountId !== undefined || patch.paymentMethod !== undefined;
  const paymentMethod = patch.paymentMethod ?? account?.legacyPaymentMethod ?? account?.name ?? row.resolved.paymentMethod;
  const messages = row.messages.filter((m) => !(patch.categoryKey !== undefined && m.includes('類別')) && !(paymentTouched && (m.includes('帳戶') || m.includes('付款方式'))));
  return {
    ...row,
    resolved: {
      ...row.resolved,
      categoryKey,
      categoryGuessed: patch.categoryKey !== undefined ? false : row.resolved.categoryGuessed,
      accountId,
      paymentMethod,
      paymentMatched: paymentTouched ? true : row.resolved.paymentMatched,
    },
    status: row.status === 'error' ? 'error' : messages.length > 0 ? 'warn' : 'ready',
    messages,
  };
}
