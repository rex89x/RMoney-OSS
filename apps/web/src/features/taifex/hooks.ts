import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { callAppsScript } from '@/lib/apps-script';
import { formatTW } from '@/lib/tz';
import {
  getLatestTaifexSentiment,
  getTaifexAccount,
  getTaifexBacktest,
  getTaifexConfig,
  getTaifexLive,
  getTaifexOptimization,
  getTaifexTech,
  getTaifexTechTrades,
  getTaifexTuning,
  listTaifexAccounts,
  listTaifexReviews,
  listTaifexSignals,
  listTaifexTrades,
  saveTaifexConfig,
} from './api';
import { generateTaifexIngestToken, parseTaifexSentimentPaste } from './claude-schedule';
import type { TaifexConfigInput, TaifexOrderInput } from './schema';
import { sessionByClock, type TaifexSessionKind } from './tech';

/** 約 9 個月的訊號，走勢圖一天一點（pitfall #13） */
const SIGNAL_HISTORY = 180;
const TRADE_HISTORY = 200;

const KEYS = {
  account: ['taifex-account'] as const,
  signals: ['taifex-signals'] as const,
  trades: ['taifex-trades'] as const,
  sentiment: ['taifex-sentiment'] as const,
  backtest: ['taifex-backtest'] as const,
  config: ['taifex-config'] as const,
  ingest: ['taifex-ingest-status'] as const,
  live: ['taifex-live'] as const,
  accounts: ['taifex-accounts'] as const,
  optimization: ['taifex-optimization'] as const,
  tech: ['taifex-tech'] as const,
  techTrades: ['taifex-tech-trades'] as const,
  reviews: ['taifex-reviews'] as const,
  tuning: ['taifex-tuning'] as const,
};

/** 一季的週檢討 */
const REVIEW_HISTORY = 13;

/** 日盤時段（08:45–13:45，平日）：即時報價與部位每分鐘重抓；盤外不輪詢 */
export function isTaifexSessionNow(now = new Date()): boolean {
  const day = Number(formatTW(now, 'i'));
  const hhmm = formatTW(now, 'HH:mm');
  return day <= 5 && hhmm >= '08:45' && hhmm <= '13:50';
}

/** 現在是日盤 / 夜盤 / 都不是（只看台北時鐘與星期；國定假日以後端狀態為準） */
export function taifexSessionNow(now = new Date()): TaifexSessionKind | null {
  return sessionByClock(Number(formatTW(now, 'i')), formatTW(now, 'HH:mm'));
}

function useEnabled(extra = true) {
  const { user } = useAuth();
  return Boolean(user?.uid) && extra;
}

export function useTaifexAccount() {
  return useQuery({
    queryKey: KEYS.account,
    queryFn: getTaifexAccount,
    enabled: useEnabled(),
    refetchInterval: () => (isTaifexSessionNow() ? 60_000 : false),
  });
}

export function useTaifexLive() {
  return useQuery({
    queryKey: KEYS.live,
    queryFn: getTaifexLive,
    enabled: useEnabled(),
    refetchInterval: () => (isTaifexSessionNow() ? 60_000 : false),
  });
}

/** 績效分頁才讀：主帳戶 + 策略變體 */
export function useTaifexAccounts(enabled: boolean) {
  return useQuery({ queryKey: KEYS.accounts, queryFn: listTaifexAccounts, enabled: useEnabled(enabled) });
}

export function useTaifexOptimization(enabled: boolean) {
  return useQuery({ queryKey: KEYS.optimization, queryFn: getTaifexOptimization, enabled: useEnabled(enabled) });
}

export function useRunTaifexOptimization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('runTaifexOptimization'),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: KEYS.optimization });
      toast.success(data.adopt ? '最佳化完成：新參數在樣本外勝過基準' : '最佳化完成：樣本外沒有勝過基準，維持基準參數較穩');
    },
    onError: onError('runTaifexOptimization', '最佳化失敗'),
  });
}

/** 盤中手動觸發一次模擬（平常由 5 分鐘排程自動跑） */
export function useRunTaifexIntraday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('runTaifexIntraday'),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: KEYS.live });
      void qc.invalidateQueries({ queryKey: KEYS.account });
      if (data.skipped === 'already-closed') toast.info('今天已收盤，等 18:00 結算');
      else toast.success('已用最新報價模擬一次');
    },
    onError: onError('runTaifexIntraday', '盤中模擬失敗'),
  });
}

