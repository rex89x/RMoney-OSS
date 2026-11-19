import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ChevronLeft, List, Map as MapIcon, Clock, Sparkles, Plus, Trash2, GripVertical, AlertTriangle,
  Edit3, Eye, Car, Utensils, Ticket, Hotel, ShoppingBag, Circle, DollarSign, Wand2,
} from 'lucide-react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { useTrip } from '@/features/trips/hooks';
import {
  useDeleteDay,
  useDeleteItineraryItem,
  useGenerateItinerary,
  useItinerary,
  useItineraryDays,
  useItineraryItems,
  useMoveDay,
  useReorderItineraryItems,
  useSuggestDayItems,
  useUpsertItineraryItem,
  useUpsertDay,
  useUpsertItinerary,
  type SuggestedItem,
} from '../hooks';
import { cn, uid } from '@/lib/utils';
import { useConfirm } from '@/components/ui/confirm';
import { MapView } from './map-view';
import { PlaceSearch } from './place-search';
import { ItineraryItemDialog } from './item-dialog';
import { AiItineraryImportDialog } from './ai-itinerary-import-dialog';
import { ItemHours } from './item-hours';
import { DayRouteButton } from './day-route-button';
import { useAuth } from '@/hooks/use-auth';
import { formatDateInput, formatTWDateInput, parseDateInput } from '@/lib/tz';
import type { ItineraryItem, ItineraryItemType } from '../types';

