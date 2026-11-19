import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { callAppsScript } from '@/lib/apps-script';
import {
  addDividend,
  addRealizedLot,
  addToWatchlist,
  archiveInvestmentPlan,
  deleteDividend,
  deleteHistoryRange,
  deletePortfolioPosition,
  deleteRealizedLot,
  executePortfolioTrade,
  getCostBasisMethod,
  getLatestSnapshot,
  getLatestSwingPaperSyncRun,
  getStock,
  getStockCandles,
  getStockHistory,
  getLatestSwingSignalRun,
  getSwingPaperSummary,
  listInvestmentPlans,
  listDividends,
  listPortfolio,
  listRealizedLots,
  listSnapshots,
  listSnapshotsSince,
  listStocks,
  listSwingPaperTrades,
  listSwingSignalRuns,
  listSwingStrategyConfigs,
  listWatchlist,
  removeFromWatchlist,
  setCostBasisMethod,
  updateSwingPaperTradeStatus,
  upsertInvestmentPlan,
  upsertPortfolioPosition,
  upsertSwingStrategyConfig,
} from './api';
import { addTWCalendarYears, dateInputToTWDate, formatTW, formatTWDateInput } from '@/lib/tz';
import { buildPortfolioFlows, computePortfolioPerformance, type PerformanceResult } from './performance';
import { DEFAULT_COST_BASIS_METHOD, type CostBasisMethod } from './cost-basis';
import type { InvestmentPlan, PortfolioPosition, SwingPaperTrade, SwingStrategyConfig } from './types';
import { requireUid } from '@/lib/assert';

export function useStocks() {
  return useQuery({
    queryKey: ['stocks'],
    queryFn: listStocks,
    staleTime: 30 * 1000,
  });
}

export function useStock(symbol: string | undefined) {
  return useQuery({
    queryKey: ['stock', symbol],
    queryFn: () => getStock(symbol!),
    enabled: Boolean(symbol),
    staleTime: 30 * 1000,
  });
}

export function useStockHistory(symbol: string | undefined, points = 200) {
  return useQuery({
    queryKey: ['stock-history', symbol, points],
    queryFn: () => getStockHistory(symbol!, points),
    enabled: Boolean(symbol),
    staleTime: 60 * 1000,
  });
}

export function useStockCandles(symbol: string | undefined, days = 260) {
  return useQuery({
    queryKey: ['stock-candles', symbol, days],
    queryFn: () => getStockCandles(symbol!, days),
    enabled: Boolean(symbol),
    staleTime: 5 * 60 * 1000,
  });
}

export function useBackfillCandles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { scope?: 'tw' | 'us' | 'fx' | 'all'; symbol?: string; pair?: string; months?: number; days?: number; range?: string }) =>
      callAppsScript('backfillCandles', undefined, params),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock-candles'] });
      void qc.invalidateQueries({ queryKey: ['fx-candles'] });
      toast.success('K 線回填完成');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '回填失敗'),
  });
}

export function useDeleteHistoryRange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ symbol, start, end }: { symbol: string; start: Date; end: Date }) =>
      deleteHistoryRange(symbol, start, end),
    onSuccess: (_n, { symbol }) => {
      void qc.invalidateQueries({ queryKey: ['stock-history', symbol] });
      toast.success('已刪除歷史區間');
    },
  });
}

export function useWatchlist() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['watchlist', user?.uid],
    queryFn: () => listWatchlist(requireUid(user)),
    enabled: Boolean(user?.uid),
  });
}

interface RefreshResponse {
  ok: boolean;
  symbol?: string;
  market?: string;
  error?: string;
}

export function useAddWatchlist() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ symbol, note }: { symbol: string; note?: string }) => {
      if (!user) throw new Error('Not logged in');
      await addToWatchlist(user.uid, symbol, note);
      // 加完直接觸發單檔 refresh，比全表 updateStockPrices 快且能拿到具體錯誤
      try {
        const r = await callAppsScript<RefreshResponse>('refreshSymbol', { symbol });
        return { symbol, refresh: r as RefreshResponse };
      } catch (err) {
        console.warn('[useAddWatchlist] refreshSymbol failed', err);
        return { symbol, refresh: { ok: false, error: err instanceof Error ? err.message : 'unknown' } };
      }
    },
    onSuccess: ({ symbol, refresh }) => {
      void qc.invalidateQueries({ queryKey: ['watchlist'] });
      void qc.invalidateQueries({ queryKey: ['stocks'] });
      if (refresh.ok) {
        toast.success(`已加入 ${symbol} · 已取得最新價格`);
      } else {
        toast.warning(`已加入 ${symbol}，但價格抓取失敗：${refresh.error || '未知錯誤'}`, {
          description: '稍後可在列上點重抓按鈕再試一次',
        });
      }
    },
    onError: (err) => {
      console.error('[addWatchlist]', err);
      toast.error(err instanceof Error ? err.message : '加入失敗');
    },
  });
}

