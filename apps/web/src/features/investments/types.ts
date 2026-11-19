import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
import type { CostBasisMethod } from '@/types/global';

export type Market = 'TW' | 'US';

export interface Stock {
  id: string; // same as symbol
  symbol: string;
  market: Market;
  name: string;
  currency: 'TWD' | 'USD';
  currentPrice: number;
  prevClose: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  open: number;
  volume: number;
  updatedAt: Date | null;
  /** Apps Script updateDividendCalendar 寫入的除權息預告（台股） */
  upcomingDividend?: UpcomingDividend | null;
}

export interface UpcomingDividend {
  /** yyyy-MM-dd（台北） */
  exDate: string;
  cashPerShare: number;
  stockPerShare: number;
  kind: 'cash' | 'stock' | 'both' | 'unknown';
  source?: string;
}

export interface StockHistoryPoint {
  id: string;
  price: number;
  volume: number;
  timestamp: Date;
}

export interface Candle {
  id: string;       // YYYYMMDD doc id
  date: string;     // YYYY-MM-DD (local)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source?: string;
}

export interface WatchlistEntry {
  id: string;
  userId: string;
  symbol: string;
  note?: string;
  addedAt: Date;
}

export interface PortfolioLot {
  date: Date;
  shares: number;
  price: number;
  fee?: number;
}

export interface PortfolioPosition {
  id: string;
  userId: string;
  symbol: string;
  shares: number;
  avgCost: number;
  currency: 'TWD' | 'USD';
  lots: PortfolioLot[];
  notes?: string;
}

export type InvestmentPlanRisk = 'conservative' | 'balanced' | 'growth';
export type InvestmentPlanFunding = 'portfolio' | 'manual';

