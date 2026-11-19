import { AlertTriangle, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useItemOpeningHours } from '../hooks';
import { evaluateItemHours } from '../opening-hours';
import type { ItineraryItem } from '../types';

interface ItemHoursProps {
  itineraryId: string;
  dayId: string;
  /** 該天日期 `yyyy-MM-dd`（地點當地日期） */
  dayDate: string;
  item: ItineraryItem;
  canFetch: boolean;
  canSave: boolean;
}

/** 行程項目卡片內的一行：那天營業時間 + 排定時間不在營業時間 / 公休 / 歇業的警示 */
export function ItemHours({ itineraryId, dayId, dayDate, item, canFetch, canSave }: ItemHoursProps) {
  const { hours, isFetching } = useItemOpeningHours(itineraryId, dayId, item, { canFetch, canSave });
  if (!item.placeId) return null;
  if (!hours) {
    return isFetching ? (
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> 查詢營業時間…
      </div>
    ) : null;
  }
  const ev = evaluateItemHours(hours, dayDate, item.startTime, item.endTime);
  if (!ev.dayText && !ev.warning) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
      {ev.dayText ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
          <Clock className="size-3 shrink-0" />
          <span className="truncate">營業 {ev.dayText}</span>
        </span>
      ) : null}
      {ev.warning ? (
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium',
            ev.status === 'closes-before-end'
              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
              : 'bg-destructive/10 text-destructive',
          )}
        >
          <AlertTriangle className="size-3" /> {ev.warning}
        </span>
      ) : null}
    </div>
  );
}