export function useRefreshSymbol() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (symbol: string) => callAppsScript<RefreshResponse>('refreshSymbol', { symbol }),
    onSuccess: (data, symbol) => {
      void qc.invalidateQueries({ queryKey: ['stocks'] });
      void qc.invalidateQueries({ queryKey: ['stock', symbol] });
      const r = data as unknown as RefreshResponse;
      if (r.ok) toast.success(`${symbol} 已重抓`);
      else toast.error(`${symbol} 重抓失敗：${r.error || '未知錯誤'}`);
    },
    onError: (err, symbol) => toast.error(`${symbol} 重抓失敗：${err instanceof Error ? err.message : '未知錯誤'}`),
  });
}

export function useRemoveWatchlist() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (symbol: string) => {
      if (!user) throw new Error('Not logged in');
      await removeFromWatchlist(user.uid, symbol);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['watchlist'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '移除失敗'),
  });
}

export function useRefreshStocks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('updateStockPrices'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stocks'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      toast.success('已觸發更新');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '更新失敗'),
  });
}

// Portfolio

export function usePortfolio() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['portfolio', user?.uid],
    queryFn: () => listPortfolio(requireUid(user)),
    enabled: Boolean(user?.uid),
  });
}

export function useUpsertPortfolio() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({
      pos,
      id,
    }: {
      pos: Omit<PortfolioPosition, 'id' | 'userId'>;
      id?: string;
    }) => {
      if (!user) throw new Error('Not logged in');
      const newId = await upsertPortfolioPosition({ ...pos, userId: user.uid }, id);
      // 新部位若 stocks/{symbol} 不存在，順便觸發 Apps Script 抓價
      try { await callAppsScript('updateStockPrices'); } catch (err) {
        console.warn('[useUpsertPortfolio] price refresh failed', err);
      }
      return newId;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
      void qc.invalidateQueries({ queryKey: ['stocks'] });
      toast.success('已儲存持倉');
    },
    onError: (err) => {
      console.error('[upsertPortfolio]', err);
      toast.error(err instanceof Error ? err.message : '儲存失敗');
    },
  });
}

export function useExecutePortfolioTrade() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: Omit<Parameters<typeof executePortfolioTrade>[0], 'userId'>) => {
      if (!user) throw new Error('Not logged in');
      const id = await executePortfolioTrade({ ...input, userId: user.uid });
      void callAppsScript('updateStockPrices')
        .then(() => {
          void qc.invalidateQueries({ queryKey: ['stocks'] });
          void qc.invalidateQueries({ queryKey: ['stock'] });
        })
        .catch((err) => console.warn('[useExecutePortfolioTrade] price refresh failed', err));
      return id;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
      void qc.invalidateQueries({ queryKey: ['realized-lots'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['stocks'] });
      toast.success('已儲存交易並更新帳戶');
    },
    onError: (err) => {
      console.error('[executePortfolioTrade]', err);
      toast.error(err instanceof Error ? err.message : '交易失敗');
    },
  });
}

// 投資偏好：賣出成本法（users/{uid}.preferences.costBasisMethod）

export function useCostBasisMethod() {
  const { user, profile } = useAuth();
  return useQuery({
    queryKey: ['investment-prefs', 'cost-basis', user?.uid],
    queryFn: () => getCostBasisMethod(requireUid(user)),
    enabled: Boolean(user?.uid),
    placeholderData: profile?.preferences?.costBasisMethod ?? DEFAULT_COST_BASIS_METHOD,
    staleTime: 5 * 60 * 1000,
  });
}

