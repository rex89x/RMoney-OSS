import type { DocumentData, FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

export type StockRadarMarket = 'TW' | 'US';

/** 與 apps-script/src/StockRadarFactors.gs 的 STOCK_RADAR_FACTOR_WEIGHTS key 一致 */
export type StockRadarFactorKey = 'tsmom' | 'relMom' | 'high52' | 'trend' | 'reversal' | 'lowVol' | 'instFlow' | 'marginChange';

export const STOCK_RADAR_FACTOR_KEYS: StockRadarFactorKey[] = [
  'tsmom', 'relMom', 'high52', 'trend', 'reversal', 'lowVol', 'instFlow', 'marginChange',
];

/** 只有台股有資料的籌碼因子 */
export const TW_ONLY_FACTOR_KEYS: StockRadarFactorKey[] = ['instFlow', 'marginChange'];

export type StockRadarEventType =
  | 'earnings' | 'ex_dividend' | 'offering' | 'legal' | 'downgrade' | 'upgrade' | 'guidance' | 'macro' | 'other';

export interface StockRadarSource {
  title: string;
  url: string;
}

export interface StockRadarRiskEvent {
  type: StockRadarEventType;
  date: string | null;
  note: string;
}

/** Claude 排程推送、Apps Script 驗證後的個股輿情 */
export interface StockRadarSentiment {
  score: number;
  confidence: number;
  summary: string;
  catalysts: string[];
  riskEvents: StockRadarRiskEvent[];
  earningsSurprise: 'beat' | 'miss' | 'inline' | null;
  sources: StockRadarSource[];
}

export interface StockRadarMarketView {
  sentiment: number;
  confidence: number;
  summary: string;
  events: string[];
  sources: StockRadarSource[];
}

/** 持有：add / hold / trim / exit；未持有：buy / watch / avoid */
export type StockRadarAction = 'add' | 'hold' | 'trim' | 'exit' | 'buy' | 'watch' | 'avoid' | 'insufficient';

export type StockRadarRegime = 'risk_on' | 'neutral' | 'risk_off' | 'unknown';

export interface StockRadarFactor {
  /** 原始值（報酬、比例、波動率），缺資料為 null */
  raw: number | null;
  /** [-1, 1]，缺資料為 null */
  score: number | null;
}

export interface StockRadarMetrics {
  historyDays: number;
  mom12_1: number | null;
  ret21: number | null;
  vol60: number | null;
  ma200: number | null;
  high52: number | null;
  atr14: number | null;
  chandelierStop: number | null;
}

export interface StockRadarItem {
  symbol: string;
  name: string;
  held: boolean;
  inWatchlist: boolean;
  shares: number;
  avgCost: number | null;
  currency: string;
  marketValueTWD: number | null;
  weightPct: number | null;
  unrealizedPct: number | null;
  close: number | null;
  priceDate: string | null;
  /** 只有量化因子的分數 */
  quantScore: number | null;
  /** 輿情加減分（無輿情為 0） */
  sentimentAdj: number;
  /** 量化 + 輿情 */
  composite: number | null;
  coverage: number;
  eventRisk: boolean;
  sentiment: StockRadarSentiment | null;
  action: StockRadarAction;
  reasons: string[];
  factors: Partial<Record<StockRadarFactorKey, StockRadarFactor>>;
  metrics: StockRadarMetrics | null;
}

export interface StockRadarRun {
  id: string;
  runDate: string;
  market: StockRadarMarket;
  modelVersion: string;
  generatedAt: Date | null;
  status: 'ok' | 'partial' | 'empty';
  regime: StockRadarRegime;
  /** 市場輿情修正後實際採用的 regime */
  effectiveRegime: StockRadarRegime;
  marketView: StockRadarMarketView | null;
  sentimentAt: Date | null;
  sentimentCount: number;
  flowDays: number;
  benchmark: {
    symbol: string;
    close: number | null;
    priceDate: string | null;
    ma200: number | null;
    mom12_1: number | null;
  };
  universeSize: number;
  items: StockRadarItem[];
  errors: string[];
}

const EVENT_TYPES: StockRadarEventType[] = [
  'earnings', 'ex_dividend', 'offering', 'legal', 'downgrade', 'upgrade', 'guidance', 'macro', 'other',
];

const ACTIONS: StockRadarAction[] = ['add', 'hold', 'trim', 'exit', 'buy', 'watch', 'avoid', 'insufficient'];
const REGIMES: StockRadarRegime[] = ['risk_on', 'neutral', 'risk_off', 'unknown'];

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function parseSources(value: unknown): StockRadarSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = record(item);
    const url = str(raw.url);
    // 只顯示 https 連結（後端已驗證，前端再擋一次避免 javascript: 之類的 href）
    return /^https:\/\//i.test(url) ? [{ title: str(raw.title, url), url }] : [];
  });
}

