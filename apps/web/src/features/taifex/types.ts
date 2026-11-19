import type { DocumentData, FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

/** 與 apps-script/src/TaifexStrategy.gs 的 TAIFEX_PRODUCTS key 一致 */
export type TaifexProduct = 'TX' | 'MTX' | 'TMF';
export type TaifexSide = 'long' | 'short';
export type TaifexTarget = TaifexSide | 'flat';
export type TaifexMode = 'auto' | 'manual';
export type TaifexFactorKey = 'trend' | 'breakout' | 'tsmom' | 'foreignFlow' | 'pcr';
export type TaifexExitReason = 'signal' | 'stop' | 'reverse' | 'manual' | 'reset' | 'halt';
export type TaifexEventType = 'fomc' | 'cpi' | 'nfp' | 'cbc' | 'earnings' | 'settlement' | 'holiday' | 'geopolitical' | 'policy' | 'other';
export type TaifexImportance = 'high' | 'medium' | 'low';
export type TaifexDriverType =
  | 'us_market' | 'tsmc_adr' | 'fed' | 'macro_data' | 'geopolitics' | 'foreign_flow' | 'retail_sentiment' | 'earnings' | 'fx' | 'other';

export type TaifexVariantKey = 'baseline' | 'conservative' | 'aggressive' | 'optimized' | 'tuned';
export const TAIFEX_VARIANT_KEYS: TaifexVariantKey[] = ['baseline', 'conservative', 'aggressive', 'optimized', 'tuned'];

/** 與 GAS TAIFEX_TUNABLE_KEYS 一致 */
export interface TaifexParams {
  entry: number;
  exit: number;
  adxTrend: number;
  chopDamp: number;
  stopAtr: number;
  trailAtr: number;
}

export const DEFAULT_TAIFEX_PARAMS: TaifexParams = { entry: 0.35, exit: 0.05, adxTrend: 18, chopDamp: 0.6, stopAtr: 2, trailAtr: 3 };

export const TAIFEX_FACTOR_KEYS: TaifexFactorKey[] = ['trend', 'breakout', 'tsmom', 'foreignFlow', 'pcr'];

/** 與 GAS TAIFEX_FACTOR_WEIGHTS 一致（顯示用；計算只在 GAS） */
export const TAIFEX_FACTOR_WEIGHTS: Record<TaifexFactorKey, number> = {
  trend: 0.3, breakout: 0.2, tsmom: 0.2, foreignFlow: 0.2, pcr: 0.1,
};

/** 與 GAS TAIFEX_RULES 一致（顯示用） */
export const TAIFEX_RULES = { entry: 0.35, exit: 0.05, adxTrend: 18, stopAtr: 2, trailAtr: 3 } as const;

export interface TaifexPosition {
  side: TaifexSide;
  contracts: number;
  entryPrice: number;
  entryDate: string;
  stop: number;
  extreme: number | null;
  bars: number;
  source: 'auto' | 'manual';
}

export interface TaifexPendingOrder {
  target: TaifexTarget;
  contracts: number;
  source: 'auto' | 'manual';
  stopPoints: number | null;
  signalDate: string | null;
  createdAt: Date | null;
  note: string;
}

export interface TaifexEquityPoint {
  date: string;
  equity: number;
  /** 帶正負號的口數（多 > 0、空 < 0） */
  position: number;
  close: number | null;
}

export interface TaifexAccount {
  id: string;
  product: TaifexProduct;
  epoch: number;
  equity: number;
  initialCapital: number;
  peakEquity: number;
  maxDrawdownPct: number;
  position: TaifexPosition | null;
  pending: TaifexPendingOrder | null;
  lastBarDate: string | null;
  lastClose: number | null;
  halted: boolean;
  haltReason: string | null;
  realizedPnl: number;
  totalCosts: number;
  tradeCount: number;
  winCount: number;
  startDate: string | null;
  equityCurve: TaifexEquityPoint[];
  lastVeto: { date: string; reason: string } | null;
  updatedAt: Date | null;
  modelVersion: string;
  variant: TaifexVariantKey;
  params: TaifexParams;
  /** 盤中即時損益（收盤 18:00 清空） */
  live: TaifexLiveMark | null;
  ticket: TaifexOrderTicket | null;
}

export interface TaifexLiveMark {
  date: string;
  time: string;
  price: number;
  estimated: boolean;
  unrealized: number | null;
  stopDistance: number | null;
}

export type TaifexOrderSide = 'buy' | 'sell';
export type TaifexOrderType = 'LMT' | 'MWP' | 'MKT' | 'STP';

export interface TaifexOrderStep {
  action: 'open' | 'close' | 'reduce';
  label: string;
  side: TaifexOrderSide;
  qty: number;
  orderType: TaifexOrderType;
  price: number | null;
  tif: string;
  offset: string;
}

export interface TaifexOrderTicket {
  kind: 'open' | 'close' | 'reverse' | 'adjust' | 'none';
  productLabel: string;
  targetSide: TaifexTarget | null;
  targetContracts: number;
  refPrice: number | null;
  buffer: number | null;
  steps: TaifexOrderStep[];
  stopOrder: { side: TaifexOrderSide; qty: number; price: number; stopPoints: number; note: string } | null;
  riskTWD: number | null;
  riskPct: number | null;
  marginTWD: number;
  validFrom: string | null;
  notes: string[];
  generatedAt: Date | null;
  signalDate: string | null;
}

export interface TaifexLiveQuote {
  date: string;
  time: string;
  contract: string | null;
  last: number;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  basis: number | null;
  estimated: boolean;
  source: string;
}

export interface TaifexLiveDoc {
  quote: TaifexLiveQuote | null;
  quoteUpdatedAt: Date | null;
  context: { lastDate: string; lastClose: number | null; contract: string | null; atr20: number | null } | null;
}

export interface TaifexOptimizationVariant {
  params: Partial<TaifexParams>;
  inSample: TaifexBacktestMetrics | null;
  outOfSample: TaifexBacktestMetrics | null;
  eligible: boolean;
}

export interface TaifexOptimization {
  generatedAt: Date | null;
  modelVersion: string;
  bars: number;
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  maxDrawdownPct: number;
  best: TaifexOptimizationVariant | null;
  baseline: TaifexOptimizationVariant | null;
  stability: number | null;
  adopt: boolean;
  suggestedRiskPct: number | null;
  riskPerTradePct: number;
  variants: TaifexOptimizationVariant[];
  history: Array<{ date: string; params: Partial<TaifexParams> }>;
}

export interface TaifexFactor {
  raw: number | null;
  score: number | null;
}

export interface TaifexSignal {
  id: string;
  date: string;
  contract: string | null;
  close: number;
  modelVersion: string;
  indicators: {
    ema20: number | null;
    ema60: number | null;
    atr20: number | null;
    adx14: number | null;
    donchianHigh: number | null;
    donchianLow: number | null;
  };
  factors: Record<TaifexFactorKey, TaifexFactor>;
  quantScore: number | null;
  coverage: number;
  sentimentAdj: number;
  composite: number | null;
  trending: boolean | null;
  reasons: string[];
  eventRisk: boolean;
  riskEvents: TaifexEvent[];
  sentiment: { sentiment: number; confidence: number; summary: string } | null;
  desired: TaifexTarget;
  decisionReasons: string[];
  suggestedContracts: number;
  stopPoints: number | null;
  sizingLimitedBy: string | null;
  product: TaifexProduct;
  mode: TaifexMode;
  position: { side: TaifexSide; contracts: number; entryPrice: number; stop: number; entryDate: string } | null;
  pending: { target: TaifexTarget; contracts: number; source: 'auto' | 'manual' } | null;
  equity: number | null;
  generatedAt: Date | null;
}

export interface TaifexTrade {
  id: string;
  side: TaifexSide;
  contracts: number;
  product: TaifexProduct;
  openDate: string;
  closeDate: string;
  entryPrice: number;
  exitPrice: number;
  pnlPoints: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  holdingBars: number;
  exitReason: TaifexExitReason;
  source: 'auto' | 'manual';
  entryComposite: number | null;
  epoch: number;
  createdAt: Date | null;
  /** default = 主帳戶；v_xxx = 策略變體 */
  accountId: string;
  intraday: boolean;
  estimated: boolean;
}

export interface TaifexEvent {
  type: TaifexEventType;
  date: string;
  importance: TaifexImportance;
  note: string;
}

export interface TaifexSentiment {
  id: string;
  date: string;
  provider: string;
  receivedAt: Date | null;
  pushCount: number;
  overall: { sentiment: number; confidence: number; summary: string; sources: Array<{ title: string; url: string }> };
  drivers: Array<{ type: TaifexDriverType; direction: -1 | 0 | 1; note: string }>;
  events: TaifexEvent[];
  indicators: Partial<Record<'vix' | 'spxChangePct' | 'soxChangePct' | 'tsmAdrChangePct' | 'nightSessionChangePct', number | null>>;
}

export interface TaifexBacktestMetrics {
  totalReturnPct: number | null;
  cagrPct: number | null;
  sharpe: number | null;
  maxDrawdownPct: number | null;
  trades: number;
  winRatePct: number | null;
  profitFactor: number | null;
  avgHoldingBars: number | null;
  exposurePct: number | null;
  finalEquity: number | null;
}

export type TaifexBacktestVariantKey = 'full' | 'trendOnly' | 'buyHold';

export interface TaifexBacktest {
  generatedAt: Date | null;
  modelVersion: string;
  from: string;
  to: string;
  bars: number;
  flowDays: number;
  product: TaifexProduct;
  initialCapital: number;
  riskPerTradePct: number;
  variants: Record<TaifexBacktestVariantKey, { metrics: TaifexBacktestMetrics | null; curve: Array<{ date: string; equity: number }> }>;
  recentTrades: Array<Omit<TaifexTrade, 'id' | 'epoch' | 'createdAt' | 'accountId' | 'intraday' | 'estimated'>>;
}

export interface TaifexConfig {
  mode: TaifexMode;
  product: TaifexProduct;
  initialCapital: number;
  riskPerTradePct: number;
  maxContracts: number;
  allowShort: boolean;
  maxDrawdownPct: number;
  /** null → 依契約預設 */
  commissionPerSide: number | null;
  slippagePoints: number;
  marginPerContract: number | null;
  notifyEnabled: boolean;
  strategyVariant: TaifexVariantKey;
  intradayEnabled: boolean;
  /** 盤中技術模擬（日盤 + 夜盤，見 tech.ts） */
  tech: TaifexTechConfig;
  updatedAt: Date | null;
}

export interface TaifexTechConfig {
  enabled: boolean;
  day: boolean;
  night: boolean;
  notify: boolean;
  contracts: number;
  /** 自訂臨時休市日（yyyy-MM-dd），例如颱風假 */
  extraHolidays: string[];
}

export const DEFAULT_TAIFEX_TECH_CONFIG: TaifexTechConfig = { enabled: true, day: true, night: true, notify: false, contracts: 1, extraHolidays: [] };

export const DEFAULT_TAIFEX_CONFIG: TaifexConfig = {
  mode: 'auto',
  product: 'TMF',
  initialCapital: 1_000_000,
  riskPerTradePct: 1.5,
  maxContracts: 5,
  allowShort: true,
  maxDrawdownPct: 20,
  commissionPerSide: null,
  slippagePoints: 1,
  marginPerContract: null,
  notifyEnabled: true,
  strategyVariant: 'baseline',
  intradayEnabled: true,
  tech: DEFAULT_TAIFEX_TECH_CONFIG,
  updatedAt: null,
};

// -------- 解析（容錯：缺欄位給安全預設，不讓整頁壞掉） --------

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numOr(value: unknown, fallback: number): number {
  return num(value) ?? fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : fallback;
}

const PRODUCTS: TaifexProduct[] = ['TX', 'MTX', 'TMF'];
const ORDER_TYPES: TaifexOrderType[] = ['LMT', 'MWP', 'MKT', 'STP'];
const TICKET_KINDS: TaifexOrderTicket['kind'][] = ['open', 'close', 'reverse', 'adjust', 'none'];

export function parseTaifexParams(value: unknown): TaifexParams {
  const p = obj(value);
  return {
    entry: numOr(p.entry, DEFAULT_TAIFEX_PARAMS.entry),
    exit: numOr(p.exit, DEFAULT_TAIFEX_PARAMS.exit),
    adxTrend: numOr(p.adxTrend, DEFAULT_TAIFEX_PARAMS.adxTrend),
    chopDamp: numOr(p.chopDamp, DEFAULT_TAIFEX_PARAMS.chopDamp),
    stopAtr: numOr(p.stopAtr, DEFAULT_TAIFEX_PARAMS.stopAtr),
    trailAtr: numOr(p.trailAtr, DEFAULT_TAIFEX_PARAMS.trailAtr),
  };
}

function partialParams(value: unknown): Partial<TaifexParams> {
  const p = obj(value);
  const out: Partial<TaifexParams> = {};
  (Object.keys(DEFAULT_TAIFEX_PARAMS) as Array<keyof TaifexParams>).forEach((k) => {
    const v = num(p[k]);
    if (v !== null) out[k] = v;
  });
  return out;
}

export function parseTaifexTicket(value: unknown): TaifexOrderTicket | null {
  const t = obj(value);
  if (!t.kind) return null;
  const stop = obj(t.stopOrder);
  return {
    kind: oneOf(t.kind, TICKET_KINDS, 'none'),
    productLabel: str(t.productLabel),
    targetSide: typeof t.targetSide === 'string' ? oneOf(t.targetSide, TARGETS, 'flat') : null,
    targetContracts: numOr(t.targetContracts, 0),
    refPrice: num(t.refPrice),
    buffer: num(t.buffer),
    steps: arr(t.steps).map((raw) => {
      const st = obj(raw);
      return {
        action: oneOf(st.action, ['open', 'close', 'reduce'] as const, 'open'),
        label: str(st.label),
        side: st.side === 'sell' ? 'sell' : 'buy',
        qty: numOr(st.qty, 0),
        orderType: oneOf(st.orderType, ORDER_TYPES, 'MWP'),
        price: num(st.price),
        tif: str(st.tif, 'ROD'),
        offset: str(st.offset),
      } as TaifexOrderStep;
    }).filter((st) => st.qty > 0),
    stopOrder: num(stop.price) !== null
      ? { side: stop.side === 'buy' ? 'buy' : 'sell', qty: numOr(stop.qty, 0), price: numOr(stop.price, 0), stopPoints: numOr(stop.stopPoints, 0), note: str(stop.note) }
      : null,
    riskTWD: num(t.riskTWD),
    riskPct: num(t.riskPct),
    marginTWD: numOr(t.marginTWD, 0),
    validFrom: typeof t.validFrom === 'string' ? t.validFrom : null,
    notes: arr(t.notes).filter((n): n is string => typeof n === 'string'),
    generatedAt: tsToDate(t.generatedAt),
    signalDate: typeof t.signalDate === 'string' ? t.signalDate : null,
  };
}

export function parseTaifexLive(data: DocumentData | undefined): TaifexLiveDoc {
  const d = data ?? {};
  const q = obj(d.quote);
  const c = obj(d.context);
  return {
    quote: num(q.last) !== null && typeof q.date === 'string'
      ? {
        date: q.date,
        time: str(q.time),
        contract: typeof q.contract === 'string' ? q.contract : null,
        last: numOr(q.last, 0),
        open: num(q.open),
        high: num(q.high),
        low: num(q.low),
        prevClose: num(q.prevClose),
        basis: num(q.basis),
        estimated: q.estimated === true,
        source: str(q.source),
      }
      : null,
    quoteUpdatedAt: tsToDate(d.quoteUpdatedAt),
    context: typeof c.lastDate === 'string'
      ? { lastDate: c.lastDate, lastClose: num(c.lastClose), contract: typeof c.contract === 'string' ? c.contract : null, atr20: num(c.atr20) }
      : null,
  };
}

function parseOptVariant(value: unknown): TaifexOptimizationVariant | null {
  const v = obj(value);
  if (!Object.keys(v).length) return null;
  return { params: partialParams(v.params), inSample: parseMetrics(v.inSample), outOfSample: parseMetrics(v.outOfSample), eligible: v.eligible !== false };
}

export function parseTaifexOptimization(data: DocumentData | undefined): TaifexOptimization | null {
  if (!data) return null;
  return {
    generatedAt: tsToDate(data.generatedAt),
    modelVersion: str(data.modelVersion, '—'),
    bars: numOr(data.bars, 0),
    trainFrom: str(data.trainFrom),
    trainTo: str(data.trainTo),
    testFrom: str(data.testFrom),
    testTo: str(data.testTo),
    maxDrawdownPct: numOr(data.maxDrawdownPct, 20),
    best: parseOptVariant(data.best),
    baseline: parseOptVariant(data.baseline),
    stability: num(data.stability),
    adopt: data.adopt === true,
    suggestedRiskPct: num(data.suggestedRiskPct),
    riskPerTradePct: numOr(data.riskPerTradePct, DEFAULT_TAIFEX_CONFIG.riskPerTradePct),
    variants: arr(data.variants).map(parseOptVariant).filter((v): v is TaifexOptimizationVariant => v !== null),
    history: arr(data.history).map((h) => {
      const e = obj(h);
      return typeof e.date === 'string' ? { date: e.date, params: partialParams(e.params) } : null;
    }).filter((h): h is { date: string; params: Partial<TaifexParams> } => h !== null),
  };
}
const TARGETS: TaifexTarget[] = ['long', 'short', 'flat'];
const SIDES: TaifexSide[] = ['long', 'short'];
const EXIT_REASONS: TaifexExitReason[] = ['signal', 'stop', 'reverse', 'manual', 'reset', 'halt'];
const EVENT_TYPES: TaifexEventType[] = ['fomc', 'cpi', 'nfp', 'cbc', 'earnings', 'settlement', 'holiday', 'geopolitical', 'policy', 'other'];
const IMPORTANCE: TaifexImportance[] = ['high', 'medium', 'low'];
const DRIVER_TYPES: TaifexDriverType[] = ['us_market', 'tsmc_adr', 'fed', 'macro_data', 'geopolitics', 'foreign_flow', 'retail_sentiment', 'earnings', 'fx', 'other'];

function parsePosition(value: unknown): TaifexPosition | null {
  const p = obj(value);
  const side = oneOf(p.side, SIDES, 'long');
  const contracts = num(p.contracts);
  const entryPrice = num(p.entryPrice);
  if (!p.side || !contracts || entryPrice === null) return null;
  return {
    side,
    contracts,
    entryPrice,
    entryDate: str(p.entryDate),
    stop: numOr(p.stop, entryPrice),
    extreme: num(p.extreme),
    bars: numOr(p.bars, 0),
    source: p.source === 'manual' ? 'manual' : 'auto',
  };
}

function parsePending(value: unknown): TaifexPendingOrder | null {
  const p = obj(value);
  if (!p.target) return null;
  return {
    target: oneOf(p.target, TARGETS, 'flat'),
    contracts: numOr(p.contracts, 0),
    source: p.source === 'manual' ? 'manual' : 'auto',
    stopPoints: num(p.stopPoints),
    signalDate: typeof p.signalDate === 'string' ? p.signalDate : null,
    createdAt: tsToDate(p.createdAt),
    note: str(p.note),
  };
}

export function parseTaifexEvent(value: unknown): TaifexEvent | null {
  const e = obj(value);
  // 日期要是 yyyy-MM-dd，否則字串比較會把格式錯誤的日期當成「未來」
  if (!e.type || typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return null;
  return {
    type: oneOf(e.type, EVENT_TYPES, 'other'),
    date: e.date,
    importance: oneOf(e.importance, IMPORTANCE, 'medium'),
    note: str(e.note),
  };
}

export function parseTaifexAccount(id: string, data: DocumentData | undefined): TaifexAccount | null {
  if (!data) return null;
  const initialCapital = numOr(data.initialCapital, DEFAULT_TAIFEX_CONFIG.initialCapital);
  const veto = obj(data.lastVeto);
  return {
    id,
    product: oneOf(data.product, PRODUCTS, 'TMF'),
    epoch: numOr(data.epoch, 1),
    equity: numOr(data.equity, initialCapital),
    initialCapital,
    peakEquity: numOr(data.peakEquity, initialCapital),
    maxDrawdownPct: numOr(data.maxDrawdownPct, 0),
    position: parsePosition(data.position),
    pending: parsePending(data.pending),
    lastBarDate: typeof data.lastBarDate === 'string' ? data.lastBarDate : null,
    lastClose: num(data.lastClose),
    halted: data.halted === true,
    haltReason: typeof data.haltReason === 'string' ? data.haltReason : null,
    realizedPnl: numOr(data.realizedPnl, 0),
    totalCosts: numOr(data.totalCosts, 0),
    tradeCount: numOr(data.tradeCount, 0),
    winCount: numOr(data.winCount, 0),
    startDate: typeof data.startDate === 'string' ? data.startDate : null,
    equityCurve: arr(data.equityCurve).map((raw) => {
      const p = obj(raw);
      const date = str(p.d);
      const equity = num(p.e);
      return date && equity !== null ? { date, equity, position: numOr(p.p, 0), close: num(p.c) } : null;
    }).filter((p): p is TaifexEquityPoint => p !== null),
    lastVeto: typeof veto.date === 'string' ? { date: veto.date, reason: str(veto.reason) } : null,
    updatedAt: tsToDate(data.updatedAt),
    modelVersion: str(data.modelVersion, '—'),
    variant: oneOf(data.variant, TAIFEX_VARIANT_KEYS, 'baseline'),
    params: parseTaifexParams(data.params),
    live: (() => {
      const l = obj(data.live);
      return typeof l.date === 'string' && num(l.price) !== null
        ? { date: l.date, time: str(l.time), price: numOr(l.price, 0), estimated: l.estimated === true, unrealized: num(l.unrealized), stopDistance: num(l.stopDistance) }
        : null;
    })(),
    ticket: parseTaifexTicket(data.ticket),
  };
}

function parseFactor(value: unknown): TaifexFactor {
  const f = obj(value);
  return { raw: num(f.raw), score: num(f.score) };
}

export function parseTaifexSignal(id: string, data: DocumentData): TaifexSignal {
  const ind = obj(data.indicators);
  const factors = obj(data.factors);
  const sentiment = obj(data.sentiment);
  const position = obj(data.position);
  const pending = obj(data.pending);
  return {
    id,
    date: str(data.date, id),
    contract: typeof data.contract === 'string' ? data.contract : null,
    close: numOr(data.close, 0),
    modelVersion: str(data.modelVersion, '—'),
    indicators: {
      ema20: num(ind.ema20),
      ema60: num(ind.ema60),
      atr20: num(ind.atr20),
      adx14: num(ind.adx14),
      donchianHigh: num(ind.donchianHigh),
      donchianLow: num(ind.donchianLow),
    },
    factors: {
      trend: parseFactor(factors.trend),
      breakout: parseFactor(factors.breakout),
      tsmom: parseFactor(factors.tsmom),
      foreignFlow: parseFactor(factors.foreignFlow),
      pcr: parseFactor(factors.pcr),
    },
    quantScore: num(data.quantScore),
    coverage: numOr(data.coverage, 0),
    sentimentAdj: numOr(data.sentimentAdj, 0),
    composite: num(data.composite),
    trending: typeof data.trending === 'boolean' ? data.trending : null,
    reasons: arr(data.reasons).filter((r): r is string => typeof r === 'string'),
    eventRisk: data.eventRisk === true,
    riskEvents: arr(data.riskEvents).map(parseTaifexEvent).filter((e): e is TaifexEvent => e !== null),
    sentiment: num(sentiment.sentiment) !== null
      ? { sentiment: numOr(sentiment.sentiment, 0), confidence: numOr(sentiment.confidence, 0), summary: str(sentiment.summary) }
      : null,
    desired: oneOf(data.desired, TARGETS, 'flat'),
    decisionReasons: arr(data.decisionReasons).filter((r): r is string => typeof r === 'string'),
    suggestedContracts: numOr(data.suggestedContracts, 0),
    stopPoints: num(data.stopPoints),
    sizingLimitedBy: typeof data.sizingLimitedBy === 'string' ? data.sizingLimitedBy : null,
    product: oneOf(data.product, PRODUCTS, 'TMF'),
    mode: data.mode === 'manual' ? 'manual' : 'auto',
    position: position.side && num(position.contracts)
      ? {
        side: oneOf(position.side, SIDES, 'long'),
        contracts: numOr(position.contracts, 0),
        entryPrice: numOr(position.entryPrice, 0),
        stop: numOr(position.stop, 0),
        entryDate: str(position.entryDate),
      }
      : null,
    pending: pending.target
      ? { target: oneOf(pending.target, TARGETS, 'flat'), contracts: numOr(pending.contracts, 0), source: pending.source === 'manual' ? 'manual' : 'auto' }
      : null,
    equity: num(data.equity),
    generatedAt: tsToDate(data.generatedAt),
  };
}

export function parseTaifexTrade(id: string, data: DocumentData): TaifexTrade {
  return {
    id,
    side: oneOf(data.side, SIDES, 'long'),
    contracts: numOr(data.contracts, 0),
    product: oneOf(data.product, PRODUCTS, 'TMF'),
    openDate: str(data.openDate),
    closeDate: str(data.closeDate),
    entryPrice: numOr(data.entryPrice, 0),
    exitPrice: numOr(data.exitPrice, 0),
    pnlPoints: numOr(data.pnlPoints, 0),
    grossPnl: numOr(data.grossPnl, 0),
    costs: numOr(data.costs, 0),
    netPnl: numOr(data.netPnl, 0),
    holdingBars: numOr(data.holdingBars, 0),
    exitReason: oneOf(data.exitReason, EXIT_REASONS, 'signal'),
    source: data.source === 'manual' ? 'manual' : 'auto',
    entryComposite: num(data.entryComposite),
    epoch: numOr(data.epoch, 1),
    createdAt: tsToDate(data.createdAt),
    accountId: str(data.accountId, 'default'),
    intraday: data.intraday === true,
    estimated: data.estimated === true,
  };
}

export function parseTaifexSentiment(id: string, data: DocumentData | undefined): TaifexSentiment | null {
  if (!data) return null;
  const overall = obj(data.overall);
  const indicators = obj(data.indicators);
  return {
    id,
    date: str(data.date, id),
    provider: str(data.provider),
    receivedAt: tsToDate(data.receivedAt),
    pushCount: numOr(data.pushCount, 1),
    overall: {
      sentiment: numOr(overall.sentiment, 0),
      confidence: numOr(overall.confidence, 0),
      summary: str(overall.summary),
      sources: arr(overall.sources).map((s) => {
        const src = obj(s);
        return typeof src.url === 'string' && src.url.startsWith('https://') ? { title: str(src.title, src.url), url: src.url } : null;
      }).filter((s): s is { title: string; url: string } => s !== null),
    },
    drivers: arr(data.drivers).map((d) => {
      const drv = obj(d);
      if (!drv.type) return null;
      const dir = numOr(drv.direction, 0);
      return { type: oneOf(drv.type, DRIVER_TYPES, 'other'), direction: (dir > 0 ? 1 : dir < 0 ? -1 : 0) as -1 | 0 | 1, note: str(drv.note) };
    }).filter((d): d is TaifexSentiment['drivers'][number] => d !== null),
    events: arr(data.events).map(parseTaifexEvent).filter((e): e is TaifexEvent => e !== null),
    indicators: {
      vix: num(indicators.vix),
      spxChangePct: num(indicators.spxChangePct),
      soxChangePct: num(indicators.soxChangePct),
      tsmAdrChangePct: num(indicators.tsmAdrChangePct),
      nightSessionChangePct: num(indicators.nightSessionChangePct),
    },
  };
}

function parseMetrics(value: unknown): TaifexBacktestMetrics | null {
  const m = obj(value);
  if (!Object.keys(m).length) return null;
  return {
    totalReturnPct: num(m.totalReturnPct),
    cagrPct: num(m.cagrPct),
    sharpe: num(m.sharpe),
    maxDrawdownPct: num(m.maxDrawdownPct),
    trades: numOr(m.trades, 0),
    winRatePct: num(m.winRatePct),
    profitFactor: num(m.profitFactor),
    avgHoldingBars: num(m.avgHoldingBars),
    exposurePct: num(m.exposurePct),
    finalEquity: num(m.finalEquity),
  };
}

export function parseTaifexBacktest(data: DocumentData | undefined): TaifexBacktest | null {
  if (!data) return null;
  const variants = obj(data.variants);
  const variant = (key: TaifexBacktestVariantKey) => {
    const v = obj(variants[key]);
    return {
      metrics: parseMetrics(v.metrics),
      curve: arr(v.curve).map((raw) => {
        const p = obj(raw);
        const equity = num(p.e);
        return typeof p.d === 'string' && equity !== null ? { date: p.d, equity } : null;
      }).filter((p): p is { date: string; equity: number } => p !== null),
    };
  };
  return {
    generatedAt: tsToDate(data.generatedAt),
    modelVersion: str(data.modelVersion, '—'),
    from: str(data.from),
    to: str(data.to),
    bars: numOr(data.bars, 0),
    flowDays: numOr(data.flowDays, 0),
    product: oneOf(data.product, PRODUCTS, 'TMF'),
    initialCapital: numOr(data.initialCapital, DEFAULT_TAIFEX_CONFIG.initialCapital),
    riskPerTradePct: numOr(data.riskPerTradePct, DEFAULT_TAIFEX_CONFIG.riskPerTradePct),
    variants: { full: variant('full'), trendOnly: variant('trendOnly'), buyHold: variant('buyHold') },
    recentTrades: arr(data.recentTrades).map((t, i) => {
      const { id: _id, epoch: _epoch, createdAt: _createdAt, accountId: _a, intraday: _i, estimated: _e, ...rest } = parseTaifexTrade(String(i), obj(t));
      void _id; void _epoch; void _createdAt; void _a; void _i; void _e;
      return rest;
    }),
  };
}

function parseTechConfig(value: unknown): TaifexTechConfig {
  const t = obj(value);
  const contracts = num(t.contracts);
  return {
    enabled: t.enabled !== false,
    day: t.day !== false,
    night: t.night !== false,
    notify: t.notify === true,
    contracts: contracts !== null && contracts >= 1 && contracts <= 20 ? Math.floor(contracts) : 1,
    extraHolidays: arr(t.extraHolidays).filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)),
  };
}

