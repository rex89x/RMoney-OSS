import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { callAppsScript } from '@/lib/apps-script';
import {
  deleteDay,
  deleteItem,
  getItinerary,
  listDays,
  listItems,
  moveDay,
  reorderItems,
  saveItemOpeningHours,
  updateItem,
  updateItineraryNotes,
  upsertDay,
  upsertItem,
  upsertItinerary,
} from './api';
import {
  needsOpeningHoursFetch, placeDetailsToOpeningHours, type PlaceDetailsResult,
} from './opening-hours';
import type { ItemOpeningHours, ItineraryItem } from './types';
import { useAuth } from '@/hooks/use-auth';
import type { ProposedStop } from './ai-import';
import { applyAiImport, type AiImportTarget } from './apply-ai-import';
import { backgroundLocate, type LocateTask } from './locate';

export function useItinerary(id: string | undefined) {
  return useQuery({
    queryKey: ['itinerary', id],
    queryFn: () => getItinerary(id!),
    enabled: Boolean(id),
  });
}

export function useItineraryDays(id: string | undefined) {
  return useQuery({
    queryKey: ['itinerary-days', id],
    queryFn: () => listDays(id!),
    enabled: Boolean(id),
  });
}

export function useItineraryItems(itineraryId: string | undefined, dayId: string | undefined) {
  return useQuery({
    queryKey: ['itinerary-items', itineraryId, dayId],
    queryFn: () => listItems(itineraryId!, dayId!),
    enabled: Boolean(itineraryId && dayId),
  });
}

/**
 * 抓整個 itinerary 所有 day 的 items（trip overview map / day cards 用）。
 * 注意 N+1 read：用於 trip detail 預覽，但天數通常 ≤ 14。
 */
export function useAllItineraryItems(itineraryId: string | undefined, dayIds: string[]) {
  return useQuery({
    queryKey: ['itinerary-items-all', itineraryId, dayIds],
    queryFn: async () => {
      if (!itineraryId || dayIds.length === 0) return [];
      const lists = await Promise.all(dayIds.map((id) => listItems(itineraryId, id)));
      return lists.map((items, i) => ({ dayId: dayIds[i] as string, items }));
    },
    enabled: Boolean(itineraryId) && dayIds.length > 0,
    staleTime: 30 * 1000,
  });
}

export function useUpsertItineraryItem(itineraryId: string, dayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (item: ItineraryItem) => upsertItem(itineraryId, dayId, item),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['itinerary-items', itineraryId, dayId] });
    },
  });
}

export function useUpdateItineraryItem(itineraryId: string, dayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, patch }: { itemId: string; patch: Partial<ItineraryItem> }) =>
      updateItem(itineraryId, dayId, itemId, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['itinerary-items', itineraryId, dayId] });
    },
  });
}

export function useDeleteItineraryItem(itineraryId: string, dayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => deleteItem(itineraryId, dayId, itemId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['itinerary-items', itineraryId, dayId] });
    },
  });
}

const PLACE_DETAILS_STALE_MS = 6 * 60 * 60 * 1000;

/** 抓營業時間時略過的類型：交通（車站 / 機場）與住宿通常沒有意義的營業時間，省 Places 費用 */
const HOURS_SKIP_TYPES = new Set<ItineraryItem['type']>(['transport', 'accommodation']);

/**
 * 項目營業時間：item 上已有且未過期（14 天、placeId 沒變）就直接用；
 * 否則（且呼叫者是 owner / admin，Apps Script `placeDetails` 只放行這兩個角色）透過 Apps Script 抓，
 * trip writer 會把結果存回 item，下次不用再抓。Apps Script 端另有 6 小時 CacheService。
 */
