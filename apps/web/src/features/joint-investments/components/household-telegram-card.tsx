import { useState } from 'react';
import { BellRing, Check, Copy, ExternalLink, Loader2, Send, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useConfirm } from '@/components/ui/confirm';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useUpdateHousehold } from '@/features/household/hooks';
import {
  HOUSEHOLD_REPORT_DEFAULT, HOUSEHOLD_REPORT_FREQUENCY_LABEL, memberCan,
  type Household, type HouseholdReportFrequency, type HouseholdReportSettings,
} from '@/features/household/types';
import {
  useCreateTelegramLink, useMyTelegramLink, useSendHouseholdReport, useUnlinkTelegram,
} from '../hooks';
import type { TelegramLinkResult } from '../api';

interface HouseholdTelegramCardProps {
  household: Household;
}

/**
 * 共同帳本 × Telegram：
 * - 自己連結 / 解除；owner 可以替伴侶產生「加入 RMoney Telegram」的一次性連結
 * - 共同帳本獨立報告的頻率與內容（跟 owner 個人的每日 / 每週通知分開）
 */
export function HouseholdTelegramCard({ household }: HouseholdTelegramCardProps) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const amOwner = household.ownerId === myUid;
  const canEditReport = memberCan(household, myUid, 'canEditSettings');
  const { data: myLink, isLoading: linkLoading } = useMyTelegramLink();
  const createLink = useCreateTelegramLink();
  const unlink = useUnlinkTelegram();
  const sendNow = useSendHouseholdReport();
  const update = useUpdateHousehold();
  const confirm = useConfirm();
  const [links, setLinks] = useState<Record<string, TelegramLinkResult>>({});

  const report: HouseholdReportSettings = household.householdReport ?? HOUSEHOLD_REPORT_DEFAULT;
  const others = household.memberIds.filter((id) => id !== myUid);

  async function generate(forUid: string) {
    try {
      const r = await createLink.mutateAsync({ householdId: household.id, forUid: forUid === myUid ? undefined : forUid });
      setLinks((prev) => ({ ...prev, [forUid]: r }));
    } catch (err) {
      console.error('[createTelegramLink]', err);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('已複製連結');
    } catch {
      toast.error('複製失敗，請長按連結手動複製');
    }
  }

  async function handleUnlink(forUid: string) {
    const name = forUid === myUid ? '你' : (household.members[forUid]?.displayName ?? '對方');
    const ok = await confirm({ title: `解除${name}的 Telegram 連結？`, description: '之後不會再收到共同帳本報告，隨時可以重新連結。', confirmText: '解除' });
    if (!ok) return;
    try {
      await unlink.mutateAsync({ householdId: household.id, forUid: forUid === myUid ? undefined : forUid });
      toast.success('已解除');
    } catch (err) {
      console.error('[unlinkTelegram]', err);
    }
  }

  async function saveReport(patch: Partial<HouseholdReportSettings>) {
    try {
      await update.mutateAsync({ id: household.id, patch: { householdReport: { ...report, ...patch } } });
    } catch (err) {
      console.error('[saveHouseholdReport]', err);
    }
  }

  function linkBox(uid: string) {
    const r = links[uid];
    if (!r) return null;
    return (
      <div className="mt-2 space-y-2 rounded-md bg-background p-2">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate text-xs">{r.url}</code>
          <Button size="sm" variant="outline" onClick={() => void copy(r.url)}><Copy className="size-3.5" /> 複製</Button>
        </div>
        {uid === myUid ? (
          <Button asChild size="sm" className="w-full">
            <a href={r.url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3.5" /> 開啟 Telegram，按「Start」完成</a>
          </Button>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            傳給 {household.members[uid]?.displayName ?? '對方'}（LINE / 訊息），用手機點開後在 Telegram 按「Start」就完成。
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          {formatTW(r.expiresAt, 'M/d HH:mm')} 前有效、只能用一次；誰點開就會綁到這個帳號，請只傳給本人。
        </p>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><BellRing className="size-4" /> Telegram 通知</CardTitle>
        <p className="text-xs text-muted-foreground">連上 RMoney Telegram 就能收到共同帳本報告，也能在 Telegram 輸入 /report 隨時查共同支出與共同投資。</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium">我的 Telegram</p>
              {linkLoading ? <p className="text-xs text-muted-foreground">讀取中…</p> : myLink ? (
                <p className="text-xs text-muted-foreground">
                  已連結{myLink.username ? ` @${myLink.username}` : myLink.firstName ? ` ${myLink.firstName}` : ''}
                  {myLink.linkedAt ? ` · ${formatTW(myLink.linkedAt, 'yyyy/MM/dd')}` : ''}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {amOwner ? '還沒個別連結；報告會送到你原本的 RMoney Bot 對話' : '還沒連結'}
                </p>
              )}
            </div>
            {myLink ? (
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="gap-1"><Check className="size-3" /> 已連結</Badge>
                <Button size="sm" variant="ghost" onClick={() => void handleUnlink(myUid)} disabled={unlink.isPending}><Unlink className="size-3.5" /> 解除</Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => void generate(myUid)} disabled={createLink.isPending}>
                {createLink.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} 連結 Telegram
              </Button>
            )}
          </div>
          {!myLink ? linkBox(myUid) : null}
        </div>

        {amOwner && others.map((id) => {
          const linked = household.telegramLinked?.[id] === true;
          return (
            <div key={id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{household.members[id]?.displayName ?? '成員'} 的 Telegram</p>
                  <p className="text-xs text-muted-foreground">{linked ? '已連結，會一起收到共同帳本報告' : '還沒連結，產生加入連結傳給對方'}</p>
                </div>
                {linked ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="gap-1"><Check className="size-3" /> 已連結</Badge>
                    <Button size="sm" variant="ghost" onClick={() => void handleUnlink(id)} disabled={unlink.isPending}><Unlink className="size-3.5" /> 解除</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void generate(id)} disabled={createLink.isPending}>
                    {createLink.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} 產生加入連結
                  </Button>
                )}
              </div>
              {!linked ? linkBox(id) : null}
            </div>
          );
        })}

        <div className="space-y-3 rounded-lg border p-3">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>
              <span className="font-medium">共同帳本定期報告</span>
              <span className="block text-xs text-muted-foreground">發給每位已連結的成員；只含共同支出與共同投資，不含任何人的個人帳戶</span>
            </span>
            <Switch checked={report.enabled} onCheckedChange={(v) => void saveReport({ enabled: v })} disabled={!canEditReport || update.isPending} />
          </label>
          {report.enabled ? (
            <>
              <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="報告頻率">
                {(Object.keys(HOUSEHOLD_REPORT_FREQUENCY_LABEL) as HouseholdReportFrequency[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={report.frequency === f}
                    disabled={!canEditReport || update.isPending}
                    onClick={() => void saveReport({ frequency: f })}
                    className={cn(
                      'h-10 rounded-md border px-2 text-xs transition-colors disabled:opacity-60',
                      report.frequency === f ? 'border-primary bg-primary/5 font-medium' : 'hover:bg-muted/50',
                    )}
                  >
                    {HOUSEHOLD_REPORT_FREQUENCY_LABEL[f]}
                  </button>
                ))}
              </div>
              <label className="flex items-center justify-between gap-2 text-xs">
                <span>共同支出（本月合計、預算、誰欠誰、公基金）</span>
                <Switch checked={report.includeLedger} onCheckedChange={(v) => void saveReport({ includeLedger: v })} disabled={!canEditReport || update.isPending} />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs">
                <span>共同投資（市值、損益、各自持有、目標進度）</span>
                <Switch checked={report.includeInvestments} onCheckedChange={(v) => void saveReport({ includeInvestments: v })} disabled={!canEditReport || update.isPending} />
              </label>
            </>
          ) : null}
          {!canEditReport ? <p className="text-[11px] text-muted-foreground">報告設定由建立者管理。</p> : null}
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => sendNow.mutate(household.id)}
            disabled={sendNow.isPending || (!myLink && !amOwner)}
          >
            {sendNow.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} 立即傳一份給我
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