/** 盤中技術模擬：日盤 / 夜盤交易時間每分鐘重抓，其餘時間不輪詢 */
export function useTaifexTech(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.tech,
    queryFn: getTaifexTech,
    enabled: useEnabled(enabled),
    refetchInterval: () => (taifexSessionNow() ? 60_000 : false),
  });
}

export function useTaifexTechTrades(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.techTrades,
    queryFn: getTaifexTechTrades,
    enabled: useEnabled(enabled),
    refetchInterval: () => (taifexSessionNow() ? 300_000 : false),
  });
}

/** 手動跑一輪技術模擬（平常由 5 分鐘排程自動跑）；休市或時段外只會回報狀態 */
export function useRunTaifexTech() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('runTaifexTech'),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: KEYS.tech });
      void qc.invalidateQueries({ queryKey: KEYS.techTrades });
      if (data.skipped === 'market-closed') toast.info('目前休市或非交易時段，沒有進行模擬');
      else if (data.skipped === 'stale-quote') toast.info('報價沒有更新（可能臨時休市），沒有進行模擬');
      else toast.success('已用最新報價模擬一次');
    },
    onError: onError('runTaifexTech', '技術模擬失敗'),
  });
}

export function useResetTaifexTech() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('resetTaifexTech'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.tech });
      void qc.invalidateQueries({ queryKey: KEYS.techTrades });
      toast.success('已重置技術模擬，重新累積紀錄');
    },
    onError: onError('resetTaifexTech', '重置失敗'),
  });
}

/** 改了自訂休市日之後重抓休市表（後端快取 6 小時，不重抓要等快取過期才生效） */
export function useRefreshTaifexCalendar() {
  return useMutation({
    mutationFn: () => callAppsScript('refreshTaifexCalendar'),
    onError: onError('refreshTaifexCalendar', '更新休市表失敗'),
  });
}

export function useTaifexSignals() {
  return useQuery({ queryKey: KEYS.signals, queryFn: () => listTaifexSignals(SIGNAL_HISTORY), enabled: useEnabled() });
}

/** 交易分頁打開才讀 */
export function useTaifexTrades(enabled: boolean) {
  return useQuery({ queryKey: KEYS.trades, queryFn: () => listTaifexTrades(TRADE_HISTORY), enabled: useEnabled(enabled) });
}

export function useTaifexSentiment() {
  return useQuery({ queryKey: KEYS.sentiment, queryFn: getLatestTaifexSentiment, enabled: useEnabled() });
}

export function useTaifexBacktest(enabled: boolean) {
  return useQuery({ queryKey: KEYS.backtest, queryFn: getTaifexBacktest, enabled: useEnabled(enabled) });
}

export function useTaifexConfig() {
  return useQuery({ queryKey: KEYS.config, queryFn: getTaifexConfig, enabled: useEnabled() });
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: KEYS.account });
  void qc.invalidateQueries({ queryKey: KEYS.accounts });
  void qc.invalidateQueries({ queryKey: KEYS.live });
  void qc.invalidateQueries({ queryKey: KEYS.signals });
  void qc.invalidateQueries({ queryKey: KEYS.trades });
}

function onError(label: string, fallback: string) {
  return (error: unknown) => {
    console.error(`[${label}]`, error);
    toast.error(error instanceof Error ? error.message : fallback);
  };
}

export function useSaveTaifexConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaifexConfigInput) => saveTaifexConfig(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.config });
      toast.success('已儲存設定');
    },
    onError: onError('saveTaifexConfig', '儲存設定失敗'),
  });
}

/** 立即抓期交所資料並處理新 K 棒（同 18:00 排程） */
export function useRunTaifexDaily() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('runTaifexDaily'),
    onSuccess: (data) => {
      invalidateAll(qc);
      const processed = typeof data.processed === 'number' ? data.processed : 0;
      toast.success(processed ? `已處理 ${processed} 根新 K 棒` : '已是最新資料');
      if (Array.isArray(data.errors) && data.errors.length) toast.warning(`部分資料抓取失敗：${String(data.errors[0])}`);
    },
    onError: onError('runTaifexDaily', '更新失敗'),
  });
}

/** 第一次使用：回補約 2 年日 K（約 1–2 分鐘） */
export function useBackfillTaifex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (months: number) => callAppsScript('backfillTaifex', undefined, { months }),
    onSuccess: () => {
      invalidateAll(qc);
      toast.success('已回補歷史資料並建立虛擬帳戶');
    },
    onError: onError('backfillTaifex', '回補失敗'),
  });
}

