import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransactions } from '@/features/ledger/hooks';
import { addTWCalendarMonths, startOfTWDay } from '@/lib/tz';
import {
  deleteSubscription, linkSubscriptionAutoPost, listSubscriptions, setSubscriptionActive,
  unlinkSubscriptionAutoPost, upsertSubscription, type LinkAutoPostInput,
} from './api';
import { detectSubscriptions, type DetectedSubscription } from './detector';
import { monthlyAmountTWD, type Subscription } from './types';

export function useSubscriptions() {
  return useQuery({ queryKey: ['subscriptions'], queryFn: listSubscriptions, staleTime: 5 * 60 * 1000 });
}

export function useUpsertSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, id }: { input: Parameters<typeof upsertSubscription>[0]; id?: string }) =>
      upsertSubscription(input, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['subscriptions'] }),
  });
}

function invalidateSubsAndRecurring(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['subscriptions'] });
  void qc.invalidateQueries({ queryKey: ['recurring'] });
}

export function useToggleSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sub, active }: { sub: Pick<Subscription, 'id' | 'recurringId'>; active: boolean }) =>
      setSubscriptionActive(sub, active),
    onSuccess: () => invalidateSubsAndRecurring(qc),
  });
}

export function useDeleteSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sub: Pick<Subscription, 'id' | 'recurringId'>) => deleteSubscription(sub),
    onSuccess: () => invalidateSubsAndRecurring(qc),
  });
}

export function useLinkSubscriptionAutoPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LinkAutoPostInput) => linkSubscriptionAutoPost(input),
    onSuccess: () => invalidateSubsAndRecurring(qc),
  });
}

export function useUnlinkSubscriptionAutoPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sub: Pick<Subscription, 'id' | 'recurringId'>) => unlinkSubscriptionAutoPost(sub),
    onSuccess: () => invalidateSubsAndRecurring(qc),
  });
}

/** 過去 N 個月的 tx 跑偵測 */
export function useDetectedSubscriptions(monthsBack = 6): DetectedSubscription[] {
  const start = useMemo(() => {
    return startOfTWDay(addTWCalendarMonths(new Date(), -monthsBack));
  }, [monthsBack]);
  const { data: txs = [] } = useTransactions({ startDate: start, limit: 5000 });
  return useMemo(() => detectSubscriptions(txs), [txs]);
}

/** 已建立 + 啟用的訂閱合計（每月 TWD） */
export function useMonthlySubscriptionTotal(): { total: number; count: number; subs: Subscription[] } {
  const { data: subs = [] } = useSubscriptions();
  return useMemo(() => {
    const active = subs.filter((s) => s.active);
    const total = active.reduce((s, sub) => s + monthlyAmountTWD(sub), 0);
    return { total, count: active.length, subs: active };
  }, [subs]);
}
