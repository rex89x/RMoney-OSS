import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { getAiBudgetConfig, getAiUsageSummary, saveAiBudgetConfig } from './api';
import { DEFAULT_CLAUDE_MODEL, type AiBudgetConfig } from './types';
import { requireUid } from '@/lib/assert';

export function useAiBudgetConfig() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['ai-budget-config', user?.uid],
    queryFn: () => getAiBudgetConfig(requireUid(user)),
    enabled: Boolean(user?.uid),
  });
}

export function useSaveAiBudgetConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveAiBudgetConfig,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-budget-config'] });
      // 重置日 / 額度會改變本期範圍
      void queryClient.invalidateQueries({ queryKey: ['ai-usage-summary'] });
      toast.success('AI 額度設定已儲存');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '儲存失敗'),
  });
}

/** cycleOffset：0 = 本期，-1 = 上一期 */
export function useAiUsageSummary(cycleOffset = 0) {
  return useQuery({
    queryKey: ['ai-usage-summary', cycleOffset],
    queryFn: () => getAiUsageSummary(cycleOffset),
    staleTime: 60 * 1000,
  });
}

export function defaultAiBudgetConfig(userId: string): AiBudgetConfig {
  return {
    id: userId,
    userId,
    monthlyCreditUSD: 100,
    cycleResetDay: 23,
    warningPercent: 80,
    hardStopEnabled: false,
    defaultModel: DEFAULT_CLAUDE_MODEL,
    fastModel: DEFAULT_CLAUDE_MODEL,
    lastAlertCycle: null,
    lastAlertLevel: null,
    updatedAt: new Date(),
  };
}
