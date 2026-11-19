import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronDown, ChevronRight, MapPin, Clock, Calendar, ExternalLink, Sparkles,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { buildMapsUrlFromCoords } from '@/lib/google-maps-url';
import { useAllItineraryItems, useItineraryDays } from '@/features/itinerary/hooks';

export function TripDayCards({ tripId }: { tripId: string }) {
  const { data: days = [] } = useItineraryDays(tripId);
  const dayIds = useMemo(() => days.map((d) => d.id), [days]);
  const { data: groups = [] } = useAllItineraryItems(tripId, dayIds);
  const [openDays, setOpenDays] = useState<Record<string, boolean>>(() => ({}));

  if (days.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-2 p-6 text-center">
          <Sparkles className="mx-auto size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">這趟行程尚未規劃天數，先到「行程規劃」新增。</p>
          <Button asChild size="sm">
            <Link to={`/trips/${tripId}/itinerary`}>前往行程規劃</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const itemsByDay = new Map(groups.map((g) => [g.dayId, g.items]));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Calendar className="size-4" /> 行程速覽
        </CardTitle>
        <Button asChild variant="outline" size="sm">
          <Link to={`/trips/${tripId}/itinerary`}>編輯</Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {days.map((d, idx) => {
          const items = itemsByDay.get(d.id) ?? [];
          const open = openDays[d.id] ?? idx === 0;
          return (
            <div key={d.id} className="rounded-lg border bg-card">
              <button
                type="button"
                onClick={() => setOpenDays((s) => ({ ...s, [d.id]: !open }))}
                className="flex w-full items-center justify-between gap-2 rounded-t-lg p-3 text-left hover:bg-muted/50"
                aria-expanded={open}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    Day {idx + 1}
                    <span className="text-xs font-normal text-muted-foreground">{shortDayLabel(d.date)}</span>
                  </div>
                  {d.theme ? <div className="truncate text-xs text-muted-foreground">{d.theme}</div> : null}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{items.length} 項</span>
                  {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </div>
              </button>
              {open && (
                <div className={cn('border-t p-2', items.length === 0 && 'text-center text-xs text-muted-foreground')}>
                  {items.length === 0 ? (
                    '此日尚無項目'
                  ) : (
                    <ol className="space-y-1.5">
                      {items.map((it) => (
                        <li key={it.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40">
                          <div className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">
                            {it.startTime ? <span className="font-medium text-foreground">{it.startTime}</span> : '—'}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{it.title}</div>
                            {(it.placeName || it.address) && (
                              <div className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                                <MapPin className="size-3 shrink-0" />
                                <span className="truncate">{it.placeName ?? it.address}</span>
                              </div>
                            )}
                            {it.endTime && it.startTime && (
                              <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                <Clock className="size-3" /> {it.startTime}–{it.endTime}
                              </div>
                            )}
                          </div>
                          {(it.mapsUrl || (it.lat != null && it.lng != null)) && (
                            <a
                              href={
                                it.mapsUrl ??
                                buildMapsUrlFromCoords(it.lat as number, it.lng as number, it.placeName ?? it.title)
                              }
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex shrink-0 items-center gap-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                              aria-label="在 Google 地圖開啟"
                            >
                              <ExternalLink className="size-3.5" />
                            </a>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function shortDayLabel(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const d = new Date(parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10)); // 非空：regex 已匹配，群組一定存在
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${m[2]}/${m[3]} (${week})`;
}
