import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageCircleQuestion, Send, Sparkles } from 'lucide-react';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import { callAppsScript } from '@/lib/apps-script';
import { cn } from '@/lib/utils';
import { useAskStore } from '@/stores/ask-store';

const SUGGESTIONS = [
  '上個月餐飲花多少？',
  '今年到現在存了多少？',
  '最近三個月哪個類別漲最多？',
  '本月預算還剩多少？',
  '我的投資組合現在多少？',
  '這個月刷卡刷了多少？',
];

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  toolCalls?: { name: string }[];
}

interface AskResponse { answer?: string; toolCalls?: { name: string }[] }

export function AskFinanceDialog() {
  const { open, initialQuestion, closeAsk } = useAskStore();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuestion(initialQuestion);
      if (initialQuestion) void ask(initialQuestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuestion]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, busy]);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setTurns((prev) => [...prev, { role: 'user', text }]);
    setQuestion('');
    setBusy(true);
    try {
      const res = await callAppsScript<AskResponse>('askFinance', undefined, { question: text });
      if (!res.ok) throw new Error(res.error ?? '查詢失敗');
      const answer = typeof res.answer === 'string' ? res.answer : '（沒有回覆內容）';
      const toolCalls = Array.isArray(res.toolCalls) ? (res.toolCalls as { name: string }[]) : [];
      setTurns((prev) => [...prev, { role: 'assistant', text: answer, toolCalls }]);
    } catch (err) {
      console.error('[askFinance]', err);
      setTurns((prev) => [...prev, { role: 'assistant', text: `查詢失敗：${err instanceof Error ? err.message : '未知錯誤'}` }]);
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => { e.preventDefault(); void ask(question); }}
    >
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(question); }
        }}
        placeholder="問一個關於你帳目的問題…"
        rows={1}
        className="min-h-[2.75rem] flex-1 resize-none rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <Button type="submit" size="icon" disabled={busy || !question.trim()} aria-label="送出">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
      </Button>
    </form>
  );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => { if (!o) closeAsk(); }}
      title="問一下"
      description="用自然語言查帳目、預算、投資與淨值。數字來自你的資料，由 Claude 整理。"
      footer={footer}
      contentClassName="sm:max-w-lg"
    >
      <div ref={scrollRef} className="max-h-[50vh] min-h-[12rem] space-y-3 overflow-y-auto pr-1">
        {turns.length === 0 ? (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Sparkles className="size-3.5" /> 試試看：</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void ask(s)}
                  className="rounded-full border bg-card px-3 py-1.5 text-xs hover:bg-muted"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {turns.map((t, i) => (
          <div key={i} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cn(
              'max-w-[90%] rounded-2xl px-3 py-2 text-sm',
              t.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted',
            )}>
              {t.role === 'user' ? t.text : <Markdown className="prose-sm">{t.text}</Markdown>}
              {t.toolCalls && t.toolCalls.length > 0 ? (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  查了：{Array.from(new Set(t.toolCalls.map((c) => c.name))).join('、')}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {busy ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <MessageCircleQuestion className="size-3.5 animate-pulse" /> 正在查資料…
          </div>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}
