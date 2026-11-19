import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import {
  addPackingItem,
  addPackingItemsBulk,
  addTripDocument,
  createTrip,
  deletePackingItem,
  deleteTrip,
  deleteTripDocument,
  getTrip,
  listPackingItems,
  listTripDocuments,
  listTrips,
  uncheckAllPackingItems,
  updatePackingItem,
  updateTrip,
  updateTripDocument,
  type PackingItemInput,
  type PackingMemberPatch,
} from './api';
import { rememberTripForSource } from '@/features/ledger/paste-import-settings';
import { applyChiaumingImport, type ChiaumingImportTarget } from './apply-chiauming-import';
import type { ChiaumingImportPlan } from './import-chiauming';
import type { PackingTemplateItem } from './packing-template';
import type { PackingItem, Trip, TripDocument } from './types';
import { requireUid } from '@/lib/assert';

export function useTrips() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['trips', user?.uid],
    queryFn: () => listTrips(requireUid(user)),
    enabled: Boolean(user?.uid),
  });
}

export function useTrip(id: string | undefined) {
  return useQuery({
    queryKey: ['trip', id],
    queryFn: () => getTrip(id!),
    enabled: Boolean(id),
  });
}

export function useCreateTrip() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ trip, id }: { trip: Omit<Trip, 'id' | 'userId' | 'createdAt'>; id?: string }) => {
      if (!user) throw new Error('Not logged in');
      return createTrip(
        { ...trip, userId: user.uid, createdAt: new Date() } as Omit<Trip, 'id'>,
        id,
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trips'] });
      toast.success('已建立出遊');
    },
  });
}

export function useUpdateTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Trip> }) => updateTrip(id, patch),
    onSuccess: (_r, { id }) => {
      void qc.invalidateQueries({ queryKey: ['trip', id] });
      void qc.invalidateQueries({ queryKey: ['trips'] });
    },
  });
}

export function useDeleteTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTrip(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trips'] });
      toast.success('已刪除');
    },
  });
}

// -------- Trip documents --------

export function useTripDocuments(tripId: string | undefined) {
  return useQuery({
    queryKey: ['trip-documents', tripId],
    queryFn: () => listTripDocuments(tripId!),
    enabled: Boolean(tripId),
    staleTime: 30 * 1000,
  });
}

export function useAddTripDocument(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<TripDocument, 'id' | 'createdAt' | 'updatedAt'>) =>
      addTripDocument(tripId, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trip-documents', tripId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '新增文件失敗'),
  });
}

export function useUpdateTripDocument(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, patch }: { docId: string; patch: Partial<TripDocument> }) =>
      updateTripDocument(tripId, docId, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trip-documents', tripId] });
    },
  });
}

export function useDeleteTripDocument(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, storagePath }: { docId: string; storagePath?: string | null }) =>
      deleteTripDocument(tripId, docId, storagePath),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trip-documents', tripId] });
      toast.success('已刪除文件');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '刪除失敗'),
  });
}

// -------- Packing list --------

const packingKey = (tripId: string) => ['trip-packing', tripId] as const;

export function usePackingItems(tripId: string | undefined) {
  return useQuery({
    queryKey: packingKey(tripId ?? ''),
    queryFn: () => listPackingItems(tripId!),
    enabled: Boolean(tripId),
    staleTime: 15 * 1000,
  });
}

export function useAddPackingItem(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, order }: { input: PackingItemInput; order: number }) =>
      addPackingItem(tripId, input, order),
    onSuccess: () => void qc.invalidateQueries({ queryKey: packingKey(tripId) }),
    onError: (err) => {
      console.error('[addPackingItem]', err);
      toast.error(err instanceof Error ? err.message : '新增失敗');
    },
  });
}

export function useAddPackingTemplate(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ items, startOrder }: { items: PackingTemplateItem[]; startOrder: number }) =>
      addPackingItemsBulk(tripId, items, startOrder),
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: packingKey(tripId) });
      toast.success(n > 0 ? `已加入 ${n} 項` : '清單裡都有了，沒有新增項目');
    },
    onError: (err) => {
      console.error('[addPackingItemsBulk]', err);
      toast.error(err instanceof Error ? err.message : '產生失敗');
    },
  });
}

/**
 * 更新單筆（勾選 / 指派 / 編輯）。樂觀更新：先改 cache，失敗再還原（勾選是高頻動作，不等網路）。
 */
export function useUpdatePackingItem(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, patch }: { itemId: string; patch: Partial<PackingItemInput> & PackingMemberPatch }) =>
      updatePackingItem(tripId, itemId, patch),
    onMutate: async ({ itemId, patch }) => {
      await qc.cancelQueries({ queryKey: packingKey(tripId) });
      const previous = qc.getQueryData<PackingItem[]>(packingKey(tripId));
      if (previous) {
        qc.setQueryData<PackingItem[]>(
          packingKey(tripId),
          previous.map((it) => (it.id === itemId ? { ...it, ...patch, updatedAt: new Date() } : it)),
        );
      }
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(packingKey(tripId), ctx.previous);
      console.error('[updatePackingItem]', err);
      toast.error(err instanceof Error ? err.message : '更新失敗，已還原');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: packingKey(tripId) }),
  });
}

export function useDeletePackingItem(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => deletePackingItem(tripId, itemId),
    onMutate: async (itemId) => {
      await qc.cancelQueries({ queryKey: packingKey(tripId) });
      const previous = qc.getQueryData<PackingItem[]>(packingKey(tripId));
      if (previous) qc.setQueryData<PackingItem[]>(packingKey(tripId), previous.filter((it) => it.id !== itemId));
      return { previous };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(packingKey(tripId), ctx.previous);
      console.error('[deletePackingItem]', err);
      toast.error(err instanceof Error ? err.message : '刪除失敗，已還原');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: packingKey(tripId) }),
  });
}

export function useUncheckAllPacking(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemIds: string[]) => uncheckAllPackingItems(tripId, itemIds),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: packingKey(tripId) });
      const previous = qc.getQueryData<PackingItem[]>(packingKey(tripId));
      if (previous) qc.setQueryData<PackingItem[]>(packingKey(tripId), previous.map((it) => ({ ...it, packed: false })));
      return { previous };
    },
    onError: (err, _ids, ctx) => {
      if (ctx?.previous) qc.setQueryData(packingKey(tripId), ctx.previous);
      console.error('[uncheckAllPackingItems]', err);
      toast.error(err instanceof Error ? err.message : '操作失敗，已還原');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: packingKey(tripId) }),
  });
}

// -------- 從巧明日常匯入行程 --------

export function useImportChiaumingTrip() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ plan, target }: { plan: ChiaumingImportPlan; target: ChiaumingImportTarget }) => {
      if (!user) throw new Error('Not logged in');
      const result = await applyChiaumingImport({ plan, userId: user.uid, target });
      // 之後在「記帳 → 貼上匯入」貼同一趟旅程的費用，會預選這趟 RMoney 旅程。
      rememberTripForSource(plan.sourceTripKey, result.tripId);
      return result;
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['trips'] });
      void qc.invalidateQueries({ queryKey: ['trip', result.tripId] });
      void qc.invalidateQueries({ queryKey: ['itinerary', result.tripId] });
      void qc.invalidateQueries({ queryKey: ['itinerary-days', result.tripId] });
      void qc.invalidateQueries({ queryKey: ['itinerary-items', result.tripId] });
      void qc.invalidateQueries({ queryKey: ['itinerary-items-all', result.tripId] });
    },
  });
}
