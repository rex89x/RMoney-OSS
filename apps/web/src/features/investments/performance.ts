/**
 * 投資績效：XIRR（資金加權、年化）與 TWR（時間加權）。純函式、無 Firestore 依賴，
 * 方便在 node:test 直接驗證（apps/web/tests/investments-performance.test.cjs）。
 *
 * 資料來源（詳見 README「績效 XIRR / TWR」）：
 * - 市值：`portfolio_snapshots/{yyyy-MM-dd}.totalValueTWD`（Apps Script 每日凍結匯率計算）
 * - 外部現金流：相鄰兩筆快照間，各持股「原幣成本 avgCost × shares」的變動 × 快照匯率
 *   （買進 = 成本增加 = 投入；賣出 = 成本減少），再扣掉同期間寫入的 `realized_lots.realizedPnlTWD`
 *   把賣出流量從「成本」修正成「實收賣出款」；`dividends.amountTWD` 視為提出（收益落到現金帳戶）。
 *   用快照差額而不是 `portfolio.lots`：lots 沒存匯率 / 舊資料沒存手續費，
 *   且持倉全部賣光時文件會被刪除、買進紀錄跟著消失；快照差額在快照涵蓋期間內是完整的。
 */
import { dateInputToTWDate, formatTWDateInput } from '@/lib/tz';

const DAY_MS = 86_400_000;
const EPS = 1e-9;

export interface CashFlow {
  date: Date;
  /** 投資人視角：買進 / 投入為負，賣出 / 股息 / 期末市值為正 */
  amount: number;
}

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * XIRR：解 Σ amount_i / (1 + r)^(t_i) = 0，t_i = (date_i − date_0) / 365（Actual/365）。
 * 先用 Newton-Raphson（起點 10%），不收斂或跑出 (−1, ∞) 時改用區間二分法。
 *
 * 回傳 null 的情況：少於 2 筆有效現金流、全部同號、期間不到 1 天、找不到根。
 */
export function xirr(cashflows: CashFlow[]): number | null {
  const flows = cashflows
    .filter((f) => isValidDate(f.date) && Number.isFinite(f.amount) && f.amount !== 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (flows.length < 2) return null;
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;

  const first = flows[0];
  const last = flows[flows.length - 1];
  if (!first || !last) return null;
  const t0 = first.date.getTime();
  const spanDays = (last.date.getTime() - t0) / DAY_MS;
  if (spanDays < 1) return null;

  const terms = flows.map((f) => ({ a: f.amount, t: (f.date.getTime() - t0) / DAY_MS / 365 }));
  const scale = Math.max(...terms.map((x) => Math.abs(x.a)));
  const tolerance = scale * 1e-9;

  const npv = (r: number): number => {
    let s = 0;
    for (const { a, t } of terms) s += a / Math.pow(1 + r, t);
    return s;
  };
  const dnpv = (r: number): number => {
    let s = 0;
    for (const { a, t } of terms) s -= (t * a) / Math.pow(1 + r, t + 1);
    return s;
  };

  // 1) Newton-Raphson
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(r);
    if (!Number.isFinite(f)) break;
    if (Math.abs(f) <= tolerance) return r;
    const d = dnpv(r);
    if (!Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12) {
      if (Math.abs(npv(next)) <= tolerance * 1e3) return next;
      break;
    }
    r = next;
  }

  // 2) 二分法：從 −99.9999% 往上掃，找第一個變號區間
  const grid = [-0.999999, -0.99, -0.9, -0.5, -0.2, 0, 0.2, 0.5, 1, 2, 5, 10, 100, 1_000, 10_000, 1_000_000];
  let lo: number | null = null;
  let hi: number | null = null;
  let fLo = 0;
  for (let i = 0; i < grid.length - 1; i++) {
    const a = grid[i];
    const b = grid[i + 1];
    if (a === undefined || b === undefined) continue;
    const fa = npv(a);
    const fb = npv(b);
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) continue;
    if (fa === 0) return a;
    if (fa * fb < 0) { lo = a; hi = b; fLo = fa; break; }
  }
  if (lo === null || hi === null) return null;
  let a: number = lo;
  let b: number = hi;
  for (let i = 0; i < 300; i++) {
    const mid: number = (a + b) / 2;
    const fm = npv(mid);
    if (!Number.isFinite(fm)) return null;
    if (Math.abs(fm) <= tolerance || (b - a) / 2 < 1e-12) return mid;
    if (fm * fLo < 0) { b = mid; } else { a = mid; fLo = fm; }
  }
  return null;
}

