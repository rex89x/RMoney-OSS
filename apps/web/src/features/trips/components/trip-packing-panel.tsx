import { useEffect, useMemo, useState } from 'react';
import {
  BatteryCharging, CheckSquare, ClipboardList, Droplets, FileText, Loader2, Package, Pencil, Pill,
  Plus, Printer, RotateCcw, Shirt, Sparkles, Square, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useConfirm } from '@/components/ui/confirm';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import {
  useAddPackingItem, useAddPackingTemplate, useDeletePackingItem, usePackingItems,
  useUncheckAllPacking, useUpdatePackingItem,
} from '../hooks';
import {
  buildPackingTemplate, filterNewTemplateItems, inferPackingContext, packingProgress, resolveWeather,
  type PackingClimate, type PackingTemplateInput,
} from '../packing-template';
import { PackingItemFormSchema } from '../schema';
import {
  PACKING_CATEGORIES, PACKING_CATEGORY_LABEL,
  type PackingCategory, type PackingItem, type Trip,
} from '../types';

const CATEGORY_ICON: Record<PackingCategory, React.ComponentType<{ className?: string }>> = {
  documents: FileText,
  clothes: Shirt,
  toiletries: Droplets,
  electronics: BatteryCharging,
  health: Pill,
  other: Package,
};

const NO_ASSIGNEE = '__none__';

interface AssigneeOption {
  uid: string;
  label: string;
}

/** 可指派的人：建立者 + 帶 uid 的旅伴 + sharedWith */
function useAssigneeOptions(trip: Trip): AssigneeOption[] {
  const { user } = useAuth();
  return useMemo(() => {
    const out = new Map<string, string>();
    const ownerUid = trip.ownerId || trip.userId;
    const nameOf = (uid: string) => trip.members?.find((m) => m.uid === uid)?.name;
    if (ownerUid) out.set(ownerUid, nameOf(ownerUid) ?? '建立者');
    for (const m of trip.members ?? []) if (m.uid) out.set(m.uid, m.name || '旅伴');
    for (const uid of trip.sharedWith ?? []) if (!out.has(uid)) out.set(uid, nameOf(uid) ?? '旅伴');
    return Array.from(out.entries()).map(([uid, label]) => ({
      uid,
      label: uid === user?.uid ? `我（${label}）` : label,
    }));
  }, [trip, user?.uid]);
}

