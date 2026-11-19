import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, ClipboardCopy, ClipboardPaste, Link2, Loader2, MapPin, MapPinOff, Search, Sparkles, TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { formatTWDateInput } from '@/lib/tz';
import { statusForDates } from '@/features/trips/import-chiauming';
import type { Trip } from '@/features/trips/types';
import {
  buildExternalPrompt,
  buildBuiltinInstruction,
  classifyProposedStops,
  defaultSelected,
  extractProposalJson,
  fallbackTrip,
  locatePlanFor,
  parseItineraryProposal,
  summarizeLocate,
  validateSourceText,
  type ClassifiedStop,
  type ExistingStopRef,
  type ItineraryProposal,
  type ProposedStopStatus,
  type ProposedTrip,
} from '../ai-import';
import { useAllItineraryItems, useApplyAiItinerary, useItineraryDays, useParseItineraryText } from '../hooks';

interface AiItineraryImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 有值 = 加進這趟旅程；沒值 = 依 AI 整理出的旅程資訊建立新旅程。 */
  trip?: Trip;
  /** 新旅程要一併分享給的 uid（共同帳本「新旅程自動分享」設定）。 */
  autoSharedWith?: string[];
}

const STATUS_LABEL: Record<ProposedStopStatus, { label: string; variant: 'secondary' | 'outline' | 'warning' | 'destructive' }> = {
  new: { label: '新增', variant: 'secondary' },
  duplicate: { label: '重複', variant: 'outline' },
  conflict: { label: '時段衝突', variant: 'warning' },
  'out-of-range': { label: '超出日期', variant: 'warning' },
};

const TYPE_LABEL: Record<string, string> = {
  transport: '交通', meal: '餐飲', activity: '景點', accommodation: '住宿', shopping: '購物',
};