export interface ValuePoint {
  date: Date;
  valueTWD: number;
}

export interface ExternalFlow {
  date: Date;
  /** Portfolio 視角：正 = 投入（買進），負 = 提出（賣出款、股息） */
  amountTWD: number;
}

export interface TwrResult {
  /** 期間累積報酬（0.1 = 10%） */
  periodReturn: number;
  /** 期間 > 365 天才年化，否則 null */
  annualized: number | null;
  days: number;
  start: Date;
  end: Date;
  /** 累積指數（期初 = 100），與輸入快照（依日期排序後）一一對應 */
  series: Array<{ date: Date; index: number }>;
}

/**
 * TWR：相鄰快照切成子期間，r_i = (V_i + W_i) / (V_{i−1} + C_i) − 1，再連乘。
 *
 * 現金流慣例（一致套用）：
 * - flow 歸屬到 `prev.date < flow.date ≤ cur.date` 的子期間
 * - 投入（amountTWD > 0，C_i）視為發生在子期間「期初」：加進分母，當天就承擔市場波動
 * - 提出（amountTWD < 0，W_i = −Σ）視為發生在子期間「期末」：加回分子
 * 這樣第一次買進（V_{i−1} = 0）或全部賣光（V_i = 0）都不會除以 0。
 * 分母 ≤ 0（該子期間沒有任何資金在場）時，該子期間報酬視為 0。
 */
export function twr(snapshots: ValuePoint[], flows: ExternalFlow[]): TwrResult | null {
  const points = snapshots
    .filter((p) => isValidDate(p.date) && Number.isFinite(p.valueTWD))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (points.length < 2) return null;
  const validFlows = flows.filter((f) => isValidDate(f.date) && Number.isFinite(f.amountTWD) && f.amountTWD !== 0);

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;

  let growth = 1;
  const series: TwrResult['series'] = [{ date: first.date, index: 100 }];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!prev || !cur) continue;
    const p0 = prev.date.getTime();
    const p1 = cur.date.getTime();
    let contributions = 0;
    let withdrawals = 0;
    for (const f of validFlows) {
      const t = f.date.getTime();
      if (t <= p0 || t > p1) continue;
      if (f.amountTWD > 0) contributions += f.amountTWD;
      else withdrawals -= f.amountTWD;
    }
    const denom = prev.valueTWD + contributions;
    if (denom > EPS) {
      const ratio = (cur.valueTWD + withdrawals) / denom;
      if (Number.isFinite(ratio) && ratio >= 0) growth *= ratio;
    }
    series.push({ date: cur.date, index: growth * 100 });
  }

  const days = (last.date.getTime() - first.date.getTime()) / DAY_MS;
  const periodReturn = growth - 1;
  const annualized = days > 365 && growth > 0 ? Math.pow(growth, 365 / days) - 1 : null;
  return { periodReturn, annualized, days, start: first.date, end: last.date, series };
}

// ---------------------------------------------------------------------------
// 從 Firestore 資料組出 TWR / XIRR 需要的市值點與外部現金流
// ---------------------------------------------------------------------------

export interface PerfSnapshotInput {
  /** yyyy-MM-dd（台北） */
  date: string;
  /** 快照實際寫入時間（同日重跑會覆寫） */
  createdAt: Date;
  totalValueTWD: number;
  positions: Array<{ symbol: string; shares: number; avgCost: number; fxRate: number }>;
}

export interface PerfRealizedInput {
  symbol: string;
  /** realized_lots 寫入時間：用它判斷賣出發生在哪兩張快照之間 */
  createdAt: Date;
  realizedPnlTWD: number;
}

export interface PerfDividendInput {
  payDate: Date;
  amountTWD: number;
}

export interface PortfolioFlowSeries {
  /** 依日期排序的快照市值點 */
  points: ValuePoint[];
  /** 與 points 平行的 yyyy-MM-dd */
  keys: string[];
  flows: ExternalFlow[];
}

/**
 * 相鄰快照之間：
 * - 每檔持股 flow = (avgCost₁·shares₁ − avgCost₀·shares₀) × fx（期末快照匯率；已出清則用期初匯率）
 *   − 同期間（依 createdAt 落在兩張快照寫入時間之間）該檔 realized_lots.realizedPnlTWD
 *   → 買進 ≈ +實付金額（含手續費），賣出 ≈ −實收賣出款
 * - 股息：payDate 落在 (prev.date, cur.date] 的 dividends.amountTWD → 提出（負值）
 * 所有 flow 都標在期末快照的日期，交給 `twr` / `xirr` 用同一套歸屬規則。
 */
