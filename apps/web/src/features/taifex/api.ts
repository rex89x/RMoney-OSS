import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { parseTaifexReview, parseTaifexTuning, type TaifexReview, type TaifexTuning } from './review';
import type { TaifexConfigInput } from './schema';
import { parseTaifexTech, parseTaifexTechTrades, type TaifexTechDoc, type TaifexTechTrade } from './tech';
import {
  parseTaifexAccount,
  parseTaifexBacktest,
  parseTaifexConfig,
  parseTaifexLive,
  parseTaifexOptimization,
  parseTaifexSentiment,
  taifexSignalConverter,
  taifexTradeConverter,
  type TaifexAccount,
  type TaifexBacktest,
  type TaifexConfig,
  type TaifexLiveDoc,
  type TaifexOptimization,
  type TaifexSentiment,
  type TaifexSignal,
  type TaifexTrade,
} from './types';

/** 帳戶、訊號、交易、輿情、回測都由 Apps Script 寫入（Rules write: false），前端只讀 */

export async function getTaifexAccount(): Promise<TaifexAccount | null> {
  const snap = await getDoc(doc(db, 'taifex_paper_accounts', 'default'));
  return snap.exists() ? parseTaifexAccount(snap.id, snap.data()) : null;
}

/** 最近 N 天訊號；單欄位排序（doc id = 日期），不需要 composite index */
export async function listTaifexSignals(max: number): Promise<TaifexSignal[]> {
  const ref = collection(db, 'taifex_signals').withConverter(taifexSignalConverter);
  const snap = await getDocs(query(ref, orderBy('date', 'desc'), limit(max)));
  return snap.docs.map((d) => d.data());
}

/** 主帳戶與策略變體的交易混在同一個 collection（accountId 區分）；單欄位排序後在前端分組，不需要 composite index */
export async function listTaifexTrades(max: number): Promise<TaifexTrade[]> {
  const ref = collection(db, 'taifex_paper_trades').withConverter(taifexTradeConverter);
  const snap = await getDocs(query(ref, orderBy('closeDate', 'desc'), limit(max)));
  return snap.docs.map((d) => d.data());
}

/** 主帳戶 + 策略變體帳戶（最多 5 筆） */
export async function listTaifexAccounts(): Promise<TaifexAccount[]> {
  const snap = await getDocs(collection(db, 'taifex_paper_accounts'));
  return snap.docs.map((d) => parseTaifexAccount(d.id, d.data())).filter((a): a is TaifexAccount => a !== null);
}

export async function getTaifexLive(): Promise<TaifexLiveDoc> {
  const snap = await getDoc(doc(db, 'taifex_live', 'current'));
  return parseTaifexLive(snap.exists() ? snap.data() : undefined);
}

/** 盤中技術模擬：狀態 + 4 個監控頻率的機器人 + 各時段摘要（單一文件） */
export async function getTaifexTech(): Promise<TaifexTechDoc | null> {
  const snap = await getDoc(doc(db, 'taifex_live', 'tech'));
  return snap.exists() ? parseTaifexTech(snap.data()) : null;
}

/** 盤中技術模擬最近 400 筆交易（單一文件，新的在前） */
export async function getTaifexTechTrades(): Promise<TaifexTechTrade[]> {
  const snap = await getDoc(doc(db, 'taifex_live', 'tech_trades'));
  return parseTaifexTechTrades(snap.exists() ? snap.data() : undefined);
}

export async function getTaifexOptimization(): Promise<TaifexOptimization | null> {
  const snap = await getDoc(doc(db, 'taifex_optimizations', 'latest'));
  return snap.exists() ? parseTaifexOptimization(snap.data()) : null;
}

/** 最新一筆 Claude 輿情（doc id = 台北日期） */
export async function getLatestTaifexSentiment(): Promise<TaifexSentiment | null> {
  const snap = await getDocs(query(collection(db, 'taifex_sentiment'), orderBy('date', 'desc'), limit(1)));
  const first = snap.docs[0];
  return first ? parseTaifexSentiment(first.id, first.data()) : null;
}

export async function getTaifexBacktest(): Promise<TaifexBacktest | null> {
  const snap = await getDoc(doc(db, 'taifex_backtests', 'latest'));
  return snap.exists() ? parseTaifexBacktest(snap.data()) : null;
}

/** 最近 N 週的檢討（doc id = 週日日期）；單欄位排序，不需要 composite index */
export async function listTaifexReviews(max: number): Promise<TaifexReview[]> {
  const snap = await getDocs(query(collection(db, 'taifex_reviews'), orderBy('weekEnd', 'desc'), limit(max)));
  return snap.docs.map((d) => parseTaifexReview(d.id, d.data())).filter((r): r is TaifexReview => r !== null);
}

/** 目前生效的調校值（owner 核准提案後由 Apps Script 寫入） */
export async function getTaifexTuning(): Promise<TaifexTuning> {
  const snap = await getDoc(doc(db, 'taifex_tuning', 'current'));
  return parseTaifexTuning(snap.exists() ? snap.data() : undefined);
}

const CONFIG_DOC = () => doc(db, 'taifex_configs', 'default');

export async function getTaifexConfig(): Promise<TaifexConfig> {
  const snap = await getDoc(CONFIG_DOC());
  return parseTaifexConfig(snap.exists() ? snap.data() : undefined);
}

export async function saveTaifexConfig(input: TaifexConfigInput): Promise<void> {
  await setDoc(CONFIG_DOC(), { ...input, updatedAt: new Date() }, { merge: true });
}
