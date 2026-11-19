import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit as qLimit,
  orderBy,
  query,
  runTransaction,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Account } from '@/features/accounts';
import { parseCostBasisMethod, planSell, realizedRows, type CostBasisMethod } from './cost-basis';
import {
  Candle,
  candleConverter,
  Dividend,
  dividendConverter,
  investmentPlanConverter,
  InvestmentPlan,
  PortfolioLot,
  PortfolioPosition,
  portfolioConverter,
  PortfolioSnapshot,
  portfolioSnapshotConverter,
  RealizedLot,
  realizedLotConverter,
  Stock,
  stockConverter,
  StockHistoryPoint,
  stockHistoryConverter,
  SwingPaperTrade,
  swingPaperTradeConverter,
  SwingPaperSummary,
  swingPaperSummaryConverter,
  SwingPaperSyncRun,
  swingPaperSyncRunConverter,
  SwingSignalRun,
  swingSignalRunConverter,
  SwingStrategyConfig,
  swingStrategyConfigConverter,
  WatchlistEntry,
  watchlistConverter,
  type Market,
} from './types';
import { inferCurrency, inferMarket } from './symbol-utils';

export const stocksCol = () => collection(db, 'stocks').withConverter(stockConverter);
export const watchlistCol = () => collection(db, 'watchlist').withConverter(watchlistConverter);
export const portfolioCol = () => collection(db, 'portfolio').withConverter(portfolioConverter);
export const investmentPlansCol = () =>
  collection(db, 'investment_plans').withConverter(investmentPlanConverter);
export const portfolioSnapshotsCol = () =>
  collection(db, 'portfolio_snapshots').withConverter(portfolioSnapshotConverter);
export const swingStrategyConfigsCol = () =>
  collection(db, 'swing_strategy_configs').withConverter(swingStrategyConfigConverter);
export const swingSignalRunsCol = () =>
  collection(db, 'swing_signal_runs').withConverter(swingSignalRunConverter);
export const swingPaperTradesCol = () =>
  collection(db, 'swing_paper_trades').withConverter(swingPaperTradeConverter);
export const swingPaperSummariesCol = () =>
  collection(db, 'swing_paper_summaries').withConverter(swingPaperSummaryConverter);
export const swingPaperSyncRunsCol = () =>
  collection(db, 'swing_paper_sync_runs').withConverter(swingPaperSyncRunConverter);

export async function listStocks(): Promise<Stock[]> {
  const snap = await getDocs(query(stocksCol(), orderBy('symbol', 'asc')));
  return snap.docs.map((d) => d.data());
}

export async function getStock(symbol: string): Promise<Stock | null> {
  const snap = await getDoc(doc(db, 'stocks', symbol).withConverter(stockConverter));
  return snap.exists() ? snap.data() : null;
}

export async function getStockHistory(
  symbol: string,
  limitPoints = 200,
): Promise<StockHistoryPoint[]> {
  const ref = collection(db, 'stocks', symbol, 'history').withConverter(stockHistoryConverter);
  const q = query(ref, orderBy('timestamp', 'desc'), qLimit(limitPoints));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()).reverse();
}

export async function getStockCandles(symbol: string, limitDays = 260): Promise<Candle[]> {
  const ref = collection(db, 'stocks', symbol, 'candles').withConverter(candleConverter);
  const q = query(ref, orderBy('date', 'desc'), qLimit(limitDays));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()).reverse();
}

export async function deleteHistoryRange(
  symbol: string,
  start: Date,
  end: Date,
): Promise<number> {
  const ref = collection(db, 'stocks', symbol, 'history');
  const q = query(
    ref,
    where('timestamp', '>=', Timestamp.fromDate(start)),
    where('timestamp', '<=', Timestamp.fromDate(end)),
  );
  const snap = await getDocs(q);
  if (snap.empty) return 0;
  const batch = writeBatch(db);
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}

