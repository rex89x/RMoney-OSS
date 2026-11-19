import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { useNotificationCenterStore } from '@/stores/notification-center-store';
import { useUnreadNotificationCount } from '../hooks';
import { formatUnreadBadge } from '../utils';

interface NotificationBellProps {
  className?: string;
  /** 開通知中心前先做的事（例如關掉「更多」drawer，避免兩層面板疊在一起） */
  onBeforeOpen?: () => void;
}

/** 鈴鐺 + 未讀徽章；只給 owner（notifications rules 是 owner-only） */
export function NotificationBell({ className, onBeforeOpen }: NotificationBellProps) {
  const { isOwner } = useAuth();
  const unread = useUnreadNotificationCount();
  const setOpen = useNotificationCenterStore((s) => s.setOpen);
  if (!isOwner) return null;
  const badge = formatUnreadBadge(unread);
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className={cn('relative shrink-0', className)}
      onClick={() => { onBeforeOpen?.(); setOpen(true); }}
      aria-label={unread > 0 ? `通知（${unread} 則未讀）` : '通知'}
      title="通知"
    >
      <Bell className="size-5" />
      {badge ? <UnreadBadge text={badge} className="absolute -right-0.5 -top-0.5" /> : null}
    </Button>
  );
}

interface UnreadBadgeProps {
  text: string;
  className?: string;
}

export function UnreadBadge({ text, className }: UnreadBadgeProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground',
        className,
      )}
    >
      {text}
    </span>
  );
}
