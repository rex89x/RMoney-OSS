import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { useNotificationCenterStore } from '@/stores/notification-center-store';
import {
  deleteNotification, listNotifications, markNotificationRead, markNotificationsRead,
} from './api';
import type { AppNotification } from './types';
import { countUnread, safeNotificationLink } from './utils';

const NOTIFICATIONS_KEY = ['notifications'] as const;

/**
 * 不掛 onSnapshot（CLAUDE.md §5.5）：getDocs + 每 60 秒輪詢 + 視窗回到前景時重抓。
 * 背景分頁不輪詢（TanStack 預設 refetchIntervalInBackground: false）。
 */
function notificationsQuery(uid: string | undefined, enabled: boolean) {
  return queryOptions({
    queryKey: [...NOTIFICATIONS_KEY, uid ?? ''],
    queryFn: () => (uid ? listNotifications(uid) : Promise.resolve<AppNotification[]>([])),
    enabled: enabled && !!uid,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

/** rules 是 owner-only，member / viewer 不查 */
function useNotificationsQueryArgs() {
  const { user, isOwner } = useAuth();
  return { uid: user?.uid, enabled: isOwner };
}

export function useNotifications() {
  const { uid, enabled } = useNotificationsQueryArgs();
  return useQuery(notificationsQuery(uid, enabled));
}

/** 跟 useNotifications 共用同一個 query（同 key、同一次 fetch），只是 select 出未讀數 */
export function useUnreadNotificationCount(): number {
  const { uid, enabled } = useNotificationsQueryArgs();
  const { data = 0 } = useQuery({ ...notificationsQuery(uid, enabled), select: countUnread });
  return data;
}

/** 先改 cache 讓徽章立即更新，再 invalidate 跟伺服器對齊 */
function patchCache(qc: QueryClient, update: (items: AppNotification[]) => AppNotification[]) {
  qc.setQueriesData<AppNotification[]>({ queryKey: NOTIFICATIONS_KEY }, (prev) => (prev ? update(prev) : prev));
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: markNotificationRead,
    onSuccess: (_void, id) => {
      const now = new Date();
      patchCache(qc, (items) => items.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: now } : n)));
      void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: markNotificationsRead,
    onSuccess: (_void, ids) => {
      const now = new Date();
      const set = new Set(ids);
      patchCache(qc, (items) => items.map((n) => (set.has(n.id) && !n.readAt ? { ...n, readAt: now } : n)));
      void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}

export function useDeleteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteNotification,
    onSuccess: (_void, id) => {
      patchCache(qc, (items) => items.filter((n) => n.id !== id));
      void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}

/**
 * 通知中心面板的動作：點通知 → 標已讀 + 有站內連結就導頁並關面板；全部標為已讀；刪除。
 * 錯誤一律 toast（CLAUDE.md §10）。回傳 `navigated` 讓元件決定沒有連結時要不要展開內文。
 */
export function useNotificationCenterActions() {
  const navigate = useNavigate();
  const setOpen = useNotificationCenterStore((s) => s.setOpen);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const remove = useDeleteNotification();

  function markReadQuietly(n: AppNotification) {
    if (n.readAt) return;
    markRead.mutate(n.id, {
      onError: (err) => {
        console.error('[markNotificationRead]', err);
        toast.error(err instanceof Error ? err.message : '標記已讀失敗');
      },
    });
  }

  function open(n: AppNotification): { navigated: boolean } {
    markReadQuietly(n);
    const link = safeNotificationLink(n.link);
    if (!link) return { navigated: false };
    setOpen(false);
    navigate(link);
    return { navigated: true };
  }

  async function markAllRead(items: AppNotification[]) {
    const ids = items.filter((n) => !n.readAt).map((n) => n.id);
    if (ids.length === 0) return;
    try {
      await markAll.mutateAsync(ids);
      toast.success(`已將 ${ids.length} 則標為已讀`);
    } catch (err) {
      console.error('[markNotificationsRead]', err);
      toast.error(err instanceof Error ? err.message : '標記已讀失敗');
    }
  }

  async function removeOne(id: string) {
    try {
      await remove.mutateAsync(id);
    } catch (err) {
      console.error('[deleteNotification]', err);
      toast.error(err instanceof Error ? err.message : '刪除失敗');
    }
  }

  return {
    open,
    markAllRead,
    remove: removeOne,
    markingAll: markAll.isPending,
    removingId: remove.isPending ? remove.variables : undefined,
  };
}
