/**
 * 虛擬帳戶績效評估（純函式，測試 apps/web/tests/taifex.test.cjs）。
 * 只用帳戶的每日權益曲線與交易紀錄計算，GAS 不必多存一份。
 */
import { tradeStats, type TaifexTradeStats } from './dashboard';
import type { TaifexAccount, TaifexBacktestMetrics, TaifexTrade, TaifexVariantKey } from './types';

/** 至少要這麼多樣本，績效數字才有統計意義 */
export const PERF_MIN_DAYS = 60;
export const PERF_MIN_TRADES = 10;

export interface TaifexPerfMetrics {
  days: number;
  totalReturnPct: number;
  cagrPct: number | null;
  volatilityPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number;
  calmar: number | null;
  /** 同期間大盤（近月連續收盤，不含槓桿） */
  benchmarkReturnPct: number | null;
  excessReturnPct: number | null;
  exposurePct: number;
}

export interface TaifexMonthlyReturn {
  month: string;
  returnPct: number;
}

export type TaifexVerdictLevel = 'insufficient' | 'good' | 'ok' | 'poor';

export interface TaifexVerdict {
  level: TaifexVerdictLevel;
  headline: string;
  reasons: string[];
}

export interface TaifexPerfReport {
  metrics: TaifexPerfMetrics;
  trades: TaifexTradeStats;
  monthly: TaifexMonthlyReturn[];
  verdict: TaifexVerdict;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}

export function perfMetrics(account: TaifexAccount): TaifexPerfMetrics {
  const curve = account.equityCurve;
  const initial = account.initialCapital;
  const equities = curve.map((p) => p.equity);
  const rets: number[] = [];
  for (let i = 1; i < equities.length; i++) {
    const prev = equities[i - 1] ?? 0;
    const cur = equities[i] ?? 0;
    if (prev > 0) rets.push(cur / prev - 1);
  }
  let peak = initial;
  let maxDd = 0;
  equities.forEach((e) => {
    peak = Math.max(peak, e);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e) / peak);
  });
  const last = equities[equities.length - 1] ?? account.equity;
  const days = Math.max(0, curve.length - 1);
  const totalReturnPct = initial > 0 ? (last / initial - 1) * 100 : 0;
  const years = days / 252;
  // 少於 20 個交易日年化會被放大到沒有意義，不顯示
  const cagrPct = days >= 20 && last > 0 ? ((last / initial) ** (1 / years) - 1) * 100 : null;
  const sd = stdev(rets);
  const downside = Math.sqrt(mean(rets.map((r) => Math.min(0, r) ** 2)));
  const firstClose = curve[0]?.close ?? null;
  const lastClose = curve[curve.length - 1]?.close ?? null;
  const benchmarkReturnPct = firstClose && lastClose && days > 0 ? (lastClose / firstClose - 1) * 100 : null;
  return {
    days,
    totalReturnPct,
    cagrPct,
    volatilityPct: rets.length >= 5 ? sd * Math.sqrt(252) * 100 : null,
    sharpe: rets.length >= 5 && sd > 0 ? (mean(rets) / sd) * Math.sqrt(252) : null,
    sortino: rets.length >= 5 && downside > 0 ? (mean(rets) / downside) * Math.sqrt(252) : null,
    maxDrawdownPct: maxDd * 100,
    calmar: cagrPct !== null && maxDd > 0 ? cagrPct / (maxDd * 100) : null,
    benchmarkReturnPct,
    excessReturnPct: benchmarkReturnPct === null ? null : totalReturnPct - benchmarkReturnPct,
    exposurePct: curve.length ? (curve.filter((p) => p.position !== 0).length / curve.length) * 100 : 0,
  };
}

/** 每月報酬：以每月最後一天的權益相對上個月最後一天（第一個月相對起始資金） */
export function monthlyReturns(account: TaifexAccount): TaifexMonthlyReturn[] {
  const lastByMonth = new Map<string, number>();
  account.equityCurve.forEach((p) => lastByMonth.set(p.date.slice(0, 7), p.equity));
  let prev = account.initialCapital;
  return [...lastByMonth.entries()].map(([month, equity]) => {
    const returnPct = prev > 0 ? (equity / prev - 1) * 100 : 0;
    prev = equity;
    return { month, returnPct };
  });
}

/**
 * 白話結論。樣本不足時直接說「還不能下結論」，避免看幾天的數字就調策略。
 * backtest：回測的完整策略績效，用來檢查實際模擬有沒有偏離預期太多。
 */
