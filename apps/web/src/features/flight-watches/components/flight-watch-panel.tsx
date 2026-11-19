import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { useAuth } from '@/hooks/use-auth';
import { useActiveHousehold } from '@/features/household';
import {
  BellRing,
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  CopyPlus,
  ExternalLink,
  History,
  Pencil,
  PlaneTakeoff,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useConfirm } from '@/components/ui/confirm';
import {
  addTWCalendarMonths,
  dateInputToTWDate,
  daysBetweenTWDates,
  formatTW,
  formatTWDateInput,
  parseDateInput,
} from '@/lib/tz';
import { cn, formatCurrency } from '@/lib/utils';
import { FlightWatchSchema, type FlightWatchFormValues } from '../schema';
import {
  useCreateFlightWatch,
  useDeleteFlightWatch,
  useFlightPriceSnapshots,
  useRefreshFlightWatch,
  useUpdateFlightWatch,
} from '../hooks';
import {
  AIRLINE_OPTIONS,
  AIRPORT_OPTIONS,
  CABIN_LABELS,
  FLIGHT_PROVIDER_LABELS,
  airlineLabel,
  airportLabel,
  flightRouteKey,
  flightWatchTitle,
  DEFAULT_CLAUDE_GROUP_LABEL,
  TICKET_SEARCH_OPTIONS,
  TRIP_TYPE_LABELS,
  claudeGroupLabel,
} from '../options';
import { cheapestWindow, compareTicketing, formatFlightDate, formatFlightDuration } from '../dashboard';
import { FlightTicket } from './flight-ticket';
import { defaultTicketSearch, flightTicketSearch, type FlightCabin, type FlightPriceAdvice, type FlightWatch } from '../types';

const CABINS = Object.keys(CABIN_LABELS) as FlightCabin[];
const WEEKDAY_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function defaultValues(): FlightWatchFormValues {
  return {
    segmentLabel: '',
    tripType: 'roundtrip',
    claudeGroup: '',
    origin: 'TPE',
    destination: '',
    returnOrigin: '',
    returnDestination: '',
    ticketSearch: 'single',
    departureStart: formatTWDateInput(addTWCalendarMonths(new Date(), 1)),
    departureEnd: formatTWDateInput(addTWCalendarMonths(new Date(), 4)),
    minNights: 4,
    maxNights: 8,
    adults: 1,
    selectedCabins: ['economy', 'business'],
    nonstopOnly: false,
    excludeLowCostCarriers: false,
    airlineFilter: 'all',
    airlineCodes: [],
    // 預設用 Claude 排程推送（不另付 API 費用）；Claude API 搜尋每次掃描會扣 Claude API 額度
    scanProvider: 'claude',
    scanFrequency: 'daily',
    weeklyDay: 0,
    notifyOnDeal: true,
    notifyOnEveryScan: false,
    priceDropPercent: 5,
    maxPriceTWD: '',
    enabled: true,
  };
}

function valuesFromWatch(watch: FlightWatch): FlightWatchFormValues {
  return {
    segmentLabel: watch.segmentLabel,
    tripType: watch.tripType,
    claudeGroup: watch.claudeGroup,
    origin: watch.origin,
    destination: watch.destination,
    returnOrigin: watch.returnOrigin,
    returnDestination: watch.returnDestination,
    ticketSearch: flightTicketSearch(watch),
    departureStart: formatTWDateInput(watch.departureStart),
    departureEnd: formatTWDateInput(watch.departureEnd),
    minNights: watch.minNights,
    maxNights: watch.maxNights,
    adults: watch.adults,
    selectedCabins: watch.selectedCabins.length > 0 ? watch.selectedCabins : [watch.cabin],
    nonstopOnly: watch.nonstopOnly,
    excludeLowCostCarriers: watch.excludeLowCostCarriers,
    airlineFilter: watch.airlineFilter,
    airlineCodes: watch.airlineCodes,
    scanProvider: watch.scanProvider,
    scanFrequency: watch.scanFrequency,
    weeklyDay: watch.weeklyDay,
    notifyOnDeal: watch.notifyOnDeal,
    notifyOnEveryScan: watch.notifyOnEveryScan,
    priceDropPercent: watch.priceDropPercent,
    maxPriceTWD: watch.maxPriceTWD ?? '',
    enabled: watch.enabled,
  };
}

interface FlightWatchPanelProps {
  /** 已套用頁面篩選的區段 */
  watches: FlightWatch[];
  /** 全部區段（表單的 Claude 群組選項要看全部） */
  allWatches: FlightWatch[];
  isLoading: boolean;
  filtered: boolean;
  /** 打開 Claude 排程對話框（由頁面持有，總覽分頁也會用到） */
  onOpenClaude: () => void;
}