function parseSentiment(value: unknown): StockRadarSentiment | null {
  const raw = record(value);
  if (num(raw.score) === null) return null;
  const surprise = raw.earningsSurprise;
  return {
    score: num(raw.score) ?? 0,
    confidence: num(raw.confidence) ?? 0,
    summary: str(raw.summary),
    catalysts: strings(raw.catalysts),
    riskEvents: Array.isArray(raw.riskEvents)
      ? raw.riskEvents.flatMap((ev: unknown) => {
        const e = record(ev);
        return EVENT_TYPES.includes(e.type as StockRadarEventType)
          ? [{ type: e.type as StockRadarEventType, date: typeof e.date === 'string' ? e.date : null, note: str(e.note) }]
          : [];
      })
      : [],
    earningsSurprise: surprise === 'beat' || surprise === 'miss' || surprise === 'inline' ? surprise : null,
    sources: parseSources(raw.sources),
  };
}

function parseMarketView(value: unknown): StockRadarMarketView | null {
  const raw = record(value);
  if (num(raw.sentiment) === null) return null;
  return {
    sentiment: num(raw.sentiment) ?? 0,
    confidence: num(raw.confidence) ?? 0,
    summary: str(raw.summary),
    events: strings(raw.events),
    sources: parseSources(raw.sources),
  };
}

function parseFactors(value: unknown): StockRadarItem['factors'] {
  const raw = record(value);
  const out: StockRadarItem['factors'] = {};
  STOCK_RADAR_FACTOR_KEYS.forEach((key) => {
    const factor = record(raw[key]);
    if (Object.keys(factor).length > 0) out[key] = { raw: num(factor.raw), score: num(factor.score) };
  });
  return out;
}

function parseMetrics(value: unknown): StockRadarMetrics | null {
  const raw = record(value);
  if (Object.keys(raw).length === 0) return null;
  return {
    historyDays: num(raw.historyDays) ?? 0,
    mom12_1: num(raw.mom12_1),
    ret21: num(raw.ret21),
    vol60: num(raw.vol60),
    ma200: num(raw.ma200),
    high52: num(raw.high52),
    atr14: num(raw.atr14),
    chandelierStop: num(raw.chandelierStop),
  };
}

export function parseStockRadarItem(value: unknown): StockRadarItem | null {
  const raw = record(value);
  const symbol = str(raw.symbol);
  if (!symbol) return null;
  const action = ACTIONS.includes(raw.action as StockRadarAction) ? raw.action as StockRadarAction : 'insufficient';
  return {
    symbol,
    name: str(raw.name, symbol),
    held: raw.held === true,
    inWatchlist: raw.inWatchlist === true,
    shares: num(raw.shares) ?? 0,
    avgCost: num(raw.avgCost),
    currency: str(raw.currency, 'TWD'),
    marketValueTWD: num(raw.marketValueTWD),
    weightPct: num(raw.weightPct),
    unrealizedPct: num(raw.unrealizedPct),
    close: num(raw.close),
    priceDate: typeof raw.priceDate === 'string' ? raw.priceDate : null,
    quantScore: num(raw.quantScore) ?? num(raw.composite),
    sentimentAdj: num(raw.sentimentAdj) ?? 0,
    composite: num(raw.composite),
    coverage: num(raw.coverage) ?? 0,
    eventRisk: raw.eventRisk === true,
    sentiment: parseSentiment(raw.sentiment),
    action,
    reasons: strings(raw.reasons),
    factors: parseFactors(raw.factors),
    metrics: parseMetrics(raw.metrics),
  };
}