export interface InvestmentPlan {
  id: string;
  userId: string;
  name: string;
  targetAmountTWD: number;
  targetDate: Date;
  monthlyContributionTWD: number;
  expectedAnnualReturnPct: number;
  currentAmountTWD: number | null;
  fundingSource: InvestmentPlanFunding;
  riskLevel: InvestmentPlanRisk;
  notes?: string | null;
  alertEnabled: boolean;
  /**
   * 明確標記為退休規劃（理財健檢用）。舊資料沒有這個欄位 → undefined，
   * 由 retirement.ts isRetirementPlan 退回名稱比對。
   */
  isRetirement?: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SwingStrategyWeights {
  return5: number;
  return10: number;
  rs20: number;
  breakout20: number;
  volumeRatio20: number;
  ma5DeviationPenalty: number;
}

export interface SwingStrategyConfig {
  id: string;
  userId: string;
  name: string;
  active: boolean;
  universeSymbols: string[];
  topN: number;
  maxOpenPositions: number;
  maxPositionPctOfAssets: number;
  riskPerTradePct: number;
  virtualCapitalTWD: number;
  perTradeBudgetTWD: number;
  stopLossPct: number;
  atrStopMultiplier: number;
  takeProfitPct: number;
  trailingStopPct: number;
  maxHoldingDays: number;
  minAvgVolume20: number;
  maxMa5DeviationPct: number;
  minimumRewardRiskRatio: number;
  marketTrendFilterEnabled: boolean;
  weights: SwingStrategyWeights;
  notifyEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SwingSignalCandidate {
  rank: number;
  symbol: string;
  name: string;
  score: number;
  close: number;
  volume: number;
  avgVolume20: number;
  return5: number;
  return10: number;
  return20: number;
  rs20: number;
  breakout20: boolean;
  volumeRatio20: number;
  ma5DeviationPct: number;
  atr14: number;
  atrPct?: number;
  aboveMa20?: boolean;
  rewardRiskRatio?: number;
  suggestedStopPrice: number;
  suggestedTakeProfitPrice: number;
  notes: string[];
}

export interface SwingSignalRun {
  id: string;
  runDate: string;
  market: 'TW';
  status?: 'ok' | 'no_candidates' | 'no_config' | 'lock_busy';
  configId: string;
  configName: string;
  generatedAt: Date;
  benchmarkSymbol: string;
  benchmarkReturn20: number;
  strategyVersion?: string;
  marketTrendUp?: boolean;
  scanned?: number;
  eligible?: number;
  filteredLowVolume?: number;
  filteredOverheat?: number;
  filteredTrend?: number;
  filteredRewardRisk?: number;
  insufficientData?: number;
  reason?: string | null;
  errors?: string[];
  candidates: SwingSignalCandidate[];
}

export type SwingPaperTradeStatus = 'planned' | 'open' | 'closed' | 'skipped';
export type SwingPaperTradeExitReason =
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_stop'
  | 'time_exit'
  | 'manual_skip';

export interface SwingPaperTrade {
  id: string;
  userId: string;
  signalRunId: string;
  symbol: string;
  name: string;
  status: SwingPaperTradeStatus;
  plannedEntryDate: string;
  entryDate: string | null;
  entryPrice: number | null;
  shares: number;
  plannedCapitalTWD: number;
  plannedRiskTWD?: number | null;
  strategyVersion?: string | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  trailingStopPct: number;
  maxHoldingDays: number;
  highestPrice: number | null;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: SwingPaperTradeExitReason | null;
  grossReturnPct: number | null;
  costPct: number;
  netReturnPct: number | null;
  realizedPnlTWD: number | null;
  unrealizedPnlTWD: number | null;
  holdingDays: number;
  maxFavorablePct: number | null;
  maxAdversePct: number | null;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SwingPaperSummary {
  id: string;
  userId: string;
  updatedAt: Date;
  virtualCapitalTWD: number;
  openTrades: number;
  closedTrades: number;
  skippedTrades: number;
  realizedPnlTWD: number;
  unrealizedPnlTWD: number;
  equityTWD: number;
  totalReturnPct: number;
  winRate: number;
  averageWinPct: number;
  averageLossPct: number;
  expectancyPct: number;
  profitFactor: number;
  maxConsecutiveLosses: number;
  maxDrawdownPct: number;
}

export interface SwingPaperSyncRun {
  id: string;
  runDate: string;
  generatedAt: Date;
  status: 'ok' | 'lock_busy';
  scanned: number;
  opened: number;
  closed: number;
  noCandles: number;
  noEntryCandle: number;
}

export const stockConverter: FirestoreDataConverter<Stock> = {
  toFirestore: (s) => {
    const { id: _id, ...rest } = s as Stock;
    void _id;
    return {
      ...rest,
      updatedAt: rest.updatedAt ? Timestamp.fromDate(rest.updatedAt) : null,
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): Stock => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      symbol: d.symbol ?? snap.id,
      market: (d.market as Market) ?? 'TW',
      name: d.name ?? snap.id,
      currency: (d.currency as 'TWD' | 'USD') ?? 'TWD',
      currentPrice: d.currentPrice ?? 0,
      prevClose: d.prevClose ?? 0,
      change: d.change ?? 0,
      changePercent: d.changePercent ?? 0,
      high: d.high ?? 0,
      low: d.low ?? 0,
      open: d.open ?? 0,
      volume: d.volume ?? 0,
      updatedAt: tsToDate(d.updatedAt),
      upcomingDividend: d.upcomingDividend && typeof d.upcomingDividend.exDate === 'string'
        ? {
          exDate: d.upcomingDividend.exDate,
          cashPerShare: Number(d.upcomingDividend.cashPerShare ?? 0),
          stockPerShare: Number(d.upcomingDividend.stockPerShare ?? 0),
          kind: (d.upcomingDividend.kind as UpcomingDividend['kind']) ?? 'unknown',
          source: d.upcomingDividend.source,
        }
        : null,
    };
  },
};

const DEFAULT_SWING_WEIGHTS: SwingStrategyWeights = {
  return5: 1,
  return10: 1,
  rs20: 1.2,
  breakout20: 1.4,
  volumeRatio20: 1,
  ma5DeviationPenalty: 1,
};

export const swingStrategyConfigConverter: FirestoreDataConverter<SwingStrategyConfig> = {
  toFirestore: (c) => {
    const { id: _id, ...rest } = c as SwingStrategyConfig;
    void _id;
    return {
      ...rest,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): SwingStrategyConfig => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      name: d.name ?? '短波段實驗',
      active: d.active !== false,
      universeSymbols: Array.isArray(d.universeSymbols) ? d.universeSymbols as string[] : [],
      topN: d.topN ?? 8,
      maxOpenPositions: d.maxOpenPositions ?? 5,
      maxPositionPctOfAssets: d.maxPositionPctOfAssets ?? 5,
      riskPerTradePct: d.riskPerTradePct ?? 0.75,
      virtualCapitalTWD: d.virtualCapitalTWD ?? 100000,
      perTradeBudgetTWD: d.perTradeBudgetTWD ?? 20000,
      stopLossPct: d.stopLossPct ?? 4,
      atrStopMultiplier: d.atrStopMultiplier ?? 1.5,
      takeProfitPct: d.takeProfitPct ?? 8,
      trailingStopPct: d.trailingStopPct ?? 4,
      maxHoldingDays: d.maxHoldingDays ?? 5,
      minAvgVolume20: d.minAvgVolume20 ?? 500000,
      maxMa5DeviationPct: d.maxMa5DeviationPct ?? 8,
      minimumRewardRiskRatio: d.minimumRewardRiskRatio ?? 1.5,
      marketTrendFilterEnabled: d.marketTrendFilterEnabled !== false,
      weights: { ...DEFAULT_SWING_WEIGHTS, ...(d.weights ?? {}) },
      notifyEnabled: d.notifyEnabled !== false,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};

export const swingSignalRunConverter: FirestoreDataConverter<SwingSignalRun> = {
  toFirestore: (r) => {
    const { id: _id, ...rest } = r as SwingSignalRun;
    void _id;
    return {
      ...rest,
      generatedAt: Timestamp.fromDate(rest.generatedAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): SwingSignalRun => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      runDate: d.runDate ?? snap.id,
      market: 'TW',
      status: d.status,
      configId: d.configId ?? '',
      configName: d.configName ?? '短波段實驗',
      generatedAt: tsToDate(d.generatedAt) ?? new Date(),
      benchmarkSymbol: d.benchmarkSymbol ?? '0050',
      benchmarkReturn20: d.benchmarkReturn20 ?? 0,
      strategyVersion: d.strategyVersion ?? undefined,
      marketTrendUp: typeof d.marketTrendUp === 'boolean' ? d.marketTrendUp : undefined,
      scanned: d.scanned,
      eligible: d.eligible,
      filteredLowVolume: d.filteredLowVolume,
      filteredOverheat: d.filteredOverheat,
      filteredTrend: d.filteredTrend,
      filteredRewardRisk: d.filteredRewardRisk,
      insufficientData: d.insufficientData,
      reason: d.reason ?? null,
      errors: Array.isArray(d.errors) ? d.errors as string[] : [],
      candidates: Array.isArray(d.candidates) ? d.candidates as SwingSignalCandidate[] : [],
    };
  },
};

export const swingPaperTradeConverter: FirestoreDataConverter<SwingPaperTrade> = {
  toFirestore: (t) => {
    const { id: _id, ...rest } = t as SwingPaperTrade;
    void _id;
    return {
      ...rest,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): SwingPaperTrade => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      signalRunId: d.signalRunId ?? '',
      symbol: d.symbol ?? '',
      name: d.name ?? d.symbol ?? '',
      status: (d.status as SwingPaperTradeStatus) ?? 'planned',
      plannedEntryDate: d.plannedEntryDate ?? '',
      entryDate: d.entryDate ?? null,
      entryPrice: typeof d.entryPrice === 'number' ? d.entryPrice : null,
      shares: d.shares ?? 0,
      plannedCapitalTWD: d.plannedCapitalTWD ?? 0,
      plannedRiskTWD: typeof d.plannedRiskTWD === 'number' ? d.plannedRiskTWD : null,
      strategyVersion: d.strategyVersion ?? null,
      stopPrice: typeof d.stopPrice === 'number' ? d.stopPrice : null,
      takeProfitPrice: typeof d.takeProfitPrice === 'number' ? d.takeProfitPrice : null,
      trailingStopPct: d.trailingStopPct ?? 4,
      maxHoldingDays: d.maxHoldingDays ?? 5,
      highestPrice: typeof d.highestPrice === 'number' ? d.highestPrice : null,
      exitDate: d.exitDate ?? null,
      exitPrice: typeof d.exitPrice === 'number' ? d.exitPrice : null,
      exitReason: (d.exitReason as SwingPaperTradeExitReason | null) ?? null,
      grossReturnPct: typeof d.grossReturnPct === 'number' ? d.grossReturnPct : null,
      costPct: d.costPct ?? 0.005,
      netReturnPct: typeof d.netReturnPct === 'number' ? d.netReturnPct : null,
      realizedPnlTWD: typeof d.realizedPnlTWD === 'number' ? d.realizedPnlTWD : null,
      unrealizedPnlTWD: typeof d.unrealizedPnlTWD === 'number' ? d.unrealizedPnlTWD : null,
      holdingDays: d.holdingDays ?? 0,
      maxFavorablePct: typeof d.maxFavorablePct === 'number' ? d.maxFavorablePct : null,
      maxAdversePct: typeof d.maxAdversePct === 'number' ? d.maxAdversePct : null,
      notes: d.notes ?? null,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};

export const swingPaperSummaryConverter: FirestoreDataConverter<SwingPaperSummary> = {
  toFirestore: (s) => {
    const { id: _id, ...rest } = s as SwingPaperSummary;
    void _id;
    return {
      ...rest,
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): SwingPaperSummary => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
      virtualCapitalTWD: d.virtualCapitalTWD ?? 100000,
      openTrades: d.openTrades ?? 0,
      closedTrades: d.closedTrades ?? 0,
      skippedTrades: d.skippedTrades ?? 0,
      realizedPnlTWD: d.realizedPnlTWD ?? 0,
      unrealizedPnlTWD: d.unrealizedPnlTWD ?? 0,
      equityTWD: d.equityTWD ?? 0,
      totalReturnPct: d.totalReturnPct ?? 0,
      winRate: d.winRate ?? 0,
      averageWinPct: d.averageWinPct ?? 0,
      averageLossPct: d.averageLossPct ?? 0,
      expectancyPct: d.expectancyPct ?? 0,
      profitFactor: d.profitFactor ?? 0,
      maxConsecutiveLosses: d.maxConsecutiveLosses ?? 0,
      maxDrawdownPct: d.maxDrawdownPct ?? 0,
    };
  },
};

export const swingPaperSyncRunConverter: FirestoreDataConverter<SwingPaperSyncRun> = {
  toFirestore: (r) => {
    const { id: _id, ...rest } = r as SwingPaperSyncRun;
    void _id;
    return {
      ...rest,
      generatedAt: Timestamp.fromDate(rest.generatedAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): SwingPaperSyncRun => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      runDate: d.runDate ?? snap.id,
      generatedAt: tsToDate(d.generatedAt) ?? new Date(),
      status: d.status === 'lock_busy' ? 'lock_busy' : 'ok',
      scanned: d.scanned ?? 0,
      opened: d.opened ?? 0,
      closed: d.closed ?? 0,
      noCandles: d.noCandles ?? 0,
      noEntryCandle: d.noEntryCandle ?? 0,
    };
  },
};

export const candleConverter: FirestoreDataConverter<Candle> = {
  toFirestore: (c) => {
    const { id: _id, ...rest } = c as Candle;
    void _id;
    return rest;
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      date: d.date ?? snap.id,
      open: d.open ?? 0,
      high: d.high ?? 0,
      low: d.low ?? 0,
      close: d.close ?? 0,
      volume: d.volume ?? 0,
      source: d.source,
    };
  },
};

export const stockHistoryConverter: FirestoreDataConverter<StockHistoryPoint> = {
  toFirestore: (h) => {
    const { id: _id, ...rest } = h as StockHistoryPoint;
    void _id;
    return {
      ...rest,
      timestamp: Timestamp.fromDate(rest.timestamp),
    };
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      price: d.price ?? 0,
      volume: d.volume ?? 0,
      timestamp: tsToDate(d.timestamp) ?? new Date(),
    };
  },
};

export const watchlistConverter: FirestoreDataConverter<WatchlistEntry> = {
  toFirestore: (w) => {
    const { id: _id, ...rest } = w as WatchlistEntry;
    void _id;
    return {
      ...rest,
      addedAt: Timestamp.fromDate(rest.addedAt),
    };
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      symbol: d.symbol ?? '',
      note: d.note,
      addedAt: tsToDate(d.addedAt) ?? new Date(),
    };
  },
};

