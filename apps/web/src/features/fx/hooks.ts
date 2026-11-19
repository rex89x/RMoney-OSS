import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { callAppsScript } from '@/lib/apps-script';
import {
  createAlert, deleteAlert, deleteFxPair, getFxCandles, listAlerts, listFxPairs, listFxRates,
  listRecentAlertLogs, setFxPairEnabled, updateAlert, upsertFxPair,
} from './api';
import type { Alert } from './types';
import { requireUid } from '@/lib/assert';

export function useFxRates() {
  return useQuery({
    queryKey: ['fx-rates'],
    queryFn: listFxRates,
    staleTime: 30 * 1000,
  });
}

export function useRefreshFx() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('updateFxRates'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fx-rates'] });
      void qc.invalidateQueries({ queryKey: ['fx-candles'] });
      toast.success('已更新匯率');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '更新失敗'),
  });
}

export function useAlerts() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['alerts', user?.uid],
    queryFn: () => listAlerts(requireUid(user)),
    enabled: Boolean(user?.uid),
  });
}

export function useCreateAlert() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (a: Omit<Alert, 'id' | 'userId' | 'createdAt' | 'lastTriggeredAt'>) => {
      if (!user) throw new Error('Not logged in');
      return createAlert({
        ...a,
        userId: user.uid,
        createdAt: new Date(),
        lastTriggeredAt: null,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      toast.success('已新增警報');
    },
  });
}

export function useUpdateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Alert> }) => updateAlert(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts'] }),
  });
}

export function useDeleteAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAlert(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts'] }),
  });
}

export function useFxPairs() {
  return useQuery({
    queryKey: ['fx-pairs'],
    queryFn: listFxPairs,
    staleTime: 60 * 1000,
  });
}

export function useUpsertFxPair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ base, quote, enabled = true }: { base: string; quote: string; enabled?: boolean }) =>
      upsertFxPair(base, quote, enabled),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fx-pairs'] });
      toast.success('已新增幣別');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '新增失敗'),
  });
}

export function useToggleFxPair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => setFxPairEnabled(id, enabled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fx-pairs'] }),
  });
}

export function useDeleteFxPair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFxPair(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fx-pairs'] });
      void qc.invalidateQueries({ queryKey: ['fx-rates'] });
      toast.success('已刪除幣別');
    },
  });
}

export function useFxCandles(pair: string | undefined, days = 365) {
  return useQuery({
    queryKey: ['fx-candles', pair, days],
    queryFn: () => getFxCandles(pair!, days),
    enabled: Boolean(pair),
    staleTime: 5 * 60 * 1000,
  });
}

export function useAlertLogs() {
  return useQuery({
    queryKey: ['alert-logs'],
    queryFn: () => listRecentAlertLogs(30),
    staleTime: 60 * 1000,
  });
}
