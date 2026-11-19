import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import {
  createPayoutGroup, deletePayoutGroup, listPayoutGroups, updatePayoutGroup,
} from './api';
import type { PayoutGroup, PayoutParticipant } from './types';
import { requireUid } from '@/lib/assert';

export function usePayoutGroups() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['payout-groups', user?.uid],
    queryFn: () => listPayoutGroups(requireUid(user)),
    enabled: Boolean(user?.uid),
    staleTime: 30 * 1000,
  });
}

export function useCreatePayoutGroup() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      date: Date;
      totalAmountTWD: number;
      participants: PayoutParticipant[];
      note?: string | null;
      selfParticipantId?: string | null;
      paymentMethod?: string;
    }) => {
      if (!user) throw new Error('Not logged in');
      return createPayoutGroup({ ...input, ownerId: user.uid });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payout-groups'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      toast.success('已建立墊付團');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '建立失敗'),
  });
}

export function useUpdatePayoutGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updatePayoutGroup>[1] }) =>
      updatePayoutGroup(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payout-groups'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '更新失敗'),
  });
}

export function useDeletePayoutGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePayoutGroup(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payout-groups'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      toast.success('已刪除');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '刪除失敗'),
  });
}

export type { PayoutGroup, PayoutParticipant };