export async function addToWatchlist(userId: string, symbol: string, note?: string) {
  const id = `${userId}_${symbol}`;
  const ref = doc(db, 'watchlist', id).withConverter(watchlistConverter);
  await setDoc(ref, {
    id,
    userId,
    symbol,
    note,
    addedAt: new Date(),
  });
  // 順手寫 stocks/{sym} 佔位 doc — Apps Script 抓價尚未跑完前，前端就有 market info
  // 可顯示，且日後 updateStockPrices 取 watchlist symbols 時 market 推斷不會迷路。
  // 用 merge 確保已存在的 doc 不被洗掉現有價格欄位。
  const stockRef = doc(db, 'stocks', symbol).withConverter(stockConverter);
  const existing = await getDoc(stockRef);
  if (!existing.exists()) {
    // 台股：4–6 碼數字 + 英文字尾（00878、00981A…）；以前只認 4 碼，其他都被當成美股（symbol-utils.ts）
    const market: 'TW' | 'US' = inferMarket(symbol);
    await setDoc(
      stockRef,
      {
        symbol,
        market,
        name: symbol,
        currency: inferCurrency(symbol),
        currentPrice: 0,
        prevClose: 0,
        change: 0,
        changePercent: 0,
        high: 0,
        low: 0,
        open: 0,
        volume: 0,
        updatedAt: null,
      } as unknown as Stock,
      { merge: true },
    );
  }
}

export async function removeFromWatchlist(userId: string, symbol: string) {
  await deleteDoc(doc(db, 'watchlist', `${userId}_${symbol}`));
}