export function parseStockRadarRun(id: string, d: DocumentData): StockRadarRun {
  const benchmark = record(d.benchmark);
  const market: StockRadarMarket = d.market === 'US' ? 'US' : 'TW';
  const regime = REGIMES.includes(d.regime as StockRadarRegime) ? d.regime as StockRadarRegime : 'unknown';
  return {
    id,
    runDate: str(d.runDate, id.slice(0, 10)),
    market,
    modelVersion: str(d.modelVersion),
    generatedAt: tsToDate(d.generatedAt),
    status: d.status === 'partial' || d.status === 'empty' ? d.status : 'ok',
    regime,
    effectiveRegime: REGIMES.includes(d.effectiveRegime as StockRadarRegime) ? d.effectiveRegime as StockRadarRegime : regime,
    marketView: parseMarketView(d.marketView),
    sentimentAt: tsToDate(d.sentimentAt),
    sentimentCount: num(d.sentimentCount) ?? 0,
    flowDays: num(d.flowDays) ?? 0,
    benchmark: {
      symbol: str(benchmark.symbol, market === 'TW' ? '0050' : 'SPY'),
      close: num(benchmark.close),
      priceDate: typeof benchmark.priceDate === 'string' ? benchmark.priceDate : null,
      ma200: num(benchmark.ma200),
      mom12_1: num(benchmark.mom12_1),
    },
    universeSize: num(d.universeSize) ?? 0,
    items: Array.isArray(d.items)
      ? d.items.flatMap((item: unknown) => {
        const parsed = parseStockRadarItem(item);
        return parsed ? [parsed] : [];
      })
      : [],
    errors: strings(d.errors),
  };
}

/** 唯讀：stock_radar_runs 只由 Apps Script 寫入（Rules write: false） */
export const stockRadarRunConverter: FirestoreDataConverter<StockRadarRun> = {
  toFirestore: () => {
    throw new Error('stock_radar_runs is read-only on the client');
  },
  fromFirestore: (snap: QueryDocumentSnapshot) => parseStockRadarRun(snap.id, snap.data()),
};

// -------- 成績單：事後報酬 --------

export interface StockRadarForward {
  entryDate: string | null;
  fwd1: number | null;
  fwd5: number | null;
  fwd20: number | null;
}

export interface StockRadarOutcome {
  id: string;
  runDate: string;
  market: StockRadarMarket;
  modelVersion: string;
  returns: Record<string, StockRadarForward>;
  benchmark: StockRadarForward;
  complete: boolean;
}

function parseForward(value: unknown): StockRadarForward {
  const raw = record(value);
  return {
    entryDate: typeof raw.entryDate === 'string' ? raw.entryDate : null,
    fwd1: num(raw.fwd1),
    fwd5: num(raw.fwd5),
    fwd20: num(raw.fwd20),
  };
}

export function parseStockRadarOutcome(id: string, d: DocumentData): StockRadarOutcome {
  const returns: Record<string, StockRadarForward> = {};
  Object.entries(record(d.returns)).forEach(([symbol, value]) => { returns[symbol] = parseForward(value); });
  return {
    id,
    runDate: str(d.runDate, id.slice(0, 10)),
    market: d.market === 'US' ? 'US' : 'TW',
    modelVersion: str(d.modelVersion),
    returns,
    benchmark: parseForward(d.benchmark),
    complete: d.complete === true,
  };
}

export const stockRadarOutcomeConverter: FirestoreDataConverter<StockRadarOutcome> = {
  toFirestore: () => {
    throw new Error('stock_radar_outcomes is read-only on the client');
  },
  fromFirestore: (snap: QueryDocumentSnapshot) => parseStockRadarOutcome(snap.id, snap.data()),
};

// -------- 回測 --------

export interface StockRadarCurveStats {
  totalReturn: number | null;
  cagr: number | null;
  volatility: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
}

export type StockRadarBucketKey = 'strong' | 'positive' | 'weak' | 'very_weak';

