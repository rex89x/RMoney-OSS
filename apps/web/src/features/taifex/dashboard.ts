/**
 * 台指期虛擬交易的顯示用純函式（測試：apps/web/tests/taifex.test.cjs）。
 * 所有策略計算都在 Apps Script，前端只做摘要與排版。
 */
import { TAIFEX_PRODUCT_SPECS } from './options';
import { TAIFEX_RULES } from './types';
import type { TaifexAccount, TaifexEvent, TaifexSentiment, TaifexSignal, TaifexTrade } from './types';

export interface TaifexAccountSummary {
  pointValue: number;
  returnPct: number;
  drawdownPct: number;
  unrealizedPoints: number | null;
  unrealizedPnl: number | null;
  stopDistancePoints: number | null;
  /** 停損被打到時的預估損失（相對目前收盤，不含成本） */
  riskToStop: number | null;
  winRatePct: number | null;
  notional: number | null;
}

export function summarizeAccount(account: TaifexAccount): TaifexAccountSummary {
  const pointValue = TAIFEX_PRODUCT_SPECS[account.product].pointValue;
  const returnPct = account.initialCapital > 0 ? (account.equity / account.initialCapital - 1) * 100 : 0;
  const drawdownPct = account.peakEquity > 0 ? Math.max(0, (account.peakEquity - account.equity) / account.peakEquity * 100) : 0;
  const pos = account.position;
  const close = account.lastClose;
  let unrealizedPoints: number | null = null;
  let unrealizedPnl: number | null = null;
  let stopDistancePoints: number | null = null;
  let riskToStop: number | null = null;
  let notional: number | null = null;
  if (pos && close !== null) {
    const dir = pos.side === 'long' ? 1 : -1;
    unrealizedPoints = dir * (close - pos.entryPrice);
    unrealizedPnl = Math.round(unrealizedPoints * pos.contracts * pointValue);
    stopDistancePoints = dir * (close - pos.stop);
    riskToStop = Math.round(Math.max(0, stopDistancePoints) * pos.contracts * pointValue);
    notional = Math.round(close * pos.contracts * pointValue);
  }
  return {
    pointValue,
    returnPct,
    drawdownPct,
    unrealizedPoints,
    unrealizedPnl,
    stopDistancePoints,
    riskToStop,
    winRatePct: account.tradeCount > 0 ? account.winCount / account.tradeCount * 100 : null,
    notional,
  };
}

export interface TaifexTradeStats {
  count: number;
  winRatePct: number | null;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number | null;
  avgHoldingBars: number | null;
  totalNet: number;
  totalCosts: number;
}

export function tradeStats(trades: TaifexTrade[]): TaifexTradeStats {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const sum = (list: TaifexTrade[], pick: (t: TaifexTrade) => number) => list.reduce((s, t) => s + pick(t), 0);
  const grossWin = sum(wins, (t) => t.netPnl);
  const grossLoss = sum(losses, (t) => t.netPnl);
  return {
    count: trades.length,
    winRatePct: trades.length ? wins.length / trades.length * 100 : null,
    profitFactor: grossLoss < 0 ? grossWin / -grossLoss : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? grossLoss / losses.length : null,
    expectancy: trades.length ? (grossWin + grossLoss) / trades.length : null,
    avgHoldingBars: trades.length ? sum(trades, (t) => t.holdingBars) / trades.length : null,
    totalNet: grossWin + grossLoss,
    totalCosts: sum(trades, (t) => t.costs),
  };
}

export type CompositeZone = 'strong_long' | 'lean_long' | 'neutral' | 'lean_short' | 'strong_short' | 'unknown';

export const ZONE_LABELS: Record<CompositeZone, string> = {
  strong_long: '偏多（達進場門檻）',
  lean_long: '略偏多',
  neutral: '中性',
  lean_short: '略偏空',
  strong_short: '偏空（達進場門檻）',
  unknown: '資料不足',
};

export function compositeZone(composite: number | null): CompositeZone {
  if (composite === null || !Number.isFinite(composite)) return 'unknown';
  if (composite >= TAIFEX_RULES.entry) return 'strong_long';
  if (composite <= -TAIFEX_RULES.entry) return 'strong_short';
  if (composite > TAIFEX_RULES.exit) return 'lean_long';
  if (composite < -TAIFEX_RULES.exit) return 'lean_short';
  return 'neutral';
}

/** composite（-1..1）→ 量表百分比位置（0..100） */
export function gaugePercent(composite: number | null): number {
  if (composite === null || !Number.isFinite(composite)) return 50;
  return Math.max(0, Math.min(100, (composite + 1) * 50));
}

export interface TaifexChartPoint {
  date: string;
  close: number;
  ema20: number | null;
  ema60: number | null;
  stop: number | null;
  composite: number | null;
}

/** 訊號（任意順序）→ 依日期排序的走勢圖資料；最多 maxPoints 點（pitfall #13） */
export function signalChartData(signals: TaifexSignal[], maxPoints = 180): TaifexChartPoint[] {
  return [...signals]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-maxPoints)
    .map((s) => ({
      date: s.date,
      close: s.close,
      ema20: s.indicators.ema20,
      ema60: s.indicators.ema60,
      stop: s.position?.stop ?? null,
      composite: s.composite,
    }));
}

/** 今天（含）之後的事件，依日期排序 */
export function upcomingEvents(sentiment: TaifexSentiment | null, today: string, max = 6): TaifexEvent[] {
  if (!sentiment) return [];
  return sentiment.events
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || importanceRank(a.importance) - importanceRank(b.importance))
    .slice(0, max);
}

function importanceRank(level: TaifexEvent['importance']): number {
  return level === 'high' ? 0 : level === 'medium' ? 1 : 2;
}

/** 帳戶資料是否過期：最後一根 K 棒比「上一個平日」還舊（期交所假日不算，只做提示） */
export function isStale(lastBarDate: string | null, today: string): boolean {
  if (!lastBarDate) return true;
  const d = new Date(`${today}T00:00:00Z`);
  let back = 0;
  // 往回找 3 個平日：超過就視為過期（容忍連假）
  while (back < 3) {
    d.setUTCDate(d.getUTCDate() - 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) back += 1;
  }
  // d 是 UTC 午夜的純日期運算，不經時區轉換（避開 pitfall #21）
  const cutoff = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return lastBarDate < cutoff;
}

/** 權益曲線 → 圖表資料（含回撤%） */
export function equityChartData(account: TaifexAccount): Array<{ date: string; equity: number; drawdown: number }> {
  let peak = account.initialCapital;
  return account.equityCurve.map((p) => {
    peak = Math.max(peak, p.equity);
    return { date: p.date, equity: p.equity, drawdown: peak > 0 ? -((peak - p.equity) / peak) * 100 : 0 };
  });
}
