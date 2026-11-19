/**
 * Technical indicators — pure functions, no React.
 *
 * 所有函式吃 number[]（收盤/高/低/量）回 number[]（同長度），
 * 尚未夠數的位置填 NaN，方便 Recharts 自動斷線。
 */

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= period) sum -= values[i - period] ?? 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length === 0) return out;
  const k = 2 / (period + 1);
  // seed：前 period 個的 SMA
  let seed = 0;
  for (let i = 0; i < Math.min(period, values.length); i++) seed += values[i] ?? 0;
  if (values.length < period) return out;
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) {
    const prev = out[i - 1];
    const v = values[i] ?? 0;
    out[i] = v * k + (prev as number) * (1 - k);
  }
  return out;
}

export function rsi(values: number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = (values[i] ?? 0) - (values[i - 1] ?? 0);
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = (values[i] ?? 0) - (values[i - 1] ?? 0);
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  hist: number[];
}

export function macd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdLine = values.map((_, i) => {
    const f = fast[i];
    const s = slow[i];
    return Number.isFinite(f) && Number.isFinite(s) ? (f as number) - (s as number) : NaN;
  });

  // signal = EMA of macdLine，但要從第一個有效 macd 開始算
  const firstValid = macdLine.findIndex((v) => Number.isFinite(v));
  const signal = new Array<number>(values.length).fill(NaN);
  if (firstValid !== -1 && firstValid + signalPeriod <= values.length) {
    const slice = macdLine.slice(firstValid);
    const sig = ema(slice, signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i] ?? NaN;
  }
  const hist = macdLine.map((v, i) => {
    const s = signal[i];
    return Number.isFinite(v) && Number.isFinite(s) ? v - (s as number) : NaN;
  });
  return { macd: macdLine, signal, hist };
}

export interface BollingerResult {
  middle: number[];
  upper: number[];
  lower: number[];
}

export function bollingerBands(values: number[], period = 20, stdMul = 2): BollingerResult {
  const middle = sma(values, period);
  const upper = new Array<number>(values.length).fill(NaN);
  const lower = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sumSq = 0;
    const mean = middle[i] as number;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = (values[j] ?? 0) - mean;
      sumSq += diff * diff;
    }
    const sd = Math.sqrt(sumSq / period);
    upper[i] = mean + stdMul * sd;
    lower[i] = mean - stdMul * sd;
  }
  return { middle, upper, lower };
}

export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length === 0) return out;
  const tr: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const h = highs[i] ?? closes[i] ?? 0;
    const l = lows[i] ?? closes[i] ?? 0;
    const prev = i > 0 ? closes[i - 1] ?? 0 : h;
    tr.push(Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev)));
  }
  if (tr.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i] ?? 0;
  out[period - 1] = sum / period;
  for (let i = period; i < tr.length; i++) {
    out[i] = ((out[i - 1] as number) * (period - 1) + (tr[i] ?? 0)) / period;
  }
  return out;
}

export function obv(closes: number[], volumes: number[]): number[] {
  const out = new Array<number>(closes.length).fill(0);
  if (closes.length === 0) return out;
  out[0] = volumes[0] ?? 0;
  for (let i = 1; i < closes.length; i++) {
    const c = closes[i] ?? 0;
    const p = closes[i - 1] ?? 0;
    const v = volumes[i] ?? 0;
    const prev = out[i - 1] as number;
    if (c > p) out[i] = prev + v;
    else if (c < p) out[i] = prev - v;
    else out[i] = prev;
  }
  return out;
}

export interface StochasticResult {
  k: number[];
  d: number[];
}

export function stochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod = 14,
  dPeriod = 3,
): StochasticResult {
  const k = new Array<number>(closes.length).fill(NaN);
  for (let i = kPeriod - 1; i < closes.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hi = Math.max(hi, highs[j] ?? -Infinity);
      lo = Math.min(lo, lows[j] ?? Infinity);
    }
    const denom = hi - lo;
    k[i] = denom === 0 ? 100 : ((closes[i] ?? 0) - lo) / denom * 100;
  }
  const d = sma(k.map((v) => (Number.isFinite(v) ? v : 0)), dPeriod).map((v, i) =>
    Number.isFinite(k[i]) ? v : NaN,
  );
  return { k, d };
}
