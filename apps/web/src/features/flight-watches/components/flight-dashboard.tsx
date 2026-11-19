import { useMemo, useState, type ReactNode } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bot,
  CalendarRange,
  ListChecks,
  Clock,
  LayoutGrid,
  LineChart as LineChartIcon,
  Plane,
  Ruler,
  ScatterChart as ScatterIcon,
  Ticket,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, formatAxisTWD, paletteColor } from '@/lib/chart-theme';
import { db } from '@/lib/firebase';
import { formatTW, parseDateInput } from '@/lib/tz';
import { cn, formatCurrency } from '@/lib/utils';
import {
  CABIN_ORDER,
  allTravelWindows,
  buildAirlineRows,
  buildCabinComparison,
  buildDeparturePoints,
  buildFlightOverview,
  buildPriceLadder,
  buildStopsSummary,
  buildTimeOfDay,
  buildCandidateRows,
  buildNightsRows,
  buildTrendRows,
  buildWeekBuckets,
  buildWeekdayRows,
  cabinsPresent,
  cheapestWindow,
  formatFlightDate,
  stableSeriesIndex,
  ticketingOf,
  type CabinFilter,
  type CandidateRow,
  type CandidateTag,
  type FlightAttentionItem,
  type PriceLadderRow,
  type RankedTravelWindow,
} from '../dashboard';
import { useClaudeWatchStatuses, useFlightSnapshotsForWatches } from '../hooks';
import { CABIN_LABELS, TRIP_TYPE_LABELS, flightWatchTitle } from '../options';
import type { FlightCabin, FlightPriceSnapshot, FlightWatch } from '../types';
import { FlightTicket } from './flight-ticket';

/** 走勢圖最多同時畫幾條線（色盤 8 色，超過就要使用者自己挑） */
const MAX_TREND_SERIES = 8;
const DEFAULT_TREND_SERIES = 4;
const DEFAULT_TICKETS = 4;
const ALL_FOCUS = '__all';

/** 艙等顏色固定，不隨篩選或資料多寡改變 */
function cabinColor(cabin: FlightCabin): string {
  return paletteColor(CABIN_ORDER.indexOf(cabin) + 1);
}

type SectionKey =
  | 'tickets'
  | 'attention'
  | 'timing'
  | 'candidates'
  | 'ladder'
  | 'cabins'
  | 'departure'
  | 'details'
  | 'trend';

const SECTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: 'tickets', label: '目前最低價機票' },
  { key: 'attention', label: '需要處理' },
  { key: 'timing', label: '哪段時間出發最便宜' },
  { key: 'candidates', label: '候選日期評估' },
  { key: 'ladder', label: '各區段目前價格' },
  { key: 'cabins', label: '艙等價差' },
  { key: 'departure', label: '出發日與票價' },
  { key: 'details', label: '航班時段、航空公司、直飛' },
  { key: 'trend', label: '較低價走勢比較' },
];
const SECTION_KEYS = SECTIONS.map((section) => section.key);

interface FlightDashboardProps {
  /** 已套用行程 / 航線 / 艙等篩選的區段 */
  watches: FlightWatch[];
  /** 未篩選的全部區段（KPI 與需要處理仍看全部，避免篩選後漏掉問題） */
  allWatches: FlightWatch[];
  cabin: CabinFilter;
  onOpenClaude: () => void;
  onGoToList: () => void;
}