export function useSetCostBasisMethod() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (method: CostBasisMethod) => {
      if (!user) throw new Error('Not logged in');
      await setCostBasisMethod(user.uid, method);
      return method;
    },
    onSuccess: (method) => {
      void qc.invalidateQueries({ queryKey: ['investment-prefs', 'cost-basis'] });
      toast.success(method === 'fifo' ? '之後的賣出改用 FIFO（先進先出）' : '之後的賣出改用平均成本');
    },
    onError: (err) => {
      console.error('[setCostBasisMethod]', err);
      toast.error(err instanceof Error ? err.message : '儲存成本法失敗');
    },
  });
}

export function useDeletePortfolio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePortfolioPosition(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });
}

export function useInvestmentPlans() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['investment-plans', user?.uid],
    queryFn: () => listInvestmentPlans(requireUid(user)),
    enabled: Boolean(user?.uid),
    staleTime: 60 * 1000,
  });
}

export function useUpsertInvestmentPlan() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({
      plan,
      id,
    }: {
      plan: Omit<InvestmentPlan, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'archivedAt'>;
      id?: string;
    }) => {
      if (!user) throw new Error('Not logged in');
      return upsertInvestmentPlan({ ...plan, userId: user.uid }, id);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['investment-plans'] });
      toast.success('已儲存投資計畫');
    },
    onError: (err) => {
      console.error('[upsertInvestmentPlan]', err);
      toast.error(err instanceof Error ? err.message : '儲存失敗');
    },
  });
}

export function useArchiveInvestmentPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: archiveInvestmentPlan,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['investment-plans'] });
      toast.success('已封存投資計畫');
    },
    onError: (err) => {
      console.error('[archiveInvestmentPlan]', err);
      toast.error(err instanceof Error ? err.message : '封存失敗');
    },
  });
}

export function useSwingStrategyConfigs() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['swing-strategy-configs', user?.uid],
    queryFn: () => listSwingStrategyConfigs(requireUid(user)),
    enabled: Boolean(user?.uid),
    staleTime: 60 * 1000,
  });
}

export function useUpsertSwingStrategyConfig() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({
      config,
      id,
    }: {
      config: Omit<SwingStrategyConfig, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;
      id?: string;
    }) => {
      if (!user) throw new Error('Not logged in');
      return upsertSwingStrategyConfig({ ...config, userId: user.uid }, id);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['swing-strategy-configs'] });
      toast.success('已儲存短波段設定');
    },
    onError: (err) => {
      console.error('[upsertSwingStrategyConfig]', err);
      toast.error(err instanceof Error ? err.message : '儲存失敗');
    },
  });
}

export function useLatestSwingSignalRun() {
  return useQuery({
    queryKey: ['swing-signal-runs', 'latest'],
    queryFn: getLatestSwingSignalRun,
    staleTime: 60 * 1000,
  });
}

export function useSwingSignalRuns(limitRuns = 20) {
  return useQuery({
    queryKey: ['swing-signal-runs', limitRuns],
    queryFn: () => listSwingSignalRuns(limitRuns),
    staleTime: 60 * 1000,
  });
}

export function useSwingPaperTrades(limitTrades = 100) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['swing-paper-trades', user?.uid, limitTrades],
    queryFn: () => listSwingPaperTrades(requireUid(user), limitTrades),
    enabled: Boolean(user?.uid),
    staleTime: 60 * 1000,
  });
}

export function useSwingPaperSummary() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['swing-paper-summary', user?.uid],
    queryFn: () => getSwingPaperSummary(requireUid(user)),
    enabled: Boolean(user?.uid),
    staleTime: 60 * 1000,
  });
}

export function useLatestSwingPaperSyncRun() {
  return useQuery({
    queryKey: ['swing-paper-sync-runs', 'latest'],
    queryFn: getLatestSwingPaperSyncRun,
    staleTime: 60 * 1000,
  });
}

export function useRunSwingScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('runSwingScan'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['swing-signal-runs'] });
      void qc.invalidateQueries({ queryKey: ['swing-paper-trades'] });
      void qc.invalidateQueries({ queryKey: ['swing-paper-summary'] });
      toast.success('已完成短波段掃描');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '掃描失敗'),
  });
}

export function useSyncSwingPaperTrades() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('syncSwingPaperTrades'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['swing-paper-trades'] });
      void qc.invalidateQueries({ queryKey: ['swing-paper-summary'] });
      void qc.invalidateQueries({ queryKey: ['swing-paper-sync-runs'] });
      toast.success('已同步紙上交易');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '同步失敗'),
  });
}

export function useUpdateSwingPaperTradeStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: {
      id: string;
      patch: Pick<SwingPaperTrade, 'status'> & Partial<Pick<SwingPaperTrade, 'notes'>>;
    }) => updateSwingPaperTradeStatus(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['swing-paper-trades'] });
      void qc.invalidateQueries({ queryKey: ['swing-paper-summary'] });
      toast.success('已更新紙上交易');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '更新失敗'),
  });
}

// Portfolio snapshots

export function usePortfolioSnapshots(days = 90) {
  return useQuery({
    queryKey: ['portfolio-snapshots', days],
    queryFn: () => listSnapshots(days),
    staleTime: 5 * 60 * 1000,
  });
}

export function usePortfolioSnapshotsSince(fromKey: string | null) {
  return useQuery({
    queryKey: ['portfolio-snapshots', 'since', fromKey ?? 'all'],
    queryFn: () => listSnapshotsSince(fromKey),
    staleTime: 5 * 60 * 1000,
  });
}

export type PerformancePeriod = 'ytd' | '1y' | '3y' | 'all';

/** 期間起點（台北 yyyy-MM-dd）；'all' = null */
export function performancePeriodStartKey(period: PerformancePeriod, now: Date = new Date()): string | null {
  if (period === 'all') return null;
  if (period === 'ytd') return `${formatTW(now, 'yyyy')}-01-01`;
  return formatTWDateInput(addTWCalendarYears(now, period === '1y' ? -1 : -3));
}

/**
 * 投資績效（XIRR / TWR），資料來源見 performance.ts 與 README。
 * 多抓起點前 10 天的快照，找「起點當天或之前最後一筆」當期初。
 */
export function usePortfolioPerformance(period: PerformancePeriod) {
  const startKey = useMemo(() => performancePeriodStartKey(period), [period]);
  const fetchKey = useMemo(() => {
    if (!startKey) return null;
    const start = dateInputToTWDate(startKey);
    return start ? formatTWDateInput(new Date(start.getTime() - 10 * 86_400_000)) : startKey;
  }, [startKey]);
  const snapshotsQuery = usePortfolioSnapshotsSince(fetchKey);
  const realizedQuery = useRealizedLots();
  const dividendsQuery = useDividends();

  const data = useMemo<PerformanceResult | null>(() => {
    const snapshots = snapshotsQuery.data;
    if (!snapshots || snapshots.length < 2) return null;
    const series = buildPortfolioFlows(snapshots, realizedQuery.data ?? [], dividendsQuery.data ?? []);
    return computePortfolioPerformance(series, startKey);
  }, [snapshotsQuery.data, realizedQuery.data, dividendsQuery.data, startKey]);

  return {
    data,
    startKey,
    isLoading: snapshotsQuery.isLoading || realizedQuery.isLoading || dividendsQuery.isLoading,
    error: snapshotsQuery.error ?? realizedQuery.error ?? dividendsQuery.error,
  };
}

export function useLatestSnapshot() {
  return useQuery({
    queryKey: ['portfolio-snapshots', 'latest'],
    queryFn: getLatestSnapshot,
    staleTime: 60 * 1000,
  });
}

export function useTriggerSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('refreshPortfolioSnapshot'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portfolio-snapshots'] });
      void qc.invalidateQueries({ queryKey: ['stocks'] });
      void qc.invalidateQueries({ queryKey: ['fx-rates'] });
      toast.success('已觸發投資快照');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '觸發失敗'),
  });
}

// Realized lots & dividends

export function useRealizedLots() {
  return useQuery({ queryKey: ['realized-lots'], queryFn: listRealizedLots, staleTime: 60 * 1000 });
}

export function useAddRealizedLot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: addRealizedLot,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['realized-lots'] }),
  });
}

export function useDeleteRealizedLot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteRealizedLot,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['realized-lots'] }),
  });
}

export function useDividends() {
  return useQuery({ queryKey: ['dividends'], queryFn: listDividends, staleTime: 60 * 1000 });
}

export function useAddDividend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: addDividend,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['dividends'] }),
  });
}

export function useDeleteDividend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteDividend,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['dividends'] }),
  });
}
