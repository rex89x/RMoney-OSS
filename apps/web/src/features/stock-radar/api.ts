import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  parseStockRadarBacktest,
  parseStockRadarConfig,
  stockRadarOutcomeConverter,
  stockRadarRunConverter,
  type StockRadarBacktest,
  type StockRadarConfig,
  type StockRadarMarket,
  type StockRadarOutcome,
  type StockRadarRun,
} from './types';

export const stockRadarRunsCol = () =>
  collection(db, 'stock_radar_runs').withConverter(stockRadarRunConverter);

export const stockRadarOutcomesCol = () =>
  collection(db, 'stock_radar_outcomes').withConverter(stockRadarOutcomeConverter);

/** 最近的評估（兩個市場混在一起，每天各一筆）；單欄位排序，不需要 composite index */
export async function listStockRadarRuns(maxRuns: number): Promise<StockRadarRun[]> {
  const snapshot = await getDocs(query(stockRadarRunsCol(), orderBy('runDate', 'desc'), limit(maxRuns)));
  return snapshot.docs.map((item) => item.data());
}

export async function listStockRadarOutcomes(maxRuns: number): Promise<StockRadarOutcome[]> {
  const snapshot = await getDocs(query(stockRadarOutcomesCol(), orderBy('runDate', 'desc'), limit(maxRuns)));
  return snapshot.docs.map((item) => item.data());
}

export async function getStockRadarBacktest(market: StockRadarMarket): Promise<StockRadarBacktest | null> {
  const snapshot = await getDoc(doc(db, 'stock_radar_backtests', market));
  return snapshot.exists() ? parseStockRadarBacktest(market, snapshot.data()) : null;
}

const CONFIG_DOC = () => doc(db, 'stock_radar_configs', 'default');

export async function getStockRadarConfig(): Promise<StockRadarConfig> {
  const snapshot = await getDoc(CONFIG_DOC());
  return parseStockRadarConfig(snapshot.exists() ? snapshot.data() : undefined);
}

/** 複製提示詞後記下該市場的代號清單；之後追蹤清單變了就提醒重新複製 */
export async function markStockRadarPromptCopied(market: StockRadarMarket, symbols: string[]): Promise<void> {
  await setDoc(CONFIG_DOC(), {
    promptSymbols: { [market]: [...symbols].sort() },
    promptCopiedAt: { [market]: new Date() },
    updatedAt: new Date(),
  }, { merge: true });
}
