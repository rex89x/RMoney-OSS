import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Map as MapIcon, MapPinOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAllItineraryItems, useItineraryDays, useRelocateItems } from '@/features/itinerary/hooks';
import { relocateTaskFor, type LocateTask } from '@/features/itinerary/locate';
import { PointsMap, type MapPoint } from '@/features/itinerary/components/map-view';

const DAY_COLORS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#a855f7',
  '#22d3ee', '#fb7185', '#facc15', '#14b8a6',
];

interface TripOverviewMapProps {
  tripId: string;
  /** 只有旅程擁有者能寫行程表（Firestore Rules canWriteTrip），才顯示「重新定位」。 */
  canEdit?: boolean;
  /** 搜尋地名時補上目的地，避免同名地點搜到別的城市。 */
  destination?: string;
}

export function TripOverviewMap({ tripId, canEdit = false, destination = '' }: TripOverviewMapProps) {
  const { data: days = [] } = useItineraryDays(tripId);
  const dayIds = useMemo(() => days.map((d) => d.id), [days]);
  const { data: groups = [], isLoading } = useAllItineraryItems(tripId, dayIds);

  const points = useMemo<MapPoint[]>(() => {
    const out: MapPoint[] = [];
    groups.forEach(({ dayId, items }, dayIdx) => {
      const color = DAY_COLORS[dayIdx % DAY_COLORS.length] ?? '#8b5cf6';
      let cnt = 0;
      items.forEach((it) => {
        if (typeof it.lat !== 'number' || typeof it.lng !== 'number') return;
        cnt += 1;
        out.push({
          lat: it.lat,
          lng: it.lng,
          title: `Day ${dayIdx + 1} · ${it.title}`,
          groupKey: dayId,
          label: String(cnt),
          color,
        });
      });
    });
    return out;
  }, [groups]);

  const hasAny = points.length > 0;
  const relocate = useRelocateItems(tripId);
  // 還沒定位、但有辦法定位的項目（有地圖連結，或非交通類有地名）
  const unlocated = useMemo<LocateTask[]>(
    () => groups.flatMap(({ dayId, items }) => items
      .map((item) => relocateTaskFor(dayId, item, destination))
      .filter((task): task is LocateTask => task !== null)),
    [groups, destination],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MapIcon className="size-4" /> 全程地圖總覽
        </CardTitle>
        <Button asChild variant="outline" size="sm">
          <Link to={`/trips/${tripId}/itinerary`}>編輯行程</Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            載入地圖…
          </div>
        ) : (
          <PointsMap
            points={points}
            height={320}
            emptyHint={
              days.length === 0
                ? '尚未有行程 — 進入「行程規劃」新增'
                : '尚無含座標的項目 — 在 item 上貼 Google 地圖連結即可'
            }
          />
        )}
        {unlocated.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <MapPinOff className="size-3.5" /> {unlocated.length} 個項目還沒定位，地圖上看不到
            </span>
            {canEdit ? (
              <Button size="sm" variant="outline" disabled={relocate.isPending} onClick={() => relocate.mutate(unlocated)}>
                {relocate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {relocate.isPending ? '定位中…' : '重新定位'}
              </Button>
            ) : null}
          </div>
        )}
        {hasAny && (
          <div className="flex flex-wrap gap-2 pt-1">
            {groups.map(({ dayId }, i) => {
              const color = DAY_COLORS[i % DAY_COLORS.length] ?? '#8b5cf6';
              return (
                <span key={dayId} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
                  Day {i + 1}
                </span>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
