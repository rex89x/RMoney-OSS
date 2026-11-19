import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteScheduledPayment, listScheduledPayments, markScheduledPaid, upsertScheduledPayment,
} from './api';
import type { ScheduledPayment } from './types';
import { startOfTWDay } from '@/lib/tz';

export function useScheduledPayments() {
  return useQuery({ queryKey: ['scheduled-payments'], queryFn: listScheduledPayments, staleTime: 5 * 60 * 1000 });
}

export function useUpsertScheduledPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, id }: { input: Parameters<typeof upsertScheduledPayment>[0]; id?: string }) =>
      upsertScheduledPayment(input, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scheduled-payments'] }),
  });
}

export function useMarkScheduledPaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: markScheduledPaid,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scheduled-payments'] }),
  });
}

export function useDeleteScheduledPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteScheduledPayment,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scheduled-payments'] }),
  });
}

/** 即將到期：90 天內 */
export function useUpcomingScheduledPayments(daysAhead = 90): ScheduledPayment[] {
  const { data: items = [] } = useScheduledPayments();
  return useMemo(() => {
    const now = startOfTWDay().getTime();
    const cutoff = now + daysAhead * 86400000;
    return items.filter((p) => {
      // one-time 已繳就不再列出
      if (p.recurrence === 'one-time' && p.paidAt) return false;
      const ts = startOfTWDay(p.dueDate).getTime();
      return ts <= cutoff;
    });
  }, [items, daysAhead]);
}
