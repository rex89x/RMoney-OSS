/**
 * 股市雷達 Dashboard 的純函式（不碰 React / Firestore），由 apps/web/tests/stock-radar.test.cjs 測試。
 */
import { ACTION_ORDER } from './options';
import type { StockRadarAction, StockRadarItem, StockRadarMarket, StockRadarRun } from './types';

/** 每個市場最新一次評估；runs 需依 runDate 降冪 */
export function latestRunByMarket(runs: StockRadarRun[]): Partial<Record<StockRadarMarket, StockRadarRun>> {
  const out: Partial<Record<StockRadarMarket, StockRadarRun>> = {};
  runs.forEach((run) => {
    const current = out[run.market];
    if (!current || run.runDate > current.runDate) out[run.market] = run;
  });
  return out;
}

export interface ActionGroup {
  action: StockRadarAction;
  items: StockRadarItem[];
}

/** 依 ACTION_ORDER 分組，組內依綜合分數排序（減碼／出場由弱到強，其餘由強到弱） */
export function groupByAction(items: StockRadarItem[]): ActionGroup[] {
  return ACTION_ORDER.flatMap((action) => {
    const group = items.filter((item) => item.action === action);
    if (group.length === 0) return [];
    const ascending = action === 'exit' || action === 'trim';
    group.sort((a, b) => {
      const diff = (a.composite ?? 0) - (b.composite ?? 0);
      return ascending ? diff : -diff;
    });
    return [{ action, items: group }];
  });
}

export interface StockRadarOverview {
  held: number;
  needsAction: number;
  addCandidates: number;
  buyCandidates: number;
  /** 持股依市值加權的平均綜合分數 */
  weightedScore: number | null;
  /** 分數為負的持股占股票部位比例 */
  weakWeightPct: number;
}

export function buildOverview(items: StockRadarItem[]): StockRadarOverview {
  const held = items.filter((item) => item.held);
  let weightSum = 0;
  let scoreSum = 0;
  let weakWeight = 0;
  held.forEach((item) => {
    const weight = item.weightPct ?? 0;
    if (item.composite === null || weight <= 0) return;
    weightSum += weight;
    scoreSum += weight * item.composite;
    if (item.composite < 0) weakWeight += weight;
  });
  return {
    held: held.length,
    needsAction: items.filter((item) => item.action === 'trim' || item.action === 'exit').length,
    addCandidates: items.filter((item) => item.action === 'add').length,
    buyCandidates: items.filter((item) => item.action === 'buy').length,
    weightedScore: weightSum ? scoreSum / weightSum : null,
    weakWeightPct: weakWeight,
  };
}

export interface SymbolHistoryPoint {
  date: string;
  composite: number | null;
  close: number | null;
  action: StockRadarAction;
}

/** 單一標的的評估歷史（每天一點，升冪），給走勢圖用 */
export function symbolHistory(runs: StockRadarRun[], market: StockRadarMarket, symbol: string): SymbolHistoryPoint[] {
  const byDate = new Map<string, SymbolHistoryPoint>();
  runs.forEach((run) => {
    if (run.market !== market) return;
    const item = run.items.find((candidate) => candidate.symbol === symbol);
    if (!item) return;
    byDate.set(run.runDate, { date: run.runDate, composite: item.composite, close: item.close, action: item.action });
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** 動作與前一次評估不同的標的（「今天有變化」提示） */
export function changedActions(
  runs: StockRadarRun[],
  market: StockRadarMarket,
): Array<{ symbol: string; from: StockRadarAction; to: StockRadarAction }> {
  const marketRuns = runs.filter((run) => run.market === market).sort((a, b) => b.runDate.localeCompare(a.runDate));
  const [latest, previous] = marketRuns;
  if (!latest || !previous) return [];
  const prior = new Map(previous.items.map((item) => [item.symbol, item.action]));
  return latest.items.flatMap((item) => {
    const from = prior.get(item.symbol);
    return from && from !== item.action ? [{ symbol: item.symbol, from, to: item.action }] : [];
  });
}