export interface StockRadarBacktest {
  market: StockRadarMarket;
  modelVersion: string;
  generatedAt: Date | null;
  benchmarkSymbol: string;
  from: string | null;
  to: string | null;
  periods: number;
  samples: number;
  symbols: number;
  skippedSymbols: string[];
  meanIC: number | null;
  icTStat: number | null;
  icPositiveRate: number | null;
  buckets: Array<{ key: StockRadarBucketKey; n: number; avgExcess20: number | null; hitRate: number | null }>;
  strategy: StockRadarCurveStats;
  equalWeight: StockRadarCurveStats;
  benchmark: StockRadarCurveStats;
  curve: Array<{ date: string; strategy: number; equalWeight: number; benchmark: number; holdings: number }>;
  icSeries: Array<{ date: string; ic: number; n: number }>;
}

const BUCKETS: StockRadarBucketKey[] = ['strong', 'positive', 'weak', 'very_weak'];

function parseCurveStats(value: unknown): StockRadarCurveStats {
  const raw = record(value);
  return {
    totalReturn: num(raw.totalReturn),
    cagr: num(raw.cagr),
    volatility: num(raw.volatility),
    sharpe: num(raw.sharpe),
    maxDrawdown: num(raw.maxDrawdown),
  };
}

export function parseStockRadarBacktest(market: StockRadarMarket, d: DocumentData): StockRadarBacktest {
  const rows = (value: unknown) => (Array.isArray(value) ? value.map(record) : []);
  return {
    market,
    modelVersion: str(d.modelVersion),
    generatedAt: tsToDate(d.generatedAt),
    benchmarkSymbol: str(d.benchmarkSymbol, market === 'TW' ? '0050' : 'SPY'),
    from: typeof d.from === 'string' ? d.from : null,
    to: typeof d.to === 'string' ? d.to : null,
    periods: num(d.periods) ?? 0,
    samples: num(d.samples) ?? 0,
    symbols: num(d.symbols) ?? 0,
    skippedSymbols: strings(d.skippedSymbols),
    meanIC: num(d.meanIC),
    icTStat: num(d.icTStat),
    icPositiveRate: num(d.icPositiveRate),
    buckets: rows(d.buckets).flatMap((b) => (BUCKETS.includes(b.key as StockRadarBucketKey)
      ? [{ key: b.key as StockRadarBucketKey, n: num(b.n) ?? 0, avgExcess20: num(b.avgExcess20), hitRate: num(b.hitRate) }]
      : [])),
    strategy: parseCurveStats(d.strategy),
    equalWeight: parseCurveStats(d.equalWeight),
    benchmark: parseCurveStats(d.benchmark),
    curve: rows(d.curve).flatMap((p) => {
      const date = str(p.date);
      const strategy = num(p.strategy);
      const equalWeight = num(p.equalWeight);
      const benchmark = num(p.benchmark);
      return date && strategy !== null && equalWeight !== null && benchmark !== null
        ? [{ date, strategy, equalWeight, benchmark, holdings: num(p.holdings) ?? 0 }]
        : [];
    }),
    icSeries: rows(d.icSeries).flatMap((p) => {
      const ic = num(p.ic);
      return typeof p.date === 'string' && ic !== null ? [{ date: p.date, ic, n: num(p.n) ?? 0 }] : [];
    }),
  };
}

// -------- 前端設定 --------

/** stock_radar_configs/default：記錄複製進 Claude 排程的代號清單，用來提醒追蹤清單變了要重新複製 */
export interface StockRadarConfig {
  promptSymbols: Partial<Record<StockRadarMarket, string[]>>;
  promptCopiedAt: Partial<Record<StockRadarMarket, Date | null>>;
}

export function parseStockRadarConfig(d: DocumentData | undefined): StockRadarConfig {
  const symbols = record(d?.promptSymbols);
  const copied = record(d?.promptCopiedAt);
  return {
    promptSymbols: { TW: strings(symbols.TW), US: strings(symbols.US) },
    promptCopiedAt: { TW: tsToDate(copied.TW), US: tsToDate(copied.US) },
  };
}
