/**
 * 共同投資帳的純計算（不 import firebase，方便單元測試）。
 * 與 Apps Script `HouseholdInvest.gs` 的 hhSummarizeLots_ / hhValueHoldings_ 同一套規則，改一邊要改另一邊。
 */
import { normalizeStockSymbol } from '@/features/investments/symbol-utils';

export type JointMarket = 'TW' | 'US';
export type JointCurrency = 'TWD' | 'USD';
export type HoldingBucket = 'joint' | 'personal';
export type LotSide = 'buy' | 'sell';

export interface HoldingLot {
  side: LotSide;
  date: Date;
  shares: number;
  /** 原幣單價 */
  price: number;
  /** 原幣手續費 + 稅 */
  fee: number;
}

export interface HoldingLike {
  id: string;
  symbol: string;
  name: string;
  market: JointMarket;
  currency: JointCurrency;
  bucket: HoldingBucket;
  ownerUid: string | null;
  jointShares: Record<string, number> | null;
  lots: HoldingLot[];
}

export interface LotSummary {
  shares: number;
  /** 剩餘持股的原幣成本（含手續費） */
  costNative: number;
  avgCost: number;
  /** 已實現損益（原幣） */
  realizedNative: number;
}

/** 平均成本法：buy 累加成本；sell 以當下均價沖銷並計已實現損益。賣超過持股的部分忽略。 */
export function summarizeLots(lots: readonly HoldingLot[]): LotSummary {
  let shares = 0;
  let cost = 0;
  let realized = 0;
  const sorted = [...lots].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const lot of sorted) {
    const n = Number(lot.shares) || 0;
    const price = Number(lot.price) || 0;
    const fee = Number(lot.fee) || 0;
    if (n <= 0) continue;
    if (lot.side === 'sell') {
      const sellN = Math.min(n, shares);
      if (sellN <= 0) continue;
      const avg = shares > 0 ? cost / shares : 0;
      realized += sellN * price - fee - avg * sellN;
      cost -= avg * sellN;
      shares -= sellN;
    } else {
      cost += n * price + fee;
      shares += n;
    }
  }
  if (shares < 1e-9) {
    shares = 0;
    cost = 0;
  }
  return { shares, costNative: cost, avgCost: shares > 0 ? cost / shares : 0, realizedNative: realized };
}

/** 持股歸屬到每位成員的比例（加總 = 1）。personal → 持有人 100%；joint → jointShares，沒設用 splitRatio。 */
export function holdingAttribution(
  holding: Pick<HoldingLike, 'bucket' | 'ownerUid' | 'jointShares'>,
  memberIds: readonly string[],
  splitRatio: Record<string, number>,
): Record<string, number> {
  if (holding.bucket === 'personal') return holding.ownerUid ? { [holding.ownerUid]: 1 } : {};
  const raw = holding.jointShares ?? splitRatio;
  const total = memberIds.reduce((s, id) => s + Math.max(0, Number(raw[id]) || 0), 0);
  const out: Record<string, number> = {};
  for (const id of memberIds) {
    out[id] = total > 0 ? Math.max(0, Number(raw[id]) || 0) / total : 1 / (memberIds.length || 1);
  }
  return out;
}

export interface Quote {
  price: number;
  change: number;
  changePercent: number;
  updatedAt: Date | null;
}

export interface Agg {
  valueTWD: number;
  costTWD: number;
  unrealizedTWD: number;
  realizedTWD: number;
  dayChangeTWD: number;
}

export interface HoldingValuation<H extends HoldingLike = HoldingLike> extends Agg {
  holding: H;
  summary: LotSummary;
  quote: Quote | null;
  fxRate: number | null;
  /** 沒報價：市值暫以成本計 */
  priceMissing: boolean;
  /** bucket key：'joint' 或持有人 uid */
  bucketKey: string;
  attribution: Record<string, number>;
}

export interface PortfolioValuation<H extends HoldingLike = HoldingLike> extends Agg {
  holdings: HoldingValuation<H>[];
  byBucket: Record<string, Agg>;
  byMember: Record<string, Agg>;
  missing: string[];
}

export const EMPTY_AGG: Agg = { valueTWD: 0, costTWD: 0, unrealizedTWD: 0, realizedTWD: 0, dayChangeTWD: 0 };
const AGG_KEYS = Object.keys(EMPTY_AGG) as (keyof Agg)[];

function addAgg(target: Agg, src: Agg, weight = 1) {
  for (const k of AGG_KEYS) target[k] += src[k] * weight;
}

export function bucketKeyOf(h: Pick<HoldingLike, 'bucket' | 'ownerUid'>): string {
  return h.bucket === 'personal' ? (h.ownerUid ?? 'unknown') : 'joint';
}