export async function listWatchlist(userId: string): Promise<WatchlistEntry[]> {
  const q = query(watchlistCol(), where('userId', '==', userId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

// Portfolio
export async function listPortfolio(userId: string): Promise<PortfolioPosition[]> {
  const q = query(portfolioCol(), where('userId', '==', userId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function upsertPortfolioPosition(
  pos: Omit<PortfolioPosition, 'id'>,
  id?: string,
): Promise<string> {
  if (id) {
    await setDoc(
      doc(db, 'portfolio', id).withConverter(portfolioConverter),
      { ...pos, id } as PortfolioPosition,
      { merge: true },
    );
    return id;
  }
  const ref = await addDoc(portfolioCol(), pos as unknown as PortfolioPosition);
  return ref.id;
}

export async function deletePortfolioPosition(id: string) {
  await deleteDoc(doc(db, 'portfolio', id));
}

export async function listInvestmentPlans(userId: string): Promise<InvestmentPlan[]> {
  const q = query(
    investmentPlansCol(),
    where('userId', '==', userId),
    where('archivedAt', '==', null),
    orderBy('updatedAt', 'desc'),
    qLimit(20),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function upsertInvestmentPlan(
  input: Omit<InvestmentPlan, 'id' | 'createdAt' | 'updatedAt' | 'archivedAt'>,
  id?: string,
): Promise<string> {
  const now = new Date();
  if (id) {
    const ref = doc(db, 'investment_plans', id).withConverter(investmentPlanConverter);
    const existing = await getDoc(ref);
    await setDoc(
      ref,
      {
        ...input,
        id,
        archivedAt: null,
        createdAt: existing.exists() ? existing.data().createdAt : now,
        updatedAt: now,
      } as InvestmentPlan,
      { merge: true },
    );
    return id;
  }
  const ref = doc(investmentPlansCol());
  await setDoc(ref, {
    ...input,
    id: ref.id,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  } as InvestmentPlan);
  return ref.id;
}

export async function archiveInvestmentPlan(id: string): Promise<void> {
  const now = new Date();
  await setDoc(
    doc(db, 'investment_plans', id).withConverter(investmentPlanConverter),
    { archivedAt: now, updatedAt: now } as Partial<InvestmentPlan>,
    { merge: true },
  );
}

export async function listSwingStrategyConfigs(userId: string): Promise<SwingStrategyConfig[]> {
  const q = query(
    swingStrategyConfigsCol(),
    where('userId', '==', userId),
    orderBy('updatedAt', 'desc'),
    qLimit(10),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function upsertSwingStrategyConfig(
  input: Omit<SwingStrategyConfig, 'id' | 'createdAt' | 'updatedAt'>,
  id?: string,
): Promise<string> {
  const now = new Date();
  if (id) {
    const ref = doc(db, 'swing_strategy_configs', id).withConverter(swingStrategyConfigConverter);
    const existing = await getDoc(ref);
    await setDoc(ref, {
      ...input,
      id,
      createdAt: existing.exists() ? existing.data().createdAt : now,
      updatedAt: now,
    } as SwingStrategyConfig, { merge: true });
    return id;
  }
  const ref = doc(swingStrategyConfigsCol());
  await setDoc(ref, {
    ...input,
    id: ref.id,
    createdAt: now,
    updatedAt: now,
  } as SwingStrategyConfig);
  return ref.id;
}

export async function getLatestSwingSignalRun(): Promise<SwingSignalRun | null> {
  const snap = await getDocs(query(swingSignalRunsCol(), orderBy('runDate', 'desc'), qLimit(1)));
  return snap.empty ? null : snap.docs[0]!.data(); // 非空：snap.empty 已先檢查
}

export async function listSwingSignalRuns(limitRuns = 20): Promise<SwingSignalRun[]> {
  const snap = await getDocs(
    query(swingSignalRunsCol(), orderBy('runDate', 'desc'), qLimit(limitRuns)),
  );
  return snap.docs.map((d) => d.data());
}

export async function listSwingPaperTrades(
  userId: string,
  limitTrades = 100,
): Promise<SwingPaperTrade[]> {
  const q = query(
    swingPaperTradesCol(),
    where('userId', '==', userId),
    orderBy('updatedAt', 'desc'),
    qLimit(limitTrades),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function getSwingPaperSummary(userId: string): Promise<SwingPaperSummary | null> {
  const snap = await getDoc(
    doc(db, 'swing_paper_summaries', userId).withConverter(swingPaperSummaryConverter),
  );
  return snap.exists() ? snap.data() : null;
}

export async function getLatestSwingPaperSyncRun(): Promise<SwingPaperSyncRun | null> {
  const snap = await getDocs(query(swingPaperSyncRunsCol(), orderBy('runDate', 'desc'), qLimit(1)));
  return snap.empty ? null : snap.docs[0]!.data(); // 非空：snap.empty 已先檢查
}

export async function updateSwingPaperTradeStatus(
  id: string,
  patch: Pick<SwingPaperTrade, 'status'> & Partial<Pick<SwingPaperTrade, 'notes'>>,
): Promise<void> {
  await setDoc(
    doc(db, 'swing_paper_trades', id).withConverter(swingPaperTradeConverter),
    { ...patch, updatedAt: new Date() } as Partial<SwingPaperTrade>,
    { merge: true },
  );
}

type PortfolioTradeSide = 'buy' | 'sell';

export interface ExecutePortfolioTradeInput {
  userId: string;
  side: PortfolioTradeSide;
  symbol: string;
  shares: number;
  price: number;
  currency: 'TWD' | 'USD';
  fxRate: number;
  accountFxRate?: number;
  accountId: string;
  existingPositionId?: string;
  market?: Market;
  /** 成交日（預設現在）；AI 匯入歷史成交時用 */
  date?: Date;
  /** 手續費 + 交易稅（原幣）：買進算進成本、賣出從所得扣除、帳戶也照實扣 */
  fee?: number;
  note?: string;
  /** 賣出成本法；未指定時讀 users/{uid}.preferences.costBasisMethod（預設 average） */
  costBasisMethod?: CostBasisMethod;
}

// 投資偏好（users/{uid}.preferences.costBasisMethod）
export async function getCostBasisMethod(userId: string): Promise<CostBasisMethod> {
  const snap = await getDoc(doc(db, 'users', userId));
  const prefs: unknown = snap.exists() ? snap.get('preferences') : null;
  const raw = prefs && typeof prefs === 'object' ? (prefs as { costBasisMethod?: unknown }).costBasisMethod : undefined;
  return parseCostBasisMethod(raw);
}

export async function setCostBasisMethod(userId: string, method: CostBasisMethod): Promise<void> {
  await updateDoc(doc(db, 'users', userId), { 'preferences.costBasisMethod': method });
}

function accountBalancePatch(
  account: Account,
  currency: 'TWD' | 'USD',
  nativeDelta: number,
  twdDelta: number,
  accountFxRate?: number,
): Pick<Account, 'balance' | 'balanceTWD' | 'balanceUpdatedAt' | 'updatedAt'> {
  const currentBalance = typeof account.balance === 'number' ? account.balance : 0;
  const rate = typeof accountFxRate === 'number' && Number.isFinite(accountFxRate) && accountFxRate > 0
    ? accountFxRate
    : 1;
  const balanceDelta = account.currency === currency
    ? nativeDelta
    : account.currency === 'TWD'
      ? twdDelta
      : twdDelta / rate;
  const nextBalance = currentBalance + balanceDelta;
  const now = new Date();
  return {
    balance: nextBalance,
    balanceTWD: account.currency === 'TWD' ? nextBalance : nextBalance * rate,
    balanceUpdatedAt: now,
    updatedAt: now,
  };
}

export async function executePortfolioTrade(input: ExecutePortfolioTradeInput): Promise<string | null> {
  const fee = Math.max(0, input.fee ?? 0);
  // 買進：帳戶扣「成交 + 費用」、成本含費用；賣出：帳戶收「成交 − 費用」、所得已扣費用
  const grossNative = input.shares * input.price;
  const cashNative = input.side === 'buy' ? grossNative + fee : grossNative - fee;
  const cashTWD = cashNative * input.fxRate;
  const now = input.date ?? new Date();
  const lot: PortfolioLot = {
    date: now,
    shares: input.side === 'buy' ? input.shares : -input.shares,
    price: input.price,
    // 買進批次記下手續費，FIFO 每批成本才會含費用（與 avgCost 一致）；不影響平均成本計算
    ...(input.side === 'buy' && fee > 0 ? { fee } : {}),
  };
  const costBasisMethod: CostBasisMethod = input.side === 'sell'
    ? input.costBasisMethod ?? await getCostBasisMethod(input.userId)
    : 'average';
  const accountRef = doc(db, 'accounts', input.accountId);
  const positionRef = input.existingPositionId
    ? doc(db, 'portfolio', input.existingPositionId).withConverter(portfolioConverter)
    : doc(collection(db, 'portfolio')).withConverter(portfolioConverter);

  return runTransaction(db, async (tx) => {
    const [accountSnap, positionSnap] = await Promise.all([
      tx.get(accountRef),
      input.existingPositionId ? tx.get(positionRef) : Promise.resolve(null),
    ]);
    if (!accountSnap.exists()) throw new Error('找不到交易帳戶');
    const account = { ...(accountSnap.data() as Account), id: accountSnap.id };
    const accountPatch = accountBalancePatch(
      account,
      input.currency,
      input.side === 'buy' ? -cashNative : cashNative,
      input.side === 'buy' ? -cashTWD : cashTWD,
      input.accountFxRate ?? (account.currency === input.currency ? input.fxRate : 1),
    );

    if (input.side === 'buy') {
      const existing = positionSnap?.exists() ? positionSnap.data() : null;
      if (existing) {
        const totalShares = existing.shares + input.shares;
        const avgCost = totalShares > 0
          ? ((existing.avgCost * existing.shares) + cashNative) / totalShares
          : input.price;
        tx.set(positionRef, {
          ...existing,
          shares: totalShares,
          avgCost,
          currency: existing.currency,
          lots: [...existing.lots, lot],
        } as PortfolioPosition, { merge: true });
      } else {
        tx.set(positionRef, {
          id: positionRef.id,
          userId: input.userId,
          symbol: input.symbol,
          shares: input.shares,
          avgCost: input.shares > 0 ? cashNative / input.shares : input.price,
          currency: input.currency,
          lots: [lot],
        } as PortfolioPosition);
      }
    } else {
      const existing = positionSnap?.exists() ? positionSnap.data() : null;
      if (!existing) throw new Error('找不到可賣出的持倉');
      if (input.shares > existing.shares) throw new Error('賣出股數超過持有股數');

      const remaining = existing.shares - input.shares;
      // average：一筆、成本 = avgCost（與舊版完全相同）；fifo：每個被扣的買進批次一筆
      const plan = planSell(existing, input.shares, costBasisMethod);
      const createdAt = new Date();
      for (const row of realizedRows(plan, input.shares, cashTWD, input.fxRate)) {
        const realizedRef = doc(collection(db, 'realized_lots')).withConverter(realizedLotConverter);
        tx.set(realizedRef, {
          id: realizedRef.id,
          symbol: input.symbol,
          market: input.market ?? (input.currency === 'USD' ? 'US' : 'TW'),
          sellDate: now,
          shares: row.shares,
          avgCost: row.unitCost,
          sellPrice: input.price,
          currency: existing.currency,
          fxRate: input.fxRate,
          costTWD: row.costTWD,
          proceedsTWD: row.proceedsTWD,
          realizedPnlTWD: row.realizedPnlTWD,
          note: input.note ?? null,
          costBasisMethod: plan.method,
          ...(plan.fallback ? { costBasisFallback: true } : {}),
          ...(row.buyDate ? { buyDate: row.buyDate } : {}),
          createdAt,
        } as RealizedLot);
      }

      if (remaining <= 0) {
        tx.delete(positionRef);
      } else {
        tx.set(positionRef, {
          ...existing,
          shares: remaining,
          // FIFO：剩餘持倉成本 = 未賣出批次的成本；平均成本法 avgCost 不變
          ...(plan.method === 'fifo' ? { avgCost: plan.remainingAvgCost } : {}),
          lots: [...existing.lots, lot],
        } as PortfolioPosition, { merge: true });
      }
    }

    tx.update(accountRef, {
      balance: accountPatch.balance,
      balanceTWD: accountPatch.balanceTWD,
      balanceUpdatedAt: Timestamp.fromDate(accountPatch.balanceUpdatedAt),
      updatedAt: Timestamp.fromDate(accountPatch.updatedAt),
    });

    return input.side === 'buy' ? positionRef.id : null;
  });
}

// Portfolio snapshots

export async function getLatestSnapshot(): Promise<PortfolioSnapshot | null> {
  const snap = await getDocs(query(portfolioSnapshotsCol(), orderBy('date', 'desc'), qLimit(1)));
  return snap.empty ? null : snap.docs[0]!.data(); // 非空：snap.empty 已先檢查
}

export async function listSnapshots(days = 90): Promise<PortfolioSnapshot[]> {
  const snap = await getDocs(query(portfolioSnapshotsCol(), orderBy('date', 'desc'), qLimit(days)));
  return snap.docs.map((d) => d.data()).reverse();
}

/**
 * 從某日（含）起的所有快照，依日期升冪；fromKey = null 代表全部。
 * 績效卡（XIRR / TWR）用；上限 2000 筆（約 5.5 年日快照）避免無上限讀取。
 * 只對 `date` 單欄位 where + orderBy，不需要 composite index。
 */
export async function listSnapshotsSince(fromKey: string | null, maxDocs = 2000): Promise<PortfolioSnapshot[]> {
  const q = fromKey
    ? query(portfolioSnapshotsCol(), where('date', '>=', fromKey), orderBy('date', 'asc'), qLimit(maxDocs))
    : query(portfolioSnapshotsCol(), orderBy('date', 'asc'), qLimit(maxDocs));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function getSnapshot(dateKey: string): Promise<PortfolioSnapshot | null> {
  const ref = doc(db, 'portfolio_snapshots', dateKey).withConverter(portfolioSnapshotConverter);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

// Realized lots (賣出記錄)
export const realizedLotsCol = () => collection(db, 'realized_lots').withConverter(realizedLotConverter);

export async function listRealizedLots(): Promise<RealizedLot[]> {
  const snap = await getDocs(query(realizedLotsCol(), orderBy('sellDate', 'desc')));
  return snap.docs.map((d) => d.data());
}

export async function addRealizedLot(input: Omit<RealizedLot, 'id' | 'createdAt'>): Promise<string> {
  const ref = doc(realizedLotsCol());
  const data = { ...input, id: ref.id, createdAt: new Date() } as RealizedLot;
  await setDoc(ref, data);
  return ref.id;
}

// Dividends
export const dividendsCol = () => collection(db, 'dividends').withConverter(dividendConverter);

export async function listDividends(): Promise<Dividend[]> {
  const snap = await getDocs(query(dividendsCol(), orderBy('payDate', 'desc')));
  return snap.docs.map((d) => d.data());
}

export async function addDividend(input: Omit<Dividend, 'id' | 'createdAt'>): Promise<string> {
  const ref = doc(dividendsCol());
  await setDoc(ref, { ...input, id: ref.id, createdAt: new Date() } as Dividend);
  return ref.id;
}

export async function deleteDividend(id: string) { await deleteDoc(doc(db, 'dividends', id)); }
export async function deleteRealizedLot(id: string) { await deleteDoc(doc(db, 'realized_lots', id)); }
