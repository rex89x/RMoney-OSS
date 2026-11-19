import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, Copy, Edit3, ListTree, Maximize2, Minimize2, Printer, Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Markdown, extractHeadings, type MarkdownHeading } from '@/components/ui/markdown';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { ErrorBoundary } from '@/components/error-boundary';
import { cn } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import {
  useGenerateTripNotes,
  useItinerary,
  useUpdateItineraryNotes,
} from '@/features/itinerary/hooks';
import { useTrip } from '../hooks';

export function TripNotesReaderPage() {
  const { id = '' } = useParams();
  const { data: trip } = useTrip(id);
  const { data: itinerary } = useItinerary(id);
  const update = useUpdateItineraryNotes(id);
  const generate = useGenerateTripNotes();

  const notes = itinerary?.notes ?? '';
  const headings = useMemo(() => extractHeadings(notes), [notes]);

  const [tocOpen, setTocOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [llmOpen, setLlmOpen] = useState(false);
  const activeId = useScrollSpy(headings.map((h) => h.id));

  function handleChecklistChange(next: string) {
    void update.mutateAsync({ notes: next });
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(notes);
      toast.success('已複製 Markdown 到剪貼簿');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '複製失敗');
    }
  }

  async function handlePrint() {
    if (typeof window !== 'undefined') window.print();
  }

  return (
    <ErrorBoundary scope="TripNotesReader">
      <div
        className={cn(
          'space-y-3',
          focusMode && 'mx-auto max-w-3xl',
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <div className="min-w-0">
            <Link to={`/trips/${id}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <ChevronLeft className="size-3.5" /> 回到旅程
            </Link>
            <h1 className="mt-1 truncate text-xl font-semibold">
              {trip?.name ?? '旅程筆記'}
            </h1>
            {itinerary?.notesUpdatedAt ? (
              <p className="text-[11px] text-muted-foreground">
                最後更新：{formatTW(itinerary.notesUpdatedAt, 'yyyy/MM/dd HH:mm')}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="lg:hidden"
              onClick={() => setTocOpen(true)}
              disabled={headings.length === 0}
            >
              <ListTree className="size-4" /> 目錄
            </Button>
            <Button size="sm" variant="outline" onClick={() => setLlmOpen(true)}>
              <Sparkles className="size-4" /> 生成
            </Button>
            <Button size="sm" variant="outline" onClick={() => void handleCopy()} disabled={!notes}>
              <Copy className="size-4" /> 複製
            </Button>
            <Button size="sm" variant="outline" onClick={() => void handlePrint()} disabled={!notes}>
              <Printer className="size-4" /> 列印
            </Button>
            <Button size="sm" variant="outline" onClick={() => setFocusMode((v) => !v)}>
              {focusMode ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              {focusMode ? '退出專注' : '專注閱讀'}
            </Button>
            <Button asChild size="sm">
              <Link to={`/trips/${id}?tab=notes`}>
                <Edit3 className="size-4" /> 編輯
              </Link>
            </Button>
          </div>
        </div>

        {!notes ? (
          <Card>
            <CardContent className="space-y-3 py-12 text-center">
              <ListTree className="mx-auto size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">這趟旅程還沒有筆記。</p>
              <Button onClick={() => setLlmOpen(true)}>
                <Sparkles className="size-4" /> 用 LLM 生成
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div
            className={cn(
              'gap-6',
              focusMode ? 'flex flex-col' : 'lg:grid lg:grid-cols-[1fr_240px]',
            )}
          >
            <Card>
              <CardContent className="p-4 sm:p-6">
                <Markdown withAnchors onChange={handleChecklistChange}>
                  {notes}
                </Markdown>
              </CardContent>
            </Card>
            {!focusMode && headings.length > 0 ? (
              <aside className="hidden lg:block print:hidden">
                <div className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-lg border bg-card p-3">
                  <div className="mb-2 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <ListTree className="size-3.5" /> 目錄
                  </div>
                  <TocList headings={headings} activeId={activeId} onSelect={() => undefined} />
                </div>
              </aside>
            ) : null}
          </div>
        )}

        <ResponsiveDialog
          open={tocOpen}
          onOpenChange={setTocOpen}
          title="目錄"
          contentClassName="sm:max-w-sm"
        >
          <TocList
            headings={headings}
            activeId={activeId}
            onSelect={() => setTocOpen(false)}
            mobile
          />
        </ResponsiveDialog>

        <LLMNotesReaderDialog
          open={llmOpen}
          onOpenChange={setLlmOpen}
          tripId={id}
          tripName={trip?.name}
          loading={generate.isPending}
          existing={notes}
          runGenerate={(input) => generate.mutateAsync(input)}
          onApply={(next) => void update.mutateAsync({ notes: next })}
        />
      </div>
    </ErrorBoundary>
  );
}

function TocList({
  headings, activeId, onSelect, mobile,
}: {
  headings: MarkdownHeading[];
  activeId: string | null;
  onSelect: () => void;
  mobile?: boolean;
}) {
  if (headings.length === 0) {
    return <p className="text-xs text-muted-foreground">這份筆記還沒有 ## 標題。</p>;
  }
  return (
    <ul className="space-y-1 text-sm">
      {headings.map((h) => (
        <li key={h.id} style={{ paddingLeft: (h.level - 1) * 10 }}>
          <a
            href={`#${h.id}`}
            onClick={(e) => {
              e.preventDefault();
              const el = document.getElementById(h.id);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                history.replaceState(null, '', `#${h.id}`);
              }
              onSelect();
            }}
            className={cn(
              'flex items-center gap-1 truncate rounded px-1.5 py-1 text-xs transition-colors',
              h.id === activeId
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              mobile && 'text-sm',
            )}
          >
            {h.level <= 2 ? null : <ChevronRight className="size-3 shrink-0 opacity-50" />}
            <span className="truncate">{h.text}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** 監聽哪個 heading 在視窗中（最靠近頂部的） */
function useScrollSpy(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (ids.length === 0) {
      setActive(null);
      return;
    }
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        let current: string | null = null;
        for (const id of ids) {
          const el = document.getElementById(id);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          if (rect.top - 96 <= 0) current = id;
          else break;
        }
        setActive(current ?? ids[0] ?? null);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [ids]);
  return active;
}

function LLMNotesReaderDialog({
  open, onOpenChange, tripId, tripName, existing, loading, runGenerate, onApply,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tripId: string;
  tripName?: string;
  existing: string;
  loading: boolean;
  runGenerate: (input: { tripId: string; prompt: string; tone?: string }) => Promise<string>;
  onApply: (next: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [tone, setTone] = useState('輕鬆、實用、條列式');
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setPrompt(defaultPrompt(tripName));
    }
  }, [open, tripName]);

  async function handleGenerate() {
    if (!prompt.trim()) return;
    try {
      const md = await runGenerate({ tripId, prompt: prompt.trim(), tone: tone.trim() || undefined });
      setResult(md);
    } catch (err) {
      console.error('[generateTripNotes]', err);
    }
  }

  function apply(action: 'replace' | 'append') {
    if (!result) return;
    const next = action === 'replace'
      ? result
      : `${existing ? `${existing}\n\n---\n\n` : ''}${result}`;
    onApply(next);
    toast.success(action === 'replace' ? '已取代為 LLM 生成內容' : '已附加到筆記末尾');
    onOpenChange(false);
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="LLM 生成旅程筆記"
      description="生成後可選擇附加到結尾或取代整段。"
      contentClassName="sm:max-w-xl"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {result ? (
            <>
              <Button variant="outline" onClick={() => setResult(null)} disabled={loading}>重來</Button>
              <Button variant="outline" onClick={() => apply('append')} disabled={loading}>
                附加到筆記
              </Button>
              <Button onClick={() => apply('replace')} disabled={loading}>
                取代整段筆記
              </Button>
            </>
          ) : (
            <Button onClick={() => void handleGenerate()} disabled={loading || !prompt.trim()}>
              <Sparkles className="size-4" /> {loading ? '產生中…' : '產生'}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">寫作風格</label>
          <input
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
          />
        </div>
        {result ? (
          <div className="max-h-[40vh] overflow-y-auto rounded-md border bg-card p-3">
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