export function valuePortfolio<H extends HoldingLike>(
  holdings: readonly H[],
  quotes: Record<string, Quote | null | undefined>,
  fxRates: Record<string, number | null | undefined>,
  memberIds: readonly string[],
  splitRatio: Record<string, number>,
): PortfolioValuation<H> {
  const out: PortfolioValuation<H> = {
    ...EMPTY_AGG, holdings: [], byBucket: {}, byMember: {}, missing: [],
  };
  for (const id of memberIds) out.byMember[id] = { ...EMPTY_AGG };
  for (const h of holdings) {
    const summary = summarizeLots(h.lots);
    const fxRate = h.currency === 'TWD' ? 1 : (fxRates[h.currency] ?? null);
    const quote = quotes[h.symbol] ?? null;
    const price = quote && quote.price > 0 ? quote.price : 0;
    const priceMissing = summary.shares > 0 && !price;
    const bucketKey = bucketKeyOf(h);
    const attribution = holdingAttribution(h, memberIds, splitRatio);
    if (fxRate == null) {
      out.missing.push(`${h.symbol}（缺 ${h.currency} 匯率）`);
      out.holdings.push({ holding: h, summary, quote, fxRate, priceMissing: true, bucketKey, attribution, ...EMPTY_AGG });
      continue;
    }
    if (priceMissing) out.missing.push(h.symbol);
    const valueNative = price ? summary.shares * price : summary.costNative;
    const agg: Agg = {
      valueTWD: valueNative * fxRate,
      costTWD: summary.costNative * fxRate,
      unrealizedTWD: (valueNative - summary.costNative) * fxRate,
      realizedTWD: summary.realizedNative * fxRate,
      dayChangeTWD: price && quote ? quote.change * summary.shares * fxRate : 0,
    };
    addAgg(out, agg);
    out.byBucket[bucketKey] ??= { ...EMPTY_AGG };
    addAgg(out.byBucket[bucketKey], agg);
    for (const [uid, w] of Object.entries(attribution)) {
      out.byMember[uid] ??= { ...EMPTY_AGG };
      addAgg(out.byMember[uid], agg, w);
    }
    out.holdings.push({ holding: h, summary, quote, fxRate, priceMissing, bucketKey, attribution, ...agg });
  }
  out.holdings.sort((a, b) => b.valueTWD - a.valueTWD);
  return out;
}

export function pnlPct(a: Pick<Agg, 'unrealizedTWD' | 'costTWD'>): number | null {
  return a.costTWD > 0 ? (a.unrealizedTWD / a.costTWD) * 100 : null;
}

export interface ProjectionPoint {
  /** 距今第幾個月 */
  month: number;
  projectedTWD: number;
  contributedTWD: number;
}

/**
 * 月複利試算：每月初投入 monthly，年化 annualPct 換成月利率。
 * 回傳 0..months 共 months+1 個點（第 0 點 = 現值）。
 */
export function projectGrowth(currentTWD: number, monthlyTWD: number, annualPct: number, months: number): ProjectionPoint[] {
  const r = Math.pow(1 + annualPct / 100, 1 / 12) - 1;
  const points: ProjectionPoint[] = [{ month: 0, projectedTWD: currentTWD, contributedTWD: currentTWD }];
  let value = currentTWD;
  let contributed = currentTWD;
  const n = Math.max(0, Math.min(600, Math.round(months)));
  for (let m = 1; m <= n; m += 1) {
    value = (value + monthlyTWD) * (1 + r);
    contributed += monthlyTWD;
    points.push({ month: m, projectedTWD: value, contributedTWD: contributed });
  }
  return points;
}

/** 要在 months 個月後達到 target，每月需要投入多少（同一套月複利假設） */
export function requiredMonthly(currentTWD: number, targetTWD: number, annualPct: number, months: number): number {
  if (months <= 0) return Math.max(0, targetTWD - currentTWD);
  const r = Math.pow(1 + annualPct / 100, 1 / 12) - 1;
  const fvCurrent = currentTWD * Math.pow(1 + r, months);
  const gap = targetTWD - fvCurrent;
  if (gap <= 0) return 0;
  if (r === 0) return gap / months;
  // 每月初投入的年金終值係數
  const factor = ((Math.pow(1 + r, months) - 1) / r) * (1 + r);
  return gap / factor;
}

/** 照目前月投入，第幾個月會達標（600 個月內達不到回 null） */
export function monthsToTarget(currentTWD: number, monthlyTWD: number, annualPct: number, targetTWD: number): number | null {
  if (currentTWD >= targetTWD) return 0;
  const points = projectGrowth(currentTWD, monthlyTWD, annualPct, 600);
  const hit = points.find((p) => p.projectedTWD >= targetTWD);
  return hit ? hit.month : null;
}

/**
 * 使用者輸入的代號 → 標準化。規則與個人投資共用（features/investments/symbol-utils.ts）：
 * 台股 4–6 碼數字加 0–2 碼英文字尾（0050、00878、00981A、2881A）；外幣交易 ETF（K / C / M / S / V 字尾）以 USD 計價。
 */
export function normalizeJointSymbol(raw: string):
  | { ok: true; symbol: string; market: JointMarket; currency: JointCurrency }
  | { ok: false; reason: string } {
  const n = normalizeStockSymbol(raw);
  if (!n.ok) return n;
  return { ok: true, symbol: n.symbol, market: n.market, currency: n.currency === 'USD' ? 'USD' : 'TWD' };
}
