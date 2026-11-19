import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import type { Household } from '@/features/household/types';
import type { PortfolioPosition } from '@/features/investments/types';
import {
  createJointHolding, createTelegramLink, deleteJointHolding, getFxToTWD, getJointQuotes, listJointHoldings,
  listJointSnapshots, refreshHouseholdQuotes, sendHouseholdReportNow, subscribeJointHoldings,
  subscribeMyTelegramLink, syncLinkedPositions, unlinkTelegram, updateJointHolding, getMyTelegramLink,
  type JointHoldingPatch,
} from './api';
import { valuePortfolio, type PortfolioValuation } from './calc';
import type { JointHolding, JointHoldingInput, TelegramLink } from './types';

const HOLDINGS_KEY = 'joint_holdings';
const QUOTES_KEY = 'joint_quotes';
const FX_KEY = 'joint_fx';
const SNAPSHOTS_KEY = 'joint_snapshots';
const TG_LINK_KEY = 'telegram_link';

function reportError(scope: string, fallback: string) {
  return (err: unknown) => {
    console.error(`[${scope}]`, err);
    toast.error(err instanceof Error ? err.message : fallback);
  };
}

/** 共同投資持股（onSnapshot 即時同步：伴侶新增後這邊馬上看得到） */
export function useJointHoldings(householdId: string | null | undefined) {
  const qc = useQueryClient();
  const queryKey = useMemo(() => [HOLDINGS_KEY, householdId] as const, [householdId]);
  const q = useQuery<JointHolding[]>({
    queryKey,
    // enabled 保證 householdId 存在
    queryFn: () => listJointHoldings(householdId as string),
    enabled: Boolean(householdId),
    staleTime: 60 * 1000,
  });
  useEffect(() => {
    if (!householdId) return undefined;
    return subscribeJointHoldings(
      householdId,
      (rows) => qc.setQueryData(queryKey, rows),
      (err) => console.error('[subscribeJointHoldings]', err),
    );
  }, [householdId, qc, queryKey]);
  return q;
}

export function useJointQuotes(symbols: readonly string[]) {
  const key = useMemo(() => Array.from(new Set(symbols)).sort(), [symbols]);
  return useQuery({
    queryKey: [QUOTES_KEY, key],
    queryFn: () => getJointQuotes(key),
    enabled: key.length > 0,
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useJointFx(currencies: readonly string[]) {
  const key = useMemo(() => Array.from(new Set(currencies)).sort(), [currencies]);
  return useQuery({
    queryKey: [FX_KEY, key],
    queryFn: () => getFxToTWD(key),
    enabled: key.some((c) => c !== 'TWD'),
    staleTime: 10 * 60 * 1000,
  });
}

/** 持股 × 報價 × 匯率 → 估值（總覽 / 圖表 / 表格的單一資料來源） */
export function useJointValuation(household: Household) {
  const holdingsQ = useJointHoldings(household.id);
  const holdings = useMemo(() => holdingsQ.data ?? [], [holdingsQ.data]);
  const symbols = useMemo(() => holdings.map((h) => h.symbol), [holdings]);
  const currencies = useMemo(() => holdings.map((h) => h.currency), [holdings]);
  const quotesQ = useJointQuotes(symbols);
  const fxQ = useJointFx(currencies);
  const valuation: PortfolioValuation<JointHolding> = useMemo(
    () => valuePortfolio(holdings, quotesQ.data ?? {}, fxQ.data ?? { TWD: 1 }, household.memberIds, household.splitRatio),
    [holdings, quotesQ.data, fxQ.data, household.memberIds, household.splitRatio],
  );
  const lastQuoteAt = useMemo(() => {
    const times = Object.values(quotesQ.data ?? {}).map((q) => q?.updatedAt?.getTime() ?? 0).filter((t) => t > 0);
    return times.length ? new Date(Math.min(...times)) : null;
  }, [quotesQ.data]);
  return {
    holdings,
    valuation,
    lastQuoteAt,
    isLoading: holdingsQ.isLoading || (symbols.length > 0 && quotesQ.isLoading),
    error: holdingsQ.error,
  };
}

export function useJointSnapshots(householdId: string, days = 180) {
  return useQuery({
    queryKey: [SNAPSHOTS_KEY, householdId, days],
    queryFn: () => listJointSnapshots(householdId, days),
    staleTime: 10 * 60 * 1000,
  });
}

export function useCreateJointHolding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, input }: { householdId: string; input: JointHoldingInput }) =>
      createJointHolding(householdId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [HOLDINGS_KEY] });
      void qc.invalidateQueries({ queryKey: [QUOTES_KEY] });
    },
    onError: reportError('createJointHolding', '新增失敗'),
  });
}

