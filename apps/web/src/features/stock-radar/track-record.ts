/**
 * 成績單：把每天的建議（stock_radar_runs）和事後報酬（stock_radar_outcomes）對起來，
 * 算命中率、IC、各動作的平均超額報酬。純函式，由 apps/web/tests/stock-radar.test.cjs 測試。
 *
 * 超額報酬 = 個股從建議隔天開盤進場的 N 日報酬 − 大盤（0050 / SPY）同期報酬。
 */
import type { StockRadarAction, StockRadarMarket, StockRadarOutcome, StockRadarRun } from './types';

export type Horizon = 1 | 5 | 20;
export const HORIZONS: Horizon[] = [1, 5, 20];

export interface TrackRecordRow {
  runDate: string;
  market: StockRadarMarket;
  modelVersion: string;
  symbol: string;
  action: StockRadarAction;
  composite: number;
  quantScore: number;
  hasSentiment: boolean;
  excess: Record<Horizon, number | null>;
}

const BULLISH: StockRadarAction[] = ['add', 'buy'];
const BEARISH: StockRadarAction[] = ['trim', 'exit', 'avoid'];

export function actionDirection(action: StockRadarAction): 'bullish' | 'bearish' | 'neutral' {
  if (BULLISH.includes(action)) return 'bullish';
  if (BEARISH.includes(action)) return 'bearish';
  return 'neutral';
}

function excessOf(stock: number | null | undefined, bench: number | null | undefined): number | null {
  return typeof stock === 'number' && typeof bench === 'number' ? stock - bench : null;
}

export function joinTrackRecord(runs: StockRadarRun[], outcomes: StockRadarOutcome[]): TrackRecordRow[] {
  const runById = new Map(runs.map((run) => [`${run.runDate}_${run.market}`, run]));
  return outcomes.flatMap((outcome) => {
    const run = runById.get(`${outcome.runDate}_${outcome.market}`);
    if (!run) return [];
    return run.items.flatMap((item) => {
      const fwd = outcome.returns[item.symbol];
      if (!fwd || item.composite === null || item.action === 'insufficient') return [];
      return [{
        runDate: run.runDate,
        market: run.market,
        modelVersion: outcome.modelVersion || run.modelVersion,
        symbol: item.symbol,
        action: item.action,
        composite: item.composite,
        quantScore: item.quantScore ?? item.composite,
        hasSentiment: item.sentiment !== null && item.sentimentAdj !== 0,
        excess: {
          1: excessOf(fwd.fwd1, outcome.benchmark.fwd1),
          5: excessOf(fwd.fwd5, outcome.benchmark.fwd5),
          20: excessOf(fwd.fwd20, outcome.benchmark.fwd20),
        },
      }];
    });
  });
}

/** Spearman 等級相關（同分取平均名次）；與 apps-script srSpearman_ 同邏輯 */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const ranks = (values: number[]) => {
    const idx = values.map((_, i) => i).sort((a, b) => (values[a] ?? 0) - (values[b] ?? 0));
    const r = new Array<number>(n).fill(0);
    let k = 0;
    while (k < n) {
      let j = k;
      while (j + 1 < n && values[idx[j + 1] ?? 0] === values[idx[k] ?? 0]) j++;
      const avg = (k + j) / 2;
      for (let m = k; m <= j; m++) r[idx[m] ?? 0] = avg;
      k = j + 1;
    }
    return r;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = (rx[i] ?? 0) - mx;
    const b = (ry[i] ?? 0) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

export interface ActionStat {
  action: StockRadarAction;
  n: number;
  avgExcess: number | null;
  /** 看多動作：超額 > 0 的比例；看空動作：超額 < 0 的比例；中性動作為 null */
  hitRate: number | null;
}

export interface IcPoint {
  date: string;
  ic: number;
  quantIc: number | null;
  n: number;
}

export interface TrackRecordSummary {
  horizon: Horizon;
  samples: number;
  directionalSamples: number;
  hitRate: number | null;
  meanIC: number | null;
  meanQuantIC: number | null;
  icTStat: number | null;
  actions: ActionStat[];
  icSeries: IcPoint[];
  /** 有輿情的樣本：合成後 vs 純量化的平均 IC（看輿情有沒有幫到） */
  sentimentLift: { periods: number; withSentiment: number | null; quantOnly: number | null };
}

const ACTION_ORDER: StockRadarAction[] = ['add', 'buy', 'hold', 'watch', 'trim', 'exit', 'avoid'];

function mean(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

export function summarizeTrackRecord(rows: TrackRecordRow[], horizon: Horizon): TrackRecordSummary {
  const valid = rows.filter((row) => row.excess[horizon] !== null);
  const ex = (row: TrackRecordRow) => row.excess[horizon] ?? 0;

  const actions = ACTION_ORDER.flatMap((action) => {
    const group = valid.filter((row) => row.action === action);
    if (!group.length) return [];
    const direction = actionDirection(action);
    const hits = direction === 'bullish'
      ? group.filter((row) => ex(row) > 0).length
      : direction === 'bearish' ? group.filter((row) => ex(row) < 0).length : null;
    return [{
      action,
      n: group.length,
      avgExcess: mean(group.map(ex)),
      hitRate: hits === null ? null : hits / group.length,
    }];
  });

  const directional = valid.filter((row) => actionDirection(row.action) !== 'neutral');
  const directionalHits = directional.filter((row) => (actionDirection(row.action) === 'bullish' ? ex(row) > 0 : ex(row) < 0)).length;

  const byRun = new Map<string, TrackRecordRow[]>();
  valid.forEach((row) => {
    const key = `${row.runDate}_${row.market}`;
    byRun.set(key, [...(byRun.get(key) ?? []), row]);
  });
  const icSeries: IcPoint[] = [];
  const lift: Array<{ withSentiment: number; quantOnly: number }> = [];
  byRun.forEach((group) => {
    const ys = group.map(ex);
    const ic = spearman(group.map((row) => row.composite), ys);
    if (ic === null) return;
    const quantIc = spearman(group.map((row) => row.quantScore), ys);
    icSeries.push({ date: group[0]?.runDate ?? '', ic, quantIc, n: group.length });
    if (quantIc !== null && group.some((row) => row.hasSentiment)) lift.push({ withSentiment: ic, quantOnly: quantIc });
  });
  icSeries.sort((a, b) => a.date.localeCompare(b.date));
  const ics = icSeries.map((p) => p.ic);
  const meanIC = mean(ics);
  const sd = ics.length > 1 && meanIC !== null
    ? Math.sqrt(ics.reduce((s, v) => s + (v - meanIC) ** 2, 0) / (ics.length - 1))
    : 0;

  return {
    horizon,
    samples: valid.length,
    directionalSamples: directional.length,
    hitRate: directional.length ? directionalHits / directional.length : null,
    meanIC,
    meanQuantIC: mean(icSeries.flatMap((p) => (p.quantIc === null ? [] : [p.quantIc]))),
    icTStat: sd && meanIC !== null ? meanIC / (sd / Math.sqrt(ics.length)) : null,
    actions,
    icSeries,
    sentimentLift: {
      periods: lift.length,
      withSentiment: mean(lift.map((p) => p.withSentiment)),
      quantOnly: mean(lift.map((p) => p.quantOnly)),
    },
  };
}
