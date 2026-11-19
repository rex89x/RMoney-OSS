/**
 * 盤中技術模擬（日盤 + 夜盤，4 個監控頻率）的型別、解析與分析純函式。
 * 資料由 GAS `runTaifexTech` 寫入 `taifex_live/tech`、`taifex_live/tech_trades`；公式在 `apps-script/src/TaifexTech.gs`。
 * 測試：apps/web/tests/taifex.test.cjs。
 */
import type { DocumentData } from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
import type { TaifexProduct, TaifexSide, TaifexTarget } from './types';

export type TaifexSessionKind = 'day' | 'night';
export type TaifexTechBotId = 'm5' | 'm15' | 'm30' | 'm60';
export type TaifexTechState = 'running' | 'closed' | 'disabled' | 'stale' | 'no-quote';
export type TaifexTechExitReason = 'signal' | 'stop' | 'reverse' | 'session_end';
export type TaifexTechAction = 'hold' | 'enter' | 'exit' | 'reverse';
export type TaifexTechFactorKey = 'trend' | 'macd' | 'rsi' | 'breakout';

export const TAIFEX_TECH_BOT_IDS: TaifexTechBotId[] = ['m5', 'm15', 'm30', 'm60'];
export const TAIFEX_TECH_INTERVALS: Record<TaifexTechBotId, number> = { m5: 5, m15: 15, m30: 30, m60: 60 };
export const TAIFEX_TECH_FACTOR_KEYS: TaifexTechFactorKey[] = ['trend', 'macd', 'rsi', 'breakout'];

/** 顯示用，要與 GAS TAIFEX_TECH_RULES 一致（模型版本 txi-v1） */
export const TAIFEX_TECH_RULES = {
  version: 'txi-v1',
  emaFast: 9,
  emaSlow: 21,
  rsi: 14,
  atr: 14,
  channel: 20,
  minBars: 35,
  entry: 0.4,
  exit: 0.1,
  stopAtr: 2,
  trailAtr: 3,
  noEntryMin: 30,
  flatMin: 10,
  weights: { trend: 0.35, macd: 0.25, rsi: 0.2, breakout: 0.2 } as Record<TaifexTechFactorKey, number>,
} as const;

export const TECH_FACTOR_LABELS: Record<TaifexTechFactorKey, { label: string; desc: string }> = {
  trend: { label: '均線趨勢', desc: 'EMA9 與 EMA21 的距離，以 ATR14 標準化' },
  macd: { label: 'MACD 柱狀體', desc: 'MACD(12,26,9) 柱狀體 ÷ 0.25×ATR' },
  rsi: { label: 'RSI 動能', desc: '(RSI14 − 50) ÷ 20' },
  breakout: { label: '通道位置', desc: '收盤在前 20 根高低通道中的位置' },
};

export const TECH_EXIT_LABELS: Record<TaifexTechExitReason, string> = {
  signal: '訊號出場',
  stop: '停損',
  reverse: '反手',
  session_end: '收盤平倉',
};

export const TECH_ACTION_LABELS: Record<TaifexTechAction, string> = { hold: '不動作', enter: '進場', exit: '出場', reverse: '反手' };

export const SESSION_LABELS: Record<TaifexSessionKind, string> = { day: '日盤', night: '夜盤' };

/** 進場時間分段（開盤後多久進場）；id 與 GAS TAIFEX_TECH_BUCKETS 一致 */
export const TECH_BUCKETS: Array<{ id: string; session: TaifexSessionKind; label: string }> = [
  { id: 'd1', session: 'day', label: '08:45–09:15 開盤 30 分' },
  { id: 'd2', session: 'day', label: '09:15–10:15' },
  { id: 'd3', session: 'day', label: '10:15–11:45' },
  { id: 'd4', session: 'day', label: '11:45–13:45 午盤' },
  { id: 'n1', session: 'night', label: '15:00–16:00 夜盤開盤' },
  { id: 'n2', session: 'night', label: '16:00–21:30 歐洲時段' },
  { id: 'n3', session: 'night', label: '21:30–01:00 美股開盤' },
  { id: 'n4', session: 'night', label: '01:00–05:00 美股後段' },
];

/** 交易筆數少於這個數字，排名只能參考 */
export const TECH_MIN_TRADES = 30;

export interface TaifexTechStat {
  n: number;
  wins: number;
  net: number;
  grossWin: number;
  grossLoss: number;
  points: number;
}

export interface TaifexTechPosition {
  side: TaifexSide;
  contracts: number;
  entryPrice: number;
  entryTime: string;
  session: TaifexSessionKind;
  stop: number;
  unrealized: number | null;
}

