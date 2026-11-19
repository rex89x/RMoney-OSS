import { useMemo, useState } from 'react';
import { CheckCircle2, ClipboardCopy, ClipboardPaste, KeyRound, Plus, ShieldCheck, TriangleAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatTW } from '@/lib/tz';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/utils';
import { CLAUDE_PUSH_BATCH_SIZE, FLIGHT_INGEST_ENV_VAR, type ClaudePromptState } from '../claude-schedule';
import {
  useClaudeSchedulePrompt,
  useClaudeWatchStatuses,
  useFlightIngestStatus,
  useImportFlightPrices,
  useMarkClaudePromptCopied,
  useRevokeFlightIngestToken,
  useRotateFlightIngestToken,
  useUpdateFlightWatch,
} from '../hooks';
import { DEFAULT_CLAUDE_GROUP_LABEL, TRIP_TYPE_LABELS, claudeGroupLabel, flightWatchTitle } from '../options';

/** Radix Select 不接受空字串 value，預設群組用這個代號 */
const DEFAULT_GROUP_VALUE = '__default';
import type { FlightWatch } from '../types';

interface ClaudeScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  watches: FlightWatch[];
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`已複製${label}`);
  } catch (error) {
    console.error('[copyText]', error);
    toast.error('無法存取剪貼簿，請手動選取複製');
  }
}