export function useUpdateJointHolding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, id, patch }: { householdId: string; id: string; patch: JointHoldingPatch }) =>
      updateJointHolding(householdId, id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [HOLDINGS_KEY] }),
    onError: reportError('updateJointHolding', '儲存失敗'),
  });
}

export function useDeleteJointHolding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, id }: { householdId: string; id: string }) => deleteJointHolding(householdId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [HOLDINGS_KEY] }),
    onError: reportError('deleteJointHolding', '刪除失敗'),
  });
}

export function useSyncLinkedPositions() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: ({ householdId, positions, existing, names }: {
      householdId: string;
      positions: readonly PortfolioPosition[];
      existing: readonly JointHolding[];
      names: Record<string, string>;
    }) => {
      if (!user) throw new Error('尚未登入');
      return syncLinkedPositions(householdId, user.uid, positions, existing, names);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [HOLDINGS_KEY] }),
    onError: reportError('syncLinkedPositions', '同步失敗'),
  });
}

export function useRefreshHouseholdQuotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (householdId: string) => refreshHouseholdQuotes(householdId),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [QUOTES_KEY] });
      void qc.invalidateQueries({ queryKey: [FX_KEY] });
      if (r.failed.length) toast.warning(`已更新 ${r.updated} 檔；${r.failed.join('、')} 抓不到報價`);
      else toast.success(`已更新 ${r.updated} 檔報價`);
    },
    onError: reportError('refreshHouseholdQuotes', '更新報價失敗'),
  });
}

// -------- Telegram --------

export function useMyTelegramLink() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const queryKey = useMemo(() => [TG_LINK_KEY, user?.uid] as const, [user?.uid]);
  const q = useQuery<TelegramLink | null>({
    queryKey,
    queryFn: () => getMyTelegramLink(user?.uid ?? ''),
    enabled: Boolean(user?.uid),
  });
  useEffect(() => {
    if (!user?.uid) return undefined;
    // 對方在 Telegram 按 Start 後，這邊即時變成「已連結」
    return subscribeMyTelegramLink(
      user.uid,
      (link) => qc.setQueryData(queryKey, link),
      (err) => console.error('[subscribeMyTelegramLink]', err),
    );
  }, [qc, queryKey, user?.uid]);
  return q;
}

export function useCreateTelegramLink() {
  return useMutation({
    mutationFn: ({ householdId, forUid }: { householdId: string; forUid?: string }) => createTelegramLink(householdId, forUid),
    onError: reportError('createTelegramLink', '產生連結失敗'),
  });
}

export function useUnlinkTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, forUid }: { householdId: string; forUid?: string }) => unlinkTelegram(householdId, forUid),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [TG_LINK_KEY] }),
    onError: reportError('unlinkTelegram', '解除失敗'),
  });
}

export function useSendHouseholdReport() {
  return useMutation({
    mutationFn: (householdId: string) => sendHouseholdReportNow(householdId),
    onSuccess: () => toast.success('已傳到你的 Telegram'),
    onError: reportError('sendHouseholdReport', '傳送失敗'),
  });
}