export function perfVerdict(
  metrics: TaifexPerfMetrics,
  trades: TaifexTradeStats,
  maxDrawdownLimit: number,
  backtest: TaifexBacktestMetrics | null,
): TaifexVerdict {
  const reasons: string[] = [];
  if (metrics.days < PERF_MIN_DAYS && trades.count < PERF_MIN_TRADES) {
    reasons.push(`目前 ${metrics.days} 個交易日、${trades.count} 筆已平倉交易；至少要 ${PERF_MIN_DAYS} 天或 ${PERF_MIN_TRADES} 筆才有統計意義`);
    if (backtest?.sharpe !== null && backtest?.sharpe !== undefined) {
      reasons.push(`在那之前先參考回測：Sharpe ${backtest.sharpe.toFixed(2)}、最大回撤 ${backtest.maxDrawdownPct ?? '—'}%`);
    }
    return { level: 'insufficient', headline: '樣本還太少，先不要下結論', reasons };
  }

  let score = 0;
  if (metrics.sharpe !== null) {
    if (metrics.sharpe >= 1) { score += 2; reasons.push(`Sharpe ${metrics.sharpe.toFixed(2)} ≥ 1，風險調整後報酬良好`); }
    else if (metrics.sharpe >= 0.5) { score += 1; reasons.push(`Sharpe ${metrics.sharpe.toFixed(2)}，尚可`); }
    else if (metrics.sharpe < 0) { score -= 2; reasons.push(`Sharpe ${metrics.sharpe.toFixed(2)} < 0，承擔風險卻沒有報酬`); }
    else reasons.push(`Sharpe ${metrics.sharpe.toFixed(2)} 偏低`);
  }
  if (metrics.maxDrawdownPct > maxDrawdownLimit) { score -= 2; reasons.push(`最大回撤 ${metrics.maxDrawdownPct.toFixed(1)}% 超過上限 ${maxDrawdownLimit}%`); }
  else if (metrics.maxDrawdownPct <= maxDrawdownLimit * 0.5) { score += 1; reasons.push(`最大回撤 ${metrics.maxDrawdownPct.toFixed(1)}%，控制在上限一半以內`); }
  if (trades.profitFactor !== null) {
    if (trades.profitFactor >= 1.3) { score += 1; reasons.push(`獲利因子 ${trades.profitFactor.toFixed(2)}，賺的明顯比賠的多`); }
    else if (trades.profitFactor < 1) { score -= 1; reasons.push(`獲利因子 ${trades.profitFactor.toFixed(2)} < 1，扣成本後虧損`); }
  }
  if (metrics.excessReturnPct !== null) {
    reasons.push(metrics.excessReturnPct >= 0
      ? `勝過同期大盤 ${metrics.excessReturnPct.toFixed(1)} 個百分點`
      : `落後同期大盤 ${Math.abs(metrics.excessReturnPct).toFixed(1)} 個百分點（但曝險只有 ${metrics.exposurePct.toFixed(0)}%）`);
  }
  if (backtest?.sharpe !== null && backtest?.sharpe !== undefined && metrics.sharpe !== null && backtest.sharpe - metrics.sharpe > 1) {
    score -= 1;
    reasons.push(`實際 Sharpe 比回測（${backtest.sharpe.toFixed(2)}）低很多，留意市場是否進入策略不擅長的盤整期`);
  }
  if (score >= 3) return { level: 'good', headline: '表現良好，可以繼續累積紀錄', reasons };
  if (score >= 0) return { level: 'ok', headline: '表現普通，繼續觀察', reasons };
  return { level: 'poor', headline: '表現不佳，先檢討再考慮調整', reasons };
}

export function perfReport(
  account: TaifexAccount,
  trades: TaifexTrade[],
  maxDrawdownLimit: number,
  backtest: TaifexBacktestMetrics | null,
): TaifexPerfReport {
  const metrics = perfMetrics(account);
  const own = trades.filter((t) => t.accountId === account.id && t.epoch === account.epoch);
  const stats = tradeStats(own);
  return { metrics, trades: stats, monthly: monthlyReturns(account), verdict: perfVerdict(metrics, stats, maxDrawdownLimit, backtest) };
}

export interface TaifexLeaderboardRow {
  id: string;
  variant: TaifexVariantKey;
  isMain: boolean;
  metrics: TaifexPerfMetrics;
  trades: TaifexTradeStats;
  /** 回撤超過上限 → 不列入報酬排名第一的候選 */
  withinDrawdown: boolean;
}

/** 策略競賽排行：以總報酬排序（使用者目標是報酬最大化），回撤超標的往後放 */
export function leaderboard(accounts: TaifexAccount[], trades: TaifexTrade[], maxDrawdownLimit: number): TaifexLeaderboardRow[] {
  return accounts
    .map((a) => {
      const metrics = perfMetrics(a);
      return {
        id: a.id,
        variant: a.variant,
        isMain: a.id === 'default',
        metrics,
        trades: tradeStats(trades.filter((t) => t.accountId === a.id && t.epoch === a.epoch)),
        withinDrawdown: metrics.maxDrawdownPct <= maxDrawdownLimit,
      };
    })
    .sort((x, y) => Number(y.withinDrawdown) - Number(x.withinDrawdown) || y.metrics.totalReturnPct - x.metrics.totalReturnPct);
}