export function AiItineraryImportDialog({ open, onOpenChange, trip, autoSharedWith = [] }: AiItineraryImportDialogProps) {
  const navigate = useNavigate();
  const parseText = useParseItineraryText();
  const applyImport = useApplyAiItinerary();
  const { data: days = [] } = useItineraryDays(open && trip ? trip.id : undefined);
  const { data: dayItems = [] } = useAllItineraryItems(open && trip ? trip.id : undefined, days.map((day) => day.id));

  const [mode, setMode] = useState<'builtin' | 'external'>('external');
  const [sourceText, setSourceText] = useState('');
  const [resultText, setResultText] = useState('');
  const [proposal, setProposal] = useState<ItineraryProposal | null>(null);
  const [repaired, setRepaired] = useState(false);
  const [parseError, setParseError] = useState('');
  const [selected, setSelected] = useState<boolean[]>([]);
  const [tripDraft, setTripDraft] = useState<ProposedTrip | null>(null);

  useEffect(() => {
    if (!open) return;
    setSourceText(''); setResultText(''); setProposal(null); setParseError(''); setSelected([]); setTripDraft(null); setRepaired(false);
  }, [open]);

  const today = formatTWDateInput(new Date());
  const tripContext = useMemo(() => trip ? {
    title: trip.name,
    destination: trip.destination.join('、'),
    startDate: formatTWDateInput(trip.startDate),
    endDate: formatTWDateInput(trip.endDate),
  } : undefined, [trip]);
  const existingStops = useMemo<ExistingStopRef[]>(
    () => dayItems.flatMap(({ dayId, items }) => items.map((item) => ({ date: dayId, time: item.startTime, title: item.title }))),
    [dayItems],
  );
  const promptContext = useMemo(() => ({ today, trip: tripContext, existingStops }), [today, tripContext, existingStops]);

  const classified = useMemo<ClassifiedStop[]>(() => {
    if (!proposal) return [];
    return classifyProposedStops(proposal.stops, {
      existingStops,
      tripRange: tripContext ? { startDate: tripContext.startDate, endDate: tripContext.endDate } : undefined,
    });
  }, [proposal, existingStops, tripContext]);

  const destination = tripContext?.destination ?? tripDraft?.destination ?? '';
  const chosen = classified.filter((_, index) => selected[index]);
  const locate = summarizeLocate(chosen, destination);

  function loadProposal(text: string): void {
    try {
      const { data, repaired: wasRepaired } = extractProposalJson(text);
      const next = parseItineraryProposal(data);
      if (next.stops.length === 0) throw new Error('結果裡沒有可以匯入的停留點（需要標題與 YYYY-MM-DD 日期）。');
      setProposal(next);
      setRepaired(wasRepaired);
      setTripDraft(trip ? null : fallbackTrip(next) ?? null);
      setParseError('');
      const nextClassified = classifyProposedStops(next.stops, {
        existingStops,
        tripRange: tripContext ? { startDate: tripContext.startDate, endDate: tripContext.endDate } : undefined,
      });
      setSelected(nextClassified.map((stop) => defaultSelected(stop.status)));
    } catch (err) {
      setProposal(null);
      setParseError(err instanceof Error ? err.message : '無法解析');
    }
  }

  async function runBuiltin(): Promise<void> {
    const invalid = validateSourceText(sourceText);
    if (invalid) { setParseError(invalid); return; }
    try {
      const json = await parseText.mutateAsync({ instruction: buildBuiltinInstruction(promptContext), text: sourceText.trim() });
      loadProposal(json);
    } catch (err) {
      console.error('[aiItineraryImport.builtin]', err);
      setParseError(err instanceof Error ? err.message : 'AI 整理失敗');
    }
  }

  async function copyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildExternalPrompt({ ...promptContext, sourceText }));
      toast.success('已複製提示詞，貼到 Claude 或 ChatGPT；回覆的 JSON 貼回下方');
    } catch (err) {
      console.error('[aiItineraryImport.copyPrompt]', err);
      toast.error('瀏覽器不允許寫入剪貼簿');
    }
  }

  async function pasteResult(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      setResultText(text);
      loadProposal(text);
    } catch (err) {
      console.error('[aiItineraryImport.paste]', err);
      toast.error('瀏覽器不允許讀取剪貼簿，請直接貼到欄位');
    }
  }

  async function submit(): Promise<void> {
    if (chosen.length === 0) return;
    const stops = chosen.map(({ status: _status, reason: _reason, ...stop }) => stop);
    try {
      let result;
      if (trip) {
        result = await applyImport.mutateAsync({ stops, target: { kind: 'existing', trip } });
      } else {
        if (!tripDraft || !tripDraft.title.trim()) { toast.error('請填旅程名稱'); return; }
        result = await applyImport.mutateAsync({
          stops,
          target: {
            kind: 'new',
            trip: tripDraft,
            status: statusForDates(tripDraft.startDate, tripDraft.endDate, today),
            sharedWith: autoSharedWith,
          },
        });
      }
      const parts = [
        result.created > 0 ? `新增 ${result.created} 個` : '',
        result.updated > 0 ? `更新 ${result.updated} 個` : '',
      ].filter(Boolean).join('、');
      toast.success(`已匯入行程：${parts}${result.locating > 0 ? `，背景定位 ${result.locating} 個地點中` : ''}`);
      onOpenChange(false);
      navigate(`/trips/${result.tripId}`);
    } catch (err) {
      console.error('[aiItineraryImport.submit]', err);
      toast.error(err instanceof Error ? err.message : '匯入失敗');
    }
  }

  const footer = proposal ? (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
      <Button variant="outline" onClick={() => setProposal(null)}>重新整理</Button>
      <Button onClick={() => void submit()} disabled={chosen.length === 0 || applyImport.isPending}>
        {applyImport.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
        {trip ? `加入 ${chosen.length} 個停留點` : `建立旅程・${chosen.length} 個停留點`}
      </Button>
    </div>
  ) : undefined;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={trip ? `AI 匯入行程到「${trip.name}」` : 'AI 匯入行程'}
      description="貼上攻略、訂房信或任何行程文字，整理成每天的停留點；先預覽、勾選後才寫入，並自動在地圖上定位。"
      footer={footer}
    >
      {!proposal ? (
        <Tabs value={mode} onValueChange={(value) => { setMode(value as 'builtin' | 'external'); setParseError(''); }}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="external">外部 AI（Claude 等）</TabsTrigger>
            <TabsTrigger value="builtin">站內 Claude</TabsTrigger>
          </TabsList>

          <div className="mt-3 space-y-2">
            <Textarea
              value={sourceText}
              onChange={(event) => setSourceText(event.target.value)}
              placeholder="例：10/2 早上築地市場吃壽司，中午淺草寺，晚上住淺草 Richmond…"
              rows={6}
              aria-label="行程文字"
            />
            <p className="text-xs text-muted-foreground">{sourceText.trim().length} / 20000 字</p>
          </div>

          <TabsContent value="external" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              複製提示詞貼到 Claude 或 ChatGPT（建議開啟網路搜尋），它會順便附上每個地點的 Google Maps 連結，地圖就能直接定位。不花站內 AI 額度。
            </p>
            <Button variant="outline" onClick={() => void copyPrompt()}>
              <ClipboardCopy className="size-4" />複製提示詞
            </Button>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">貼上 AI 回傳的 JSON</span>
                <Button variant="ghost" size="sm" onClick={() => void pasteResult()}>
                  <ClipboardPaste className="size-4" />從剪貼簿貼上
                </Button>
              </div>
              <Textarea
                value={resultText}
                onChange={(event) => setResultText(event.target.value)}
                placeholder='```json { "stops": [ … ] } ```'
                rows={4}
                className="font-mono text-xs"
                aria-label="AI 回傳結果"
              />
              <Button onClick={() => loadProposal(resultText)} disabled={!resultText.trim()}>預覽</Button>
            </div>
          </TabsContent>

          <TabsContent value="builtin" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              直接用站內 Claude 整理（計入 Claude 額度）。站內整理不會附地圖連結，套用後改用 Google Places 依地名搜尋位置。
            </p>
            <Button onClick={() => void runBuiltin()} disabled={parseText.isPending}>
              {parseText.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              整理成行程
            </Button>
          </TabsContent>

          {parseError ? <p className="mt-3 text-sm text-destructive" role="alert">{parseError}</p> : null}
        </Tabs>
      ) : (
        <div className="space-y-4">
          {!trip && tripDraft ? (
            <div className="grid gap-2 rounded-lg border p-3 text-sm">
              <span className="text-muted-foreground">建立新旅程</span>
              <Input value={tripDraft.title} onChange={(e) => setTripDraft({ ...tripDraft, title: e.target.value })} aria-label="旅程名稱" />
              <Input value={tripDraft.destination} onChange={(e) => setTripDraft({ ...tripDraft, destination: e.target.value })} placeholder="目的地（用來縮小地圖搜尋範圍）" aria-label="目的地" />
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <CalendarDays className="size-3.5" />{tripDraft.startDate} ~ {tripDraft.endDate}（會依停留點日期往外擴）
              </span>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary"><Link2 className="mr-1 size-3" />{locate.link} 個有地圖連結</Badge>
            <Badge variant="secondary"><Search className="mr-1 size-3" />{locate.search} 個會自動搜尋位置</Badge>
            {locate.none > 0 ? <Badge variant="outline"><MapPinOff className="mr-1 size-3" />{locate.none} 個不定位（交通）</Badge> : null}
          </div>

          {(proposal.warnings.length > 0 || proposal.discarded > 0 || repaired) ? (
            <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              {repaired ? <p>JSON 格式有點壞掉，已自動修正，請確認內容。</p> : null}
              {proposal.discarded > 0 ? <p>有 {proposal.discarded} 筆缺標題或日期，已略過。</p> : null}
              {proposal.warnings.map((warning) => (
                <p key={warning} className="flex gap-1"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{warning}</p>
              ))}
            </div>
          ) : null}

          <div className="flex gap-2 text-xs">
            <Button variant="ghost" size="sm" onClick={() => setSelected(classified.map(() => true))}>全選</Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(classified.map(() => false))}>全不選</Button>
          </div>

          <ul className="space-y-2">
            {classified.map((stop, index) => {
              const plan = locatePlanFor(stop, destination);
              const status = STATUS_LABEL[stop.status];
              return (
                <li key={`${stop.date}-${stop.time ?? ''}-${stop.title}-${index}`}>
                  <label className="flex gap-3 rounded-lg border p-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0"
                      checked={selected[index] ?? false}
                      onChange={(event) => setSelected((prev) => prev.map((value, i) => (i === index ? event.target.checked : value)))}
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="tabular-nums text-muted-foreground">{stop.date.slice(5).replace('-', '/')} {stop.time ?? '—'}{stop.endTime ? `–${stop.endTime}` : ''}</span>
                        <span className="font-medium">{stop.title}</span>
                        <Badge variant="outline">{TYPE_LABEL[stop.type] ?? stop.type}</Badge>
                        {stop.status !== 'new' ? <Badge variant={status.variant}>{status.label}</Badge> : null}
                      </span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        {plan.kind === 'coords' || plan.kind === 'resolve'
                          ? <Link2 className="size-3" />
                          : plan.kind === 'search' ? <MapPin className="size-3" /> : <MapPinOff className="size-3" />}
                        {stop.place}
                        {stop.estimatedCost != null ? ` · 約 ${stop.estimatedCost.toLocaleString()} ${stop.currency ?? ''}` : ''}
                      </span>
                      {stop.reason ? <span className="block text-xs text-muted-foreground">{stop.reason}</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </ResponsiveDialog>
  );
}