export function TripPackingPanel({ trip }: { trip: Trip }) {
  const { user, isAdmin } = useAuth();
  const uid = user?.uid ?? '';
  const canEdit = Boolean(uid) && (trip.userId === uid || trip.ownerId === uid || isAdmin);
  const canToggle = canEdit || Boolean(uid && trip.sharedWith?.includes(uid));

  const { data: items = [], isLoading } = usePackingItems(trip.id);
  const update = useUpdatePackingItem(trip.id);
  const del = useDeletePackingItem(trip.id);
  const uncheckAll = useUncheckAllPacking(trip.id);
  const confirm = useConfirm();
  const assignees = useAssigneeOptions(trip);
  const assigneeLabel = useMemo(() => new Map(assignees.map((a) => [a.uid, a.label])), [assignees]);

  const [editing, setEditing] = useState<PackingItem | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  const progress = packingProgress(items);
  const grouped = useMemo(
    () => PACKING_CATEGORIES.map((c) => ({ category: c, items: items.filter((i) => i.category === c) })),
    [items],
  );
  const nextOrder = items.reduce((m, i) => Math.max(m, i.order), 0) + 1;

  // 列印只印清單：body 掛 class，index.css 的 print 規則把其他內容藏起來
  useEffect(() => {
    if (!printing) return;
    document.body.classList.add('print-packing');
    const done = () => {
      document.body.classList.remove('print-packing');
      setPrinting(false);
    };
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    return () => {
      window.removeEventListener('afterprint', done);
      document.body.classList.remove('print-packing');
    };
  }, [printing]);

  async function handleDelete(it: PackingItem) {
    const ok = await confirm({ title: '刪除這個項目？', description: it.name, confirmText: '刪除' });
    if (ok) del.mutate(it.id);
  }

  async function handleUncheckAll() {
    const packedIds = items.filter((i) => i.packed).map((i) => i.id);
    if (packedIds.length === 0) return;
    const ok = await confirm({
      title: '全部取消勾選？',
      description: `${packedIds.length} 項會變回未打包（回程整理行李時用）`,
      confirmText: '取消勾選',
    });
    if (ok) uncheckAll.mutate(packedIds);
  }

  return (
    <div className="space-y-4">
      <Card className="packing-print">
        <CardHeader className="flex flex-col items-start justify-between gap-2 pb-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="size-4" /> 行李清單
            <span className="hidden text-sm font-normal print:inline">— {trip.name}</span>
          </CardTitle>
          <div className="flex flex-wrap gap-2 print:hidden">
            {canEdit ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setTemplateOpen(true)}>
                  <Sparkles className="size-4" /> 從範本產生
                </Button>
                <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
                  <Plus className="size-4" /> 新增
                </Button>
              </>
            ) : null}
            {canToggle && progress.packed > 0 ? (
              <Button size="sm" variant="outline" onClick={() => void handleUncheckAll()} disabled={uncheckAll.isPending}>
                <RotateCcw className="size-4" /> 全部取消勾選
              </Button>
            ) : null}
            {items.length > 0 ? (
              <Button size="sm" variant="outline" onClick={() => setPrinting(true)}>
                <Printer className="size-4" /> 列印
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.length > 0 ? (
            <div>
              <div className="mb-1 flex justify-between text-sm">
                <span>打包進度</span>
                <span className="tabular-nums">{progress.packed} / {progress.total} 已打包 · {progress.percent}%</span>
              </div>
              <Progress value={progress.percent} />
            </div>
          ) : null}

          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full rounded-md" />)}
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              <ClipboardList className="mx-auto mb-2 size-5" />
              {canEdit
                ? '還沒有行李清單。按「從範本產生」依天數、季節、國內外自動列一份，再自己增刪。'
                : '旅程建立者還沒有建立行李清單。'}
            </div>
          ) : (
            <div className="space-y-4">
              {grouped.map(({ category, items: list }) => {
                if (list.length === 0) return null;
                const Icon = CATEGORY_ICON[category];
                const done = list.filter((i) => i.packed).length;
                return (
                  <section key={category} className="break-inside-avoid">
                    <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <Icon className="size-3.5" /> {PACKING_CATEGORY_LABEL[category]}
                      <span className="tabular-nums text-[10px]">（{done}/{list.length}）</span>
                    </div>
                    <ul className="space-y-1">
                      {list.map((it) => (
                        <PackingRow
                          key={it.id}
                          item={it}
                          canEdit={canEdit}
                          canToggle={canToggle}
                          assignees={assignees}
                          assigneeLabel={it.assignee ? assigneeLabel.get(it.assignee) ?? '旅伴' : null}
                          onToggle={() => update.mutate({ itemId: it.id, patch: { packed: !it.packed } })}
                          onAssign={(assignee) => update.mutate({ itemId: it.id, patch: { assignee } })}
                          onEdit={() => { setEditing(it); setFormOpen(true); }}
                          onDelete={() => void handleDelete(it)}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {canEdit ? (
        <>
          <PackingItemDialog
            open={formOpen}
            onOpenChange={setFormOpen}
            tripId={trip.id}
            item={editing}
            nextOrder={nextOrder}
            assignees={assignees}
          />
          <PackingTemplateDialog
            open={templateOpen}
            onOpenChange={setTemplateOpen}
            trip={trip}
            existingNames={items.map((i) => i.name)}
            nextOrder={nextOrder}
          />
        </>
      ) : null}
    </div>
  );
}

interface PackingRowProps {
  item: PackingItem;
  canEdit: boolean;
  canToggle: boolean;
  assignees: AssigneeOption[];
  assigneeLabel: string | null;
  onToggle: () => void;
  onAssign: (uid: string | null) => void;
  onEdit: () => void;
  onDelete: () => void;
}

function PackingRow({
  item, canEdit, canToggle, assignees, assigneeLabel, onToggle, onAssign, onEdit, onDelete,
}: PackingRowProps) {
  const CheckIcon = item.packed ? CheckSquare : Square;
  return (
    <li className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-sm">
      <button
        type="button"
        role="checkbox"
        aria-checked={item.packed}
        aria-label={item.packed ? `取消勾選 ${item.name}` : `勾選 ${item.name}`}
        disabled={!canToggle}
        onClick={onToggle}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left',
          canToggle && 'hover:bg-muted/60',
        )}
      >
        <CheckIcon className={cn('size-5 shrink-0', item.packed ? 'text-primary' : 'text-muted-foreground')} />
        <span className={cn('min-w-0 flex-1 truncate', item.packed && 'text-muted-foreground line-through')}>
          {item.name}
        </span>
        {item.quantity > 1 ? (
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">×{item.quantity}</span>
        ) : null}
      </button>
      {assignees.length > 1 && canToggle ? (
        <Select
          value={item.assignee ?? NO_ASSIGNEE}
          onValueChange={(v) => onAssign(v === NO_ASSIGNEE ? null : v)}
        >
          <SelectTrigger className="h-7 w-auto max-w-[7.5rem] gap-1 px-2 text-xs print:hidden" aria-label="誰帶">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_ASSIGNEE}>未指派</SelectItem>
            {assignees.map((a) => <SelectItem key={a.uid} value={a.uid}>{a.label}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : null}
      {assigneeLabel ? (
        <span className={cn('shrink-0 text-xs text-muted-foreground', assignees.length > 1 && canToggle && 'hidden print:inline')}>
          {assigneeLabel}
        </span>
      ) : null}
      {canEdit ? (
        <div className="flex shrink-0 print:hidden">
          <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label="編輯">
            <Pencil className="size-3.5" />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={onDelete} aria-label="刪除">
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function PackingItemDialog({
  open, onOpenChange, tripId, item, nextOrder, assignees,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tripId: string;
  item: PackingItem | null;
  nextOrder: number;
  assignees: AssigneeOption[];
}) {
  const add = useAddPackingItem(tripId);
  const update = useUpdatePackingItem(tripId);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<PackingCategory>('other');
  const [quantity, setQuantity] = useState('1');
  const [assignee, setAssignee] = useState<string>(NO_ASSIGNEE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? '');
    setCategory(item?.category ?? 'other');
    setQuantity(String(item?.quantity ?? 1));
    setAssignee(item?.assignee ?? NO_ASSIGNEE);
    setError(null);
  }, [open, item]);

  async function handleSubmit() {
    const parsed = PackingItemFormSchema.safeParse({
      name, category, quantity, assignee: assignee === NO_ASSIGNEE ? null : assignee,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '格式錯誤');
      return;
    }
    try {
      if (item) await update.mutateAsync({ itemId: item.id, patch: parsed.data });
      else await add.mutateAsync({ input: parsed.data, order: nextOrder });
      onOpenChange(false);
    } catch (err) {
      // toast 已在 hook onError 處理；這裡只保留對話框讓使用者重試
      console.error('[PackingItemDialog]', err);
    }
  }

  const pending = add.isPending || update.isPending;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? '編輯項目' : '新增行李項目'}
      contentClassName="sm:max-w-md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={pending || !name.trim()}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            儲存
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>名稱</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：自拍棒" autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>分類</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as PackingCategory)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PACKING_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>{PACKING_CATEGORY_LABEL[c]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>數量</Label>
            <Input
              className="mt-1"
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
        </div>
        {assignees.length > 1 ? (
          <div>
            <Label>誰帶</Label>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ASSIGNEE}>未指派</SelectItem>
                {assignees.map((a) => <SelectItem key={a.uid} value={a.uid}>{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </ResponsiveDialog>
  );
}

const CLIMATE_LABEL: Record<PackingClimate | 'unknown', string> = {
  tropical: '熱帶',
  temperate: '四季分明',
  cold: '寒冷地區',
  unknown: '未知（只看季節）',
};

const WEATHER_LABEL = { hot: '炎熱', mild: '溫和', cold: '寒冷' } as const;

function PackingTemplateDialog({
  open, onOpenChange, trip, existingNames, nextOrder,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trip: Trip;
  existingNames: string[];
  nextOrder: number;
}) {
  const addTemplate = useAddPackingTemplate(trip.id);
  const inferred = useMemo(() => inferPackingContext(trip), [trip]);
  const [ctx, setCtx] = useState<PackingTemplateInput>(inferred);

  useEffect(() => {
    if (open) setCtx(inferred);
  }, [open, inferred]);

  const preview = useMemo(
    () => filterNewTemplateItems(buildPackingTemplate(ctx), existingNames),
    [ctx, existingNames],
  );
  const weather = resolveWeather(ctx);

  async function handleApply() {
    try {
      await addTemplate.mutateAsync({ items: preview, startOrder: nextOrder });
      onOpenChange(false);
    } catch (err) {
      console.error('[PackingTemplateDialog]', err);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="從範本產生行李清單"
      description="依旅程天數、出發月份（台北時間）、目的地與國內外自動列出；已在清單裡的不會重複加入。"
      contentClassName="sm:max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void handleApply()} disabled={addTemplate.isPending || preview.length === 0}>
            {addTemplate.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            加入 {preview.length} 項
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <ContextTile label="天數" value={`${ctx.days} 天`} />
          <ContextTile label="出發月份" value={`${ctx.startMonth} 月`} />
          <ContextTile label="目的地氣候" value={CLIMATE_LABEL[ctx.climate ?? 'unknown']} />
          <ContextTile label="預估體感" value={WEATHER_LABEL[weather]} />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={ctx.international}
              onCheckedChange={(v) => setCtx((c) => ({ ...c, international: v }))}
            />
            出國（護照、轉接頭、外幣、網卡 / eSIM、旅平險）
          </label>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">氣候</span>
            <Select
              value={ctx.climate ?? 'unknown'}
              onValueChange={(v) => setCtx((c) => ({ ...c, climate: v === 'unknown' ? null : (v as PackingClimate) }))}
            >
              <SelectTrigger className="h-8 w-auto gap-1 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(['tropical', 'temperate', 'cold', 'unknown'] as const).map((k) => (
                  <SelectItem key={k} value={k}>{CLIMATE_LABEL[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {preview.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            範本裡的項目都已經在清單上了。
          </p>
        ) : (
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
            {PACKING_CATEGORIES.map((c) => {
              const list = preview.filter((p) => p.category === c);
              if (list.length === 0) return null;
              return (
                <div key={c}>
                  <div className="text-xs font-medium text-muted-foreground">{PACKING_CATEGORY_LABEL[c]}</div>
                  <div className="text-sm">
                    {list.map((p) => (p.quantity > 1 ? `${p.name} ×${p.quantity}` : p.name)).join('、')}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ResponsiveDialog>
  );
}

function ContextTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
