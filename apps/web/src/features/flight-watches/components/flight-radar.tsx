import { useMemo, useState } from 'react';
import { BookOpen, Filter, LayoutDashboard, List, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollTabsList } from '@/components/ui/scroll-tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  CABIN_ORDER,
  DEFAULT_FLIGHT_FILTERS,
  applyFlightFilters,
  isDefaultFilters,
  type CabinFilter,
  type FlightRadarFilters,
  type TripTypeFilter,
} from '../dashboard';
import { useFlightWatches, useSyncFlightWatchSharing } from '../hooks';
import { useAuth } from '@/hooks/use-auth';
import { CABIN_LABELS, flightRouteKey, flightRouteText } from '../options';
import type { FlightWatch } from '../types';
import { ClaudeScheduleDialog } from './claude-schedule-dialog';
import { FlightDashboard } from './flight-dashboard';
import { FlightRadarGuide } from './flight-radar-guide';
import { FlightWatchPanel } from './flight-watch-panel';

type FlightRadarTab = 'overview' | 'list' | 'guide';

/** /flights 頁面本體：總覽、航線列表、使用說明三個分頁；篩選與 Claude 排程對話框由這裡統一持有 */
export function FlightRadar() {
  const { user } = useAuth();
  const { data: watches = [], isLoading, isSuccess } = useFlightWatches();
  useSyncFlightWatchSharing(watches, isSuccess);
  // Claude 排程只處理自己建立的航線（推送 / 匯入都以建立者驗證）；別人分享的只能看
  const ownWatches = useMemo(() => watches.filter((watch) => watch.userId === user?.uid), [watches, user?.uid]);
  const [tab, setTab] = useState<FlightRadarTab | null>(null);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [filters, setFilters] = useState<FlightRadarFilters>(DEFAULT_FLIGHT_FILTERS);
  const filtered = useMemo(() => applyFlightFilters(watches, filters), [watches, filters]);
  // 還沒有任何航線時直接進列表，避免第一次進來看到空的總覽
  const active: FlightRadarTab = tab ?? (!isLoading && watches.length === 0 ? 'list' : 'overview');

  return (
    <>
      <Tabs value={active} onValueChange={(value) => setTab(value as FlightRadarTab)}>
        <ScrollTabsList
          aria-label="機票雷達分頁"
          value={active}
          items={[
            { value: 'overview', label: '總覽', icon: LayoutDashboard },
            { value: 'list', label: '航線', icon: List },
            { value: 'guide', label: '使用說明', icon: BookOpen },
          ]}
        />
        {active !== 'guide' && watches.length > 0 ? (
          <FilterBar watches={watches} filters={filters} onChange={setFilters} matched={filtered.length} />
        ) : null}
        <TabsContent value="overview" className="mt-3 min-w-0">
          {active === 'overview' ? (
            <FlightDashboard
              watches={filtered}
              allWatches={watches}
              cabin={filters.cabin}
              onOpenClaude={() => setClaudeOpen(true)}
              onGoToList={() => setTab('list')}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="list" className="mt-3 min-w-0">
          <FlightWatchPanel
            watches={filtered}
            allWatches={watches}
            isLoading={isLoading}
            filtered={!isDefaultFilters(filters)}
            onOpenClaude={() => setClaudeOpen(true)}
          />
        </TabsContent>
        <TabsContent value="guide" className="mt-3 min-w-0">
          {active === 'guide' ? <FlightRadarGuide /> : null}
        </TabsContent>
      </Tabs>
      <ClaudeScheduleDialog open={claudeOpen} onOpenChange={setClaudeOpen} watches={ownWatches} />
    </>
  );
}

const TRIP_OPTIONS: Array<{ value: TripTypeFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'roundtrip', label: '來回' },
  { value: 'oneway', label: '單程' },
  { value: 'openjaw', label: '多點' },
];

function FilterBar({ watches, filters, onChange, matched }: {
  watches: FlightWatch[];
  filters: FlightRadarFilters;
  onChange: (filters: FlightRadarFilters) => void;
  matched: number;
}) {
  const routes = useMemo(() => {
    const map = new Map<string, string>();
    watches.forEach((watch) => map.set(
      flightRouteKey(watch),
      flightRouteText(watch),
    ));
    return [...map.entries()];
  }, [watches]);
  const cabins = CABIN_ORDER.filter((cabin) => watches.some((watch) => watch.selectedCabins.includes(cabin)));

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border p-2 text-xs">
      <Filter className="ml-1 size-3.5 text-muted-foreground" aria-hidden />
      <div className="flex overflow-hidden rounded-full border" role="radiogroup" aria-label="行程">
        {TRIP_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={filters.tripType === option.value}
            onClick={() => onChange({ ...filters, tripType: option.value })}
            className={cn('px-2.5 py-1', filters.tripType === option.value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
          >
            {option.label}
          </button>
        ))}
      </div>
      <Select value={filters.cabin} onValueChange={(value) => onChange({ ...filters, cabin: value as CabinFilter })}>
        <SelectTrigger className="h-8 w-32 text-xs" aria-label="艙等"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部艙等</SelectItem>
          {cabins.map((cabin) => <SelectItem key={cabin} value={cabin}>{CABIN_LABELS[cabin]}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={filters.route} onValueChange={(value) => onChange({ ...filters, route: value })}>
        <SelectTrigger className="h-8 w-auto min-w-40 max-w-full text-xs" aria-label="航線"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部航線</SelectItem>
          {routes.map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground">{matched} / {watches.length} 個區段</span>
      {!isDefaultFilters(filters) ? (
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onChange(DEFAULT_FLIGHT_FILTERS)}>
          <X className="size-3.5" /> 清除
        </Button>
      ) : null}
    </div>
  );
}
