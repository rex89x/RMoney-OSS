import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import {
  archiveAccount,
  createAccount,
  listAccounts,
  subscribeAccounts,
  updateAccount,
  type ListAccountsFilters,
} from './api';
import type { Account, AccountInput } from './types';
import { requireUid } from '@/lib/assert';

export function useAccounts(filters: Omit<ListAccountsFilters, 'ownerId'> = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const stableFilters = useMemo<Omit<ListAccountsFilters, 'ownerId'>>(() => ({
    type: filters.type,
    includeArchived: filters.includeArchived,
  }), [filters.includeArchived, filters.type]);
  const queryKey = useMemo(() => ['accounts', user?.uid, stableFilters] as const, [stableFilters, user?.uid]);
  const result = useQuery<Account[]>({
    queryKey,
    queryFn: () => listAccounts({ ...stableFilters, ownerId: requireUid(user) }),
    enabled: Boolean(user?.uid),
    staleTime: 60 * 1000,
  });
  useEffect(() => {
    if (!user?.uid) return undefined;
    return subscribeAccounts(
      { ...stableFilters, ownerId: user.uid },
      (rows) => queryClient.setQueryData(queryKey, rows),
      (error) => console.error('[subscribeAccounts]', error),
    );
  }, [queryClient, queryKey, stableFilters, user?.uid]);
  return result;
}

export function useCreateAccount() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (input: Omit<AccountInput, 'ownerId'>) => {
      if (!user) throw new Error('Not logged in');
      return createAccount({ ...input, ownerId: user.uid });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('已新增帳戶');
    },
    onError: (err) => {
      console.error('[createAccount]', err);
      toast.error(err instanceof Error ? err.message : '新增帳戶失敗');
    },
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<AccountInput> }) =>
      updateAccount(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('已更新帳戶');
    },
    onError: (err) => {
      console.error('[updateAccount]', err);
      toast.error(err instanceof Error ? err.message : '更新帳戶失敗');
    },
  });
}

export function useArchiveAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: archiveAccount,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('已封存帳戶');
    },
    onError: (err) => {
      console.error('[archiveAccount]', err);
      toast.error(err instanceof Error ? err.message : '封存帳戶失敗');
    },
  });
}