export const investmentPlanConverter: FirestoreDataConverter<InvestmentPlan> = {
  toFirestore: (p) => {
    const { id: _id, ...rest } = p as InvestmentPlan;
    void _id;
    return {
      ...rest,
      targetDate: Timestamp.fromDate(rest.targetDate),
      archivedAt: rest.archivedAt ? Timestamp.fromDate(rest.archivedAt) : null,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): InvestmentPlan => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      name: d.name ?? '投資計畫',
      targetAmountTWD: d.targetAmountTWD ?? 0,
      targetDate: tsToDate(d.targetDate) ?? new Date(),
      monthlyContributionTWD: d.monthlyContributionTWD ?? 0,
      expectedAnnualReturnPct: d.expectedAnnualReturnPct ?? 0,
      currentAmountTWD: typeof d.currentAmountTWD === 'number' ? d.currentAmountTWD : null,
      fundingSource: (d.fundingSource as InvestmentPlanFunding) ?? 'portfolio',
      riskLevel: (d.riskLevel as InvestmentPlanRisk) ?? 'balanced',
      notes: d.notes ?? null,
      alertEnabled: d.alertEnabled !== false,
      isRetirement: typeof d.isRetirement === 'boolean' ? d.isRetirement : undefined,
      archivedAt: tsToDate(d.archivedAt),
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};

/**
 * 投資組合每日快照（doc id = YYYY-MM-DD）。
 * 由 Apps Script tick_daily_0700 在台北 07:00（美股收盤後）產生。
 *
 * 設計理念（§12）：以「當日凍結」的匯率與股價計算 TWD 值，
 * 之後查詢歷史曲線時不會因即時匯率變動而被改寫。
 */
export interface PortfolioSnapshotPosition {
  symbol: string;
  market: Market;
  shares: number;
  /** 該檔加權成本（原幣） */
  avgCost: number;
  /** 當日收盤價（原幣） */
  currentPrice: number;
  /** 換算 TWD 用的匯率（USD/TWD 用 USD→TWD；TW 直接 1） */
  fxRate: number;
  costTWD: number;
  valueTWD: number;
  pnlTWD: number;
  pnlPct: number;
  /** 與前一日相比的 valueTWD 變動 */
  dayChangeTWD: number;
}

/**
 * 已實現損益批次：賣出時依使用者的成本法（preferences.costBasisMethod）落帳，給年度 capital gain 報表用。
 * average：一筆、avgCost = 持倉平均成本；fifo：每個被扣的買進批次一筆（見 cost-basis.ts）。
 */
export interface RealizedLot {
  id: string;
  symbol: string;
  market: Market;
  /** 賣出日期 */
  sellDate: Date;
  shares: number;
  /** 平均成本（原幣） */
  avgCost: number;
  /** 賣出價（原幣） */
  sellPrice: number;
  currency: 'TWD' | 'USD';
  fxRate: number;
  costTWD: number;
  proceedsTWD: number;
  realizedPnlTWD: number;
  note?: string | null;
  /**
   * 這筆用的成本法；舊資料（含 Apps Script ImportApply 寫入）沒有此欄 → 視為 average。
   * FIFO 賣出時每個被扣的買進批次各一筆，avgCost = 該批每股成本。
   */
  costBasisMethod?: CostBasisMethod;
  /** 使用者設定 FIFO，但持倉缺完整買入批次紀錄 → 退回平均成本 */
  costBasisFallback?: boolean;
  /** FIFO：被扣的買進批次日期 */
  buyDate?: Date | null;
  createdAt: Date;
}

/** 股息紀錄 */
export interface Dividend {
  id: string;
  symbol: string;
  market: Market;
  payDate: Date;
  amountPerShare: number;
  shares: number;
  currency: 'TWD' | 'USD';
  fxRate: number;
  amountTWD: number;
  note?: string | null;
  createdAt: Date;
}

export const realizedLotConverter: FirestoreDataConverter<RealizedLot> = {
  toFirestore: (l) => {
    const { id: _id, ...rest } = l as RealizedLot;
    void _id;
    return {
      ...rest,
      sellDate: Timestamp.fromDate(rest.sellDate),
      buyDate: rest.buyDate ? Timestamp.fromDate(rest.buyDate) : undefined,
      createdAt: Timestamp.fromDate(rest.createdAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): RealizedLot => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      symbol: d.symbol ?? '',
      market: (d.market as Market) ?? 'TW',
      sellDate: tsToDate(d.sellDate) ?? new Date(),
      shares: d.shares ?? 0,
      avgCost: d.avgCost ?? 0,
      sellPrice: d.sellPrice ?? 0,
      currency: (d.currency as 'TWD' | 'USD') ?? 'TWD',
      fxRate: d.fxRate ?? 1,
      costTWD: d.costTWD ?? 0,
      proceedsTWD: d.proceedsTWD ?? 0,
      realizedPnlTWD: d.realizedPnlTWD ?? 0,
      note: d.note ?? null,
      costBasisMethod: d.costBasisMethod === 'fifo' ? 'fifo' : 'average',
      costBasisFallback: d.costBasisFallback === true,
      buyDate: tsToDate(d.buyDate),
      createdAt: tsToDate(d.createdAt) ?? new Date(),
    };
  },
};

export const dividendConverter: FirestoreDataConverter<Dividend> = {
  toFirestore: (d) => {
    const { id: _id, ...rest } = d as Dividend;
    void _id;
    return {
      ...rest,
      payDate: Timestamp.fromDate(rest.payDate),
      createdAt: Timestamp.fromDate(rest.createdAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): Dividend => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      symbol: d.symbol ?? '',
      market: (d.market as Market) ?? 'TW',
      payDate: tsToDate(d.payDate) ?? new Date(),
      amountPerShare: d.amountPerShare ?? 0,
      shares: d.shares ?? 0,
      currency: (d.currency as 'TWD' | 'USD') ?? 'TWD',
      fxRate: d.fxRate ?? 1,
      amountTWD: d.amountTWD ?? 0,
      note: d.note ?? null,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
    };
  },
};

export interface PortfolioSnapshot {
  id: string;          // YYYY-MM-DD
  date: string;        // YYYY-MM-DD
  totalValueTWD: number;
  totalCostTWD: number;
  unrealizedPnlTWD: number;
  unrealizedPnlPct: number;
  dayChangeTWD: number;
  dayChangePct: number;
  byMarket: {
    TW?: { valueTWD: number; costTWD: number; pnlTWD: number; dayChangeTWD: number };
    US?: { valueTWD: number; costTWD: number; pnlTWD: number; dayChangeTWD: number };
  };
  positions: PortfolioSnapshotPosition[];
  fxRatesUsed: Record<string, number>;
  createdAt: Date;
}

export const portfolioSnapshotConverter: FirestoreDataConverter<PortfolioSnapshot> = {
  toFirestore: (s) => {
    const { id: _id, ...rest } = s as PortfolioSnapshot;
    void _id;
    return {
      ...rest,
      createdAt: Timestamp.fromDate(rest.createdAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): PortfolioSnapshot => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      date: d.date ?? snap.id,
      totalValueTWD: d.totalValueTWD ?? 0,
      totalCostTWD: d.totalCostTWD ?? 0,
      unrealizedPnlTWD: d.unrealizedPnlTWD ?? 0,
      unrealizedPnlPct: d.unrealizedPnlPct ?? 0,
      dayChangeTWD: d.dayChangeTWD ?? 0,
      dayChangePct: d.dayChangePct ?? 0,
      byMarket: d.byMarket ?? {},
      positions: Array.isArray(d.positions) ? (d.positions as PortfolioSnapshotPosition[]) : [],
      fxRatesUsed: d.fxRatesUsed ?? {},
      createdAt: tsToDate(d.createdAt) ?? new Date(),
    };
  },
};

export const portfolioConverter: FirestoreDataConverter<PortfolioPosition> = {
  toFirestore: (p) => {
    const { id: _id, ...rest } = p as PortfolioPosition;
    void _id;
    return {
      ...rest,
      lots: rest.lots.map((l) => ({
        ...l,
        date: Timestamp.fromDate(l.date),
      })),
    };
  },
  fromFirestore: (snap) => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      symbol: d.symbol ?? '',
      shares: d.shares ?? 0,
      avgCost: d.avgCost ?? 0,
      currency: (d.currency as 'TWD' | 'USD') ?? 'TWD',
      lots: (d.lots ?? []).map((l: { date: unknown; shares: number; price: number; fee?: number }) => ({
        date: tsToDate(l.date) ?? new Date(),
        shares: l.shares ?? 0,
        price: l.price ?? 0,
        fee: l.fee,
      })),
      notes: d.notes,
    };
  },
};
