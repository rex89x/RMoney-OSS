import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import {
  cancelInstallmentPlan, createInstallmentPlan, listInstallmentPlans, postDueInstallments,
} from './api';
import { installmentRemainingTWD, totalInstallmentRemainingTWD } from './schedule';
import type { InstallmentPlan, InstallmentPlanInput } from './types';

const QUERY_KEY = 'installment-plans';

/** owner-only collection：非 owner 不查，避免被 rules 拒絕 */
export function useInstallmentPlans() {
  const { user, isOwner } = useAuth();
  const uid = user?.uid ?? '';
  return useQuery<InstallmentPlan[]>({
    queryKey: [QUERY_KEY, uid],
    queryFn: () => listInstallmentPlans(uid),
    enabled: Boolean(uid) && isOwner,
    staleTime: 60 * 1000,
  });
}

function useInvalidateInstallmentData() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    void qc.invalidateQueries({ queryKey: ['transactions'] });
    void qc.invalidateQueries({ queryKey: ['accounts'] });
  };
}

/**
 * 建立計畫後立即請 Apps Script 入帳已到期的期數。
 * Apps Script 失敗不算建立失敗：隔天 01:00 排程會補上（冪等，不會重複）。
 */
export function useCreateInstallmentPlan() {
  const { user } = useAuth();
  const invalidate = useInvalidateInstallmentData();
  return useMutation({
    mutationFn: async (input: Omit<InstallmentPlanInput, 'ownerId'>) => {
      if (!user) throw new Error('尚未登入');
      const id = await createInstallmentPlan({ ...input, ownerId: user.uid });
      let posted: number | null = null;
      try {
        posted = await postDueInstallments();
      } catch (err) {
        console.error('[postDueInstallments]', err);
      }
      return { id, posted };
    },
    onSuccess: ({ posted }) => {
      invalidate();
      if (posted === null) {
        toast.success('已建立分期', { description: '到期的期數會在每天 01:00 自動入帳' });
      } else {
        toast.success('已建立分期', posted > 0 ? { description: `已入帳 ${posted} 期` } : undefined);
      }
    },
    onError: (err) => {
      console.error('[createInstallmentPlan]', err);
      toast.error(err instanceof Error ? err.message : '建立分期失敗');
    },
  });
}

export function useCancelInstallmentPlan() {
  const invalidate = useInvalidateInstallmentData();
  return useMutation({
    mutationFn: cancelInstallmentPlan,
    onSuccess: () => {
      invalidate();
      toast.success('已取消分期，之後不再入帳');
    },
    onError: (err) => {
      console.error('[cancelInstallmentPlan]', err);
      toast.error(err instanceof Error ? err.message : '取消失敗');
    },
  });
}

export function usePostDueInstallments() {
  const invalidate = useInvalidateInstallmentData();
  return useMutation({
    mutationFn: postDueInstallments,
    onSuccess: (created) => {
      invalidate();
      toast.success(created > 0 ? `已入帳 ${created} 期` : '沒有到期未入帳的期數');
    },
    onError: (err) => {
      console.error('[postDueInstallments]', err);
      toast.error(err instanceof Error ? err.message : '分期入帳失敗');
    },
  });
}

/** 進行中計畫「尚未入帳」的總額（淨值負債端用） */
export function useInstallmentRemainingTWD(): number {
  const { data: plans = [] } = useInstallmentPlans();
  return useMemo(() => totalInstallmentRemainingTWD(plans), [plans]);
}

/** 依信用卡帳戶加總「分期未到期」金額 */
export function useInstallmentRemainingByCard(): Map<string, number> {
  const { data: plans = [] } = useInstallmentPlans();
  return useMemo(() => {
    const out = new Map<string, number>();
    for (const plan of plans) {
      const remaining = installmentRemainingTWD(plan);
      if (remaining <= 0) continue;
      out.set(plan.cardAccountId, (out.get(plan.cardAccountId) ?? 0) + remaining);
    }
    return out;
  }, [plans]);
}
