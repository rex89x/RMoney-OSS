import { useEffect, useMemo, useState } from 'react';
import {
  BookText, Edit3, Eye, ExternalLink, Loader2, Plus, Save, Sparkles, Trash2, X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Markdown } from '@/components/ui/markdown';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { cn } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import {
  useGenerateTripNotes,
  useItinerary,
  useUpdateItineraryNotes,
  useUpsertItinerary,
} from '@/features/itinerary/hooks';
import { useTrip } from '../hooks';
import { useAuth } from '@/hooks/use-auth';

const NOTES_SOFT_LIMIT = 50_000;

export function TripNotesPanel({ tripId }: { tripId: string }) {
  const { data: trip } = useTrip(tripId);
  const { data: itinerary } = useItinerary(tripId);
  const upsert = useUpsertItinerary();
  const update = useUpdateItineraryNotes(tripId);
  const generate = useGenerateTripNotes();
  const { user, isViewer } = useAuth();
  const canEdit = !isViewer && Boolean(trip && (trip.userId === user?.uid || trip.ownerId === user?.uid));

  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [editValue, setEditValue] = useState('');
  const [previewWhileEditing, setPreviewWhileEditing] = useState<'edit' | 'preview'>('edit');
  const [llmOpen, setLlmOpen] = useState(false);
  const [tipsDraft, setTipsDraft] = useState('');

  // 拉到最新 notes 後同步進編輯框（換 trip 或 reload 後也會同步）
  useEffect(() => {
    if (mode === 'view') {
      setEditValue(itinerary?.notes ?? '');
    }
  }, [itinerary?.notes, mode]);

  const tips = useMemo(() => itinerary?.tips ?? [], [itinerary?.tips]);

  async function ensureItinerary(): Promise<void> {
    if (itinerary) return;
    await upsert.mutateAsync({
      id: tripId,
      tripId,
      title: trip?.name ?? 'Itinerary',
    });
  }

  async function handleStartEdit() {
    await ensureItinerary();
    setEditValue(itinerary?.notes ?? '');
    setMode('edit');
    setPreviewWhileEditing('edit');
  }

  async function handleSave() {
    if (editValue.length > NOTES_SOFT_LIMIT) {
      toast.warning(`內容超過 ${NOTES_SOFT_LIMIT.toLocaleString()} 字，已照樣儲存但建議拆分。`);
    }
    await ensureItinerary();
    await update.mutateAsync({ notes: editValue });
    toast.success('已儲存筆記');
    setMode('view');
  }

  function handleCancel() {
    setEditValue(itinerary?.notes ?? '');
    setMode('view');
  }

  async function applyLLMResult(markdown: string, action: 'replace' | 'append') {
    const next = action === 'replace'
      ? markdown
      : `${editValue ? `${editValue}\n\n---\n\n` : ''}${markdown}`;
    setEditValue(next);
    setMode('edit');
    setPreviewWhileEditing('preview');
    setLlmOpen(false);
    toast.success(action === 'replace' ? '已取代為 LLM 生成內容（尚未儲存）' : '已附加到筆記末尾（尚未儲存）');
  }

  async function handleAddTip() {
    const t = tipsDraft.trim();
    if (!t) return;
    await ensureItinerary();
    await update.mutateAsync({ tips: [...tips, t] });
    setTipsDraft('');
  }

  async function handleRemoveTip(idx: number) {
    const next = tips.filter((_, i) => i !== idx);
    await update.mutateAsync({ tips: next });
  }

  const hasNotes = (itinerary?.notes ?? '').trim().length > 0;
  const lastUpdated = itinerary?.notesUpdatedAt;

  return (
    <Card>
      <CardHeader className="flex flex-col items-start justify-between gap-2 pb-2 sm:flex-row sm:items-center">
        <CardTitle className="flex items-center gap-2 text-base">
          <BookText className="size-4" /> 旅程筆記
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to={`/trips/${tripId}/notes`}>
              <ExternalLink className="size-4" /> 全螢幕閱讀
            </Link>
          </Button>
          {canEdit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLlmOpen(true)}
              disabled={generate.isPending}
            >
              <Sparkles className="size-4" /> LLM 生成
            </Button>
          ) : null}
          {!canEdit ? null : mode === 'view' ? (
            <Button size="sm" onClick={() => void handleStartEdit()}>
              <Edit3 className="size-4" /> 編輯
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancel}
                disabled={update.isPending}
              >
                <X className="size-4" /> 取消
              </Button>
              <Button size="sm" onClick={() => void handleSave()} disabled={update.isPending}>
                {update.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                儲存
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {mode === 'edit' ? (
          <div className="space-y-2">
            <Tabs value={previewWhileEditing} onValueChange={(v) => setPreviewWhileEditing(v as 'edit' | 'preview')}>
              <TabsList>
                <TabsTrigger value="edit" className="text-xs"><Edit3 className="size-3" /> 編輯</TabsTrigger>
                <TabsTrigger value="preview" className="text-xs"><Eye className="size-3" /> 預覽</TabsTrigger>
              </TabsList>
            </Tabs>
            {previewWhileEditing === 'edit' ? (
              <Textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                placeholder="支援 Markdown：## 標題、- 清單、- [ ] checklist、表格、連結…"
                className="min-h-[280px] font-mono text-sm leading-relaxed"
              />
            ) : (
              <div className="rounded-md border bg-card p-4">
                {editValue.trim() ? (
                  <Markdown>{editValue}</Markdown>
                ) : (
                  <p className="text-sm text-muted-foreground">（預覽空白）</p>
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              字數 {editValue.length.toLocaleString()}{editValue.length > NOTES_SOFT_LIMIT ? ' · 超過軟上限，建議拆分' : ''}
            </p>
          </div>
        ) : hasNotes ? (
          <Markdown
            withAnchors
            onChange={canEdit ? (next) => void update.mutateAsync({ notes: next }) : undefined}
          >
            {itinerary!.notes!}
          </Markdown>
        ) : (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            尚無筆記。可以點上方「LLM 生成」、「編輯」開始寫，或直接貼 Markdown。
          </div>
        )}
        {lastUpdated ? (
          <p className="text-[11px] text-muted-foreground">
            最後更新：{formatTW(lastUpdated, 'yyyy/MM/dd HH:mm')}
          </p>
        ) : null}

        <TipsSection
          tips={tips}
          draft={tipsDraft}
          onDraftChange={setTipsDraft}
          onAdd={() => void handleAddTip()}
          onRemove={(i) => void handleRemoveTip(i)}
          generatedSummary={itinerary?.summary}
          disabled={update.isPending}
          readOnly={!canEdit}
        />
      </CardContent>

      <LLMNotesDialog
        open={llmOpen}
        onOpenChange={setLlmOpen}
        tripId={tripId}
        defaultPrompt={defaultPrompt(trip?.name)}
        onResult={applyLLMResult}
        loading={generate.isPending}
        runGenerate={(input) => generate.mutateAsync(input)}
      />
    </Card>
  );
}

function TipsSection({
  tips, draft, onDraftChange, onAdd, onRemove, generatedSummary, disabled, readOnly,
}: {
  tips: string[];
  draft: string;
  onDraftChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  generatedSummary?: string;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="text-sm font-medium">小撇步</div>
      {generatedSummary ? (
        <p className="text-xs text-muted-foreground">{generatedSummary}</p>
      ) : null}
      {tips.length > 0 ? (
        <ul className="space-y-1.5">
          {tips.map((t, i) => (
            <li
              key={`${i}-${t}`}
              className="flex items-start gap-2 rounded-md bg-background px-2.5 py-1.5 text-sm"
            >
              <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-primary" />
              <span className="min-w-0 flex-1 break-words">{t}</span>
              {!readOnly ? (
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label="移除"
                  className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Trash2 className="size-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{readOnly ? '尚無小撇步。' : '還沒有撇步，加一個吧。'}</p>
      )}
      {!readOnly ? (
        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder="例如：當地咖啡店推薦 Coffee Verse"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onAdd();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={onAdd} disabled={disabled || !draft.trim()}>
            <Plus className="size-4" /> 加入
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function LLMNotesDialog({
  open, onOpenChange, tripId, defaultPrompt: dp, onResult, loading, runGenerate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tripId: string;
  defaultPrompt: string;
  onResult: (markdown: string, action: 'replace' | 'append') => void;
  loading: boolean;
  runGenerate: (input: { tripId: string; prompt: string; tone?: string }) => Promise<string>;
}) {
  const [prompt, setPrompt] = useState(dp);
  const [tone, setTone] = useState('輕鬆、實用、條列式');
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setPrompt(dp);
    }
  }, [open, dp]);

  async function handleGenerate() {
    if (!prompt.trim()) return;
    try {
      const md = await runGenerate({ tripId, prompt: prompt.trim(), tone: tone.trim() || undefined });
      setResult(md);
    } catch (err) {
      console.error('[generateTripNotes]', err);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="LLM 生成旅程筆記"
      description="描述你想要產出的內容（行前準備、必買清單、口袋名單…），LLM 會根據旅程資訊產出 Markdown。"
      contentClassName="sm:max-w-xl"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {result ? (
            <>
              <Button variant="outline" onClick={() => setResult(null)} disabled={loading}>重來</Button>
              <Button variant="outline" onClick={() => onResult(result, 'append')} disabled={loading}>
                附加到筆記
              </Button>
              <Button onClick={() => onResult(result, 'replace')} disabled={loading}>
                取代整段筆記
              </Button>
            </>
          ) : (
            <Button onClick={() => void handleGenerate()} disabled={loading || !prompt.trim()}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              產生
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">寫作風格（tone）</label>
          <Input
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            placeholder="輕鬆、條列式"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Prompt</label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            placeholder="例如：幫我整理東京 5 天的行前必買清單與當地交通卡建議"
            className="font-mono text-sm"
          />
        </div>
        {result ? (
          <div className={cn('rounded-md border bg-card p-3 max-h-[40vh] overflow-y-auto')}>
            <Markdown>{result}</Markdown>
          </div>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}

function defaultPrompt(tripName?: string): string {
  return [
    '請幫我整理這趟' + (tripName ? `「${tripName}」` : '旅程') + '的筆記，包括：',
    '1. 行前準備清單（簽證 / 換匯 / 上網卡 / 行李重點）',
    '2. 當地交通與必備 App',
    '3. 各天行程上你會想推薦的補充景點 / 餐廳口袋名單',
    '4. 注意事項（治安、退稅、文化禁忌）',
    '輸出 Markdown，第二級標題分區。',
  ].join('\n');
}
