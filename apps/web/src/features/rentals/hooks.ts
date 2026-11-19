import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import {
  archiveRental, createRental, deleteRentalIncome, listRentals, recordRentalIncome, updateRental,
  type CreateRentalInput, type RecordRentalIncomeInput,
} from './api';
import type { Rental } from './types';
import { requireUid } from '@/lib/assert';

export function useRentals() {
  const { user } = useAuth();
  return useQuery<Rental[]>({
    queryKey: ['rentals', user?.uid],
    queryFn: () => listRentals(requireUid(user)),
    enabled: Boolean(user?.uid),
    staleTime: 60 * 1000,
  });
}

export function useCreateRental() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (input: Omit<CreateRentalInput, 'ownerId'>) => {
      if (!user) throw new Error('Not logged in');
      return createRental({ ...input, ownerId: user.uid });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rentals'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('已新增租賃資產');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '新增失敗'),
  });
}

export function useUpdateRental() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updateRental>[1] }) =>
      updateRental(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rentals'] });
      toast.success('已更新');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '更新失敗'),
  });
}

export function useArchiveRental() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: archiveRental,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rentals'] });
      toast.success('已封存');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '封存失敗'),
  });
}

export function useRecordRentalIncome() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (input: Omit<RecordRentalIncomeInput, 'ownerId'>) => {
      if (!user) throw new Error('Not logged in');
      return recordRentalIncome({ ...input, ownerId: user.uid });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rentals'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('已記錄收款');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '記錄失敗'),
  });
}

export function useDeleteRentalIncome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rentalId, incomeId }: { rentalId: string; incomeId: string }) =>
      deleteRentalIncome(rentalId, incomeId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rentals'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('已刪除收款');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '刪除失敗'),
  });
}
