/**
 * 賣出成本計算：平均成本（預設）與 FIFO（先進先出）。純函式，executePortfolioTrade 與
 * 測試（apps/web/tests/investments-performance.test.cjs）共用。
 *
 * FIFO 的批次來源是 `portfolio.lots[]`：依日期重播所有買進（shares > 0）與賣出（shares < 0），
 * 賣出一律從最早的買進批次扣（舊的平均成本賣出也用 FIFO 重播，等同「當初就用 FIFO 辨認股份」）。
 * 重播結果與持倉股數對不上（手動改過持倉、舊資料缺批次）就判定批次不可靠 → 退回平均成本並標記 fallback。
 */
import type { CostBasisMethod } from '@/types/global';
import type { PortfolioLot, PortfolioPosition } from './types';

export type { CostBasisMethod };

export const DEFAULT_COST_BASIS_METHOD: CostBasisMethod = 'average';

export const COST_BASIS_LABEL: Record<CostBasisMethod, string> = {
  average: '平均成本',
  fifo: 'FIFO',
};

const SHARE_EPS = 1e-6;

export function parseCostBasisMethod(raw: unknown): CostBasisMethod {
  return raw === 'fifo' ? 'fifo' : 'average';
}

export interface OpenLot {
  date: Date;
  shares: number;
  /** 每股成本（原幣，含該批買進手續費；舊批次沒記 fee 就只含成交價） */
  unitCost: number;
}

export interface FifoReplay {
  openLots: OpenLot[];
  /** 批次重播可信：沒有超賣、剩餘股數與持倉一致 */
  reliable: boolean;
}

/** 依日期（同日保留原順序）重播 lots，回傳尚未賣出的買進批次 */
export function replayFifoLots(lots: PortfolioLot[], positionShares: number): FifoReplay {
  const ordered = lots
    .map((lot, i) => ({ lot, i }))
    .filter(({ lot }) => Number.isFinite(lot.shares) && lot.shares !== 0 && lot.date instanceof Date && Number.isFinite(lot.date.getTime()))
    .sort((a, b) => a.lot.date.getTime() - b.lot.date.getTime() || a.i - b.i);

  const open: OpenLot[] = [];
  let reliable = true;
  for (const { lot } of ordered) {
    if (lot.shares > 0) {
      const fee = typeof lot.fee === 'number' && Number.isFinite(lot.fee) ? Math.max(0, lot.fee) : 0;
      open.push({ date: lot.date, shares: lot.shares, unitCost: (lot.shares * lot.price + fee) / lot.shares });
      continue;
    }
    let toSell = -lot.shares;
    while (toSell > SHARE_EPS && open.length > 0) {
      const head = open[0];
      if (!head) break;
      const used = Math.min(head.shares, toSell);
      head.shares -= used;
      toSell -= used;
      if (head.shares <= SHARE_EPS) open.shift();
    }
    if (toSell > SHARE_EPS) reliable = false;
  }
  const remaining = open.reduce((s, l) => s + l.shares, 0);
  if (Math.abs(remaining - positionShares) > SHARE_EPS) reliable = false;
  return { openLots: open, reliable };
}

/** 持倉的批次是否足以用 FIFO（UI 用來提前提示會退回平均成本） */
export function canUseFifo(position: Pick<PortfolioPosition, 'shares' | 'lots'>): boolean {
  return replayFifoLots(position.lots ?? [], position.shares).reliable;
}

export interface SellPlanRow {
  shares: number;
  /** 這批每股成本（原幣）；平均成本法 = position.avgCost */
  unitCost: number;
  /** FIFO 被扣的買進批次日期；平均成本法為 null */
  buyDate: Date | null;
}

export interface SellPlan {
  /** 實際使用的方法 */
  method: CostBasisMethod;
  /** 要求 FIFO 但批次不可靠，退回平均成本 */
  fallback: boolean;
  rows: SellPlanRow[];
  remainingShares: number;
  /** 賣出後持倉的平均成本；平均成本法維持原值，FIFO = 剩餘批次成本 / 剩餘股數 */
  remainingAvgCost: number;
}

export function planSell(
  position: Pick<PortfolioPosition, 'shares' | 'avgCost' | 'lots'>,
  sharesToSell: number,
  requested: CostBasisMethod,
): SellPlan {
  const remainingShares = position.shares - sharesToSell;
  const averagePlan = (fallback: boolean): SellPlan => ({
    method: 'average',
    fallback,
    rows: [{ shares: sharesToSell, unitCost: position.avgCost, buyDate: null }],
    remainingShares,
    remainingAvgCost: position.avgCost,
  });
  if (requested !== 'fifo') return averagePlan(false);

  const replay = replayFifoLots(position.lots ?? [], position.shares);
  if (!replay.reliable) return averagePlan(true);

  const open = replay.openLots.map((l) => ({ ...l }));
  const rows: SellPlanRow[] = [];
  let toSell = sharesToSell;
  while (toSell > SHARE_EPS && open.length > 0) {
    const head = open[0];
    if (!head) break;
    const used = Math.min(head.shares, toSell);
    rows.push({ shares: used, unitCost: head.unitCost, buyDate: head.date });
    head.shares -= used;
    toSell -= used;
    if (head.shares <= SHARE_EPS) open.shift();
  }
  if (toSell > SHARE_EPS) return averagePlan(true);

  const remainingCost = open.reduce((s, l) => s + l.shares * l.unitCost, 0);
  return {
    method: 'fifo',
    fallback: false,
    rows,
    remainingShares,
    remainingAvgCost: remainingShares > SHARE_EPS ? remainingCost / remainingShares : position.avgCost,
  };
}

export interface RealizedRowAmounts {
  shares: number;
  unitCost: number;
  buyDate: Date | null;
  costTWD: number;
  proceedsTWD: number;
  realizedPnlTWD: number;
}

/**
 * 把一筆賣出的實收金額（TWD，已扣手續費）依股數分攤到各批，最後一批吃尾差，
 * 讓各批 proceeds 加總剛好等於實收。成本 TWD 一律用賣出當下匯率（與平均成本法一致）。
 * 只有一批時（平均成本法）proceeds 就是 cashTWD 本身，計算與舊版逐位元相同。
 */
export function realizedRows(plan: SellPlan, sharesSold: number, cashTWD: number, fxRate: number): RealizedRowAmounts[] {
  let allocated = 0;
  return plan.rows.map((row, i) => {
    const isLast = i === plan.rows.length - 1;
    const proceedsTWD = isLast ? cashTWD - allocated : (cashTWD * row.shares) / sharesSold;
    allocated += proceedsTWD;
    const costTWD = row.unitCost * row.shares * fxRate;
    return {
      shares: row.shares,
      unitCost: row.unitCost,
      buyDate: row.buyDate,
      costTWD,
      proceedsTWD,
      realizedPnlTWD: proceedsTWD - costTWD,
    };
  });
}