export interface TaifexTechDecision {
  t: string;
  session: TaifexSessionKind | null;
  price: number;
  score: number | null;
  action: TaifexTechAction;
  target: TaifexTarget;
  reason: string;
  bars: number | null;
  indicators: { emaFast: number; emaSlow: number; rsi: number; macdHist: number; atr: number; channelHigh: number; channelLow: number } | null;
  factors: Record<TaifexTechFactorKey, number> | null;
}

export interface TaifexTechBot {
  id: TaifexTechBotId;
  interval: number;
  position: TaifexTechPosition | null;
  realized: number;
  maxDrawdown: number;
  checks: number;
  stats: Record<'all' | TaifexSessionKind, TaifexTechStat>;
  buckets: Record<string, TaifexTechStat>;
  lastDecision: TaifexTechDecision | null;
  decisions: Array<{ t: string; price: number; score: number | null; action: TaifexTechAction; target: TaifexTarget }>;
}

export interface TaifexTechStatus {
  state: TaifexTechState;
  reason: string | null;
  label: string;
  date: string;
  time: string;
  session: TaifexSessionKind | null;
  toClose: number | null;
  price: number | null;
  contract: string | null;
  source: string | null;
  estimated: boolean;
  next: { session: TaifexSessionKind; date: string; time: string } | null;
  updatedAt: Date | null;
}

export interface TaifexTechSessionSummary {
  key: string;
  session: TaifexSessionKind;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
  pnl: Partial<Record<TaifexTechBotId, number>>;
  trades: Partial<Record<TaifexTechBotId, number>>;
}

export interface TaifexTechDoc {
  modelVersion: string;
  epoch: number;
  startDate: string | null;
  product: TaifexProduct;
  contracts: number;
  status: TaifexTechStatus | null;
  bots: TaifexTechBot[];
  sessions: TaifexTechSessionSummary[];
  updatedAt: Date | null;
}

export interface TaifexTechTrade {
  id: string;
  bot: TaifexTechBotId;
  interval: number;
  session: TaifexSessionKind;
  sessionKey: string;
  side: TaifexSide;
  contracts: number;
  entryTime: string;
  entryPrice: number;
  entryM: number;
  entryScore: number | null;
  exitTime: string;
  exitPrice: number;
  points: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  reason: TaifexTechExitReason;
  estimated: boolean;
  epoch: number;
}

// -------- 解析 --------

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

const STATES: TaifexTechState[] = ['running', 'closed', 'disabled', 'stale', 'no-quote'];
const ACTIONS: TaifexTechAction[] = ['hold', 'enter', 'exit', 'reverse'];
const TARGETS: TaifexTarget[] = ['long', 'short', 'flat'];
const EXIT_REASONS: TaifexTechExitReason[] = ['signal', 'stop', 'reverse', 'session_end'];
const PRODUCTS: TaifexProduct[] = ['TX', 'MTX', 'TMF'];

function sessionOrNull(value: unknown): TaifexSessionKind | null {
  return value === 'day' || value === 'night' ? value : null;
}

export function emptyTechStat(): TaifexTechStat {
  return { n: 0, wins: 0, net: 0, grossWin: 0, grossLoss: 0, points: 0 };
}

function parseStat(value: unknown): TaifexTechStat {
  const s = obj(value);
  return {
    n: num(s.n) ?? 0,
    wins: num(s.wins) ?? 0,
    net: num(s.net) ?? 0,
    grossWin: num(s.grossWin) ?? 0,
    grossLoss: num(s.grossLoss) ?? 0,
    points: num(s.points) ?? 0,
  };
}

function parseDecision(value: unknown): TaifexTechDecision | null {
  const d = obj(value);
  const price = num(d.price);
  if (typeof d.t !== 'string' || price === null) return null;
  const ind = obj(d.indicators);
  const fac = obj(d.factors);
  const hasInd = num(ind.atr) !== null;
  return {
    t: d.t,
    session: sessionOrNull(d.session),
    price,
    score: num(d.score),
    action: oneOf(d.action, ACTIONS, 'hold'),
    target: oneOf(d.target, TARGETS, 'flat'),
    reason: typeof d.reason === 'string' ? d.reason : '',
    bars: num(d.bars),
    indicators: hasInd
      ? {
        emaFast: num(ind.emaFast) ?? 0,
        emaSlow: num(ind.emaSlow) ?? 0,
        rsi: num(ind.rsi) ?? 0,
        macdHist: num(ind.macdHist) ?? 0,
        atr: num(ind.atr) ?? 0,
        channelHigh: num(ind.channelHigh) ?? 0,
        channelLow: num(ind.channelLow) ?? 0,
      }
      : null,
    factors: hasInd
      ? { trend: num(fac.trend) ?? 0, macd: num(fac.macd) ?? 0, rsi: num(fac.rsi) ?? 0, breakout: num(fac.breakout) ?? 0 }
      : null,
  };
}

