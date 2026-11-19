import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addContribution, archiveGoal, deleteContribution, deleteGoal, listContribs, listGoals, listHouseholdGoals, upsertGoal,
} from './api';
import { estimateGoalEta, type SavingsGoal } from './types';

export function useGoals(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['savings-goals'],
    queryFn: listGoals,
    staleTime: 60 * 1000,
    enabled: options?.enabled ?? true,
  });
}

/** 共同目標：householdId 為 null 時不查（member 沒有 household 就沒目標） */
export function useHouseholdGoals(householdId: string | null | undefined) {
  return useQuery({
    queryKey: ['savings-goals', 'household', householdId],
    queryFn: () => listHouseholdGoals(householdId as string),
    enabled: Boolean(householdId),
    staleTime: 60 * 1000,
  });
}

export function useGoalContribs(goalId: string | null | undefined) {
  return useQuery({
    queryKey: ['savings-goals', goalId, 'contribs'],
    queryFn: () => listContribs(goalId as string),
    enabled: !!goalId,
    staleTime: 60 * 1000,
  });
}

export function useUpsertGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, id }: { input: Parameters<typeof upsertGoal>[0]; id?: string }) => upsertGoal(input, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['savings-goals'] }),
  });
}

export function useArchiveGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: archiveGoal,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['savings-goals'] }),
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteGoal,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['savings-goals'] }),
  });
}

export function useAddContribution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ goalId, input }: { goalId: string; input: Parameters<typeof addContribution>[1] }) =>
      addContribution(goalId, input),
    onSuccess: (_v, vars) => {
      void qc.invalidateQueries({ queryKey: ['savings-goals'] });
      void qc.invalidateQueries({ queryKey: ['savings-goals', vars.goalId, 'contribs'] });
    },
  });
}

export function useDeleteContribution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ goalId, contribId, amountTWD }: { goalId: string; contribId: string; amountTWD: number }) =>
      deleteContribution(goalId, contribId, amountTWD),
    onSuccess: (_v, vars) => {
      void qc.invalidateQueries({ queryKey: ['savings-goals'] });
      void qc.invalidateQueries({ queryKey: ['savings-goals', vars.goalId, 'contribs'] });
    },
  });
}

/**
 * 給定 goal 與其近 90 天 contribs，估算月貢獻速度與 ETA
 */
export function useGoalEta(goal: SavingsGoal) {
  const { data: contribs = [] } = useGoalContribs(goal.id);
  return useMemo(() => {
    const cutoff = Date.now() - 90 * 86400000;
    const recent = contribs.filter((c) => c.date.getTime() >= cutoff);
    const sum90 = recent.reduce((s, c) => s + c.amountTWD, 0);
    const monthlyRate = sum90 / 3;
    return estimateGoalEta(goal, monthlyRate);
  }, [contribs, goal]);
}
