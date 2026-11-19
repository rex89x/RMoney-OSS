import { useMemo, useState } from 'react';
import { ClipboardCopy, ClipboardPaste, KeyRound, ShieldCheck, TriangleAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Textarea } from '@/components/ui/textarea';
import { formatTW } from '@/lib/tz';
import { TAIFEX_CLAUDE_SCHEDULES, TAIFEX_INGEST_ENV_VAR, buildTaifexPrompt } from '../claude-schedule';
import {
  useImportTaifexSentiment,
  useRevokeTaifexIngestToken,
  useRotateTaifexIngestToken,
  useTaifexIngestStatus,
} from '../hooks';

interface TaifexClaudeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`已複製${label}`);
  } catch (error) {
    console.error('[copyText]', error);
    toast.error('複製失敗，請手動選取');
  }
}

/** Claude 排程：token 管理、複製提示詞、手動貼上結果 */
export function TaifexClaudeDialog({ open, onOpenChange }: TaifexClaudeDialogProps) {
  const confirm = useConfirm();
  const status = useTaifexIngestStatus(open);
  const rotate = useRotateTaifexIngestToken();
  const revoke = useRevokeTaifexIngestToken();
  const importSentiment = useImportTaifexSentiment();
  const [pasted, setPasted] = useState('');
  const prompt = useMemo(() => (open ? buildTaifexPrompt() : ''), [open]);
  const newToken = rotate.data ?? null;

  async function handleRotate() {
    if (status.data?.configured) {
      const ok = await confirm({ title: '產生新的推送 token？', description: '舊 token 會立即失效，需要更新 Claude 排程的環境變數。', confirmText: '產生' });
      if (!ok) return;
    }
    rotate.mutate();
  }

  async function handleRevoke() {
    const ok = await confirm({ title: '撤銷推送 token？', description: 'Claude 排程將無法再寫入輿情；手動貼上不受影響。', confirmText: '撤銷' });
    if (!ok) return;
    rotate.reset();
    revoke.mutate();
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      // 明文 token 只在這次開啟期間顯示
      rotate.reset();
      importSentiment.reset();
    }
    onOpenChange(next);
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Claude 排程：台指期輿情"
      description="讓 Claude 每天上網整理隔夜美股、外資動向、總經事件與市場情緒，推送後與技術面合成訊號。"
      contentClassName="sm:max-w-2xl"
    >
      <div className="space-y-5 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>產生推送 token，存成 Claude 雲端環境的環境變數 <code className="rounded bg-muted px-1">{TAIFEX_INGEST_ENV_VAR}</code>，並允許連線 script.google.com、script.googleusercontent.com。</li>
          <li>複製提示詞，建立兩個 Claude 每日排程：{TAIFEX_CLAUDE_SCHEDULES.join('、')}（台北時間）。</li>
          <li>輿情最多影響 ±0.2 分；重大事件只會暫停新開倉、盤前強烈反向只會取消待成交單，不會自己開倉。</li>
        </ol>

        <section className="space-y-3 rounded-xl border p-3">
          <div className="flex items-center gap-2 font-medium"><KeyRound className="size-4" aria-hidden /> 推送 token</div>
          {status.isLoading ? (
            <p className="text-xs text-muted-foreground">讀取中…</p>
          ) : status.data?.configured ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              <Badge variant="success">已啟用</Badge>
              {status.data.createdAt ? <div>建立：{formatTW(status.data.createdAt, 'yyyy/MM/dd HH:mm')}</div> : null}
              <div>最後推送：{status.data.lastUsedAt ? formatTW(status.data.lastUsedAt, 'yyyy/MM/dd HH:mm') : '尚未使用'}</div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">尚未設定。未設定時仍可手動貼上結果。</p>
          )}
          {newToken ? (
            <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-warning">
                <TriangleAlert className="size-3.5" aria-hidden /> 只會顯示這一次，請立刻存到 Claude 環境變數
              </div>
              <div className="flex gap-2">
                <Input readOnly value={newToken} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" size="sm" variant="outline" onClick={() => void copyText(newToken, ' token')}>
                  <ClipboardCopy className="size-4" /> 複製
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void handleRotate()} disabled={rotate.isPending}>
              <KeyRound className="size-4" /> {status.data?.configured ? '重新產生 token' : '產生 token'}
            </Button>
            {status.data?.configured ? (
              <Button type="button" size="sm" variant="outline" onClick={() => void handleRevoke()} disabled={revoke.isPending}>撤銷</Button>
            ) : null}
          </div>
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Token 只能寫入當天輿情，不能讀取任何資料；提示詞不含帳戶、部位或資金。伺服器只保存雜湊值，外洩時重新產生即可。
          </p>
        </section>

        <section className="space-y-3 rounded-xl border p-3">
          <div className="flex items-center gap-2 font-medium"><ClipboardCopy className="size-4" aria-hidden /> 提示詞</div>
          <Textarea readOnly value={prompt} className="h-40 font-mono text-[11px]" />
          <Button type="button" size="sm" variant="outline" onClick={() => void copyText(prompt, '提示詞')}>
            <ClipboardCopy className="size-4" /> 複製提示詞
          </Button>
        </section>

        <section className="space-y-3 rounded-xl border p-3">
          <div className="flex items-center gap-2 font-medium"><ClipboardPaste className="size-4" aria-hidden /> 貼上結果（手動備援）</div>
          <p className="text-xs text-muted-foreground">排程無法推送時，Claude 會在回覆中輸出 JSON；整段貼到這裡，驗證規則與自動推送相同。</p>
          <Textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder='{"overall":{...},"drivers":[...],"events":[...]}'
            className="h-28 font-mono text-[11px]"
          />
          <Button
            type="button"
            size="sm"
            disabled={!pasted.trim() || importSentiment.isPending}
            onClick={() => importSentiment.mutate(pasted, { onSuccess: () => setPasted('') })}
          >
            <Upload className="size-4" /> {importSentiment.isPending ? '匯入中…' : '匯入'}
          </Button>
        </section>
      </div>
    </ResponsiveDialog>
  );
}
