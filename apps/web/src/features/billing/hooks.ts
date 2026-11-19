import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clearBillOverride, listAllBills, listBillsForCard, markBillPaid, setBillOverride, unmarkBillPaid,
} from './api';

export function useAllBills() {
  return useQuery({
    queryKey: ['credit-card-bills'],
    queryFn: () => listAllBills(60),
    staleTime: 60 * 1000,
  });
}

export function useBillsForCard(paymentMethodId: string | null | undefined) {
  return useQuery({
    queryKey: ['credit-card-bills', 'card', paymentMethodId],
    queryFn: () => listBillsForCard(paymentMethodId as string, 12),
    enabled: !!paymentMethodId,
    staleTime: 60 * 1000,
  });
}

export function useMarkBillPaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: markBillPaid,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['credit-card-bills'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

export function useUnmarkBillPaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentMethodId, cycleMonth }: { paymentMethodId: string; cycleMonth: string }) =>
      unmarkBillPaid(paymentMethodId, cycleMonth),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['credit-card-bills'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

export function useSetBillOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: setBillOverride,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['credit-card-bills'] }),
  });
}

export function useClearBillOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentMethodId, cycleMonth }: { paymentMethodId: string; cycleMonth: string }) =>
      clearBillOverride(paymentMethodId, cycleMonth),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['credit-card-bills'] }),
  });
}
