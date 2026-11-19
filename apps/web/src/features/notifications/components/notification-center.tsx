import { Link } from 'react-router-dom';
import { BellOff, CheckCheck, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { useNotificationCenterStore } from '@/stores/notification-center-store';
import { useNotificationCenterActions, useNotifications } from '../hooks';
import { countUnread, NOTIFICATIONS_LIMIT } from '../utils';
import { NotificationItem } from './notification-item';

/** 通知中心面板：在 AppLayout 掛一份，由 NotificationBell 透過 store 開啟 */
export function NotificationCenter() {
  const { isOwner } = useAuth();
  const open = useNotificationCenterStore((s) => s.open);
  const setOpen = useNotificationCenterStore((s) => s.setOpen);
  const { data: items = [], isLoading, isError, error } = useNotifications();
  const actions = useNotificationCenterActions();
  const unread = countUnread(items);
  // 同一次渲染共用一個 now，相對時間一致；60 秒輪詢 / 開關面板都會重新渲染
  const now = new Date();

  if (!isOwner) return null;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={setOpen}
      title="通知"
      description={unread > 0 ? `${unread} 則未讀 · 保留 60 天` : `最近 ${NOTIFICATIONS_LIMIT} 則 · 保留 60 天`}
      contentClassName="sm:max-w-lg"
      footer={(
        <div className="flex items-center justify-between gap-2">
          <Button asChild size="sm" variant="ghost">
            <Link to="/settings?tab=notifications" onClick={() => setOpen(false)}>
              <Settings className="size-4" /> 通知設定
            </Link>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={unread === 0 || actions.markingAll}
            onClick={() => void actions.markAllRead(items)}
          >
            <CheckCheck className="size-4" /> 全部標為已讀
          </Button>
        </div>
      )}
    >
      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive">
          讀取通知失敗：{error instanceof Error ? error.message : '未知錯誤'}
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={BellOff}
          title="目前沒有通知"
          description="排程推播（記帳日報、預算提醒、錯誤…）會同步出現在這裡"
        />
      ) : (
        <ul className="-mx-2 space-y-1">
          {items.map((n) => (
            <NotificationItem
              key={n.id}
              notification={n}
              now={now}
              onOpen={actions.open}
              onDelete={(id) => void actions.remove(id)}
              deleting={actions.removingId === n.id}
            />
          ))}
        </ul>
      )}
    </ResponsiveDialog>
  );
}