export function FlightDashboard({ watches, allWatches, cabin, onOpenClaude, onGoToList }: FlightDashboardProps) {
  const statuses = useClaudeWatchStatuses(allWatches);
  const overview = useMemo(
    () => buildFlightOverview(allWatches, statuses.data ?? []),
    [allWatches, statuses.data],
  );
  const seriesIndex = useMemo(() => stableSeriesIndex(allWatches), [allWatches]);
  const layout = useFlightRadarLayout();
  const active = watches.filter((watch) => watch.enabled);
  // 出發時機、候選日期等分析預設只看一個區段：不同航線、單程與來回混在一起比「哪週便宜」會誤導
  const analysable = active.filter((watch) => (watch.latestEstimate?.travelWindows.length ?? 0) > 0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const defaultFocus = [...analysable]
    .sort((a, b) => (cheapestWindow(a, cabin)?.priceTWD ?? Infinity) - (cheapestWindow(b, cabin)?.priceTWD ?? Infinity))[0];
  const focus = focusId === ALL_FOCUS
    ? null
    : analysable.find((watch) => watch.id === focusId) ?? defaultFocus ?? null;
  const focusWatches = focus ? [focus] : active;
  const windows = allTravelWindows(focusWatches, cabin);
  // 週幾、時段、航空公司這類比較要在同一個艙等內比；沒選艙等時用最便宜那組的艙等
  const cheapestCabin = [...windows].sort((a, b) => a.window.priceTWD - b.window.priceTWD)[0]?.window.cabin;
  const comparisonCabin: FlightCabin | null = cabin !== 'all' ? cabin : cheapestCabin ?? null;
  const cabinWindows = comparisonCabin ? windows.filter(({ window }) => window.cabin === comparisonCabin) : windows;
  const cabinNote = comparisonCabin ? ` · ${CABIN_LABELS[comparisonCabin]}` : '';
  const focusLabel = focus ? `${flightWatchTitle(focus)}（${TRIP_TYPE_LABELS[focus.tripType]}）` : '全部區段';
  const focusPicker = analysable.length > 1 ? (
    <FocusPicker watches={analysable} value={focus ? focus.id : ALL_FOCUS} onChange={setFocusId} />
  ) : null;

  const render: Record<SectionKey, () => ReactNode> = {
    tickets: () => <TicketsSection watches={active} cabin={cabin} />,
    attention: () => (overview.attention.length > 0
      ? <AttentionCard items={overview.attention} onOpenClaude={onOpenClaude} />
      : null),
    timing: () => <TimingCard windows={cabinWindows} focusLabel={focusLabel + cabinNote} picker={focusPicker} />,
    candidates: () => <CandidatesCard windows={windows} focusLabel={focusLabel} picker={focusPicker} />,
    ladder: () => <PriceLadderCard rows={buildPriceLadder(active)} />,
    cabins: () => <CabinComparisonCard watches={active} cabin={cabin} />,
    departure: () => <DepartureScatterCard watches={focusWatches} cabin={cabin} focusLabel={focusLabel} picker={focusPicker} />,
    details: () => <FlightDetailsCard windows={cabinWindows} focusLabel={focusLabel + cabinNote} picker={focusPicker} />,
    trend: () => <TrendCard watches={watches} seriesIndex={seriesIndex} />,
  };

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatTile
          label="追蹤中區段"
          value={`${overview.activeCount} / ${overview.totalCount}`}
          hint={`${overview.routeCount} 條航線`}
          onClick={onGoToList}
        />
        <StatTile
          label="低於理想價"
          value={overview.belowTargetCount}
          tone={overview.belowTargetCount > 0 ? 'good' : 'plain'}
          hint="目前較低價已達你設定的理想價"
        />
        <StatTile
          label="建議購買"
          value={overview.buyNowCount}
          tone={overview.buyNowCount > 0 ? 'good' : 'plain'}
          hint="明顯低於常見價或達理想價"
        />
        <StatTile
          label="需要處理"
          value={overview.attention.length}
          tone={overview.attention.length > 0 ? 'warn' : 'plain'}
          hint={overview.attention.length > 0 ? '見下方清單' : '一切正常'}
        />
      </StatGrid>

      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => layout.setEditing(true)}>
          <LayoutGrid className="size-4" /> 調整版面
        </Button>
      </div>

      {active.length === 0 && allWatches.length > 0 ? (
        <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">沒有符合篩選條件的啟用中區段。</p>
      ) : null}

      {layout.order.filter((key) => !layout.hidden.includes(key)).map((key) => (
        <div key={key}>{render[key]()}</div>
      ))}

      <LayoutDialog layout={layout} />
    </div>
  );
}

// ---------- 版面設定（存在 users/{uid}.preferences.flightRadar） ----------

function useFlightRadarLayout() {
  const { user, profile } = useAuth();
  const saved = profile?.preferences?.flightRadar;
  const [order, setOrder] = useState<SectionKey[]>(() => {
    const known = (saved?.order ?? []).filter((key): key is SectionKey => SECTION_KEYS.includes(key as SectionKey));
    // 新版本加入的區塊自動補在最後
    return [...known, ...SECTION_KEYS.filter((key) => !known.includes(key))];
  });
  const [hidden, setHidden] = useState<SectionKey[]>(
    () => (saved?.hiddenSections ?? []).filter((key): key is SectionKey => SECTION_KEYS.includes(key as SectionKey)),
  );
  const [editing, setEditing] = useState(false);

  async function persist(nextOrder: SectionKey[], nextHidden: SectionKey[]) {
    setOrder(nextOrder);
    setHidden(nextHidden);
    if (!user) return;
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        'preferences.flightRadar': { order: nextOrder, hiddenSections: nextHidden },
      });
    } catch (error) {
      console.error('[saveFlightRadarLayout]', error);
      toast.error(error instanceof Error ? error.message : '儲存版面失敗');
    }
  }

  return {
    order,
    hidden,
    editing,
    setEditing,
    toggle: (key: SectionKey) => void persist(
      order,
      hidden.includes(key) ? hidden.filter((item) => item !== key) : [...hidden, key],
    ),
    move: (key: SectionKey, delta: -1 | 1) => {
      const index = order.indexOf(key);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= order.length) return;
      const next = [...order];
      next.splice(index, 1);
      next.splice(target, 0, key);
      void persist(next, hidden);
    },
    reset: () => void persist(SECTION_KEYS, []),
  };
}