export function parseTaifexConfig(data: DocumentData | undefined): TaifexConfig {
  const d = data ?? {};
  return {
    mode: d.mode === 'manual' ? 'manual' : 'auto',
    product: oneOf(d.product, PRODUCTS, DEFAULT_TAIFEX_CONFIG.product),
    initialCapital: numOr(d.initialCapital, DEFAULT_TAIFEX_CONFIG.initialCapital),
    riskPerTradePct: numOr(d.riskPerTradePct, DEFAULT_TAIFEX_CONFIG.riskPerTradePct),
    maxContracts: numOr(d.maxContracts, DEFAULT_TAIFEX_CONFIG.maxContracts),
    allowShort: d.allowShort !== false,
    maxDrawdownPct: numOr(d.maxDrawdownPct, DEFAULT_TAIFEX_CONFIG.maxDrawdownPct),
    commissionPerSide: num(d.commissionPerSide),
    slippagePoints: numOr(d.slippagePoints, DEFAULT_TAIFEX_CONFIG.slippagePoints),
    marginPerContract: num(d.marginPerContract),
    notifyEnabled: d.notifyEnabled !== false,
    strategyVariant: oneOf(d.strategyVariant, TAIFEX_VARIANT_KEYS, 'baseline'),
    intradayEnabled: d.intradayEnabled !== false,
    tech: parseTechConfig(d.tech),
    updatedAt: tsToDate(d.updatedAt),
  };
}

export const taifexSignalConverter: FirestoreDataConverter<TaifexSignal> = {
  toFirestore: () => { throw new Error('taifex_signals is read-only'); },
  fromFirestore: (snap: QueryDocumentSnapshot) => parseTaifexSignal(snap.id, snap.data()),
};

export const taifexTradeConverter: FirestoreDataConverter<TaifexTrade> = {
  toFirestore: () => { throw new Error('taifex_paper_trades is read-only'); },
  fromFirestore: (snap: QueryDocumentSnapshot) => parseTaifexTrade(snap.id, snap.data()),
};