export function useItemOpeningHours(
  itineraryId: string,
  dayId: string,
  item: ItineraryItem,
  opts: { canFetch: boolean; canSave: boolean },
): { hours: ItemOpeningHours | undefined; isFetching: boolean } {
  const qc = useQueryClient();
  const placeId = item.placeId ?? '';
  const shouldFetch = opts.canFetch
    && Boolean(placeId)
    && !HOURS_SKIP_TYPES.has(item.type)
    && needsOpeningHoursFetch(item);

  const query = useQuery({
    queryKey: ['place-details', placeId],
    queryFn: async () => {
      try {
        const resp = await callAppsScript<PlaceDetailsResult>('placeDetails', undefined, { placeId });
        if (!resp.result) throw new Error('placeDetails 沒有回傳結果');
        return placeDetailsToOpeningHours(resp.result, placeId);
      } catch (err) {
        // 一天多個項目同時抓，失敗不逐筆 toast（例如 key 沒開 Places API），只記 log
        console.error('[placeDetails]', placeId, err);
        throw err;
      }
    },
    enabled: shouldFetch,
    staleTime: PLACE_DETAILS_STALE_MS,
    gcTime: PLACE_DETAILS_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const savedFor = useRef<string | null>(null);
  const fetched = query.data;
  useEffect(() => {
    if (!fetched || !opts.canSave || !shouldFetch) return;
    const key = `${item.id}:${fetched.placeId ?? placeId}:${fetched.fetchedAt.getTime()}`;
    if (savedFor.current === key) return;
    savedFor.current = key;
    saveItemOpeningHours(itineraryId, dayId, item.id, fetched)
      .then(() => qc.invalidateQueries({ queryKey: ['itinerary-items', itineraryId, dayId] }))
      .catch((err: unknown) => console.error('[saveItemOpeningHours]', err));
  }, [fetched, opts.canSave, shouldFetch, itineraryId, dayId, item.id, placeId, qc]);

  const hours = shouldFetch && fetched ? fetched : item.openingHours;
  return { hours, isFetching: query.isFetching };
}

export function useReorderItineraryItems(itineraryId: string, dayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) => reorderItems(itineraryId, dayId, orderedIds),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['itinerary-items', itineraryId, dayId] });
    },
  });
}

export function useMoveDay(itineraryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ oldDayId, newDayId, meta }: {
      oldDayId: string;
      newDayId: string;
      meta: { date: string; theme?: string };
    }) => moveDay(itineraryId, oldDayId, newDayId, meta),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['itinerary-days', itineraryId] });
      void qc.invalidateQueries({ queryKey: ['itinerary-items', itineraryId] });
      toast.success('已更新日期');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '移動失敗'),
  });
}

export function useDeleteDay(itineraryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dayId: string) => deleteDay(itineraryId, dayId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['itinerary-days', itineraryId] });
      void qc.invalidateQueries({ queryKey: ['itinerary-items', itineraryId] });
      toast.success('已刪除整天');
    },
  });
}

export interface GenerateItineraryInput {
  tripId: string;
  destination: string;
  startDate: string;
  endDate: string;
  budget?: number;
  interests?: string[];
  pace?: 'relaxed' | 'balanced' | 'packed';
  musts?: string[];
  avoid?: string[];
}

export interface SuggestedItem {
  startTime?: string;
  endTime?: string;
  type?: 'transport' | 'meal' | 'activity' | 'accommodation' | 'shopping';
  title: string;
  placeName?: string;
  estimatedCost?: number;
  currency?: string;
  notes?: string;
}

export function useSuggestDayItems() {
  return useMutation({
    mutationFn: async (input: {
      destination: string;
      dayTheme?: string;
      existingItems: Array<Pick<ItineraryItem, 'startTime' | 'title' | 'type'>>;
      count?: number;
      interests?: string[];
      avoid?: string[];
    }) => {
      const resp = await callAppsScript<{ suggestions?: SuggestedItem[] }>(
        'suggestDayItems', undefined, input,
      );
      return resp.suggestions ?? [];
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '建議失敗'),
  });
}

export function useGenerateItinerary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: GenerateItineraryInput) => {
      const resp = await callAppsScript('generateItinerary', undefined, {
        tripId: input.tripId,
        preferences: {
          destination: input.destination,
          startDate: input.startDate,
          endDate: input.endDate,
          budget: input.budget,
          interests: input.interests ?? [],
          pace: input.pace ?? 'balanced',
          musts: input.musts ?? [],
          avoid: input.avoid ?? [],
        },
      });
      return resp;
    },
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: ['itinerary', input.tripId] });
      void qc.invalidateQueries({ queryKey: ['itinerary-days', input.tripId] });
      toast.success('已生成行程 draft');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '生成失敗'),
  });
}