function LayoutDialog({ layout }: { layout: ReturnType<typeof useFlightRadarLayout> }) {
  return (
    <ResponsiveDialog
      open={layout.editing}
      onOpenChange={layout.setEditing}
      title="調整總覽版面"
      description="開關要顯示的區塊並調整順序，會記在你的帳號設定。"
      footer={<Button variant="outline" className="w-full" onClick={layout.reset}>恢復預設</Button>}
    >
      <ul className="space-y-2">
        {layout.order.map((key, index) => (
          <li key={key} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
            <Switch
              checked={!layout.hidden.includes(key)}
              onCheckedChange={() => layout.toggle(key)}
              aria-label={`顯示${SECTIONS.find((section) => section.key === key)?.label ?? key}`}
            />
            <span className="min-w-0 flex-1 truncate">{SECTIONS.find((section) => section.key === key)?.label}</span>
            <Button size="icon-sm" variant="ghost" disabled={index === 0} onClick={() => layout.move(key, -1)} aria-label="上移">
              <ArrowUp className="size-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" disabled={index === layout.order.length - 1} onClick={() => layout.move(key, 1)} aria-label="下移">
              <ArrowDown className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    </ResponsiveDialog>
  );
}

// ---------- 區塊 ----------

function SectionCard({ icon: Icon, title, description, actions, children }: {
  icon: typeof Ticket;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <CardTitle className="flex items-center gap-2 text-base"><Icon className="size-4" /> {title}</CardTitle>
          {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="min-w-0 sm:shrink-0">{actions}</div> : null}
      </CardHeader>
      {/* min-w-0：子元素自己換行，不會把整張卡片撐寬而被頁面切掉 */}
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

function TicketsSection({ watches, cabin }: { watches: FlightWatch[]; cabin: CabinFilter }) {
  const [showAll, setShowAll] = useState(false);
  const tickets = watches
    .flatMap((watch) => {
      const window = cheapestWindow(watch, cabin);
      return window ? [{ watch, window }] : [];
    })
    .sort((a, b) => a.window.priceTWD - b.window.priceTWD);
  if (tickets.length === 0) return null;
  const visible = showAll ? tickets : tickets.slice(0, DEFAULT_TICKETS);
  return (
    <SectionCard
      icon={Ticket}
      title="目前最低價機票"
      description="每個區段最近一次掃描最便宜的一組日期，由低到高排列"
      actions={tickets.length > DEFAULT_TICKETS ? (
        <Button size="sm" variant="ghost" onClick={() => setShowAll((value) => !value)}>
          {showAll ? '收合' : `全部 ${tickets.length} 張`}
        </Button>
      ) : undefined}
    >
      <div className="grid gap-3 2xl:grid-cols-2">
        {visible.map(({ watch, window }) => (
          <div key={watch.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="min-w-0 break-words font-medium text-foreground">{flightWatchTitle(watch)}</span>
              <Badge variant="outline" className="shrink-0">{TRIP_TYPE_LABELS[watch.tripType]}</Badge>
            </div>
            <FlightTicket watch={watch} window={window} />
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

const ATTENTION_LABELS: Record<FlightAttentionItem['kind'], string> = {
  error: '更新失敗',
  'stale-push': '排程沒推送',
  'prompt-stale': '提示詞過期',
  'prompt-new': '未加入排程',
};

function AttentionCard({ items, onOpenClaude }: { items: FlightAttentionItem[]; onOpenClaude: () => void }) {
  const needsClaude = items.some((item) => item.kind !== 'error');
  return (
    <SectionCard
      icon={AlertTriangle}
      title="需要處理"
      actions={needsClaude ? (
        <Button size="sm" variant="outline" onClick={onOpenClaude}>
          <Bot className="size-4" /> Claude 排程
        </Button>
      ) : undefined}
    >
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={`${item.kind}-${index}`} className="flex items-start gap-2 text-xs">
            <Badge variant={item.kind === 'error' ? 'destructive' : 'warning'} className="shrink-0">
              {ATTENTION_LABELS[item.kind]}
            </Badge>
            <div className="min-w-0">
              <div className="font-medium">{item.watches.map(flightWatchTitle).join('、')}</div>
              <div className="break-words text-muted-foreground">{item.message}</div>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/**
 * 出發時機：每週一格，格子深淺代表該週最低價（越深越便宜），價格直接印在格子裡，不靠顏色辨識；
 * 最便宜的三週標「推薦」。下方再拆週幾出發、住幾晚。
 */
function TimingCard({ windows, focusLabel, picker }: { windows: RankedTravelWindow[]; focusLabel: string; picker: ReactNode }) {
  const weeks = buildWeekBuckets(windows);
  if (weeks.length === 0) return null;
  const weekdays = buildWeekdayRows(windows);
  const nights = buildNightsRows(windows);
  const prices = weeks.map((week) => week.minPrice);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const intensity = (price: number) => (max === min ? 0.85 : 0.2 + 0.65 * ((max - price) / (max - min)));
  const recommended = [...weeks].sort((a, b) => a.rank - b.rank).slice(0, 3);
  return (
    <SectionCard
      icon={CalendarRange}
      title="哪段時間出發最便宜"
      description={`${focusLabel}：依出發日所在的週分組，每格是該週查到的最低價；格子越深越便宜`}
      actions={picker}
    >
      <div className="space-y-4">
        {recommended.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {recommended.map((week) => (
              <div key={week.weekStart} className="rounded-lg border p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">推薦 #{week.rank} · {week.label}</span>
                  <span className="font-semibold tabular-nums text-primary">{formatCurrency(week.minPrice)}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {flightWatchTitle(week.best.watch)} · {formatFlightDate(week.best.window.departureDate)}
                  {week.best.window.returnDate ? ` → ${formatFlightDate(week.best.window.returnDate)}` : '（單程）'}
                </div>
                <div className="text-muted-foreground">
                  {CABIN_LABELS[week.best.window.cabin]} · {week.best.window.airline || '航空公司待確認'} · {week.best.window.stops === 0 ? '直飛' : `${week.best.window.stops} 轉`}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 lg:grid-cols-8" role="list" aria-label="每週最低價">
          {weeks.map((week) => {
            const alpha = intensity(week.minPrice);
            return (
              <div
                key={week.weekStart}
                role="listitem"
                title={`${week.label}：最低 ${formatCurrency(week.minPrice)}（${week.count} 組候選）`}
                className="rounded-md p-1.5 text-center"
                style={{ background: `hsl(var(--primary) / ${alpha.toFixed(2)})` }}
              >
                <div className={cn('text-[10px]', alpha > 0.5 ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{week.label}</div>
                <div className={cn('text-xs font-semibold tabular-nums', alpha > 0.5 ? 'text-primary-foreground' : 'text-foreground')}>
                  {formatAxisTWD(week.minPrice)}
                </div>
                {week.rank <= 3 ? (
                  <div className={cn('text-[10px]', alpha > 0.5 ? 'text-primary-foreground' : 'text-primary')}>推薦</div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>較貴</span>
          <span className="h-2 w-24 rounded-full" style={{ background: 'linear-gradient(to right, hsl(var(--primary) / 0.2), hsl(var(--primary) / 0.85))' }} />
          <span>較便宜</span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-medium">週幾出發</h4>
            <HorizontalBars rows={weekdays.map((row) => ({ label: row.label, value: row.minPrice, hint: `${row.count} 組` }))} />
          </div>
          {nights.length > 0 ? (
            <div>
              <h4 className="mb-2 text-xs font-medium">住幾晚（來回）</h4>
              <HorizontalBars rows={nights.map((row) => ({ label: row.label, value: row.minPrice, hint: `${row.count} 組` }))} />
            </div>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

const CANDIDATE_TAG_LABELS: Record<CandidateTag, string> = {
  cheapest: '區段最低',
  'direct-cheapest': '直飛最低',
  weekend: '週五六出發',
  'below-target': '達理想價',
};

type CandidateSort = 'price' | 'date' | 'diff';
type CandidateDayFilter = 'all' | 'weekday' | 'weekend';
const CANDIDATE_PAGE = 12;

/** 候選日期評估：所有推薦日期攤開比較，可排序、篩平日／週末與直飛，並顯示比同區段最低價貴多少 */
function CandidatesCard({ windows, focusLabel, picker }: { windows: RankedTravelWindow[]; focusLabel: string; picker: ReactNode }) {
  const [sort, setSort] = useState<CandidateSort>('price');
  const [day, setDay] = useState<CandidateDayFilter>('all');
  const [directOnly, setDirectOnly] = useState(false);
  const [ticket, setTicket] = useState<'all' | 'single' | 'separate'>('all');
  const [limit, setLimit] = useState(CANDIDATE_PAGE);
  const hasSeparate = windows.some(({ window }) => ticketingOf(window) === 'separate');
  const rows = buildCandidateRows(windows)
    .filter((row) => (day === 'all' || (day === 'weekend') === row.weekend) && (!directOnly || row.window.stops === 0))
    .filter((row) => ticket === 'all' || !hasSeparate || ticketingOf(row.window) === ticket)
    .sort((a, b) => (sort === 'date'
      ? a.window.departureDate.localeCompare(b.window.departureDate) || a.window.priceTWD - b.window.priceTWD
      : sort === 'diff'
        ? a.diffPercent - b.diffPercent || a.window.priceTWD - b.window.priceTWD
        : a.window.priceTWD - b.window.priceTWD));
  if (windows.length === 0) return null;
  return (
    <SectionCard
      icon={ListChecks}
      title="候選日期評估"
      description={`${focusLabel}：共 ${windows.length} 組候選日期；「比最低」是跟同區段、同艙等最便宜的那組相比`}
      actions={picker}
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
        <ChipGroup
          value={sort}
          onChange={setSort}
          options={[{ value: 'price', label: '價格低→高' }, { value: 'date', label: '出發日' }, { value: 'diff', label: '比最低差距' }]}
        />
        <ChipGroup
          value={day}
          onChange={setDay}
          options={[{ value: 'all', label: '全部日子' }, { value: 'weekday', label: '平日出發' }, { value: 'weekend', label: '週五六出發' }]}
        />
        {hasSeparate ? (
          <ChipGroup
            value={ticket}
            onChange={setTicket}
            options={[{ value: 'all', label: '全部票種' }, { value: 'single', label: '一張票' }, { value: 'separate', label: '拼單程' }]}
          />
        ) : null}
        <label className="flex items-center gap-1.5 rounded-full border px-2.5 py-1">
          <Switch checked={directOnly} onCheckedChange={setDirectOnly} className="scale-75" aria-label="只看直飛" />
          只看直飛
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">沒有符合條件的候選日期。</p>
      ) : (
        <ul className="divide-y">
          {rows.slice(0, limit).map((row, index) => (
            <CandidateItem key={`${row.watch.id}-${row.window.departureDate}-${row.window.cabin}-${index}`} row={row} />
          ))}
        </ul>
      )}
      {rows.length > limit ? (
        <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={() => setLimit((value) => value + CANDIDATE_PAGE)}>
          再顯示 {Math.min(CANDIDATE_PAGE, rows.length - limit)} 組（還有 {rows.length - limit} 組）
        </Button>
      ) : null}
    </SectionCard>
  );
}

function CandidateItem({ row }: { row: CandidateRow }) {
  const { watch, window } = row;
  return (
    <li className="flex items-start justify-between gap-3 py-2 text-xs">
      <div className="min-w-0 space-y-0.5 break-words">
        <div className="font-medium">
          {formatFlightDate(window.departureDate)}
          {window.departureTime ? ` ${window.departureTime}` : ''}
          {window.returnDate ? ` → ${formatFlightDate(window.returnDate)}` : '（單程）'}
          {row.nights !== null ? <span className="font-normal text-muted-foreground">（{row.nights} 晚）</span> : null}
        </div>
        <div className="text-muted-foreground">
          {flightWatchTitle(watch)} · {CABIN_LABELS[window.cabin]} · {window.airline || '航空公司待確認'}
          {window.flightNumber ? ` ${window.flightNumber}` : ''} · {window.stops === 0 ? '直飛' : `${window.stops} 轉`}
        </div>
        {ticketingOf(window) === 'separate' ? (
          <div className="text-muted-foreground">
            <Badge variant="warning" className="mr-1 text-[10px]">拼單程</Badge>
            {window.outboundPriceTWD && window.returnPriceTWD
              ? `去 ${formatCurrency(window.outboundPriceTWD)} ＋ 回 ${formatCurrency(window.returnPriceTWD)}${window.returnAirline ? `（回程 ${window.returnAirline}）` : ''}`
              : '去回分開兩張票'}
          </div>
        ) : null}
        {row.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {row.tags.map((tag) => (
              <Badge key={tag} variant={tag === 'cheapest' || tag === 'below-target' ? 'success' : 'secondary'} className="text-[10px]">
                {CANDIDATE_TAG_LABELS[tag]}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">{formatCurrency(window.priceTWD)}</div>
        <div className="text-[11px] tabular-nums text-muted-foreground">
          {row.diffFromBest === 0 ? '最低' : `+${formatCurrency(row.diffFromBest)}（+${row.diffPercent.toFixed(0)}%）`}
        </div>
      </div>
    </li>
  );
}

function ChipGroup<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="flex max-w-full flex-wrap overflow-hidden rounded-2xl border" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn('px-2.5 py-1', value === option.value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 各區段價格尺：同一條 TWD 軸上比較目前較低價（長條）、歷史最低（圓點）與理想價（直線）。
 * 用 HTML 畫而不是 Recharts，手機上每列一行、數字直接標在右邊，不必 hover。
 */
function PriceLadderCard({ rows }: { rows: PriceLadderRow[] }) {
  if (rows.length === 0) return null;
  const values = rows.flatMap((row) => [row.current, row.best, row.typical, row.target ?? row.current]);
  const domainMin = Math.min(...values) * 0.85;
  const domainMax = Math.max(...values) * 1.05;
  const position = (value: number) => `${((value - domainMin) / (domainMax - domainMin)) * 100}%`;

  return (
    <SectionCard icon={Ruler} title="各區段目前價格">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-primary" /> 目前較低價</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-full border-2 border-background bg-foreground ring-1 ring-foreground" /> 歷史最低</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-0.5 bg-foreground/60" /> 理想價</span>
      </div>
      <div className="space-y-3">
        {rows.map((row) => {
          const below = row.target !== null && row.current <= row.target;
          return (
            <div
              key={row.watch.id}
              title={`目前 ${formatCurrency(row.current)}｜常見 ${formatCurrency(row.typical)}｜歷史最低 ${formatCurrency(row.best)}${row.target ? `｜理想價 ${formatCurrency(row.target)}` : ''}`}
            >
              <div className="mb-1 flex items-start justify-between gap-2 text-xs">
                <span className="min-w-0 break-words font-medium">
                  {flightWatchTitle(row.watch)}
                  <span className="ml-1 font-normal text-muted-foreground">{TRIP_TYPE_LABELS[row.watch.tripType]}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatCurrency(row.current)}
                  {below ? <Badge variant="success" className="ml-1.5">達理想價</Badge> : null}
                </span>
              </div>
              <div className="relative h-3 rounded-full bg-muted">
                <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: position(row.current) }} />
                {row.target !== null ? (
                  <div className="absolute -inset-y-1 w-0.5 bg-foreground/60" style={{ left: position(row.target) }} />
                ) : null}
                <div
                  className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground"
                  style={{ left: position(row.best) }}
                />
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                常見 {formatCurrency(row.typical)} · 歷史最低 {formatCurrency(row.best)}
                {row.target ? ` · 理想價 ${formatCurrency(row.target)}` : ''}
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

function CabinComparisonCard({ watches, cabin }: { watches: FlightWatch[]; cabin: CabinFilter }) {
  const rows = buildCabinComparison(watches, cabin);
  const cabins = cabinsPresent(rows);
  if (rows.length === 0) return null;
  const height = Math.max(160, rows.length * (cabins.length * 14 + 18) + 40);
  // Y 軸標籤（區段名稱）寬度依最長名稱估算，避免「NRT/KIX 寒假」這種多點進出名稱被切掉；CJK 字約 11px、英數約 7px
  const labelWidth = Math.min(150, Math.max(64, ...rows.map((row) => estimateLabelWidth(row.name))));
  return (
    <SectionCard icon={BarChart3} title="艙等價差" description="每個區段各艙等目前的較低價（所有旅客合計）">
      <div className="w-full" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }} barGap={2} barCategoryGap={8}>
            <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" {...AXIS_PROPS} tickFormatter={formatAxisTWD} />
            <YAxis type="category" dataKey="name" {...AXIS_PROPS} width={labelWidth} tickFormatter={(value: string) => clampLabel(value, labelWidth)} />
            <Tooltip
              {...CHART_TOOLTIP_PROPS}
              formatter={(value: number, key: string) => [formatCurrency(value), CABIN_LABELS[key as FlightCabin] ?? key]}
            />
            {cabins.length > 1 ? (
              <Legend formatter={(value: string) => CABIN_LABELS[value as FlightCabin] ?? value} wrapperStyle={{ fontSize: 11 }} />
            ) : null}
            {cabins.map((item) => (
              <Bar key={item} dataKey={item} fill={cabinColor(item)} radius={[0, 4, 4, 0]} barSize={12} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </SectionCard>
  );
}

function DepartureScatterCard({ watches, cabin, focusLabel, picker }: {
  watches: FlightWatch[];
  cabin: CabinFilter;
  focusLabel: string;
  picker: ReactNode;
}) {
  const points = buildDeparturePoints(watches, cabin);
  const cabins = CABIN_ORDER.filter((item) => points.some((point) => point.cabin === item));
  if (points.length === 0) return null;
  const formatDay = (value: number) => {
    const date = new Date(value);
    return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
  };
  return (
    <SectionCard
      icon={ScatterIcon}
      title="出發日與票價"
      description={`${focusLabel}：每個點是一組候選日期；越低越便宜`}
      actions={picker}
    >
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              domain={['dataMin - 43200000', 'dataMax + 43200000']}
              padding={{ left: 12, right: 12 }}
              minTickGap={12}
              {...AXIS_PROPS}
              tickFormatter={formatDay}
              name="出發日"
            />
            <YAxis type="number" dataKey="price" {...AXIS_PROPS} width={48} tickFormatter={formatAxisTWD} domain={['auto', 'auto']} name="價格" />
            <ZAxis range={[64, 64]} />
            <Tooltip
              {...CHART_TOOLTIP_PROPS}
              cursor={{ stroke: CHART_COLORS.axis, strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                const point = active ? (payload?.[0]?.payload as ReturnType<typeof buildDeparturePoints>[number] | undefined) : undefined;
                if (!point) return null;
                return (
                  <div style={CHART_TOOLTIP_PROPS.contentStyle} className="px-2 py-1.5">
                    <div className="font-medium">{point.label}</div>
                    <div>{formatFlightDate(point.date)} · {CABIN_LABELS[point.cabin]}</div>
                    <div className="font-semibold">{formatCurrency(point.price)}</div>
                  </div>
                );
              }}
            />
            {cabins.length > 1 ? (
              <Legend formatter={(value: string) => CABIN_LABELS[value as FlightCabin] ?? value} wrapperStyle={{ fontSize: 11 }} />
            ) : null}
            {cabins.map((item) => (
              <Scatter
                key={item}
                name={item}
                data={points.filter((point) => point.cabin === item)}
                fill={cabinColor(item)}
                stroke="hsl(var(--background))"
                strokeWidth={2}
                isAnimationActive={false}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </SectionCard>
  );
}

function FlightDetailsCard({ windows, focusLabel, picker }: { windows: RankedTravelWindow[]; focusLabel: string; picker: ReactNode }) {
  if (windows.length === 0) return null;
  const timeOfDay = buildTimeOfDay(windows);
  const airlines = buildAirlineRows(windows);
  const stops = buildStopsSummary(windows);
  return (
    <SectionCard
      icon={Plane}
      title="航班時段、航空公司、直飛"
      description={`${focusLabel}：以候選日期計算各類別的最低價`}
      actions={picker}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <h4 className="mb-2 text-xs font-medium">直飛 vs 轉機</h4>
          <div className="grid grid-cols-2 gap-2">
            <MiniStat label={`直飛（${stops.directCount}）`} value={stops.directMin} />
            <MiniStat label={`轉機（${stops.connectingCount}）`} value={stops.connectingMin} />
          </div>
          {stops.directMin !== null && stops.connectingMin !== null ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              直飛比轉機{stops.directMin >= stops.connectingMin ? '貴' : '便宜'} {formatCurrency(Math.abs(stops.directMin - stops.connectingMin))}
            </p>
          ) : null}
        </div>
        <div>
          <h4 className="mb-2 flex items-center gap-1 text-xs font-medium"><Clock className="size-3.5" /> 去程出發時段最低價</h4>
          {timeOfDay.withTime === 0 ? (
            <p className="text-xs text-muted-foreground">結果還沒有航班時間。Claude 排程新版提示詞與 Duffel 會附上出發時間。</p>
          ) : (
            <HorizontalBars rows={timeOfDay.rows.map((row) => ({ label: row.label, value: row.minPrice, hint: `${row.count} 筆` }))} />
          )}
        </div>
        <div>
          <h4 className="mb-2 text-xs font-medium">航空公司最低價</h4>
          <HorizontalBars rows={airlines.map((row) => ({ label: row.airline, value: row.minPrice, hint: `${row.count} 筆` }))} />
        </div>
      </div>
    </SectionCard>
  );
}

function MiniStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value === null ? '—' : formatCurrency(value)}</div>
    </div>
  );
}

/** 單一數列的橫條（HTML）：同一個區塊內共用尺度，數字標在右邊 */
function HorizontalBars({ rows }: { rows: Array<{ label: string; value: number | null; hint: string }> }) {
  const max = Math.max(...rows.map((row) => row.value ?? 0), 1);
  const values = rows.map((row) => row.value).filter((value): value is number => value !== null);
  const lowest = values.length > 1 ? Math.min(...values) : null;
  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.label} className="text-xs" title={`${row.label}：${row.value === null ? '無資料' : formatCurrency(row.value)}（${row.hint}）`}>
          <div className="flex items-start justify-between gap-2">
            <span className={cn('min-w-0 break-words', row.value === lowest && 'font-medium')}>
              {row.label}{row.value === lowest ? <span className="ml-1 text-primary">最低</span> : null}
            </span>
            <span className={cn('shrink-0 tabular-nums', row.value === lowest ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
              {row.value === null ? '—' : formatCurrency(row.value)}
              {row.value !== null && lowest !== null && row.value > lowest ? (
                <span className="ml-1 text-[10px]">+{formatAxisTWD(row.value - lowest)}</span>
              ) : null}
            </span>
          </div>
          <div className="mt-0.5 h-1.5 rounded-full bg-muted">
            {row.value !== null ? (
              <div
                className={cn('h-full rounded-full', lowest === null || row.value === lowest ? 'bg-primary' : 'bg-primary/40')}
                style={{ width: `${(row.value / max) * 100}%` }}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function TrendCard({ watches, seriesIndex }: { watches: FlightWatch[]; seriesIndex: Map<string, number> }) {
  const candidates = useMemo(
    () => watches
      .filter((watch) => watch.latestEstimate !== null)
      .sort((a, b) => (seriesIndex.get(a.id) ?? 0) - (seriesIndex.get(b.id) ?? 0)),
    [watches, seriesIndex],
  );
  const [picked, setPicked] = useState<string[] | null>(null);
  const selectedIds = (picked ?? candidates.filter((watch) => watch.enabled).slice(0, DEFAULT_TREND_SERIES).map((watch) => watch.id))
    .filter((id) => candidates.some((watch) => watch.id === id));
  const queries = useFlightSnapshotsForWatches(selectedIds);
  const loading = queries.some((query) => query.isLoading);
  // 最多 8 條 × 36 筆，直接每次重算即可
  const rows = buildTrendRows(new Map<string, FlightPriceSnapshot[]>(
    selectedIds.map((id, index) => [id, queries[index]?.data ?? []]),
  ));
  const byId = new Map(watches.map((watch) => [watch.id, watch]));

  if (candidates.length === 0) return null;

  function toggle(id: string) {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((item) => item !== id)
      : selectedIds.length >= MAX_TREND_SERIES ? selectedIds : [...selectedIds, id];
    setPicked(next);
  }

  return (
    <SectionCard
      icon={LineChartIcon}
      title="較低價走勢比較"
      description={`每個區段每天取一筆最低價；點選下方區段切換顯示（最多 ${MAX_TREND_SERIES} 條）`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="選擇要比較的區段">
          {candidates.map((watch) => {
            const active = selectedIds.includes(watch.id);
            return (
              <button
                key={watch.id}
                type="button"
                aria-pressed={active}
                onClick={() => toggle(watch.id)}
                className={cn(
                  'flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-left text-xs transition-colors',
                  active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50',
                )}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: active ? paletteColor(seriesIndex.get(watch.id) ?? 0) : CHART_COLORS.muted }}
                />
                <span className="min-w-0 break-words">{flightWatchTitle(watch)}</span>
              </button>
            );
          })}
        </div>
        {selectedIds.length === 0 ? (
          <p className="text-xs text-muted-foreground">請至少選一個區段。</p>
        ) : loading ? (
          <p className="text-xs text-muted-foreground">載入中…</p>
        ) : rows.length < 2 ? (
          <p className="text-xs text-muted-foreground">累積至少兩天的掃描後會顯示走勢。</p>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
                <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  {...AXIS_PROPS}
                  minTickGap={16}
                  padding={{ left: 8, right: 8 }}
                  tickFormatter={(value: string) => {
                    const date = parseDateInput(value);
                    return date ? formatTW(date, 'M/d') : value;
                  }}
                />
                <YAxis {...AXIS_PROPS} width={48} tickFormatter={formatAxisTWD} domain={['auto', 'auto']} />
                <Tooltip
                  {...CHART_TOOLTIP_PROPS}
                  cursor={{ stroke: CHART_COLORS.axis, strokeWidth: 1 }}
                  formatter={(value: number, key: string) => {
                    const watch = byId.get(key);
                    return [formatCurrency(value), watch ? flightWatchTitle(watch) : key];
                  }}
                />
                {selectedIds.map((id) => (
                  <Line
                    key={id}
                    type="monotone"
                    dataKey={id}
                    name={id}
                    stroke={paletteColor(seriesIndex.get(id) ?? 0)}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5, strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function FocusPicker({ watches, value, onChange }: {
  watches: FlightWatch[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-full text-xs sm:w-64" aria-label="分析區段"><SelectValue /></SelectTrigger>
      <SelectContent>
        {watches.map((watch) => (
          <SelectItem key={watch.id} value={watch.id}>{flightWatchTitle(watch)}（{TRIP_TYPE_LABELS[watch.tripType]}）</SelectItem>
        ))}
        <SelectItem value={ALL_FOCUS}>全部區段（混合比較）</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** 圖表 Y 軸類別標籤的估計寬度（px）：CJK 字較寬 */
function estimateLabelWidth(label: string): number {
  let width = 8;
  for (const char of label) width += /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(char) ? 11 : 6.5;
  return Math.ceil(width);
}

/** 超過 Y 軸可用寬度時才截斷並補「…」，完整名稱仍在 tooltip */
function clampLabel(label: string, maxWidth: number): string {
  if (estimateLabelWidth(label) <= maxWidth) return label;
  let out = '';
  for (const char of label) {
    if (estimateLabelWidth(`${out}${char}…`) > maxWidth) break;
    out += char;
  }
  return `${out}…`;
}