export function FlightWatchPanel({ watches, allWatches, isLoading, filtered, onOpenClaude }: FlightWatchPanelProps) {
  const { user } = useAuth();
  const household = useActiveHousehold();
  const myUid = user?.uid ?? '';
  const create = useCreateFlightWatch();
  const update = useUpdateFlightWatch();
  const remove = useDeleteFlightWatch();
  const refresh = useRefreshFlightWatch();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<FlightWatch | null>(null);
  const form = useForm<FlightWatchFormValues>({
    resolver: zodResolver(FlightWatchSchema),
    defaultValues: defaultValues(),
  });
  const airlineFilter = form.watch('airlineFilter');
  const scanProvider = form.watch('scanProvider');
  const scanFrequency = form.watch('scanFrequency');
  const notifyOnDeal = form.watch('notifyOnDeal');
  const tripType = form.watch('tripType');
  const claudeGroupOptions = useMemo(() => {
    const names = [...new Set(allWatches.filter((watch) => watch.userId === myUid).map((watch) => watch.claudeGroup.trim()).filter(Boolean))];
    return [{ value: '', label: DEFAULT_CLAUDE_GROUP_LABEL }, ...names.map((name) => ({ value: name, label: name }))];
  }, [allWatches, myUid]);

  // 同一條航線（出發、抵達相同）的多個日期區段放在同一組；組內依出發日排序，組與組依目前最低價排序
  const routeGroups = useMemo(() => {
    const groups = new Map<string, FlightWatch[]>();
    watches.forEach((watch) => {
      const key = flightRouteKey(watch);
      groups.set(key, [...(groups.get(key) ?? []), watch]);
    });
    const lowest = (items: FlightWatch[]) => Math.min(
      ...items.map((watch) => watch.latestEstimate?.minPriceTWD ?? Number.POSITIVE_INFINITY),
    );
    return [...groups.entries()]
      .map(([key, items]) => ({
        key,
        items: [...items].sort((a, b) => a.departureStart.getTime() - b.departureStart.getTime()),
      }))
      .sort((a, b) => lowest(a.items) - lowest(b.items));
  }, [watches]);

  async function submit(values: FlightWatchFormValues) {
    try {
      const parsed = FlightWatchSchema.parse(values);
      const departureStart = dateInputToTWDate(parsed.departureStart);
      const departureEnd = dateInputToTWDate(parsed.departureEnd);
      const primaryCabin = parsed.selectedCabins[0];
      if (!departureStart || !departureEnd || !primaryCabin) return;
      const input = {
        segmentLabel: parsed.segmentLabel,
        tripType: parsed.tripType,
        claudeGroup: parsed.claudeGroup,
        origin: parsed.origin.trim().toUpperCase(),
        destination: parsed.destination.trim().toUpperCase(),
        // 只有多點進出保存回程機場；切回來回／單程時清空，避免舊值影響 criteriaKey
        returnOrigin: parsed.tripType === 'openjaw' ? parsed.returnOrigin.trim().toUpperCase() : '',
        returnDestination: parsed.tripType === 'openjaw' ? parsed.returnDestination.trim().toUpperCase() : '',
        // 跟行程預設相同就存 null（之後預設改了會跟著走，也不會改到 criteriaKey）；單程不適用
        ticketSearch: parsed.tripType === 'oneway' || parsed.ticketSearch === defaultTicketSearch(parsed.tripType)
          ? null
          : parsed.ticketSearch,
        departureStart,
        departureEnd,
        minNights: parsed.minNights,
        maxNights: parsed.maxNights,
        adults: parsed.adults,
        cabin: primaryCabin,
        selectedCabins: parsed.selectedCabins,
        nonstopOnly: parsed.nonstopOnly,
        excludeLowCostCarriers: parsed.excludeLowCostCarriers,
        airlineFilter: parsed.airlineFilter,
        airlineCodes: parsed.airlineFilter === 'all' ? [] : parsed.airlineCodes,
        scanProvider: parsed.scanProvider,
        scanFrequency: parsed.scanFrequency,
        weeklyDay: parsed.weeklyDay,
        notifyOnDeal: parsed.notifyOnDeal,
        notifyOnEveryScan: parsed.notifyOnEveryScan,
        priceDropPercent: parsed.priceDropPercent,
        maxPriceTWD: parsed.maxPriceTWD === '' ? null : parsed.maxPriceTWD,
        enabled: parsed.enabled,
      };
      let watchId: string;
      if (editing) {
        await update.mutateAsync({ id: editing.id, patch: input });
        watchId = editing.id;
      } else {
        watchId = await create.mutateAsync(input);
      }
      form.reset(defaultValues());
      setEditing(null);
      setOpen(false);
      // Claude 排程來源不在 Apps Script 查價，等排程推送或手動貼上結果
      if (input.scanProvider === 'claude') onOpenClaude();
      else refresh.mutate(watchId);
    } catch (error) {
      console.error('[saveFlightWatch]', error);
    }
  }

  function startCreate() {
    setEditing(null);
    form.reset(defaultValues());
    setOpen(true);
  }

  /** 同一條航線加一個新的日期區段：沿用條件，日期往後接續，名稱留空讓使用者填 */
  function startNewSegment(watch: FlightWatch) {
    setEditing(null);
    const span = Math.max(1, Math.round((watch.departureEnd.getTime() - watch.departureStart.getTime()) / 86_400_000));
    const nextStart = new Date(watch.departureEnd.getTime() + 86_400_000);
    form.reset({
      ...valuesFromWatch(watch),
      // 從別人分享的航線複製：Claude 群組是對方的排程，不沿用
      ...(watch.userId === myUid ? {} : { claudeGroup: '' }),
      segmentLabel: '',
      departureStart: formatTWDateInput(nextStart),
      departureEnd: formatTWDateInput(new Date(nextStart.getTime() + span * 86_400_000)),
    });
    setOpen(true);
  }

  function startEdit(watch: FlightWatch) {
    setEditing(watch);
    form.reset(valuesFromWatch(watch));
    setOpen(true);
  }

  async function handleDelete(watch: FlightWatch) {
    const accepted = await confirm({
      title: '刪除票價訂閱？',
      description: flightWatchTitle(watch),
      confirmText: '刪除',
    });
    if (!accepted) return;
    try {
      await remove.mutateAsync(watch.id);
    } catch (error) {
      console.error('[deleteFlightWatch]', error);
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <BellRing className="size-4" /> 機票價格雷達
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              比較日期、航空公司與艙等，每日更新適合出遊的價格窗口
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={onOpenClaude}>
              <Bot className="size-4" /> Claude 排程
            </Button>
            <Button size="sm" onClick={startCreate}>
              <Plus className="size-4" /> 新增航線
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中…</p>
          ) : routeGroups.length === 0 && filtered ? (
            <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">沒有符合篩選條件的區段，調整上方篩選或清除。</p>
          ) : routeGroups.length === 0 ? (
            <EmptyState
              icon={PlaneTakeoff}
              title="尚無機票價格雷達"
              description="選擇出發與抵達機場，系統會比較經濟艙、商務艙與較便宜的出遊日期"
            />
          ) : (
            <div className="space-y-5">
              {routeGroups.map((group) => {
                const first = group.items[0];
                if (!first) return null;
                return (
                  <section key={group.key} className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">
                        {airportLabel(first.origin)} → {airportLabel(first.destination)}
                        {first.tripType === 'openjaw' ? (
                          <span className="block text-xs font-normal text-muted-foreground sm:ml-2 sm:inline">
                            回程 {airportLabel(first.returnOrigin)} → {airportLabel(first.returnDestination)}
                          </span>
                        ) : null}
                      </h3>
                      <span className="text-xs text-muted-foreground">{group.items.length} 個日期區段</span>
                    </div>
                    <div className="grid gap-3 xl:grid-cols-2">
                      {group.items.map((watch) => (
                        <FlightWatchCard
                          key={watch.id}
                          watch={watch}
                          sharedBy={watch.userId === myUid ? null : household?.members[watch.userId]?.displayName ?? '共同帳本成員'}
                          refreshing={refresh.isPending && refresh.variables === watch.id}
                          onRefresh={() => refresh.mutate(watch.id)}
                          onToggle={(enabled) => update.mutate({ id: watch.id, patch: { enabled } })}
                          onEdit={() => startEdit(watch)}
                          onNewSegment={() => startNewSegment(watch)}
                          onDelete={() => void handleDelete(watch)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            每條航線可獨立選擇 Duffel 即時票價 API、Claude API + Web Search，或由 Claude 排程查價後推送（不另付 API 費用）。Claude API 搜尋每次掃描約 US$0.05–0.30（tokens + web search），會扣本期 Claude API 額度，可在「設定 → AI 額度」啟用硬停止；價格與庫存仍需在購票前重新確認。
          </p>
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setEditing(null);
        }}
        title={editing ? '編輯機票價格雷達' : '新增機票價格雷達'}
        description="日期範圍越有彈性，越容易找出划算的出遊窗口。"
        contentClassName="sm:max-w-2xl"
        footer={
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              type="submit"
              form="flight-watch-form"
              className="flex-1"
              disabled={create.isPending || update.isPending}
            >
              {editing ? '儲存並重新掃描' : '儲存並開始掃描'}
            </Button>
          </div>
        }
      >
        <form id="flight-watch-form" className="space-y-4" onSubmit={form.handleSubmit((values) => void submit(values))}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="區段名稱（選填）" error={form.formState.errors.segmentLabel?.message}>
              <Input placeholder="例：寒假、春節、櫻花季" maxLength={20} {...form.register('segmentLabel')} />
            </Field>
            <Field label="行程" error={form.formState.errors.tripType?.message}>
              <Controller control={form.control} name="tripType" render={({ field }) => (
                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="行程">
                  {(['roundtrip', 'oneway', 'openjaw'] as const).map((value) => (
                    <Button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={field.value === value}
                      variant={field.value === value ? 'default' : 'outline'}
                      className="px-2"
                      onClick={() => {
                        if (field.value !== value) form.setValue('ticketSearch', defaultTicketSearch(value));
                        field.onChange(value);
                        // 第一次切到多點進出：回程預設「從目的地出、回到出發地」，使用者只要改不同的那一端
                        if (value === 'openjaw') {
                          if (!form.getValues('returnOrigin')) form.setValue('returnOrigin', form.getValues('destination'));
                          if (!form.getValues('returnDestination')) form.setValue('returnDestination', form.getValues('origin'));
                        }
                      }}
                    >
                      {TRIP_TYPE_LABELS[value]}
                    </Button>
                  ))}
                </div>
              )} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="出發機場" error={form.formState.errors.origin?.message}>
              <Controller control={form.control} name="origin" render={({ field }) => (
                <Combobox
                  value={field.value}
                  onChange={field.onChange}
                  options={AIRPORT_OPTIONS}
                  placeholder="選擇出發機場"
                  searchPlaceholder="搜尋城市、機場或 IATA…"
                  allowCustom
                />
              )} />
            </Field>
            <Field label={tripType === 'openjaw' ? '去程抵達（A 進）' : '抵達機場'} error={form.formState.errors.destination?.message}>
              <Controller control={form.control} name="destination" render={({ field }) => (
                <Combobox
                  value={field.value}
                  onChange={field.onChange}
                  options={AIRPORT_OPTIONS}
                  placeholder="選擇抵達機場"
                  searchPlaceholder="搜尋城市、機場或 IATA…"
                  allowCustom
                />
              )} />
            </Field>
          </div>
          {tripType === 'openjaw' ? (
            <div className="space-y-2 rounded-lg border border-dashed p-3">
              <p className="text-xs text-muted-foreground">
                多點進出（open-jaw）：去程飛到 A、回程從 B 飛回，例如「TPE → NRT 進、KIX → TPE 出」。價格以同一張多城市機票合計，晚數 = 去程出發到回程出發之間。
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="回程出發（B 出）" error={form.formState.errors.returnOrigin?.message}>
                  <Controller control={form.control} name="returnOrigin" render={({ field }) => (
                    <Combobox
                      value={field.value}
                      onChange={field.onChange}
                      options={AIRPORT_OPTIONS}
                      placeholder="選擇回程出發機場"
                      searchPlaceholder="搜尋城市、機場或 IATA…"
                      allowCustom
                    />
                  )} />
                </Field>
                <Field label="回程抵達" error={form.formState.errors.returnDestination?.message}>
                  <Controller control={form.control} name="returnDestination" render={({ field }) => (
                    <Combobox
                      value={field.value}
                      onChange={field.onChange}
                      options={AIRPORT_OPTIONS}
                      placeholder="選擇回程抵達機場"
                      searchPlaceholder="搜尋城市、機場或 IATA…"
                      allowCustom
                    />
                  )} />
                </Field>
              </div>
            </div>
          ) : null}
          {tripType !== 'oneway' ? (
            <Field label="購票方式" error={form.formState.errors.ticketSearch?.message}>
              <Controller control={form.control} name="ticketSearch" render={({ field }) => (
                <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="購票方式">
                  {TICKET_SEARCH_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={field.value === option.value}
                      onClick={() => field.onChange(option.value)}
                      className={cn(
                        'flex flex-col items-start rounded-lg border p-2 text-left transition-colors',
                        field.value === option.value ? 'border-primary bg-primary/10' : 'hover:bg-muted',
                      )}
                    >
                      <span className={cn('text-sm font-medium', field.value === option.value && 'text-primary')}>
                        {option.label}{option.value === defaultTicketSearch(tripType) ? '（預設）' : ''}
                      </span>
                      <span className="text-[11px] leading-snug text-muted-foreground">{option.hint}</span>
                    </button>
                  ))}
                </div>
              )} />
              <p className="mt-1 text-[11px] text-muted-foreground">
                拼單程 = 去程、回程各買一張單程（可不同航空公司，常常更便宜或才查得到）；兩張票互不保障，行李要各自買。Duffel 掃描時「兩種都比」每個艙等會多用 2 次查詢額度。
              </p>
            </Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="最早出發" error={form.formState.errors.departureStart?.message}>
              <Controller control={form.control} name="departureStart" render={({ field }) => (
                <DatePicker value={parseDateInput(field.value)} onChange={(date) => field.onChange(date ? formatTWDateInput(date) : '')} clearable={false} />
              )} />
            </Field>
            <Field label="最晚出發" error={form.formState.errors.departureEnd?.message}>
              <Controller control={form.control} name="departureEnd" render={({ field }) => (
                <DatePicker value={parseDateInput(field.value)} onChange={(date) => field.onChange(date ? formatTWDateInput(date) : '')} clearable={false} />
              )} />
            </Field>
          </div>
          <div className={cn('grid gap-3', tripType === 'oneway' ? 'sm:grid-cols-1' : 'sm:grid-cols-3')}>
            {/* 單程不需要晚數；欄位隱藏但保留值，切回來回時不會遺失 */}
            <div className={cn(tripType === 'oneway' && 'hidden')}>
              <Field label="最少晚數" error={form.formState.errors.minNights?.message}>
                <Input type="number" inputMode="numeric" {...form.register('minNights')} />
              </Field>
            </div>
            <div className={cn(tripType === 'oneway' && 'hidden')}>
              <Field label="最多晚數" error={form.formState.errors.maxNights?.message}>
                <Input type="number" inputMode="numeric" {...form.register('maxNights')} />
              </Field>
            </div>
            <Field label="成人數" error={form.formState.errors.adults?.message}>
              <Input type="number" inputMode="numeric" {...form.register('adults')} />
            </Field>
          </div>

          <Field label="要比較的艙等" error={form.formState.errors.selectedCabins?.message}>
            <Controller control={form.control} name="selectedCabins" render={({ field }) => (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {CABINS.map((cabin) => {
                  const selected = field.value.includes(cabin);
                  return (
                    <Button
                      key={cabin}
                      type="button"
                      variant={selected ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => field.onChange(selected ? field.value.filter((item) => item !== cabin) : [...field.value, cabin])}
                    >
                      {CABIN_LABELS[cabin]}
                    </Button>
                  );
                })}
              </div>
            )} />
          </Field>

          <div className="rounded-xl border p-3">
            <div className="flex items-center gap-2 text-sm font-medium"><RefreshCw className="size-4" /> 票價資料來源</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="掃描方式" error={form.formState.errors.scanProvider?.message}>
                <Controller control={form.control} name="scanProvider" render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="claude">{FLIGHT_PROVIDER_LABELS.claude}</SelectItem>
                      <SelectItem value="claude_api">{FLIGHT_PROVIDER_LABELS.claude_api}</SelectItem>
                      <SelectItem value="duffel">{FLIGHT_PROVIDER_LABELS.duffel}</SelectItem>
                    </SelectContent>
                  </Select>
                )} />
              </Field>
              {scanProvider === 'claude' ? (
                <Field label="Claude 排程群組" error={form.formState.errors.claudeGroup?.message}>
                  <Controller control={form.control} name="claudeGroup" render={({ field }) => (
                    <Combobox
                      value={field.value}
                      onChange={field.onChange}
                      options={claudeGroupOptions}
                      placeholder={DEFAULT_CLAUDE_GROUP_LABEL}
                      searchPlaceholder="選擇或輸入新群組…"
                      allowCustom
                    />
                  )} />
                </Field>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {scanProvider === 'claude_api'
                ? '由 Apps Script 呼叫 Claude API 上網搜尋公開票價（模型同「設定 → AI 額度」的一般模型）。依掃描頻率自動執行，每次約 US$0.05–0.30，會扣 Claude API 額度；只有附上可驗證來源的結果才會保存。'
                : scanProvider === 'claude'
                  ? '由你的 Claude 排程上網查價後推送結果；系統不會呼叫任何付費 API。一個群組對應一個 Claude 排程任務，儲存後到「Claude 排程」複製該群組的提示詞。'
                  : '直接取得可售 offer，不使用 AI；正式票價需要 Duffel live access token。'}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="航空公司篩選" error={form.formState.errors.airlineFilter?.message}>
              <Controller control={form.control} name="airlineFilter" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">不限航空公司</SelectItem>
                    <SelectItem value="include">只看指定航空公司</SelectItem>
                    <SelectItem value="exclude">排除指定航空公司</SelectItem>
                  </SelectContent>
                </Select>
              )} />
            </Field>
            <Field label="理想價格上限（TWD）" error={form.formState.errors.maxPriceTWD?.message}>
              <Input type="number" inputMode="numeric" placeholder="例：30000" {...form.register('maxPriceTWD')} />
            </Field>
          </div>

          {airlineFilter !== 'all' ? (
            <Field
              label={airlineFilter === 'include' ? '指定航空公司' : '要排除的航空公司'}
              error={form.formState.errors.airlineCodes?.message}
            >
              <Controller control={form.control} name="airlineCodes" render={({ field }) => (
                <AirlineMultiSelect value={field.value} onChange={field.onChange} />
              )} />
            </Field>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-3">
            <ToggleField label="排除廉價航空" control={
              <Controller control={form.control} name="excludeLowCostCarriers" render={({ field }) => (
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              )} />
            } />
            <ToggleField label="只看直飛" control={
              <Controller control={form.control} name="nonstopOnly" render={({ field }) => (
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              )} />
            } />
            <ToggleField label={scanProvider === 'claude' ? '接受排程推送' : '每日自動搜尋'} control={
              <Controller control={form.control} name="enabled" render={({ field }) => (
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              )} />
            } />
          </div>

          <div className="rounded-xl border p-3">
            <div className="flex items-center gap-2 text-sm font-medium"><History className="size-4" /> 掃描排程與 Telegram</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {scanProvider === 'claude'
                ? '掃描時間由 Claude 排程決定；每次推送都會依下列設定判斷是否發 Telegram。'
                : '排程於台北時間 09:00 執行；Telegram 全域開關仍可在設定頁控制。'}
            </p>
            <div className={cn('mt-3 grid gap-3 sm:grid-cols-2', scanProvider === 'claude' && 'hidden')}>
              <Field label="掃描頻率" error={form.formState.errors.scanFrequency?.message}>
                <Controller control={form.control} name="scanFrequency" render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">每天 09:00</SelectItem>
                      <SelectItem value="weekdays">週一至週五 09:00</SelectItem>
                      <SelectItem value="weekly">每週指定一天 09:00</SelectItem>
                    </SelectContent>
                  </Select>
                )} />
              </Field>
              {scanFrequency === 'weekly' ? (
                <Field label="每週掃描日" error={form.formState.errors.weeklyDay?.message}>
                  <Controller control={form.control} name="weeklyDay" render={({ field }) => (
                    <Select value={String(field.value)} onValueChange={(value) => field.onChange(Number(value))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{WEEKDAY_LABELS.map((label, day) => <SelectItem key={label} value={String(day)}>{label}</SelectItem>)}</SelectContent>
                    </Select>
                  )} />
                </Field>
              ) : null}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <ToggleField label="低價或達理想價時通知" control={
                <Controller control={form.control} name="notifyOnDeal" render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )} />
              } />
              <ToggleField label="每次掃描都回報目前票價" control={
                <Controller control={form.control} name="notifyOnEveryScan" render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )} />
              } />
            </div>
            {notifyOnDeal ? (
              <div className="mt-3 max-w-xs">
                <Field label="比前次下降多少就通知（%）" error={form.formState.errors.priceDropPercent?.message}>
                  <Input type="number" min={1} max={50} inputMode="numeric" {...form.register('priceDropPercent')} />
                </Field>
              </div>
            ) : null}
          </div>
        </form>
      </ResponsiveDialog>
    </>
  );
}

function AirlineMultiSelect({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const available = AIRLINE_OPTIONS.filter((option) => !value.includes(option.value));
  return (
    <div className="space-y-2">
      <Combobox
        value=""
        onChange={(next) => {
          const normalized = next.trim();
          if (normalized && !value.includes(normalized)) onChange([...value, normalized]);
        }}
        options={available}
        placeholder="加入航空公司"
        searchPlaceholder="搜尋代碼或航空公司…"
        allowCustom
      />
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {value.map((code) => (
            <Badge key={code} variant="secondary" className="gap-1 pr-1">
              {airlineLabel(code)}
              <button type="button" aria-label={`移除 ${airlineLabel(code)}`} onClick={() => onChange(value.filter((item) => item !== code))}>
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FlightWatchCard({
  watch,
  sharedBy,
  refreshing,
  onRefresh,
  onToggle,
  onEdit,
  onNewSegment,
  onDelete,
}: {
  watch: FlightWatch;
  /** 別人建立、分享給我的（只能看；「同航線新增日期區段」會在我名下另建一筆）；null = 我建立的 */
  sharedBy: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onNewSegment: () => void;
  onDelete: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { data: snapshots = [], isLoading: historyLoading } = useFlightPriceSnapshots(watch.id, historyOpen);
  const estimate = watch.latestEstimate;
  const isDeal = Boolean(estimate && watch.maxPriceTWD && estimate.minPriceTWD <= watch.maxPriceTWD);
  const restrictions = [
    watch.nonstopOnly ? '只看直飛' : null,
    watch.excludeLowCostCarriers ? '排除廉航' : null,
    watch.airlineFilter === 'include' ? `只看 ${watch.airlineCodes.map(airlineLabel).join('、')}` : null,
    watch.airlineFilter === 'exclude' ? `排除 ${watch.airlineCodes.map(airlineLabel).join('、')}` : null,
  ].filter((item): item is string => item !== null);
  const isClaude = watch.scanProvider === 'claude';
  const daysSinceCheck = watch.lastCheckedAt ? daysBetweenTWDates(watch.lastCheckedAt, new Date()) : null;
  const claudeStale = isClaude && watch.enabled && daysSinceCheck !== null && daysSinceCheck >= 3;
  const ticketWindow = cheapestWindow(watch);
  const ticketing = compareTicketing(watch);
  const [allWindows, setAllWindows] = useState(false);
  const scheduleLabel = isClaude
    ? `Claude 排程 · ${claudeGroupLabel(watch.claudeGroup)}`
    : watch.scanFrequency === 'weekdays'
    ? '平日 09:00'
    : watch.scanFrequency === 'weekly'
      ? `每${WEEKDAY_LABELS[watch.weeklyDay] ?? '週日'} 09:00`
      : '每日 09:00';

  return (
    <div className="rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <PlaneTakeoff className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">
              {watch.segmentLabel || `${formatTW(watch.departureStart, 'M/d')} 出發區段`}
            </span>
            <Badge variant="outline">
              {watch.scanProvider === 'claude_api' ? 'Claude API 搜尋' : isClaude ? 'Claude 排程' : 'Duffel'}
            </Badge>
            <Badge variant="secondary">{TRIP_TYPE_LABELS[watch.tripType]}</Badge>
            {sharedBy ? <Badge variant="outline">{sharedBy} 建立 · 唯讀</Badge> : null}
            {!watch.enabled ? <Badge variant="secondary">已暫停</Badge> : null}
            {isDeal ? <Badge variant="success">低於理想價</Badge> : null}
            {claudeStale ? <Badge variant="secondary">{daysSinceCheck} 天未收到排程</Badge> : null}
            {estimate ? <AdviceBadge advice={estimate.advice} /> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatTW(watch.departureStart, 'yyyy/MM/dd')}–{formatTW(watch.departureEnd, 'yyyy/MM/dd')}
            {watch.tripType === 'oneway' ? ' · 單程' : ` · ${watch.minNights}–${watch.maxNights} 晚`} · {watch.adults} 人
          </p>
          {watch.tripType === 'openjaw' ? (
            <p className="mt-1 text-xs text-muted-foreground">
              去程 {watch.origin} → {watch.destination} · 回程 {watch.returnOrigin} → {watch.returnDestination}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {watch.selectedCabins.map((cabin) => CABIN_LABELS[cabin]).join('、')}
            {restrictions.length > 0 ? ` · ${restrictions.join(' · ')}` : ''}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {scheduleLabel}
            {watch.notifyOnEveryScan ? ' · 每次 Telegram 回報' : watch.notifyOnDeal ? ` · 降 ${watch.priceDropPercent}% 或達理想價提醒` : ' · 不發 Telegram'}
          </p>
        </div>
        {sharedBy ? null : <Switch checked={watch.enabled} onCheckedChange={onToggle} aria-label="自動搜尋" />}
      </div>

      {estimate ? (
        <div className="mt-4 space-y-3">
          {ticketWindow ? <FlightTicket watch={watch} window={ticketWindow} /> : null}
          {ticketing.single && ticketing.separate ? (
            <div className="grid grid-cols-2 gap-2 rounded-lg border p-2 text-xs">
              <div className="min-w-0">
                <div className="text-[11px] text-muted-foreground">一張票最低</div>
                <div className={cn('font-semibold tabular-nums', (ticketing.savingTWD ?? 0) < 0 && 'text-success')}>{formatCurrency(ticketing.single.priceTWD)}</div>
                <div className="truncate text-[11px] text-muted-foreground">{ticketing.single.airline || '航空公司待確認'}</div>
              </div>
              <div className="min-w-0">
                <div className="text-[11px] text-muted-foreground">拼單程最低</div>
                <div className={cn('font-semibold tabular-nums', (ticketing.savingTWD ?? 0) > 0 && 'text-success')}>{formatCurrency(ticketing.separate.priceTWD)}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {[ticketing.separate.airline, ticketing.separate.returnAirline].filter(Boolean).join(' ＋ ') || '兩張單程'}
                </div>
              </div>
              <p className="col-span-2 text-[11px] text-muted-foreground">
                {(ticketing.savingTWD ?? 0) > 0
                  ? `拼單程便宜 ${formatCurrency(ticketing.savingTWD ?? 0)}；兩張票互不保障，行李要各自買。`
                  : (ticketing.savingTWD ?? 0) < 0
                    ? `一張票反而便宜 ${formatCurrency(-(ticketing.savingTWD ?? 0))}，而且轉機延誤有保障。`
                    : '兩種價格相同，建議選一張票（有保障）。'}
              </p>
            </div>
          ) : null}
          {estimate.cabinEstimates.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {estimate.cabinEstimates.map((item) => (
                <div key={item.cabin} className="rounded-lg bg-muted/50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{CABIN_LABELS[item.cabin]}</span>
                    {item.bestAirline ? <span className="truncate text-[11px] text-muted-foreground">{item.bestAirline}</span> : null}
                  </div>
                  <div className="mt-1 text-lg font-semibold text-primary">{formatCurrency(item.minPriceTWD)}</div>
                  <div className="text-[11px] text-muted-foreground">常見 {formatCurrency(item.typicalPriceTWD)} 起</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 text-center">
              <PriceStat label="較低" value={estimate.minPriceTWD} emphasized />
              <PriceStat label="常見" value={estimate.typicalPriceTWD} />
              <PriceStat label="較高" value={estimate.maxPriceTWD} />
            </div>
          )}

          {estimate.travelWindows.length > 0 ? (
            <div className="rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium"><CalendarDays className="size-3.5" /> 候選日期（{estimate.travelWindows.length} 組）</span>
                {estimate.travelWindows.length > 4 ? (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setAllWindows((value) => !value)}>
                    {allWindows ? '收合' : '顯示全部'}
                  </Button>
                ) : null}
              </div>
              <div className="mt-2 space-y-2">
                {(allWindows ? estimate.travelWindows : estimate.travelWindows.slice(0, 4)).map((window, index) => (
                  <div key={`${window.departureDate}-${window.cabin}-${index}`} className="flex items-start justify-between gap-3 text-xs">
                    <div>
                      <div className="font-medium">
                        {formatFlightDate(window.departureDate)}
                        {window.departureTime ? ` ${window.departureTime}` : ''}
                        {window.returnDate ? ` → ${formatFlightDate(window.returnDate)}` : '（單程）'}
                      </div>
                      <div className="text-muted-foreground">
                        {window.ticketing === 'separate' ? <Badge variant="warning" className="mr-1 h-4 px-1 text-[10px]">拼單程</Badge> : null}
                        {CABIN_LABELS[window.cabin]} · {window.airline || '航空公司待確認'}
                        {window.ticketing === 'separate' && window.returnAirline ? ` ＋ ${window.returnAirline}` : ''}
                        {window.flightNumber ? ` ${window.flightNumber}` : ''} · {window.stops === 0 ? '直飛' : `${window.stops} 次轉機`}
                        {window.ticketing === 'separate' && window.outboundPriceTWD && window.returnPriceTWD
                          ? ` · 去 ${formatCurrency(window.outboundPriceTWD)} ＋ 回 ${formatCurrency(window.returnPriceTWD)}`
                          : ''}
                        {window.durationMinutes ? ` · ${formatFlightDuration(window.durationMinutes)}` : ''}
                      </div>
                      {window.reason ? <div className="mt-0.5 text-[11px] text-muted-foreground">{window.reason}</div> : null}
                    </div>
                    <span className="shrink-0 font-semibold text-primary">{formatCurrency(window.priceTWD)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="rounded-lg bg-primary/5 p-3 text-xs">
            <div className="font-medium">{adviceTitle(estimate.advice)}</div>
            <p className="mt-1 leading-relaxed text-muted-foreground">{estimate.adviceReason || estimate.summary}</p>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{estimate.summary}</p>
          {watch.lastError ? (
            <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">最近一次更新失敗：{watch.lastError}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>可信度：{estimate.confidence === 'high' ? '高' : estimate.confidence === 'medium' ? '中' : '低'}</span>
            <span>更新：{formatTW(estimate.checkedAt, 'MM/dd HH:mm')}</span>
            <span>歷史最低：{formatCurrency(watch.bestPriceTWD ?? estimate.minPriceTWD)}</span>
            {watch.maxPriceTWD ? <span>理想價：{formatCurrency(watch.maxPriceTWD)}</span> : null}
          </div>
          {estimate.sources.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {estimate.sources.slice(0, 3).map((source) => (
                <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-xs text-primary hover:underline">
                  <span className="truncate">{source.title}</span><ExternalLink className="size-3 shrink-0" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          {watch.lastError
            ? `最近搜尋失敗：${watch.lastError}`
            : isClaude
              ? '尚未收到結果。到「Claude 排程」複製提示詞建立排程，或貼上 Claude 輸出的 JSON。'
              : '尚未搜尋。可立即更新，之後系統也會每日自動掃描。'}
        </p>
      )}

      {historyOpen ? (
        <div className="mt-3 rounded-lg border p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium"><History className="size-3.5" /> 歷史較低價趨勢</div>
          {historyLoading ? <p className="text-xs text-muted-foreground">載入中…</p> : snapshots.length < 2 ? (
            <p className="text-xs text-muted-foreground">累積至少兩次掃描後會顯示趨勢。</p>
          ) : (
            <div className="h-40 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={snapshots.map((item) => ({ date: formatTW(item.checkedAt, 'MM/dd'), price: item.minPriceTWD }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={16} />
                  <YAxis width={52} tick={{ fontSize: 10 }} tickFormatter={(value: number) => `${Math.round(value / 1000)}k`} domain={['dataMin', 'dataMax']} />
                  <Tooltip formatter={(value: number) => [formatCurrency(value), '較低價']} />
                  <Line type="monotone" dataKey="price" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={() => setHistoryOpen((value) => !value)}>
          <History className="size-4" /> 價格趨勢 {historyOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </Button>
        {isClaude || sharedBy ? null : (
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'size-4 animate-spin' : 'size-4'} /> 立即更新
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onNewSegment}
          aria-label={sharedBy ? '用這條航線新增我自己的日期區段' : '同航線新增日期區段'}
          title={sharedBy ? '用這條航線新增我自己的日期區段' : '同航線新增日期區段'}
        ><CopyPlus className="size-4" /></Button>
        {sharedBy ? null : (
          <>
            <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label="編輯訂閱"><Pencil className="size-4" /></Button>
            <Button size="icon-sm" variant="ghost" onClick={onDelete} aria-label="刪除訂閱"><Trash2 className="size-4" /></Button>
          </>
        )}
      </div>
    </div>
  );
}

function AdviceBadge({ advice }: { advice: FlightPriceAdvice }) {
  return <Badge variant={advice === 'buy_now' ? 'success' : 'secondary'}>{adviceTitle(advice)}</Badge>;
}

function adviceTitle(advice: FlightPriceAdvice): string {
  if (advice === 'buy_now') return '目前值得買';
  if (advice === 'wait') return '價格偏高，可再等等';
  return '持續觀察';
}

function PriceStat({ label, value, emphasized = false }: { label: string; value: number; emphasized?: boolean }) {
  return (
    <div className={cn('rounded-lg p-2', emphasized ? 'bg-primary/10 text-primary' : 'bg-muted/50')}>
      <div className="text-[11px] opacity-70">{label}</div>
      <div className="mt-0.5 text-sm font-semibold">{formatCurrency(value)}</div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1">{children}</div>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function ToggleField({ label, control }: { label: string; control: React.ReactNode }) {
  return <div className="flex items-center justify-between rounded-lg border p-3"><Label>{label}</Label>{control}</div>;
}