export function ItineraryEditor() {
  const { id = '' } = useParams();
  const { data: trip } = useTrip(id);
  const { data: itinerary } = useItinerary(id);
  const { data: days = [] } = useItineraryDays(id);
  const [activeDayId, setActiveDayId] = useState<string | null>(null);
  const { user, isOwner: isOwnerRole, isAdmin } = useAuth();
  // 營業時間：Apps Script placeDetails 只放行 owner / admin 角色；存回 item 要是 trip writer
  const canSaveHours = Boolean(user && trip && (trip.userId === user.uid || trip.ownerId === user.uid || isAdmin));

  const generate = useGenerateItinerary();
  const upsertItin = useUpsertItinerary();
  const upsertDay = useUpsertDay(id);

  const dayId = activeDayId ?? days[0]?.id ?? null;
  const { data: items = [] } = useItineraryItems(id, dayId ?? undefined);

  const [interests, setInterests] = useState('');
  const [musts, setMusts] = useState('');
  const [avoid, setAvoid] = useState('');
  const [pace, setPace] = useState<'relaxed' | 'balanced' | 'packed'>('balanced');
  const [aiImportOpen, setAiImportOpen] = useState(false);

  async function handleGenerate() {
    if (!trip) return;
    await generate.mutateAsync({
      tripId: id,
      destination: trip.destination.join(', '),
      startDate: formatTWDateInput(trip.startDate),
      endDate: formatTWDateInput(trip.endDate),
      budget: trip.budget,
      interests: interests.split(',').map((x) => x.trim()).filter(Boolean),
      musts: musts.split(',').map((x) => x.trim()).filter(Boolean),
      avoid: avoid.split(',').map((x) => x.trim()).filter(Boolean),
      pace,
    });
  }

  async function ensureItinerary() {
    if (itinerary) return;
    await upsertItin.mutateAsync({
      id,
      tripId: id,
      title: trip?.name ?? 'Itinerary',
    });
  }

  async function addManualDay() {
    await ensureItinerary();
    const n = days.length + 1;
    // 計算該日實際日期 = trip.startDate + (n-1)；若 trip 或 startDate 不存在則用今天 + n
    let date: Date;
    if (trip?.startDate) {
      date = parseDateInput(formatTWDateInput(trip.startDate)) ?? new Date();
      date.setDate(date.getDate() + n - 1);
    } else {
      date = new Date();
      date.setDate(date.getDate() + n - 1);
    }
    const iso = formatYMD(date);
    await upsertDay.mutateAsync({
      id: iso,
      date: iso,
      theme: `Day ${n}`,
    });
  }

  const currentDay = useMemo(() => days.find((d) => d.id === dayId), [days, dayId]);

  return (
    <div className="space-y-4">
      {trip ? <AiItineraryImportDialog open={aiImportOpen} onOpenChange={setAiImportOpen} trip={trip} /> : null}
      <Link to={`/trips/${id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ChevronLeft className="size-4" /> 回到出遊
      </Link>

      <Card>
        <CardContent className="grid gap-3 p-4 md:grid-cols-4">
          <div>
            <Label>興趣 (逗號)</Label>
            <Input value={interests} onChange={(e) => setInterests(e.target.value)} placeholder="海灘, 美食" />
          </div>
          <div>
            <Label>必去</Label>
            <Input value={musts} onChange={(e) => setMusts(e.target.value)} />
          </div>
          <div>
            <Label>忌口/不想去</Label>
            <Input value={avoid} onChange={(e) => setAvoid(e.target.value)} />
          </div>
          <div>
            <Label>步調</Label>
            <select
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={pace}
              onChange={(e) => setPace(e.target.value as 'relaxed' | 'balanced' | 'packed')}
            >
              <option value="relaxed">relaxed</option>
              <option value="balanced">balanced</option>
              <option value="packed">packed</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-2 md:col-span-4">
            <Button onClick={handleGenerate} disabled={generate.isPending}>
              <Sparkles className="size-4" /> {generate.isPending ? '生成中…' : 'LLM 生成 draft'}
            </Button>
            <Button variant="outline" onClick={() => setAiImportOpen(true)} disabled={!trip}>
              <Wand2 className="size-4" /> 貼文字 AI 匯入
            </Button>
            <Button variant="outline" onClick={addManualDay}>
              <Plus className="size-4" /> 手動新增一天
            </Button>
          </div>
        </CardContent>
      </Card>

      {days.length === 0 ? (
        <EmptyState icon={List} title="尚無行程" description="點上方 LLM 生成或手動新增" />
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
            {days.map((d, idx) => (
              <Button
                key={d.id}
                variant={dayId === d.id ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveDayId(d.id)}
                className="shrink-0 snap-start"
              >
                <span className="font-semibold">Day {idx + 1}</span>
                {d.date ? (
                  <span className={dayId === d.id ? 'ml-1 opacity-90' : 'ml-1 text-muted-foreground'}>
                    · {shortDayLabel(d.date)}
                  </span>
                ) : null}
              </Button>
            ))}
            <div className="shrink-0">
              <DeleteDayButton itineraryId={id} dayId={dayId} daysCount={days.length} />
            </div>
          </div>
          {currentDay ? (
            <DayMetaEditor
              itineraryId={id}
              day={currentDay}
              onRenamed={(newDate) => setActiveDayId(newDate)}
            />
          ) : null}
        </div>
      )}

      {currentDay ? (
        <Tabs defaultValue="timeline">
          <TabsList>
            <TabsTrigger value="timeline"><Clock className="size-4" /> Timeline</TabsTrigger>
            <TabsTrigger value="map"><MapIcon className="size-4" /> Map</TabsTrigger>
            <TabsTrigger value="list"><List className="size-4" /> List</TabsTrigger>
          </TabsList>
          <TabsContent value="timeline">
            <TimelineView
              itineraryId={id}
              dayId={currentDay.id}
              items={items}
              destination={trip?.destination.join(', ') ?? ''}
              dayTheme={currentDay.theme}
              dayDate={currentDay.date || currentDay.id}
              canFetchHours={isOwnerRole}
              canSaveHours={canSaveHours}
            />
          </TabsContent>
          <TabsContent value="map">
            <MapView items={items} />
          </TabsContent>
          <TabsContent value="list">
            <ListView itineraryId={id} dayId={currentDay.id} items={items} />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}

function TimelineView({
  itineraryId, dayId, items, destination, dayTheme, dayDate, canFetchHours, canSaveHours,
}: {
  itineraryId: string;
  dayId: string;
  items: ItineraryItem[];
  destination: string;
  dayTheme?: string;
  dayDate: string;
  canFetchHours: boolean;
  canSaveHours: boolean;
}) {
  const upsert = useUpsertItineraryItem(itineraryId, dayId);
  const del = useDeleteItineraryItem(itineraryId, dayId);
  const reorder = useReorderItineraryItems(itineraryId, dayId);
  const suggest = useSuggestDayItems();
  const confirm = useConfirm();
  const [suggestions, setSuggestions] = useState<SuggestedItem[]>([]);

  async function handleDeleteItem(it: ItineraryItem) {
    const ok = await confirm({
      title: '刪除項目',
      description: it.title || '(未命名)',
      confirmText: '刪除',
    });
    if (ok) await del.mutateAsync(it.id);
  }
  const [editMode, setEditMode] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ItineraryItem | null>(null);
  const [insertAfterTime, setInsertAfterTime] = useState<string | undefined>(undefined);

  async function requestSuggestions() {
    const list = (await suggest.mutateAsync({
      destination,
      dayTheme,
      existingItems: items.map((i) => ({ startTime: i.startTime, title: i.title, type: i.type })),
      count: 4,
    })) as SuggestedItem[];
    setSuggestions(list);
  }

  async function acceptSuggestion(s: SuggestedItem) {
    await upsert.mutateAsync({
      id: uid('item'),
      order: items.length + 1,
      title: s.title,
      startTime: s.startTime,
      endTime: s.endTime,
      type: s.type,
      placeName: s.placeName,
      estimatedCost: s.estimatedCost,
      currency: s.currency ?? 'TWD',
      notes: s.notes,
      status: 'planned',
    });
    setSuggestions((prev) => prev.filter((x) => x !== s));
  }

  function openNewDialog(defaultTime?: string) {
    setEditingItem(null);
    setInsertAfterTime(defaultTime);
    setDialogOpen(true);
  }

  function openEditDialog(item: ItineraryItem) {
    setEditingItem(item);
    setInsertAfterTime(undefined);
    setDialogOpen(true);
  }

  async function handleSaveDialog(data: Omit<ItineraryItem, 'id'> & { id?: string }) {
    const { id, ...rest } = data;
    await upsert.mutateAsync({
      ...rest,
      id: id ?? uid('item'),
      order: id ? rest.order : items.length + 1,
    } as ItineraryItem);
  }

  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const orderedItems = useMemo(() => {
    if (!localOrder) return items;
    const map = new Map(items.map((i) => [i.id, i]));
    const out: ItineraryItem[] = [];
    for (const id of localOrder) {
      const it = map.get(id);
      if (it) out.push(it);
    }
    for (const it of items) if (!localOrder.includes(it.id)) out.push(it);
    return out;
  }, [items, localOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const conflicts = useMemo(() => detectTimeConflicts(orderedItems), [orderedItems]);

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = orderedItems.map((x) => x.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setLocalOrder(next);
    reorder.mutate(next, {
      onSettled: () => setLocalOrder(null),
    });
  }

  return (
    <div className="space-y-3">
      {editMode && (
        <PlaceSearch
          onSelect={(place) =>
            void upsert.mutateAsync({
              id: uid('item'),
              order: items.length + 1,
              title: place.name,
              placeId: place.placeId,
              placeName: place.name,
              address: place.address,
              lat: place.lat,
              lng: place.lng,
              status: 'planned',
            })
          }
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={editMode ? 'default' : 'outline'} onClick={() => setEditMode((v) => !v)}>
          {editMode ? <><Eye className="size-4" /> 檢視模式</> : <><Edit3 className="size-4" /> 編輯模式</>}
        </Button>
        <Button size="sm" variant="outline" onClick={() => openNewDialog()}>
          <Plus className="size-4" /> 新增項目
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void requestSuggestions()}
          disabled={suggest.isPending || !destination}
        >
          <Sparkles className="size-4" /> {suggest.isPending ? 'LLM 思考中…' : '建議本日補充'}
        </Button>
        <DayRouteButton items={orderedItems} />
        {conflicts.size > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-destructive">
            <AlertTriangle className="size-3" /> {conflicts.size} 項時間重疊
          </span>
        )}
        {editMode && orderedItems.some((it) => it.startTime) && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="size-3" /> 已設時間的項目依時間自動排序，調整時間即可改順序
          </span>
        )}
      </div>

      {suggestions.length > 0 && (
        <Card>
          <CardContent className="space-y-2 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">LLM 建議（點 + 加入）</span>
              <Button size="sm" variant="ghost" onClick={() => setSuggestions([])}>
                <Trash2 className="size-4" /> 清除
              </Button>
            </div>
            <ul className="space-y-1.5">
              {suggestions.map((s, i) => (
                <li key={i} className="flex items-start gap-2 rounded-md border bg-background p-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      {s.startTime && <span className="tabular-nums text-muted-foreground">{s.startTime}</span>}
                      <span className="font-medium truncate">{s.title}</span>
                      {s.type && <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px]">{s.type}</span>}
                    </div>
                    {s.placeName && <div className="text-xs text-muted-foreground">{s.placeName}</div>}
                    {s.notes && <div className="text-xs text-muted-foreground">{s.notes}</div>}
                  </div>
                  <Button size="icon-sm" variant="ghost" onClick={() => void acceptSuggestion(s)}>
                    <Plus className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {orderedItems.some((it) => it.lat != null && it.lng != null) && (
        <div className="overflow-hidden rounded-md border">
          <MapView items={orderedItems} />
        </div>
      )}

      {editMode ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={orderedItems.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ol className="space-y-2">
              {orderedItems.map((item) => (
                <SortableItem
                  key={item.id}
                  item={item}
                  conflict={conflicts.has(item.id)}
                  onEdit={() => openEditDialog(item)}
                  onDelete={() => void handleDeleteItem(item)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      ) : (
        <ol className="space-y-2">
          {orderedItems.length === 0 ? (
            <li className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              尚無項目。點上方「新增項目」開始規劃。
            </li>
          ) : (
            orderedItems.map((item, i) => (
              <ViewItem
                key={item.id}
                item={item}
                conflict={conflicts.has(item.id)}
                onClick={() => openEditDialog(item)}
                onInsertAfter={() => {
                  const next = addMinutesStr(item.endTime || item.startTime, 60);
                  openNewDialog(next);
                }}
                isLast={i === orderedItems.length - 1}
                hours={
                  <ItemHours
                    itineraryId={itineraryId}
                    dayId={dayId}
                    dayDate={dayDate}
                    item={item}
                    canFetch={canFetchHours}
                    canSave={canSaveHours}
                  />
                }
              />
            ))
          )}
        </ol>
      )}

      <ItineraryItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        item={editingItem}
        onSave={handleSaveDialog}
        defaultStartTime={insertAfterTime}
      />
    </div>
  );
}

const TYPE_ICON: Record<ItineraryItemType, typeof Utensils> = {
  transport: Car,
  meal: Utensils,
  activity: Ticket,
  accommodation: Hotel,
  shopping: ShoppingBag,
};

function ViewItem({
  item, conflict, onClick, onInsertAfter, isLast, hours,
}: {
  item: ItineraryItem;
  conflict: boolean;
  onClick: () => void;
  onInsertAfter: () => void;
  isLast: boolean;
  /** 營業時間列（ItemHours） */
  hours?: React.ReactNode;
}) {
  const Icon = TYPE_ICON[item.type ?? 'activity'] ?? Circle;
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'group flex w-full gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/50',
          conflict && 'border-destructive/60 ring-1 ring-destructive/30',
        )}
      >
        <div className="flex w-14 shrink-0 flex-col items-center text-xs text-muted-foreground">
          {item.startTime ? (
            <span className="font-mono tabular-nums font-medium text-foreground">{item.startTime}</span>
          ) : (
            <span className="text-muted-foreground/60">--:--</span>
          )}
          {item.endTime ? (
            <span className="font-mono tabular-nums text-[10px]">{item.endTime}</span>
          ) : null}
        </div>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{item.title}</span>
            {item.status === 'done' && (
              <span className="rounded-md bg-success/20 px-1.5 py-0.5 text-[10px] text-success">已完成</span>
            )}
          </div>
          {item.placeName && (
            <div className="truncate text-xs text-muted-foreground">{item.placeName}</div>
          )}
          {item.notes && (
            <div className="truncate text-xs text-muted-foreground/80">{item.notes}</div>
          )}
          {hours}
        </div>
        {item.estimatedCost != null && (
          <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <DollarSign className="size-3" />
            <span className="tabular-nums">{Math.round(item.estimatedCost).toLocaleString()}</span>
          </div>
        )}
      </button>
      {!isLast && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={onInsertAfter}
            aria-label="在此插入項目"
            className="my-0.5 flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:my-1 [@media(hover:none)]:px-3 [@media(hover:none)]:py-1 [@media(hover:none)]:text-xs [@media(hover:none)]:opacity-70"
          >
            <Plus className="size-3" /> 插入
          </button>
        </div>
      )}
    </li>
  );
}

function addMinutesStr(time: string | undefined, mins: number): string | undefined {
  if (!time) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return undefined;
  const total = parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10) + mins; // 非空：regex 已匹配，群組一定存在
  const h = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function SortableItem({
  item, conflict, onEdit, onDelete,
}: {
  item: ItineraryItem;
  conflict: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const Icon = TYPE_ICON[item.type ?? 'activity'] ?? Circle;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-3 rounded-md border bg-card p-3',
        conflict && 'border-destructive/60 ring-1 ring-destructive/30',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        // touch-none：手指按住把手時交給 dnd-kit，不要被頁面捲動搶走手勢
        className="flex shrink-0 cursor-grab touch-none items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted lg:p-1"
        aria-label="拖曳排序"
      >
        <GripVertical className="size-4" />
      </button>
      <div className="flex w-12 shrink-0 flex-col items-center text-xs">
        {item.startTime ? (
          <span className="font-mono tabular-nums font-medium">{item.startTime}</span>
        ) : (
          <span className="text-muted-foreground/60">--:--</span>
        )}
      </div>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-4" />
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <div className="truncate text-sm font-medium">{item.title || '(未命名)'}</div>
        {item.placeName && <div className="truncate text-xs text-muted-foreground">{item.placeName}</div>}
      </button>
      <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label="編輯">
        <Edit3 className="size-4" />
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onDelete} aria-label="刪除">
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}

function formatYMD(d: Date): string {
  return formatDateInput(d);
}

function shortDayLabel(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const d = new Date(parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10)); // 非空：regex 已匹配，群組一定存在
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${m[2]}/${m[3]} (${week})`;
}

function DayMetaEditor({
  itineraryId,
  day,
  onRenamed,
}: {
  itineraryId: string;
  day: { id: string; date: string; theme?: string };
  onRenamed: (newDayId: string) => void;
}) {
  const upsert = useUpsertDay(itineraryId);
  const move = useMoveDay(itineraryId);
  const [theme, setTheme] = useState(day.theme ?? '');

  const parsedDate = parseDateInput(day.date);

  async function setDate(d: Date | null) {
    if (!d) return;
    const newId = formatYMD(d);
    if (newId === day.id) return;
    await move.mutateAsync({
      oldDayId: day.id,
      newDayId: newId,
      meta: { date: newId, theme: day.theme },
    });
    onRenamed(newId);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <span className="text-xs text-muted-foreground">這天</span>
      <div className="min-w-[200px]">
        <DatePicker value={parsedDate} onChange={(d) => void setDate(d)} clearable={false} size="sm" />
      </div>
      <span className="text-xs text-muted-foreground">主題</span>
      <Input
        className="h-9 w-48"
        value={theme}
        onChange={(e) => setTheme(e.target.value)}
        onBlur={() => {
          if (theme !== (day.theme ?? '')) {
            void upsert.mutateAsync({ id: day.id, date: day.date, theme });
          }
        }}
      />
    </div>
  );
}

function DeleteDayButton({
  itineraryId, dayId, daysCount,
}: { itineraryId: string; dayId: string | null; daysCount: number }) {
  const del = useDeleteDay(itineraryId);
  const confirm = useConfirm();
  if (!dayId || daysCount === 0) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-destructive"
      disabled={del.isPending}
      onClick={async () => {
        const ok = await confirm({
          title: '刪除整天',
          description: `${dayId} 與其所有 items 會一併移除，無法復原`,
          confirmText: '刪除',
        });
        if (ok) void del.mutateAsync(dayId);
      }}
    >
      <Trash2 className="size-4" /> 刪除本日
    </Button>
  );
}

/**
 * 回傳有時間衝突的 item id set — 定義：同一天內，某 item 的 [start, end] 與其他 item 重疊。
 * 缺 endTime 就用 start + 60min 作為預設時段。缺 startTime 的不列入比對。
 */
function detectTimeConflicts(items: ItineraryItem[]): Set<string> {
  const out = new Set<string>();
  const parsed = items
    .map((i) => {
      const s = parseHHMM(i.startTime);
      if (s == null) return null;
      const e = parseHHMM(i.endTime) ?? s + 60;
      return { id: i.id, s, e: Math.max(e, s + 1) };
    })
    .filter((x): x is { id: string; s: number; e: number } => x != null);
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i]!; // 非空：索引已做邊界 / 長度檢查
      const b = parsed[j]!; // 非空：索引已做邊界 / 長度檢查
      if (a.s < b.e && b.s < a.e) {
        out.add(a.id);
        out.add(b.id);
      }
    }
  }
  return out;
}

function parseHHMM(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1]!, 10); // 非空：regex 已匹配，群組一定存在
  const mm = parseInt(m[2]!, 10); // 非空：regex 已匹配，群組一定存在
  if (Number.isNaN(h) || Number.isNaN(mm)) return null;
  return h * 60 + mm;
}

function ListView({
  itineraryId, dayId, items,
}: { itineraryId: string; dayId: string; items: ItineraryItem[] }) {
  const del = useDeleteItineraryItem(itineraryId, dayId);
  const confirm = useConfirm();
  async function handleDel(it: ItineraryItem) {
    const ok = await confirm({
      title: '刪除項目',
      description: it.title || '(未命名)',
      confirmText: '刪除',
    });
    if (ok) await del.mutateAsync(it.id);
  }
  return (
    <ul className="divide-y rounded-md border">
      {items.map((item) => (
        <li key={item.id} className="flex items-center justify-between p-3 text-sm">
          <div>
            <div className="font-medium">{item.title}</div>
            <div className="text-xs text-muted-foreground">
              {item.startTime ?? '—'} {item.placeName ? `· ${item.placeName}` : ''}
            </div>
          </div>
          <Button size="icon-sm" variant="ghost" onClick={() => void handleDel(item)}>
            <Trash2 className="size-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