export function useUpsertItinerary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title, summary, tripId }: { id: string; title: string; summary?: string; tripId?: string }) =>
      upsertItinerary(id, { title, summary, tripId }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['itinerary', v.id] });
    },
  });
}

/** 編輯筆記 / tips（直接寫 Firestore；trip owner 才能寫，由 Rules 把關） */
export function useUpdateItineraryNotes(itineraryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { notes?: string; tips?: string[] }) =>
      updateItineraryNotes(itineraryId, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['itinerary', itineraryId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '儲存失敗'),
  });
}

interface GenerateNotesResponse {
  ok: boolean;
  markdown?: string;
  model?: string;
  error?: string;
}

/** 用 LLM 生成（只回 markdown，不直接寫 Firestore，由前端決定 append / replace） */
export function useGenerateTripNotes() {
  return useMutation({
    mutationFn: async (input: { tripId: string; prompt: string; tone?: string }) => {
      const resp = (await callAppsScript('generateTripNotes', undefined, input)) as GenerateNotesResponse;
      if (!resp.ok || !resp.markdown) {
        throw new Error(resp.error || 'LLM 沒有回應');
      }
      return resp.markdown;
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '生成失敗'),
  });
}

export function useUpsertDay(itineraryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (day: { id: string; date: string; theme?: string }) =>
      upsertDay(itineraryId, day),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['itinerary-days', itineraryId] });
    },
  });
}

/** 站內 Claude 整理行程文字：只回 JSON 字串，不寫 Firestore（Apps Script `parseItineraryText`）。 */
export function useParseItineraryText() {
  return useMutation({
    mutationFn: async (input: { instruction: string; text: string }) => {
      const resp = await callAppsScript('parseItineraryText', undefined, input);
      const json = typeof resp.json === 'string' ? resp.json : '';
      if (!json) throw new Error('AI 沒有回傳結果');
      return json;
    },
  });
}

function invalidateItinerary(qc: ReturnType<typeof useQueryClient>, tripId: string) {
  void qc.invalidateQueries({ queryKey: ['trips'] });
  void qc.invalidateQueries({ queryKey: ['trip', tripId] });
  void qc.invalidateQueries({ queryKey: ['itinerary', tripId] });
  void qc.invalidateQueries({ queryKey: ['itinerary-days', tripId] });
  void qc.invalidateQueries({ queryKey: ['itinerary-items', tripId] });
  void qc.invalidateQueries({ queryKey: ['itinerary-items-all', tripId] });
}

/** 套用勾選的 AI 提案；背景定位跑完再刷新一次地圖。 */
export function useApplyAiItinerary() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: { stops: ProposedStop[]; target: AiImportTarget }) => {
      if (!user) throw new Error('Not logged in');
      let tripIdForRefresh = '';
      const result = await applyAiImport({
        ...input,
        userId: user.uid,
        onLocateDone: ({ located, failed }) => {
          if (tripIdForRefresh) invalidateItinerary(qc, tripIdForRefresh);
          if (failed > 0) toast.warning(`地圖定位完成：${located} 個成功、${failed} 個找不到，可在行程頁按「重新定位」或貼 Google Maps 連結`);
          else if (located > 0) toast.success(`地圖定位完成：${located} 個地點`);
        },
      });
      tripIdForRefresh = result.tripId;
      return result;
    },
    onSuccess: (result) => invalidateItinerary(qc, result.tripId),
  });
}

/** 重新定位所有還沒有座標的項目。 */
export function useRelocateItems(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tasks: LocateTask[]) => backgroundLocate(tripId, tasks),
    onSuccess: ({ located, failed }) => {
      invalidateItinerary(qc, tripId);
      if (failed > 0) toast.warning(`定位 ${located} 個、${failed} 個仍找不到，可在項目裡貼 Google Maps 連結`);
      else toast.success(`已定位 ${located} 個地點`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '定位失敗'),
  });
}
