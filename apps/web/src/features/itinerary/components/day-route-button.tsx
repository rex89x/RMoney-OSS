import { useMemo, useState } from 'react';
import { Bike, Car, ExternalLink, Footprints, Route, TrainFront } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  buildDirectionsLinks, itemsToRouteStops, MAX_URL_WAYPOINTS, MOBILE_URL_WAYPOINTS, TRAVEL_MODE_LABEL,
  type TravelMode,
} from '../directions';
import type { ItineraryItem } from '../types';

const MODES: Array<{ mode: TravelMode; icon: React.ComponentType<{ className?: string }> }> = [
  { mode: 'transit', icon: TrainFront },
  { mode: 'walking', icon: Footprints },
  { mode: 'driving', icon: Car },
  { mode: 'bicycling', icon: Bike },
];

/** 觸控裝置的 Google Maps App / 行動瀏覽器只吃 3 個 waypoints */
function isCoarsePointer(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** 當天停留點依序開 Google Maps 路線（Maps URLs，不呼叫 Directions API、不計費） */
export function DayRouteButton({ items }: { items: ItineraryItem[] }) {
  const [mode, setMode] = useState<TravelMode>('transit');
  const stops = useMemo(() => itemsToRouteStops(items), [items]);
  const links = useMemo(
    () => buildDirectionsLinks(stops, mode, isCoarsePointer() ? MOBILE_URL_WAYPOINTS : MAX_URL_WAYPOINTS),
    [stops, mode],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={stops.length < 2} title={stops.length < 2 ? '至少要 2 個有地點的項目' : undefined}>
          <Route className="size-4" /> 路線
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3 p-3" align="start">
        <div className="text-sm font-medium">在 Google 地圖開啟本日路線</div>
        <div className="grid grid-cols-4 gap-1">
          {MODES.map(({ mode: m, icon: Icon }) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded-md border px-1 py-1.5 text-[11px]',
                mode === m ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
              )}
            >
              <Icon className="size-4" />
              {TRAVEL_MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <ol className="space-y-1">
          {links.map((l, i) => (
            <li key={l.url}>
              <a
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs hover:bg-muted"
              >
                <span className="shrink-0 tabular-nums text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate">{l.from} → {l.to}</span>
                {l.stopCount > 2 ? (
                  <span className="shrink-0 text-muted-foreground">{l.stopCount} 站</span>
                ) : null}
                <ExternalLink className="size-3 shrink-0" />
              </a>
            </li>
          ))}
        </ol>
        <p className="text-[11px] text-muted-foreground">
          {mode === 'transit'
            ? 'Google 大眾運輸路線不支援中途點，每段分開開啟。'
            : links.length > 1
              ? '停留點較多，已切成多段（下一段從上一段終點出發）。'
              : '依行程順序串接；沒有地點的項目會略過。'}
        </p>
      </PopoverContent>
    </Popover>
  );
}
