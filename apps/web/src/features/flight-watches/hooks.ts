import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { callAppsScript } from '@/lib/apps-script';
import { useHousehold } from '@/features/household';
import {
  createFlightWatch,
  deleteFlightWatch,
  listFlightPriceSnapshots,
  listFlightWatches,
  markClaudePromptKeys,
  setFlightWatchSharing,
  updateFlightWatch,
} from './api';
import {
  buildClaudeSchedulePrompt,
  claudePromptSyncKey,
  claudeWatchStatuses,
  flightCriteriaKey,
  generateFlightIngestToken,
  parseClaudeFlightPaste,
} from './claude-schedule';
import type { FlightWatch } from './types';
import { flightSharingDrift } from './sharing';
import { requireUid } from '@/lib/assert';

export function useFlightWatches() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['flight-watches', user?.uid],
    queryFn: () => listFlightWatches(requireUid(user)),
    enabled: Boolean(user?.uid),
  });
}

/** 我建立的訂閱要分享給誰：共同帳本的其他成員（沒有共同帳本 = 不分享） */
export function useFlightShareTargets(): { targets: string[]; ready: boolean } {
  const { user } = useAuth();
  const { household, isLoading } = useHousehold();
  const memberIds = household?.memberIds;
  const targets = useMemo(
    () => (memberIds ?? []).filter((uid) => uid !== user?.uid).sort(),
    [memberIds, user?.uid],
  );
  // 共同帳本還在載入時不能當成「沒有成員」，否則同步會把既有分享清掉
  return { targets, ready: !isLoading };
}

/**
 * 讓「我建立的」訂閱分享給目前的共同帳本成員：舊資料補上、成員加入 / 移除時跟著改。
 * 只在 /flights 掛載；每組差異只寫一次（失敗不重試轟炸，下次進頁面再試）。
 */
export function useSyncFlightWatchSharing(watches: FlightWatch[], ready: boolean) {
  const { user } = useAuth();
  const { targets, ready: householdReady } = useFlightShareTargets();
  const queryClient = useQueryClient();
  const attempted = useRef<string>('');
  useEffect(() => {
    if (!ready || !householdReady || !user?.uid) return;
    const drift = flightSharingDrift(watches, user.uid, targets);
    if (drift.length === 0) return;
    const signature = drift.map((d) => `${d.id}:${d.sharedWith.join(',')}`).join('|');
    if (attempted.current === signature) return;
    attempted.current = signature;
    setFlightWatchSharing(drift)
      .then(() => queryClient.invalidateQueries({ queryKey: ['flight-watches'] }))
      .catch((error: unknown) => console.error('[syncFlightWatchSharing]', error));
  }, [ready, householdReady, user?.uid, watches, targets, queryClient]);
}

export function useFlightPriceSnapshots(watchId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['flight-watch-snapshots', watchId],
    queryFn: () => listFlightPriceSnapshots(watchId),
    enabled: Boolean(watchId) && enabled,
  });
}

export function useCreateFlightWatch() {
  const { user } = useAuth();
  const { targets: shareTargets } = useFlightShareTargets();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Omit<
        FlightWatch,
        | 'id'
        | 'userId'
        | 'sharedWith'
        | 'createdAt'
        | 'updatedAt'
        | 'latestEstimate'
        | 'bestPriceTWD'
        | 'lastError'
        | 'lastCheckedAt'
        | 'claudePromptKey'
      >,
    ) => {
      if (!user) throw new Error('尚未登入');
      const now = new Date();
      return createFlightWatch({
        ...input,
        userId: user.uid,
        sharedWith: shareTargets,
        latestEstimate: null,
        bestPriceTWD: null,
        lastError: null,
        lastCheckedAt: null,
        claudePromptKey: null,
        createdAt: now,
        updatedAt: now,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight-watches'] });
      toast.success('已新增票價訂閱');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '新增失敗'),
  });
}

export function useUpdateFlightWatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<FlightWatch> }) =>
      updateFlightWatch(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['flight-watches'] }),
    onError: (error) => toast.error(error instanceof Error ? error.message : '更新失敗'),
  });
}

export function useDeleteFlightWatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteFlightWatch,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight-watches'] });
      toast.success('已刪除票價訂閱');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '刪除失敗'),
  });
}

export function useRefreshFlightWatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (watchId: string) => callAppsScript('refreshFlightWatch', undefined, { watchId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight-watches'] });
      void queryClient.invalidateQueries({ queryKey: ['flight-watch-snapshots'] });
      toast.success('票價區間已更新');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '更新票價失敗'),
  });
}