function parseBot(id: TaifexTechBotId, value: unknown): TaifexTechBot {
  const b = obj(value);
  const p = obj(b.position);
  const stats = obj(b.stats);
  const buckets: Record<string, TaifexTechStat> = {};
  Object.entries(obj(b.buckets)).forEach(([key, v]) => { buckets[key] = parseStat(v); });
  const entryPrice = num(p.entryPrice);
  return {
    id,
    interval: num(b.interval) ?? TAIFEX_TECH_INTERVALS[id],
    position: (p.side === 'long' || p.side === 'short') && entryPrice !== null
      ? {
        side: p.side,
        contracts: num(p.contracts) ?? 1,
        entryPrice,
        entryTime: typeof p.entryTime === 'string' ? p.entryTime : '',
        session: sessionOrNull(p.session) ?? 'day',
        stop: num(p.stop) ?? entryPrice,
        unrealized: num(p.unrealized),
      }
      : null,
    realized: num(b.realized) ?? 0,
    maxDrawdown: num(b.maxDrawdown) ?? 0,
    checks: num(b.checks) ?? 0,
    stats: { all: parseStat(stats.all), day: parseStat(stats.day), night: parseStat(stats.night) },
    buckets,
    lastDecision: parseDecision(b.lastDecision),
    decisions: arr(b.decisions).map(parseDecision).filter((d): d is TaifexTechDecision => d !== null)
      .map((d) => ({ t: d.t, price: d.price, score: d.score, action: d.action, target: d.target })),
  };
}

function parseStatus(value: unknown): TaifexTechStatus | null {
  const s = obj(value);
  if (typeof s.state !== 'string') return null;
  const n = obj(s.next);
  const nextSession = sessionOrNull(n.session);
  return {
    state: oneOf(s.state, STATES, 'closed'),
    reason: typeof s.reason === 'string' ? s.reason : null,
    label: typeof s.label === 'string' ? s.label : '',
    date: typeof s.date === 'string' ? s.date : '',
    time: typeof s.time === 'string' ? s.time : '',
    session: sessionOrNull(s.session),
    toClose: num(s.toClose),
    price: num(s.price),
    contract: typeof s.contract === 'string' ? s.contract : null,
    source: typeof s.source === 'string' ? s.source : null,
    estimated: s.estimated === true,
    next: nextSession && typeof n.date === 'string' && typeof n.time === 'string' ? { session: nextSession, date: n.date, time: n.time } : null,
    updatedAt: tsToDate(s.updatedAt),
  };
}

function parseBotMap(value: unknown): Partial<Record<TaifexTechBotId, number>> {
  const m = obj(value);
  const out: Partial<Record<TaifexTechBotId, number>> = {};
  TAIFEX_TECH_BOT_IDS.forEach((id) => {
    const v = num(m[id]);
    if (v !== null) out[id] = v;
  });
  return out;
}

export function parseTaifexTech(data: DocumentData | undefined): TaifexTechDoc | null {
  if (!data) return null;
  const bots = obj(data.bots);
  return {
    modelVersion: typeof data.modelVersion === 'string' ? data.modelVersion : TAIFEX_TECH_RULES.version,
    epoch: num(data.epoch) ?? 1,
    startDate: typeof data.startDate === 'string' ? data.startDate : null,
    product: oneOf(data.product, PRODUCTS, 'TMF'),
    contracts: num(data.contracts) ?? 1,
    status: parseStatus(data.status),
    bots: TAIFEX_TECH_BOT_IDS.map((id) => parseBot(id, bots[id])),
    sessions: arr(data.sessions).map((raw): TaifexTechSessionSummary | null => {
      const s = obj(raw);
      const session = sessionOrNull(s.session);
      if (typeof s.key !== 'string' || !session) return null;
      return {
        key: s.key,
        session,
        date: typeof s.date === 'string' ? s.date : s.key.slice(0, 10),
        open: num(s.open) ?? 0,
        high: num(s.high) ?? 0,
        low: num(s.low) ?? 0,
        close: num(s.close) ?? 0,
        ticks: num(s.ticks) ?? 0,
        pnl: parseBotMap(s.pnl),
        trades: parseBotMap(s.trades),
      };
    }).filter((s): s is TaifexTechSessionSummary => s !== null),
    updatedAt: tsToDate(data.updatedAt),
  };
}

