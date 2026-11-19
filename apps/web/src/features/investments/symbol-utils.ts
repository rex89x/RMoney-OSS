import type { Market } from './types';

/** 股票報價幣別（Stock / PortfolioPosition 只有這兩種） */
export type StockCurrency = 'TWD' | 'USD';

/**
 * 台股代號規則（臺灣證券交易所編碼原則；Apps Script 端 Stocks.gs isTwSymbol_ / twSymbolInfo_ 必須同步）：
 * - 主體 4–6 位數字：個股 2330、ETF 0050 / 00878 / 006208、DR 910322
 * - 後面可接 1–2 碼英文字母，表示特殊身分 / 商品類型 / 交易幣別：
 *   ETF（00 開頭）：A 主動股票、D 主動債券、B 被動債券、L 槓桿、R 反向、T 平衡、U 期貨；
 *                   K / C / M / S / V = 外幣交易的 股票 / 債券 / 槓桿 / 反向 / 期貨
 *   4 位數個股：A–W 特別股、X–Z 可轉換公司債換股權利證書
 * - 名稱後綴 -KY（開曼註冊）、-DR（存託憑證）不是代號的一部分，輸入時順手拿掉
 * 美股代號一律英文字母開頭，所以「數字開頭 = 台股」不會撞到。
 */
export const TW_SYMBOL_RE = /^\d{4,6}[A-Z]{0,2}$/;
const US_SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

export function isTwSymbol(symbol: string): boolean {
  return TW_SYMBOL_RE.test(symbol);
}

export type TwSymbolKind = 'stock' | 'etf' | 'preferred' | 'convertible' | 'dr' | 'other';

export interface TwSymbolInfo {
  kind: TwSymbolKind;
  /** 給 UI 顯示的中文類型，例如「主動式股票型 ETF」 */
  label: string;
  /** 外幣交易（K / C / M / S / V 字尾的 ETF）報價不是台幣 */
  currency: StockCurrency;
  foreignCurrency: boolean;
}

const ETF_SUFFIX_LABEL: Record<string, string> = {
  A: '主動式股票型 ETF',
  D: '主動式債券型 ETF',
  B: '債券型 ETF',
  L: '槓桿型 ETF',
  R: '反向型 ETF',
  T: '平衡型 ETF',
  U: '期貨型 ETF',
  K: '外幣交易股票型 ETF',
  C: '外幣交易債券型 ETF',
  M: '外幣交易槓桿型 ETF',
  S: '外幣交易反向型 ETF',
  V: '外幣交易期貨型 ETF',
};
const FOREIGN_CURRENCY_SUFFIX = new Set(['K', 'C', 'M', 'S', 'V']);

/** 解析台股代號的類型與交易幣別；不是台股代號回 null */
export function describeTwSymbol(symbol: string): TwSymbolInfo | null {
  const m = /^(\d{4,6})([A-Z]{0,2})$/.exec(symbol);
  if (!m) return null;
  const digits = m[1] ?? '';
  const suffix = m[2] ?? '';
  const last = suffix.slice(-1);
  const twd = (kind: TwSymbolKind, label: string): TwSymbolInfo => ({ kind, label, currency: 'TWD', foreignCurrency: false });

  if (digits.startsWith('00')) {
    if (!suffix) return twd('etf', 'ETF');
    if (FOREIGN_CURRENCY_SUFFIX.has(last)) {
      // 外幣交易多為美元（少數人民幣）；先以 USD 計價，避免把外幣價格當台幣算市值
      return { kind: 'etf', label: ETF_SUFFIX_LABEL[last] ?? 'ETF', currency: 'USD', foreignCurrency: true };
    }
    return twd('etf', ETF_SUFFIX_LABEL[last] ?? 'ETF');
  }
  if (digits.length === 4) {
    if (!suffix) return twd('stock', '個股');
    if (last >= 'X') return twd('convertible', '可轉換公司債換股權利證書');
    return twd('preferred', '特別股');
  }
  if (digits.length === 6 && digits.startsWith('91') && !suffix) return twd('dr', '存託憑證（DR）');
  return twd('other', '台股其他證券');
}

export function inferMarket(symbol: string): Market {
  return /^\d/.test(symbol) ? 'TW' : 'US';
}

/** 依代號推交易幣別：台股看字尾（外幣交易 ETF → USD），其他台股 TWD，美股 USD */
export function inferCurrency(symbol: string): StockCurrency {
  if (inferMarket(symbol) === 'US') return 'USD';
  return describeTwSymbol(symbol)?.currency ?? 'TWD';
}

export type NormalizedSymbol =
  | { ok: true; symbol: string; market: Market; currency: StockCurrency; twInfo: TwSymbolInfo | null }
  | { ok: false; reason: string };

/**
 * Normalize user-entered stock symbols before they become Firestore ids.
 * This keeps portfolio/watchlist/stocks documents aligned with Apps Script.
 */
export function normalizeStockSymbol(raw: string): NormalizedSymbol {
  const symbol = raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\.(TW|TWO|US)$/, '')
    // 名稱後綴不是代號：1590-KY、910322-DR 這種貼法也接受
    .replace(/-(KY|DR)$/, '');
  if (!symbol) return { ok: false, reason: '請輸入股票代號' };
  if (/^\d/.test(symbol)) {
    if (!isTwSymbol(symbol)) {
      return { ok: false, reason: '台股代號為 4–6 位數字，可加 1–2 碼英文字尾（如 2330、00878、00981A、2881A）' };
    }
    const twInfo = describeTwSymbol(symbol);
    return { ok: true, symbol, market: 'TW', currency: twInfo?.currency ?? 'TWD', twInfo };
  }
  if (!US_SYMBOL_RE.test(symbol)) {
    return { ok: false, reason: '股票代號格式不正確' };
  }
  return { ok: true, symbol, market: 'US', currency: 'USD', twInfo: null };
}