export function useRunTaifexBacktest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('runTaifexBacktest'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.backtest });
      toast.success('回測完成');
    },
    onError: onError('runTaifexBacktest', '回測失敗'),
  });
}

export function usePlaceTaifexOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (order: TaifexOrderInput) => callAppsScript('placeTaifexOrder', undefined, order),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.account });
      toast.success('已送出虛擬單，將於下一個交易日開盤價成交');
    },
    onError: onError('placeTaifexOrder', '下單失敗'),
  });
}

export function useCancelTaifexOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('cancelTaifexOrder'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.account });
      toast.success('已取消待成交單');
    },
    onError: onError('cancelTaifexOrder', '取消失敗'),
  });
}

export function useResetTaifexPaper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('resetTaifexPaper'),
    onSuccess: () => {
      invalidateAll(qc);
      toast.success('已重置虛擬帳戶');
    },
    onError: onError('resetTaifexPaper', '重置失敗'),
  });
}

export function useResumeTaifexPaper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('resumeTaifexPaper'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.account });
      toast.success('已解除熔斷');
    },
    onError: onError('resumeTaifexPaper', '解除熔斷失敗'),
  });
}

export interface TaifexIngestStatus {
  configured: boolean;
  ownedByCaller: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export function useTaifexIngestStatus(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.ingest,
    queryFn: async (): Promise<TaifexIngestStatus> => {
      const data = await callAppsScript('getTaifexIngestStatus');
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

/** 產生新 token（舊的立即失效）；明文只回給使用者複製一次，後端只存 SHA-256 */
export function useRotateTaifexIngestToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { token, tokenHash } = await generateTaifexIngestToken();
      await callAppsScript('setTaifexIngestToken', undefined, { tokenHash });
      return token;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.ingest });
      toast.success('已產生新的推送 token，舊 token 已失效');
    },
    onError: onError('rotateTaifexIngestToken', '產生 token 失敗'),
  });
}

export function useRevokeTaifexIngestToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('revokeTaifexIngestToken'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.ingest });
      toast.success('已撤銷推送 token');
    },
    onError: onError('revokeTaifexIngestToken', '撤銷失敗'),
  });
}

/** 手動貼上 Claude 輸出；與排程推送走同一套後端驗證 */
export function useImportTaifexSentiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const body = parseTaifexSentimentPaste(text);
      const data = await callAppsScript('importTaifexSentiment', undefined, body);
      return { warning: typeof data.warning === 'string' ? data.warning : null, events: typeof data.events === 'number' ? data.events : 0 };
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: KEYS.sentiment });
      if (result.warning) toast.warning(result.warning);
      else toast.success(`已匯入輿情（${result.events} 個事件）`);
    },
    onError: onError('importTaifexSentiment', '匯入失敗'),
  });
}

// -------- 每週檢討 / 調校 --------

export function useTaifexReviews(enabled: boolean) {
  return useQuery({ queryKey: KEYS.reviews, queryFn: () => listTaifexReviews(REVIEW_HISTORY), enabled: useEnabled(enabled) });
}

export function useTaifexTuning(enabled: boolean) {
  return useQuery({ queryKey: KEYS.tuning, queryFn: getTaifexTuning, enabled: useEnabled(enabled) });
}

function useReviewAction(action: 'applyTaifexReview' | 'rejectTaifexReview' | 'revertTaifexTuning', success: string, fallback: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => callAppsScript(action, undefined, { id }),
    onSuccess: () => {
      // 套用 / 還原會動到調校值、設定（資金管理、策略變體）；帳戶要等下一次每日流程才會換參數
      void qc.invalidateQueries({ queryKey: KEYS.reviews });
      void qc.invalidateQueries({ queryKey: KEYS.tuning });
      void qc.invalidateQueries({ queryKey: KEYS.config });
      toast.success(success);
    },
    onError: onError(action, fallback),
  });
}

/** 套用提案：寫入調校值，必要時把主帳戶切到「Claude 調校」變體 */
export function useApplyTaifexReview() {
  return useReviewAction('applyTaifexReview', '已套用調整，下一次每日流程起生效', '套用失敗');
}

export function useRejectTaifexReview() {
  return useReviewAction('rejectTaifexReview', '已退回提案', '退回失敗');
}

/** 還原最近一次套用（調校值、資金管理、策略變體回到套用前） */
export function useRevertTaifexTuning() {
  return useReviewAction('revertTaifexTuning', '已還原到套用前的設定', '還原失敗');
}