export function parseTaifexTechTrades(data: DocumentData | undefined): TaifexTechTrade[] {
  return arr(data?.trades).map((raw, i): TaifexTechTrade | null => {
    const t = obj(raw);
    const session = sessionOrNull(t.session);
    const entryPrice = num(t.entryPrice);
    const exitPrice = num(t.exitPrice);
    if (!session || entryPrice === null || exitPrice === null || (t.side !== 'long' && t.side !== 'short')) return null;
    const bot = oneOf(t.bot, TAIFEX_TECH_BOT_IDS, 'm5');
    return {
      id: `${String(t.exitTime ?? '')}-${bot}-${i}`,
      bot,
      interval: num(t.interval) ?? TAIFEX_TECH_INTERVALS[bot],
      session,
      sessionKey: typeof t.sessionKey === 'string' ? t.sessionKey : '',
      side: t.side,
      contracts: num(t.contracts) ?? 1,
      entryTime: typeof t.entryTime === 'string' ? t.entryTime : '',
      entryPrice,
      entryM: num(t.entryM) ?? 0,
      entryScore: num(t.entryScore),
      exitTime: typeof t.exitTime === 'string' ? t.exitTime : '',
      exitPrice,
      points: num(t.points) ?? 0,
      grossPnl: num(t.grossPnl) ?? 0,
      costs: num(t.costs) ?? 0,
      netPnl: num(t.netPnl) ?? 0,
      reason: oneOf(t.reason, EXIT_REASONS, 'signal'),
      estimated: t.estimated === true,
      epoch: num(t.epoch) ?? 1,
    };
  }).filter((t): t is TaifexTechTrade => t !== null).reverse();
}

// -------- 分析 --------

export interface TaifexTechStatView {
  n: number;
  net: number;
  points: number;
  winRatePct: number | null;
  profitFactor: number | null;
  avgNet: number | null;
}

export function statView(stat: TaifexTechStat): TaifexTechStatView {
  return {
    n: stat.n,
    net: stat.net,
    points: stat.points,
    winRatePct: stat.n ? (stat.wins / stat.n) * 100 : null,
    profitFactor: stat.grossLoss > 0 ? stat.grossWin / stat.grossLoss : null,
    avgNet: stat.n ? stat.net / stat.n : null,
  };
}

export interface TaifexTechRankRow {
  bot: TaifexTechBot;
  all: TaifexTechStatView;
  day: TaifexTechStatView;
  night: TaifexTechStatView;
  /** 每次查看盤面平均換到多少錢：頻率越高查看越多次，這個數字才能公平比較 */
  netPerCheck: number | null;
  enoughSample: boolean;
}

/** 監控頻率排名：樣本足夠的排前面，再依累計淨損益（含未實現不計）由高到低 */
export function rankTechBots(bots: TaifexTechBot[], minTrades = TECH_MIN_TRADES): TaifexTechRankRow[] {
  return bots.map((bot): TaifexTechRankRow => ({
    bot,
    all: statView(bot.stats.all),
    day: statView(bot.stats.day),
    night: statView(bot.stats.night),
    netPerCheck: bot.checks ? bot.stats.all.net / bot.checks : null,
    enoughSample: bot.stats.all.n >= minTrades,
  })).sort((a, b) => Number(b.enoughSample) - Number(a.enoughSample) || b.all.net - a.all.net || a.bot.interval - b.bot.interval);
}

export interface TaifexTechVerdict {
  level: 'insufficient' | 'ok';
  headline: string;
  notes: string[];
}

