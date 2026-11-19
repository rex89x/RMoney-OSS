import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { usePortfolio, useStocks, useWatchlist } from '@/features/investments/hooks';
import { callAppsScript } from '@/lib/apps-script';
import {
  getStockRadarBacktest,
  getStockRadarConfig,
  listStockRadarOutcomes,
  listStockRadarRuns,
  markStockRadarPromptCopied,
} from './api';
import { buildPromptUniverse, generateStockIngestToken, parseStockSentimentPaste, type PromptSymbol } from './claude-schedule';
import type { StockRadarMarket, StockRadarRun } from './types';

/** 約 60 個交易日 × 2 個市場；走勢圖每天一點（pitfall #13） */
const STOCK_RADAR_HISTORY_RUNS = 120;

export function useStockRadarRuns() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['stock-radar-runs'],
    queryFn: () => listStockRadarRuns(STOCK_RADAR_HISTORY_RUNS),
    enabled: Boolean(user?.uid),
  });
}

/** 成績單分頁才讀，避免一進頁面就多一次查詢 */
export function useStockRadarOutcomes(enabled: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['stock-radar-outcomes'],
    queryFn: () => listStockRadarOutcomes(STOCK_RADAR_HISTORY_RUNS),
    enabled: Boolean(user?.uid) && enabled,
  });
}

export function useStockRadarBacktest(market: StockRadarMarket, enabled: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['stock-radar-backtest', market],
    queryFn: () => getStockRadarBacktest(market),
    enabled: Boolean(user?.uid) && enabled,
  });
}

export function useStockRadarConfig(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['stock-radar-config'],
    queryFn: getStockRadarConfig,
    enabled: Boolean(user?.uid) && enabled,
  });
}

/**
 * Claude 提示詞的追蹤清單：即時讀持股 + 自選股（不等當天評估跑完），名稱缺的用最近一次評估補。
 */
export function useStockRadarUniverse(market: StockRadarMarket, latestRun: StockRadarRun | undefined) {
  const portfolio = usePortfolio();
  const watchlist = useWatchlist();
  const stocks = useStocks();
  const symbols = useMemo<PromptSymbol[]>(() => {
    const fallbackNames: Record<string, string> = {};
    (latestRun?.items ?? []).forEach((item) => { fallbackNames[item.symbol] = item.name; });
    return buildPromptUniverse(market, portfolio.data ?? [], watchlist.data ?? [], stocks.data ?? [], fallbackNames);
  }, [market, latestRun, portfolio.data, watchlist.data, stocks.data]);
  return {
    symbols,
    isLoading: portfolio.isLoading || watchlist.isLoading || stocks.isLoading,
    error: portfolio.error ?? watchlist.error ?? stocks.error ?? null,
  };
}

/** 手動重跑盤前評估（同一天會覆寫當天的 run，已收到的輿情會重新合併） */
export function useRunStockRadar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (market?: StockRadarMarket) => callAppsScript('runStockRadar', undefined, market ? { market } : {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stock-radar-runs'] });
      void queryClient.invalidateQueries({ queryKey: ['stock-radar-outcomes'] });
      toast.success('已重新評估');
    },
    onError: (error) => {
      console.error('[useRunStockRadar]', error);
      toast.error(error instanceof Error ? error.message : '評估失敗');
    },
  });
}

/** 回測要抓 5 年 K 線，約 1–3 分鐘 */
export function useRunStockRadarBacktest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (market: StockRadarMarket) => callAppsScript('runStockRadarBacktest', undefined, { market }),
    onSuccess: (_data, market) => {
      void queryClient.invalidateQueries({ queryKey: ['stock-radar-backtest', market] });
      toast.success('回測完成');
    },
    onError: (error) => {
      console.error('[useRunStockRadarBacktest]', error);
      toast.error(error instanceof Error ? error.message : '回測失敗');
    },
  });
}

export interface StockIngestStatus {
  configured: boolean;
  ownedByCaller: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export function useStockIngestStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['stock-ingest-status'],
    queryFn: async (): Promise<StockIngestStatus> => {
      const data = await callAppsScript('getStockIngestStatus');
      return {
        configured: data.configured === true,
        ownedByCaller: data.ownedByCaller === true,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
        lastUsedAt: typeof data.lastUsedAt === 'string' ? data.lastUsedAt : null,
      };
    },
    enabled,
  });
}

/** 產生新 token（舊的立即失效）；回傳明文只給使用者複製一次，後端只存 SHA-256。 */
export function useRotateStockIngestToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { token, tokenHash } = await generateStockIngestToken();
      await callAppsScript('setStockIngestToken', undefined, { tokenHash });
      return token;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stock-ingest-status'] });
      toast.success('已產生新的推送 token，舊 token 已失效');
    },
    onError: (error) => {
      console.error('[rotateStockIngestToken]', error);
      toast.error(error instanceof Error ? error.message : '產生 token 失敗');
    },
  });
}

export function useRevokeStockIngestToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('revokeStockIngestToken'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stock-ingest-status'] });
      toast.success('已撤銷推送 token，Claude 排程將無法再寫入');
    },
    onError: (error) => {
      console.error('[revokeStockIngestToken]', error);
      toast.error(error instanceof Error ? error.message : '撤銷失敗');
    },
  });
}

export function useMarkStockPromptCopied() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ market, symbols }: { market: StockRadarMarket; symbols: string[] }) =>
      markStockRadarPromptCopied(market, symbols),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['stock-radar-config'] }),
    onError: (error) => {
      console.error('[markStockPromptCopied]', error);
      toast.error(error instanceof Error ? error.message : '更新提示詞狀態失敗');
    },
  });
}

export interface StockImportOutcome {
  symbol: string | null;
  ok: boolean;
  error?: string;
  warning?: string;
}

/** 手動貼上 Claude 排程輸出的 JSON；與排程推送走同一套後端驗證。 */
export function useImportStockSentiment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ text, market }: { text: string; market: StockRadarMarket }): Promise<StockImportOutcome[]> => {
      const parsed = parseStockSentimentPaste(text);
      if (parsed.market && parsed.market !== market) throw new Error(`貼上的是${parsed.market === 'TW' ? '台股' : '美股'}結果，請切換市場`);
      const data = await callAppsScript('importStockSentiment', undefined, {
        market,
        items: parsed.items,
        ...(parsed.marketView ? { marketView: parsed.marketView } : {}),
      });
      return Array.isArray(data.results) ? (data.results as StockImportOutcome[]) : [];
    },
    onSuccess: (outcomes) => {
      void queryClient.invalidateQueries({ queryKey: ['stock-radar-runs'] });
      const accepted = outcomes.filter((item) => item.ok).length;
      if (accepted === outcomes.length) toast.success(`已匯入 ${accepted} 筆輿情`);
      else toast.error(`匯入 ${accepted} 筆，${outcomes.length - accepted} 筆被拒收`);
    },
    onError: (error) => {
      console.error('[importStockSentiment]', error);
      toast.error(error instanceof Error ? error.message : '匯入失敗');
    },
  });
}