export function buildPortfolioFlows(
  snapshots: PerfSnapshotInput[],
  realized: PerfRealizedInput[],
  dividends: PerfDividendInput[],
): PortfolioFlowSeries {
  const sorted = snapshots
    .map((s) => ({ s, date: dateInputToTWDate(s.date) }))
    .filter((x): x is { s: PerfSnapshotInput; date: Date } => x.date !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const points: ValuePoint[] = sorted.map(({ s, date }) => ({ date, valueTWD: s.totalValueTWD }));
  const keys = sorted.map(({ s }) => s.date);
  const flows: ExternalFlow[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;

    const bySymbol = new Map<string, number>();
    const prevPos = new Map(prev.s.positions.map((p) => [p.symbol, p]));
    const curPos = new Map(cur.s.positions.map((p) => [p.symbol, p]));
    const symbols = new Set([...prevPos.keys(), ...curPos.keys()]);
    for (const sym of symbols) {
      const a = prevPos.get(sym);
      const b = curPos.get(sym);
      const c0 = a ? (a.avgCost || 0) * (a.shares || 0) : 0;
      const c1 = b ? (b.avgCost || 0) * (b.shares || 0) : 0;
      const fx = b?.fxRate || a?.fxRate || 1;
      const delta = (c1 - c0) * fx;
      if (Number.isFinite(delta) && Math.abs(delta) > EPS) bySymbol.set(sym, delta);
    }

    const t0 = prev.s.createdAt.getTime();
    const t1 = cur.s.createdAt.getTime();
    for (const lot of realized) {
      const t = lot.createdAt.getTime();
      if (!Number.isFinite(t) || t <= t0 || t > t1) continue;
      bySymbol.set(lot.symbol, (bySymbol.get(lot.symbol) ?? 0) - (lot.realizedPnlTWD || 0));
    }

    for (const amount of bySymbol.values()) {
      if (Number.isFinite(amount) && Math.abs(amount) > EPS) flows.push({ date: cur.date, amountTWD: amount });
    }

    for (const d of dividends) {
      if (!isValidDate(d.payDate) || !(d.amountTWD > 0)) continue;
      const key = formatTWDateInput(d.payDate);
      if (key > prev.s.date && key <= cur.s.date) flows.push({ date: cur.date, amountTWD: -d.amountTWD });
    }
  }

  return { points, keys, flows };
}

export interface PerformanceResult {
  /** 年化 XIRR（0.1 = 10%），無法計算時 null */
  xirr: number | null;
  twr: TwrResult | null;
  /** 實際使用的期初快照日（可能晚於要求的起點） */
  baseKey: string;
  endKey: string;
  /** 快照歷史不足以涵蓋要求的起點 */
  coverageShort: boolean;
  days: number;
}

/**
 * 依期間起點（yyyy-MM-dd，null = 全部）計算 XIRR 與 TWR。
 * 期初快照 = 起點當天或之前最後一筆，沒有就用起點後第一筆（coverageShort = true）。
 * XIRR 現金流：期初市值當作投入（負）→ 期間 flows（取負號轉成投資人視角）→ 期末市值（正）。
 */
export function computePortfolioPerformance(
  series: PortfolioFlowSeries,
  startKey: string | null,
): PerformanceResult | null {
  const { points, keys, flows } = series;
  if (points.length < 2) return null;
  let baseIdx = 0;
  let coverageShort = false;
  if (startKey) {
    let found = -1;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k !== undefined && k <= startKey) found = i;
    }
    if (found >= 0) baseIdx = found;
    else coverageShort = true;
  }
  const window = points.slice(baseIdx);
  const base = window[0];
  const end = window[window.length - 1];
  const baseKey = keys[baseIdx];
  const endKey = keys[keys.length - 1];
  if (window.length < 2 || !base || !end || !baseKey || !endKey) return null;

  const b0 = base.date.getTime();
  const b1 = end.date.getTime();
  const windowFlows = flows.filter((f) => f.date.getTime() > b0 && f.date.getTime() <= b1);

  const cashflows: CashFlow[] = [
    { date: base.date, amount: -base.valueTWD },
    ...windowFlows.map((f) => ({ date: f.date, amount: -f.amountTWD })),
    { date: end.date, amount: end.valueTWD },
  ];

  return {
    xirr: xirr(cashflows),
    twr: twr(window, windowFlows),
    baseKey,
    endKey,
    coverageShort,
    days: (b1 - b0) / DAY_MS,
  };
}
