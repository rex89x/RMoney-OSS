import { useMemo, useState } from 'react';
import { CheckCircle2, ClipboardCopy, ClipboardPaste, KeyRound, ShieldCheck, TriangleAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Textarea } from '@/components/ui/textarea';
import { formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import {
  CLAUDE_SCHEDULE_TIME,
  STOCK_INGEST_ENV_VAR,
  buildStockRadarPrompt,
  promptSymbolDiff,
  promptSyncState,
  type PromptSyncState,
} from '../claude-schedule';
import {
  useImportStockSentiment,
  useMarkStockPromptCopied,
  useRevokeStockIngestToken,
  useRotateStockIngestToken,
  useStockIngestStatus,
  useStockRadarConfig,
  useStockRadarUniverse,
} from '../hooks';
import { MARKET_LABELS } from '../options';
import type { StockRadarMarket, StockRadarRun } from '../types';

interface StockClaudeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  latest: Partial<Record<StockRadarMarket, StockRadarRun>>;
}

const MARKETS: StockRadarMarket[] = ['TW', 'US'];

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`已複製${label}`);
  } catch (error) {
    console.error('[copyText]', error);
    toast.error('無法存取剪貼簿，請手動選取複製');
  }
}

/** 股市雷達的 Claude 排程設定：推送 token、每個市場一份提示詞、手動貼上結果 */
export function StockClaudeDialog({ open, onOpenChange, latest }: StockClaudeDialogProps) {
  const confirm = useConfirm();
  const status = useStockIngestStatus(open);
  const config = useStockRadarConfig(open);
  const rotate = useRotateStockIngestToken();
  const revoke = useRevokeStockIngestToken();
  const markCopied = useMarkStockPromptCopied();
  const importSentiment = useImportStockSentiment();
  const [market, setMarket] = useState<StockRadarMarket>('TW');
  const [pasted, setPasted] = useState('');
  const newToken = rotate.data ?? null;

  const universe = useStockRadarUniverse(market, latest[market]);
  const symbols = universe.symbols;
  const current = symbols.map((item) => item.symbol);
  const copied = config.data?.promptSymbols[market];
  const state = promptSyncState(current, copied);
  const diff = promptSymbolDiff(current, copied);
  const prompt = useMemo(() => (open && symbols.length ? buildStockRadarPrompt(market, symbols) : ''), [open, market, symbols]);

  async function handleCopyPrompt() {
    if (!prompt) return;
    await copyText(prompt, `${MARKET_LABELS[market]}提示詞`);
    markCopied.mutate({ market, symbols: current });
  }

  async function handleRotate() {
    if (status.data?.configured) {
      const accepted = await confirm({
        title: '產生新的推送 token？',
        description: '舊 token 會立即失效，需要把新 token 更新到兩個 Claude 排程的環境變數。',
        confirmText: '產生',
      });
      if (!accepted) return;
    }
    rotate.mutate();
  }

  async function handleRevoke() {
    const accepted = await confirm({
      title: '撤銷推送 token？',
      description: 'Claude 排程將無法再寫入輿情；量化評估與手動貼上結果不受影響。',
      confirmText: '撤銷',
    });
    if (!accepted) return;
    rotate.reset();
    revoke.mutate();
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      // 明文 token 只在這次開啟期間顯示，關掉就從記憶體清掉
      rotate.reset();
      importSentiment.reset();
    }
    onOpenChange(nextOpen);
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Claude 排程：盤前輿情"
      description="讓 Claude 排程每天上網整理新聞與輿情並推送，與量化因子合成買賣建議。"
      contentClassName="sm:max-w-2xl"
    >
      <div className="space-y-5 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>產生推送 token，存成 Claude 雲端環境的環境變數 <code className="rounded bg-muted px-1">{STOCK_INGEST_ENV_VAR}</code>，並允許連線 script.google.com、script.googleusercontent.com。</li>
          <li>台股、美股各複製一份提示詞，各建一個 Claude 每日排程：台股 {CLAUDE_SCHEDULE_TIME.TW}、美股 {CLAUDE_SCHEDULE_TIME.US}（台北時間）。</li>
          <li>持股或自選股改了，回來重新複製該市場提示詞（清單會即時更新，並提醒哪些代號有變）。</li>
        </ol>

        <section className="space-y-3 rounded-xl border p-3">
          <div className="flex items-center gap-2 font-medium"><KeyRound className="size-4" /> 推送 token</div>
          {status.isLoading ? (
            <p className="text-xs text-muted-foreground">讀取中…</p>
          ) : status.data?.configured ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <Badge variant="success">已啟用</Badge>
                {!status.data.ownedByCaller ? <Badge variant="secondary">由其他帳號建立</Badge> : null}
              </div>
              {status.data.createdAt ? <div>建立：{formatTW(status.data.createdAt, 'yyyy/MM/dd HH:mm')}</div> : null}
              <div>最後推送：{status.data.lastUsedAt ? formatTW(status.data.lastUsedAt, 'yyyy/MM/dd HH:mm') : '尚未使用'}</div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">尚未設定。未設定時 Claude 排程無法寫入，仍可手動貼上結果。</p>
          )}

          {newToken ? (
            <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-warning">
                <TriangleAlert className="size-3.5" /> 只會顯示這一次，請立刻存到 Claude 環境變數
              </div>
              <div className="flex gap-2">
                <Input readOnly value={newToken} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
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
              <Button type="button" size="sm" variant="outline" onClick={() => void handleRevoke()} disabled={revoke.isPending}>
                撤銷
              </Button>
            ) : null}
          </div>
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            Token 只能寫入追蹤清單內代號的輿情評分，不能讀取任何資料；提示詞只有代號與名稱，不含股數、成本與占比。伺服器只保存雜湊值，外洩時重新產生即可。
          </p>
        </section>

        <section className="space-y-3 rounded-xl border p-3">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            <ClipboardCopy className="size-4" /> 提示詞
            <div className="ml-auto flex overflow-hidden rounded-full border text-xs font-normal" role="radiogroup" aria-label="市場">
              {MARKETS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={market === value}
                  onClick={() => setMarket(value)}
                  className={cn('px-3 py-1', market === value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                >
                  {MARKET_LABELS[value]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <SyncBadge state={state} />
            <span className="text-muted-foreground">
              {universe.isLoading ? '讀取持股與自選股…' : `${current.length} 檔（目前的持股 + 自選股）`}
              {config.data?.promptCopiedAt[market] ? ` · 上次複製 ${formatTW(config.data.promptCopiedAt[market] ?? new Date(), 'MM/dd HH:mm')}` : ''}
            </span>
          </div>
          {state === 'stale' ? (
            <p className="text-xs text-warning">
              {diff.added.length ? `新增：${diff.added.join('、')}；` : ''}
              {diff.removed.length ? `移除：${diff.removed.join('、')}` : ''}
              。新增的代號在重新複製前不會有輿情。
            </p>
          ) : null}
          {universe.error ? (
            <p className="text-xs text-destructive">讀取持股或自選股失敗，請重新整理頁面。</p>
          ) : null}
          {symbols.length ? (
            <>
              <Textarea readOnly value={prompt} className="h-40 font-mono text-[11px]" />
              <Button type="button" size="sm" variant="outline" disabled={markCopied.isPending} onClick={() => void handleCopyPrompt()}>
                <ClipboardCopy className="size-4" /> 複製{MARKET_LABELS[market]}提示詞
              </Button>
            </>
          ) : (
            <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              {universe.isLoading ? '讀取中…' : `目前沒有${MARKET_LABELS[market]}持股或自選股。到「投資」加入後，這裡會自動出現。`}
            </p>
          )}
        </section>

        <section className="space-y-3 rounded-xl border p-3">
          <div className="flex items-center gap-2 font-medium"><ClipboardPaste className="size-4" /> 貼上結果（手動備援，{MARKET_LABELS[market]}）</div>
          <p className="text-xs text-muted-foreground">
            排程無法連網推送時，Claude 會在回覆中輸出 JSON；整段貼到這裡即可，驗證規則與自動推送相同。
          </p>
          <Textarea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder='{"market":"TW","marketView":{...},"items":[...]}'
            className="h-28 font-mono text-[11px]"
          />
          <Button
            type="button"
            size="sm"
            disabled={!pasted.trim() || importSentiment.isPending}
            onClick={() => importSentiment.mutate({ text: pasted, market }, { onSuccess: () => setPasted('') })}
          >
            <Upload className="size-4" /> {importSentiment.isPending ? '匯入中…' : '匯入'}
          </Button>
          {importSentiment.data && importSentiment.data.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {importSentiment.data.map((outcome, index) => (
                <li key={`${outcome.symbol ?? 'row'}-${index}`} className="flex items-start gap-1.5">
                  {outcome.ok
                    ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                    : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                  <span>
                    {outcome.symbol ?? `第 ${index + 1} 筆`}：
                    {outcome.ok ? `已匯入${outcome.warning ? `（${outcome.warning}）` : ''}` : outcome.error ?? '被拒收'}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </ResponsiveDialog>
  );
}

const SYNC_LABELS: Record<PromptSyncState, string> = {
  synced: '排程清單已同步',
  stale: '追蹤清單已改，需重新複製',
  new: '尚未複製到排程',
  empty: '沒有標的',
};

function SyncBadge({ state }: { state: PromptSyncState }) {
  const variant = state === 'synced' ? 'success' : state === 'empty' ? 'secondary' : 'warning';
  return <Badge variant={variant} className="shrink-0">{SYNC_LABELS[state]}</Badge>;
}
