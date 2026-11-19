import { useState } from 'react';
import { CalendarClock, Plus, Repeat, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { useConfirm } from '@/components/ui/confirm';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, cn } from '@/lib/utils';
import { formatTW, startOfTWDay } from '@/lib/tz';
import { useAuth } from '@/hooks/use-auth';
import { AccountSelect, useAccounts } from '@/features/accounts';
import {
  useDeleteSubscription, useDetectedSubscriptions, useLinkSubscriptionAutoPost, useMonthlySubscriptionTotal,
  useSubscriptions, useToggleSubscription, useUnlinkSubscriptionAutoPost, useUpsertSubscription,
} from '../hooks';
import {
  CYCLE_LABEL, monthlyAmountTWD, type Subscription, type SubscriptionCycle,
} from '../types';

export function SubscriptionsPanel() {
  return (
    <div className="space-y-4">
      <ManagedSubscriptions />
      <DetectedFromTransactions />
    </div>
  );
}

function ManagedSubscriptions() {
  const { data: subs = [], isLoading } = useSubscriptions();
  const { total } = useMonthlySubscriptionTotal();
  const upsert = useUpsertSubscription();
  const toggle = useToggleSubscription();
  const del = useDeleteSubscription();
  const link = useLinkSubscriptionAutoPost();
  const unlink = useUnlinkSubscriptionAutoPost();
  const confirm = useConfirm();
  const { user } = useAuth();
  const { data: accounts = [] } = useAccounts();
  const payAccounts = accounts.filter((a) => a.active !== false && !a.archivedAt
    && ['cash', 'bank', 'credit_card', 'e_wallet_balance'].includes(a.type));
  const [editing, setEditing] = useState<Subscription | null>(null);
  // 「自動入帳」設定對話框
  const [linking, setLinking] = useState<Subscription | null>(null);
  const [linkAccountId, setLinkAccountId] = useState('');
  const [linkDate, setLinkDate] = useState<Date | null>(null);

  function startLink(s: Subscription) {
    setLinking(s);
    const byPm = payAccounts.find((a) => s.paymentMethod && (a.name === s.paymentMethod || a.legacyPaymentMethod === s.paymentMethod));
    setLinkAccountId(byPm?.id ?? '');
    setLinkDate(s.nextChargeDate ?? startOfTWDay(new Date()));
  }

  async function confirmLink() {
    if (!linking || !user || !linkDate) return;
    try {
      await link.mutateAsync({
        subscription: linking,
        ownerUid: user.uid,
        account: payAccounts.find((a) => a.id === linkAccountId) ?? null,
        firstChargeDate: linkDate,
      });
      toast.success(`${linking.name} 已設定自動入帳，${formatTW(linkDate, 'MM/dd')} 起每期自動記一筆`);
      setLinking(null);
    } catch (err) {
      console.error('[subscriptionLink]', err);
      toast.error(err instanceof Error ? err.message : '設定自動入帳失敗');
    }
  }

  async function handleUnlink(s: Subscription) {
    const ok = await confirm({
      title: '取消自動入帳？',
      description: `${s.name} 之後不會再自動記帳（已記的交易不受影響），訂閱仍保留追蹤。`,
      confirmText: '取消自動入帳',
    });
    if (!ok) return;
    try {
      await unlink.mutateAsync(s);
      toast.success('已取消自動入帳');
    } catch (err) {
      console.error('[subscriptionUnlink]', err);
      toast.error(err instanceof Error ? err.message : '取消失敗');
    }
  }

  function startNew() {
    setEditing({
      id: '', name: '', amountTWD: 0, billingCycle: 'monthly',
      paymentMethod: null, vendor: null, category: null, active: true,
      note: null, createdAt: new Date(), updatedAt: new Date(),
    });
  }

  async function handleSave() {
    if (!editing) return;
    if (!editing.name.trim()) { toast.error('請輸入名稱'); return; }
    try {
      await upsert.mutateAsync({
        input: {
          name: editing.name.trim(),
          amountTWD: editing.amountTWD,
          billingCycle: editing.billingCycle,
          nextChargeDate: editing.nextChargeDate ?? null,
          paymentMethod: editing.paymentMethod,
          category: editing.category,
          vendor: editing.vendor?.trim() || null,
          active: editing.active,
          note: editing.note?.trim() || null,
          lastChargedAt: editing.lastChargedAt ?? null,
        },
        id: editing.id || undefined,
      });
      toast.success('已儲存');
      setEditing(null);
    } catch (err) {
      console.error('[subscriptionSave]', err);
      toast.error(err instanceof Error ? err.message : '訂閱儲存失敗');
    }
  }

  async function handleDelete(s: Subscription) {
    const ok = await confirm({
      title: '刪除訂閱？',
      description: s.recurringId ? `${s.name}（連結的自動入帳也會一起刪除；已記的交易不受影響）` : s.name,
      confirmText: '刪除',
    });
    if (!ok) return;
    try {
      await del.mutateAsync(s);
      toast.success('已刪除');
    } catch (err) {
      console.error('[subscriptionDelete]', err);
      toast.error(err instanceof Error ? err.message : '訂閱刪除失敗');
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <Repeat className="size-4" /> 訂閱清單
          </CardTitle>
          <Button size="sm" variant="outline" onClick={startNew}><Plus className="size-4" /> 新增</Button>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-muted-foreground">每月合計 {formatCurrency(total)}（年費已換算）</p>
          {isLoading ? <p className="text-sm text-muted-foreground">載入中…</p> : subs.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未建立任何訂閱</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {subs.map((s) => (
                <li key={s.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 p-3 text-sm', !s.active && 'opacity-60')}>
                  <button type="button" className="min-w-[8rem] flex-1 text-left" onClick={() => setEditing({ ...s })}>
                    <div className="truncate font-medium">{s.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {CYCLE_LABEL[s.billingCycle]}
                      {s.vendor ? ` · ${s.vendor}` : ''}
                      {s.nextChargeDate ? ` · 下次 ${formatTW(s.nextChargeDate, 'MM/dd')}` : ''}
                    </div>
                    {s.recurringId ? <Badge variant="secondary" className="mt-1 font-normal">自動入帳</Badge> : null}
                  </button>
                  <div className="text-right text-sm tabular-nums">
                    {formatCurrency(s.amountTWD)}
                    {s.billingCycle !== 'monthly' && (
                      <div className="text-[10px] text-muted-foreground">≈ {formatCurrency(monthlyAmountTWD(s))}/月</div>
                    )}
                  </div>
                  {/* 窄螢幕放不下時，操作按鈕整組換到下一行靠右 */}
                  <div className="ml-auto flex items-center gap-2">
                  {s.recurringId ? (
                    <Button size="sm" variant="ghost" onClick={() => void handleUnlink(s)} disabled={unlink.isPending}>取消自動</Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => startLink(s)} aria-label="設定自動入帳">
                      <CalendarClock className="size-4" /> 自動入帳
                    </Button>
                  )}
                  <Switch checked={s.active} onCheckedChange={(v) => void toggle.mutateAsync({ sub: s, active: v })} />
                  <Button size="icon-sm" variant="ghost" onClick={() => void handleDelete(s)} aria-label="刪除">
                    <Trash2 className="size-4" />
                  </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={!!linking}
        onOpenChange={(o) => { if (!o) setLinking(null); }}
        title={linking ? `自動入帳 — ${linking.name}` : '自動入帳'}
        description="建立週期交易，Apps Script 每天 01:00 依扣款日自動記一筆支出；有選帳戶會同步扣餘額。"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setLinking(null)}>取消</Button>
            <Button className="flex-1" onClick={() => void confirmLink()} disabled={link.isPending || !linkDate}>確認</Button>
          </div>
        }
      >
        {linking ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {CYCLE_LABEL[linking.billingCycle]} {formatCurrency(linking.amountTWD)}，之後改訂閱金額或週期會自動同步。
            </p>
            <div>
              <Label>第一次扣款日</Label>
              <DatePicker value={linkDate} onChange={setLinkDate} clearable={false} />
            </div>
            <div>
              <Label>扣款帳戶（選填）</Label>
              <AccountSelect value={linkAccountId} onValueChange={setLinkAccountId} accounts={payAccounts} placeholder="不指定（只記帳、不動餘額）" />
            </div>
          </div>
        ) : null}
      </ResponsiveDialog>

      <ResponsiveDialog
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        title={editing && editing.id ? '編輯訂閱' : '新增訂閱'}
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setEditing(null)}>取消</Button>
            <Button className="flex-1" onClick={() => void handleSave()} disabled={upsert.isPending}>儲存</Button>
          </div>
        }
      >
        {editing && (
          <div className="space-y-3">
            <div><Label>名稱</Label>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例：Netflix 標準方案" autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>金額（TWD）</Label>
                <Input type="number" inputMode="decimal" value={Number.isFinite(editing.amountTWD) ? editing.amountTWD : ''}
                  onChange={(e) => setEditing({ ...editing, amountTWD: Number(e.target.value) })} />
              </div>
              <div><Label>週期</Label>
                <Select value={editing.billingCycle} onValueChange={(v) => setEditing({ ...editing, billingCycle: v as SubscriptionCycle })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CYCLE_LABEL) as SubscriptionCycle[]).map((c) => (
                      <SelectItem key={c} value={c}>{CYCLE_LABEL[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div><Label>下次扣款日（選填）</Label>
              <DatePicker value={editing.nextChargeDate ?? null} onChange={(d) => setEditing({ ...editing, nextChargeDate: d })} />
            </div>
            <div><Label>廠商 / 備註</Label>
              <Input value={editing.vendor ?? ''} onChange={(e) => setEditing({ ...editing, vendor: e.target.value })} placeholder="例：Netflix" />
            </div>
          </div>
        )}
      </ResponsiveDialog>
    </>
  );
}

function DetectedFromTransactions() {
  const detected = useDetectedSubscriptions(6);
  const { data: subs = [] } = useSubscriptions();
  const upsert = useUpsertSubscription();

  const known = new Set(subs.map((s) => s.name.toLowerCase()));
  const candidates = detected.filter((d) => !known.has(d.displayName.toLowerCase()));

  async function promote(d: typeof detected[number]) {
    try {
      await upsert.mutateAsync({
        input: {
          name: d.displayName,
          amountTWD: d.amountTWD,
          billingCycle: d.cycle,
          paymentMethod: d.paymentMethod ?? null,
          category: d.category ?? null,
          vendor: null,
          active: true,
          nextChargeDate: null,
          lastChargedAt: d.lastSeen,
          note: `自動偵測 ${d.occurrences} 筆`,
        },
      });
      toast.success(`已加入「${d.displayName}」`);
    } catch (err) {
      console.error('[subscriptionPromote]', err);
      toast.error(err instanceof Error ? err.message : '加入訂閱失敗');
    }
  }

  if (candidates.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" /> 自動偵測（過去 6 個月）
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-xs text-muted-foreground">
          疑似規律扣款，標為訂閱可加入提醒與每月合計。
        </p>
        <ul className="divide-y rounded-md border">
          {candidates.slice(0, 10).map((d) => (
            <li key={d.noteKey} className="flex items-center gap-3 p-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{d.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {CYCLE_LABEL[d.cycle]} · {d.occurrences} 次 · 最近 {d.daysSinceLast} 天前
                </div>
              </div>
              {d.daysSinceLast > 60 ? <Badge variant="destructive">久未動</Badge> : null}
              <div className="text-right tabular-nums">{formatCurrency(d.amountTWD)}</div>
              <Button size="sm" variant="outline" onClick={() => void promote(d)}>加入</Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