export interface FlightIngestStatus {
  configured: boolean;
  ownedByCaller: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface FlightImportOutcome {
  watchId: string;
  ok: boolean;
  minPriceTWD?: number;
  warning?: string;
  error?: string;
}

export function useFlightIngestStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['flight-ingest-status'],
    queryFn: async (): Promise<FlightIngestStatus> => {
      const data = await callAppsScript('getFlightIngestStatus');
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
export function useRotateFlightIngestToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { token, tokenHash } = await generateFlightIngestToken();
      await callAppsScript('setFlightIngestToken', undefined, { tokenHash });
      return token;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight-ingest-status'] });
      toast.success('已產生新的推送 token，舊 token 已失效');
    },
    onError: (error) => {
      console.error('[rotateFlightIngestToken]', error);
      toast.error(error instanceof Error ? error.message : '產生 token 失敗');
    },
  });
}

export function useRevokeFlightIngestToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('revokeFlightIngestToken'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flight-ingest-status'] });
      toast.success('已撤銷推送 token，Claude 排程將無法再寫入');
    },
    onError: (error) => {
      console.error('[revokeFlightIngestToken]', error);
      toast.error(error instanceof Error ? error.message : '撤銷失敗');
    },
  });
}

/** Claude 來源航線與提示詞的同步狀態（criteriaKey 需要 async SHA-256，所以包成 query） */
export function useClaudeWatchStatuses(watches: FlightWatch[]) {
  const claudeWatches = watches.filter((watch) => watch.scanProvider === 'claude');
  return useQuery({
    queryKey: [
      'flight-claude-status',
      claudeWatches.map((watch) => `${watch.id}:${watch.updatedAt.getTime()}:${watch.claudePromptKey ?? ''}:${watch.enabled}:${watch.claudeGroup}`),
    ],
    queryFn: () => claudeWatchStatuses(claudeWatches),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useClaudeSchedulePrompt(watches: FlightWatch[], group: string, enabled: boolean) {
  return useQuery({
    queryKey: ['flight-claude-prompt', group, watches.map((watch) => `${watch.id}:${watch.updatedAt.getTime()}`)],
    queryFn: () => buildClaudeSchedulePrompt(watches, group),
    enabled: enabled && watches.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** 複製提示詞後記錄每條航線的 criteriaKey，之後條件改了才會提醒重新複製 */
export function useMarkClaudePromptCopied() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (watches: FlightWatch[]) => {
      const entries = await Promise.all(
        watches.map(async (watch) => ({ id: watch.id, criteriaKey: claudePromptSyncKey(watch, await flightCriteriaKey(watch)) })),
      );
      await markClaudePromptKeys(entries);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['flight-watches'] }),
    onError: (error) => {
      console.error('[markClaudePromptCopied]', error);
      toast.error(error instanceof Error ? error.message : '更新提示詞狀態失敗');
    },
  });
}

/** 總覽走勢圖：只讀被選到的區段，每個區段最近 36 筆快照 */
export function useFlightSnapshotsForWatches(watchIds: string[]) {
  return useQueries({
    queries: watchIds.map((watchId) => ({
      queryKey: ['flight-watch-snapshots', watchId],
      queryFn: () => listFlightPriceSnapshots(watchId),
    })),
  });
}

/** 手動貼上 Claude 排程輸出的 JSON；與排程推送走同一套後端驗證。 */
export function useImportFlightPrices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string): Promise<FlightImportOutcome[]> => {
      const results = parseClaudeFlightPaste(text);
      const data = await callAppsScript('importFlightPrices', undefined, { results });
      return Array.isArray(data.results) ? (data.results as FlightImportOutcome[]) : [];
    },
    onSuccess: (outcomes) => {
      void queryClient.invalidateQueries({ queryKey: ['flight-watches'] });
      void queryClient.invalidateQueries({ queryKey: ['flight-watch-snapshots'] });
      const accepted = outcomes.filter((item) => item.ok).length;
      if (accepted === outcomes.length) toast.success(`已匯入 ${accepted} 條航線票價`);
      else toast.error(`匯入 ${accepted} 條，${outcomes.length - accepted} 條被拒收`);
    },
    onError: (error) => {
      console.error('[importFlightPrices]', error);
      toast.error(error instanceof Error ? error.message : '匯入失敗');
    },
  });
}