export function ClaudeScheduleDialog({ open, onOpenChange, watches }: ClaudeScheduleDialogProps) {
  const confirm = useConfirm();
  // 推送 token 是整個 Apps Script 共用一把（Script Properties），只有 owner 能產生 / 撤銷；
  // 共同帳本伴侶（member）用「手動貼上 Claude 結果」更新自己的航線。
  const { isMember } = useAuth();
  const status = useFlightIngestStatus(open && !isMember);
  const rotate = useRotateFlightIngestToken();
  const revoke = useRevokeFlightIngestToken();
  const statuses = useClaudeWatchStatuses(watches);
  const markCopied = useMarkClaudePromptCopied();
  const importPrices = useImportFlightPrices();
  const [pasted, setPasted] = useState('');
  const update = useUpdateFlightWatch();
  // 一個群組 = 一個 Claude 排程任務。群組名稱存在每條航線的 claudeGroup；剛新增、還沒有航線的群組先放在本地 state
  const [draftGroups, setDraftGroups] = useState<string[]>([]);
  const [activeGroup, setActiveGroup] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const groups = useMemo(() => {
    const names = new Set<string>(['']);
    (statuses.data ?? []).forEach((item) => names.add(item.watch.claudeGroup.trim()));
    draftGroups.forEach((name) => names.add(name));
    return [...names].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [statuses.data, draftGroups]);
  const groupStatuses = (statuses.data ?? []).filter((item) => item.watch.claudeGroup.trim() === activeGroup);
  const selected = groupStatuses.filter((item) => item.state !== 'excluded').map((item) => item.watch);
  const prompt = useClaudeSchedulePrompt(selected, activeGroup, open);
  const newToken = rotate.data ?? null;

  function addGroup() {
    const name = newGroup.trim().slice(0, 20);
    if (!name) return;
    if (!groups.includes(name)) setDraftGroups((current) => [...current, name]);
    setActiveGroup(name);
    setNewGroup('');
  }

  function moveWatch(watch: FlightWatch, group: string) {
    update.mutate({ id: watch.id, patch: { claudeGroup: group } });
  }

  async function handleCopyPrompt() {
    if (!prompt.data) return;
    await copyText(prompt.data, '排程提示詞');
    markCopied.mutate(selected);
  }

  async function handleRotate() {
    if (status.data?.configured) {
      const accepted = await confirm({
        title: '產生新的推送 token？',
        description: '舊 token 會立即失效，需要把新 token 更新到 Claude 排程的環境變數。',
        confirmText: '產生',
      });
      if (!accepted) return;
    }
    rotate.mutate();
  }

  async function handleRevoke() {
    const accepted = await confirm({
      title: '撤銷推送 token？',
      description: 'Claude 排程將無法再寫入票價；手動貼上結果不受影響。',
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
      importPrices.reset();
      setDraftGroups([]);
    }
    onOpenChange(nextOpen);
  }

  const watchById = new Map(watches.map((watch) => [watch.id, watch]));

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Claude 排程查價"
      description="讓 Claude 排程上網查價後推送結果，不需要另外付費的票價 API。"
      contentClassName="sm:max-w-2xl"
    >
      <div className="space-y-5 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>把要追蹤的航線「票價資料來源」設為 Claude 排程推送。</li>
          <li>產生推送 token，存成 Claude 雲端環境的環境變數 <code className="rounded bg-muted px-1">{FLIGHT_INGEST_ENV_VAR}</code>，並允許連線 script.google.com、script.googleusercontent.com。</li>
          <li>選一個排程群組、複製提示詞，在 Claude 建立每日排程任務（一個群組一個任務）。航線條件或群組改了要重新複製。</li>
        </ol>

        {isMember ? (
          <section className="space-y-1 rounded-xl border p-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground"><KeyRound className="size-4" /> 推送 token</div>
            <p>自動推送的 token 由 owner 管理。你可以照樣複製提示詞，請 Claude 查完價後把結果貼到下方「手動貼上結果」更新自己的航線。</p>
          </section>
        ) : (
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
              <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
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
              Token 只能寫入「Claude 排程推送」且啟用中的航線票價，不能讀取任何資料；伺服器只保存雜湊值，外洩時重新產生即可讓舊的失效。
            </p>
          </section>
        )}

        <section className="space-y-3 rounded-xl border p-3">
          <div className="flex items-center gap-2 font-medium"><ClipboardCopy className="size-4" /> 排程群組與提示詞</div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            一個群組對應一個 Claude 排程任務（例如日本線、歐洲線分開，查價比較快也比較準）。新增航線預設在「{DEFAULT_CLAUDE_GROUP_LABEL}」，可隨時移到其他群組；移動或改條件後，該群組的提示詞要重新複製。推送會自動每 {CLAUDE_PUSH_BATCH_SIZE} 條分一批。
          </p>
          {statuses.isLoading ? (
            <p className="text-xs text-muted-foreground">讀取中…</p>
          ) : (statuses.data ?? []).length === 0 ? (
            <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              目前沒有資料來源為 Claude 排程的航線，所以還不會產生提示詞。到「航線」分頁編輯航線，把「掃描方式」改為 Claude 排程推送並儲存。
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Claude 排程群組">
                {groups.map((group) => {
                  const items = (statuses.data ?? []).filter((item) => item.watch.claudeGroup.trim() === group);
                  const pending = items.filter((item) => item.state === 'stale' || item.state === 'new').length;
                  return (
                    <button
                      key={group || '__default'}
                      type="button"
                      role="tab"
                      aria-selected={activeGroup === group}
                      onClick={() => setActiveGroup(group)}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${activeGroup === group ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                    >
                      {claudeGroupLabel(group)} · {items.length}
                      {pending > 0 ? <span className="rounded-full bg-warning px-1.5 text-[10px] text-warning-foreground">{pending}</span> : null}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <Input
                  value={newGroup}
                  onChange={(event) => setNewGroup(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addGroup();
                    }
                  }}
                  maxLength={20}
                  placeholder="新增群組，例：日本線"
                  className="h-8 text-xs"
                />
                <Button type="button" size="sm" variant="outline" onClick={addGroup} disabled={!newGroup.trim()}>
                  <Plus className="size-4" /> 新增
                </Button>
              </div>

              {groupStatuses.length === 0 ? (
                <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                  這個群組還沒有航線。從其他群組把航線移過來，或在航線表單選擇這個群組。
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {groupStatuses.map((item) => (
                    <li key={item.watch.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-xs">
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {flightWatchTitle(item.watch)}
                        <span className="ml-1 font-normal text-muted-foreground">{TRIP_TYPE_LABELS[item.watch.tripType]}</span>
                      </span>
                      <PromptStateBadge state={item.state} reason={item.reason} />
                      <Select value={item.watch.claudeGroup.trim() || DEFAULT_GROUP_VALUE} onValueChange={(value) => moveWatch(item.watch, value === DEFAULT_GROUP_VALUE ? '' : value)}>
                        <SelectTrigger className="h-7 w-28 text-xs" aria-label="移到群組"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {groups.map((group) => (
                            <SelectItem key={group || '__default'} value={group || DEFAULT_GROUP_VALUE}>{claudeGroupLabel(group)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </li>
                  ))}
                </ul>
              )}

              {selected.length > 0 ? (
                <>
                  <Textarea readOnly value={prompt.data ?? '產生中…'} className="h-40 font-mono text-[11px]" />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!prompt.data || markCopied.isPending}
                    onClick={() => void handleCopyPrompt()}
                  >
                    <ClipboardCopy className="size-4" /> 複製「{claudeGroupLabel(activeGroup)}」提示詞
                  </Button>
                </>
              ) : groupStatuses.length > 0 ? (
                <p className="text-xs text-muted-foreground">這個群組的航線都已暫停或過期，不會產生提示詞。</p>
              ) : null}
            </>
          )}
        </section>

        <section className="space-y-3 rounded-xl border p-3">
          <div className="flex items-center gap-2 font-medium"><ClipboardPaste className="size-4" /> 貼上結果（手動備援）</div>
          <p className="text-xs text-muted-foreground">
            排程無法連網推送時，Claude 會在回覆中輸出 JSON；整段貼到這裡即可，驗證規則與自動推送相同。
          </p>
          <Textarea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder='{"schemaVersion":1,"results":[...]}'
            className="h-28 font-mono text-[11px]"
          />
          <Button
            type="button"
            size="sm"
            disabled={!pasted.trim() || importPrices.isPending}
            onClick={() => importPrices.mutate(pasted, { onSuccess: () => setPasted('') })}
          >
            <Upload className="size-4" /> {importPrices.isPending ? '匯入中…' : '匯入'}
          </Button>
          {importPrices.data && importPrices.data.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {importPrices.data.map((outcome, index) => {
                const watch = watchById.get(outcome.watchId);
                const label = watch ? flightWatchTitle(watch) : outcome.watchId || `第 ${index + 1} 筆`;
                return (
                  <li key={`${outcome.watchId}-${index}`} className="flex items-start gap-1.5">
                    {outcome.ok
                      ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                      : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                    <span>
                      {label}：
                      {outcome.ok
                        ? `已更新，較低價 ${formatCurrency(outcome.minPriceTWD ?? 0)}${outcome.warning ? '（價格異常偏低，已標為低可信度）' : ''}`
                        : outcome.error ?? '被拒收'}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      </div>
    </ResponsiveDialog>
  );
}

const PROMPT_STATE_LABELS: Record<ClaudePromptState, string> = {
  synced: '已在排程',
  stale: '條件已改，需重新複製',
  new: '尚未加入排程',
  excluded: '不會納入',
};

function PromptStateBadge({ state, reason }: { state: ClaudePromptState; reason: string | null }) {
  const variant = state === 'synced' ? 'success' : state === 'excluded' ? 'secondary' : 'warning';
  return (
    <Badge variant={variant} className="shrink-0">
      {PROMPT_STATE_LABELS[state]}{state === 'excluded' && reason ? `：${reason}` : ''}
    </Badge>
  );
}