/** 一句話結論：哪個頻率、哪個時段表現最好；樣本不足時只說還要等多久 */
export function techVerdict(rows: TaifexTechRankRow[], minTrades = TECH_MIN_TRADES): TaifexTechVerdict {
  const total = rows.reduce((s, r) => s + r.all.n, 0);
  const ready = rows.filter((r) => r.enoughSample);
  if (!ready.length) {
    const most = rows.reduce((m, r) => Math.max(m, r.all.n), 0);
    return {
      level: 'insufficient',
      headline: total ? `樣本不足：最多的頻率也只有 ${most} 筆交易（至少 ${minTrades} 筆才比較）` : '還沒有交易紀錄',
      notes: ['60 分頻率要累積約 2 個交易日的 K 棒才開始決策', '排名在樣本足夠前只是雜訊，先不要據此調整演算法'],
    };
  }
  const best = ready[0];
  if (!best) return { level: 'insufficient', headline: '還沒有交易紀錄', notes: [] };
  const notes: string[] = [];
  const better = best.day.n && best.night.n
    ? (best.day.avgNet ?? 0) >= (best.night.avgNet ?? 0) ? '日盤' : '夜盤'
    : null;
  if (better) notes.push(`每 ${best.bot.interval} 分鐘這組在${better}的每筆平均損益較好`);
  const losing = ready.filter((r) => r.all.net < 0).map((r) => `${r.bot.interval} 分`);
  if (losing.length) notes.push(`扣成本後虧損的頻率：${losing.join('、')}`);
  if (ready.length < rows.length) notes.push('部分頻率樣本還不夠，排在後面');
  return {
    level: 'ok',
    headline: best.all.net > 0
      ? `目前每 ${best.bot.interval} 分鐘查看一次的結果最好（${best.all.n} 筆、淨損益 ${Math.round(best.all.net).toLocaleString('zh-TW')} 元）`
      : `所有頻率扣成本後都沒有獲利，虧最少的是每 ${best.bot.interval} 分鐘`,
    notes,
  };
}

export interface TaifexTechBucketRow {
  id: string;
  session: TaifexSessionKind;
  label: string;
  /** 四個頻率合計 */
  total: TaifexTechStatView;
  byBot: Record<TaifexTechBotId, TaifexTechStatView>;
}

function addStat(a: TaifexTechStat, b: TaifexTechStat): TaifexTechStat {
  return {
    n: a.n + b.n,
    wins: a.wins + b.wins,
    net: a.net + b.net,
    grossWin: a.grossWin + b.grossWin,
    grossLoss: a.grossLoss + b.grossLoss,
    points: a.points + b.points,
  };
}

/** 依進場時間分段彙總：看「開盤後多久進場」比較好 */
export function techBucketRows(bots: TaifexTechBot[]): TaifexTechBucketRow[] {
  return TECH_BUCKETS.map((bucket) => {
    let total = emptyTechStat();
    const byBot = {} as Record<TaifexTechBotId, TaifexTechStatView>;
    TAIFEX_TECH_BOT_IDS.forEach((id) => {
      const stat = bots.find((b) => b.id === id)?.buckets[bucket.id] ?? emptyTechStat();
      total = addStat(total, stat);
      byBot[id] = statView(stat);
    });
    return { ...bucket, total: statView(total), byBot };
  });
}

export type TaifexTechCurvePoint = { label: string } & Record<TaifexTechBotId, number>;

/** 各頻率的累計淨損益（每個時段一點，pitfall #13：最多 90 點） */
export function techCurve(sessions: TaifexTechSessionSummary[], filter: TaifexSessionKind | 'all' = 'all'): TaifexTechCurvePoint[] {
  const acc: Record<TaifexTechBotId, number> = { m5: 0, m15: 0, m30: 0, m60: 0 };
  return sessions.filter((s) => filter === 'all' || s.session === filter).map((s) => {
    TAIFEX_TECH_BOT_IDS.forEach((id) => { acc[id] += s.pnl[id] ?? 0; });
    return { label: `${s.date.slice(5)} ${s.session === 'day' ? '日' : '夜'}`, ...acc };
  });
}

/**
 * 依台北時間判斷現在的時段（只看時鐘與星期，不含國定假日；假日由後端狀態 `status.state === 'closed'` 為準）。
 * weekday: 1（一）–7（日）。
 */
export function sessionByClock(weekday: number, hhmm: string): TaifexSessionKind | null {
  if (hhmm >= '08:45' && hhmm <= '13:45') return weekday <= 5 ? 'day' : null;
  if (hhmm >= '15:00') return weekday <= 5 ? 'night' : null;
  if (hhmm <= '05:00') return weekday >= 2 && weekday <= 6 ? 'night' : null;
  return null;
}

/** 自訂休市日輸入：逗號 / 空白 / 換行分隔的 yyyy-MM-dd；回傳排序去重後的清單與無法辨識的片段 */
export function parseHolidayInput(text: string): { dates: string[]; invalid: string[] } {
  const dates = new Set<string>();
  const invalid: string[] = [];
  text.split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean).forEach((token) => {
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(token);
    const month = m ? Number(m[2]) : 0;
    const day = m ? Number(m[3]) : 0;
    if (m && month >= 1 && month <= 12 && day >= 1 && day <= 31) dates.add(`${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    else invalid.push(token);
  });
  return { dates: [...dates].sort(), invalid };
}
