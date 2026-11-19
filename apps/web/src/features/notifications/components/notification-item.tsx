import { useState } from 'react';
import { AlertTriangle, ChevronRight, CircleAlert, Info, Trash2, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AppNotification, NotificationSeverity } from '../types';
import { formatNotificationTime, safeNotificationLink } from '../utils';

const SEVERITY_ICON: Record<NotificationSeverity, { icon: LucideIcon; className: string }> = {
  info: { icon: Info, className: 'text-muted-foreground' },
  warn: { icon: AlertTriangle, className: 'text-warning' },
  error: { icon: CircleAlert, className: 'text-destructive' },
};

interface NotificationItemProps {
  notification: AppNotification;
  now: Date;
  onOpen: (n: AppNotification) => { navigated: boolean };
  onDelete: (id: string) => void;
  deleting: boolean;
}

export function NotificationItem({ notification: n, now, onOpen, onDelete, deleting }: NotificationItemProps) {
  const [expanded, setExpanded] = useState(false);
  const unread = !n.readAt;
  const hasLink = safeNotificationLink(n.link) !== null;
  const { icon: Icon, className: iconClass } = SEVERITY_ICON[n.severity];

  return (
    <li className={cn('group relative flex items-start gap-1 rounded-lg', unread && 'bg-primary/5')}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg p-3 text-left transition-colors hover:bg-muted"
        onClick={() => {
          const { navigated } = onOpen(n);
          if (!navigated) setExpanded((v) => !v);
        }}
        aria-expanded={hasLink ? undefined : expanded}
      >
        <span className="relative mt-0.5 shrink-0">
          <Icon className={cn('size-4', iconClass)} aria-hidden />
          {unread ? (
            <>
              <span className="absolute -left-2 top-1 size-1.5 rounded-full bg-primary" aria-hidden />
              <span className="sr-only">未讀</span>
            </>
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cn('truncate text-sm', unread ? 'font-semibold' : 'font-medium text-muted-foreground')}>
              {n.title}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatNotificationTime(n.createdAt, now)}
            </span>
          </span>
          {n.body ? (
            <span
              className={cn(
                'mt-0.5 block whitespace-pre-line break-words text-xs text-muted-foreground',
                !expanded && 'line-clamp-3',
              )}
            >
              {n.body}
            </span>
          ) : null}
          {n.telegramOk === false ? (
            <span className="mt-1 block text-[11px] text-warning">Telegram 未送達，僅保留於此</span>
          ) : null}
        </span>
        {hasLink ? <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
      </button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="mt-2 shrink-0 text-muted-foreground opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100"
        onClick={() => onDelete(n.id)}
        disabled={deleting}
        aria-label="刪除通知"
        title="刪除"
      >
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}
