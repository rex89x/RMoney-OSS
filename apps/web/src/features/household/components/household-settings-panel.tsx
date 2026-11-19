import { useEffect, useState } from 'react';
import { AlertTriangle, Copy, Eye, Link2, Loader2, Mail, Pencil, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useConfirm } from '@/components/ui/confirm';
import { useAuth } from '@/hooks/use-auth';
import { generateInviteCode, inviteCodeExpiry, isInviteCodeActive } from '../api';
import { formatTW } from '@/lib/tz';
import {
  useInviteHouseholdMember, useMyLedgerShareState, useRemoveHouseholdMember,
  useRepairLedgerSharingMirror, useSetLedgerSharing, useUpdateHousehold,
} from '../hooks';
import {
  MEMBER_COLORS, MEMBER_PERMISSION_DEFAULT, MEMBER_PERMISSION_LABEL, canEditLedgerOf, memberCan, sharesLedgerWith,
  type Household, type MemberPermissionKey,
} from '../types';
import { MemberChip } from './member-chip';

/** 成員與邀請 / 權限 / 名稱・分攤比例・預算 */
export function HouseholdSettingsPanel({ household }: { household: Household }) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const amOwner = household.ownerId === myUid;
  const canEdit = memberCan(household, myUid, 'canEditSettings');
  const update = useUpdateHousehold();
  const invite = useInviteHouseholdMember();
  const removeMember = useRemoveHouseholdMember();
  const setSharing = useSetLedgerSharing();
  const repairMirror = useRepairLedgerSharingMirror();
  // 權威來源：rules 真正看的 users/{myUid}.ledgerSharedWith / ledgerEditors
  const { data: shareState } = useMyLedgerShareState();
  const sharedWith = shareState?.viewers ?? [];
  const editors = shareState?.editors ?? [];
  const confirm = useConfirm();

  const [name, setName] = useState(household.name);
  const [ratio, setRatio] = useState<Record<string, string>>({});
  const [budget, setBudget] = useState(household.monthlyBudgetTWD != null ? String(household.monthlyBudgetTWD) : '');
  const [inviteEmail, setInviteEmail] = useState('');

  useEffect(() => {
    setName(household.name);
    setBudget(household.monthlyBudgetTWD != null ? String(household.monthlyBudgetTWD) : '');
    const r: Record<string, string> = {};
    for (const id of household.memberIds) r[id] = String(household.splitRatio[id] ?? 0);
    setRatio(r);
  }, [household]);

  const ratioSum = household.memberIds.reduce((s, id) => s + (parseFloat(ratio[id] ?? '') || 0), 0);
  const ratioOk = Math.abs(ratioSum - 100) < 0.01;
  // 過期或舊資料沒有到期時間的碼不再顯示為可用（Apps Script 也會拒絕），要重設才能用
  const inviteActive = isInviteCodeActive(household);
  const inviteLink = inviteActive && household.inviteCode
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/login?join=${household.inviteCode}`
    : null;

  async function handleSave() {
    if (!name.trim()) { toast.error('請輸入名稱'); return; }
    if (!ratioOk) { toast.error('分攤比例加總需為 100%'); return; }
    const splitRatio: Record<string, number> = {};
    for (const id of household.memberIds) splitRatio[id] = parseFloat(ratio[id] ?? '') || 0;
    const b = budget.trim() === '' ? null : Math.max(0, Math.round(parseFloat(budget) || 0));
    try {
      await update.mutateAsync({ id: household.id, patch: { name: name.trim(), splitRatio, monthlyBudgetTWD: b } });
      toast.success('已儲存');
    } catch (err) {
      console.error('[householdSettings]', err);
    }
  }

  async function handleInvite() {
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) { toast.error('請輸入有效 email'); return; }
    try {
      await invite.mutateAsync({ householdId: household.id, email });
      toast.success(`已邀請 ${email}，對方用這個 Google 帳號登入後就會加入`);
      setInviteEmail('');
    } catch (err) {
      console.error('[householdInvite]', err);
    }
  }

  async function cancelPending(email: string) {
    try {
      await update.mutateAsync({ id: household.id, patch: { pendingInvites: household.pendingInvites.filter((e) => e !== email) } });
    } catch (err) {
      console.error('[householdCancelInvite]', err);
    }
  }

  async function regenerateCode() {
    if (household.inviteCode) {
      const ok = await confirm({ title: '重設邀請連結？', description: '舊連結會立刻失效。', confirmText: '重設' });
      if (!ok) return;
    }
    try {
      await update.mutateAsync({ id: household.id, patch: { inviteCode: generateInviteCode(), inviteCodeExpiresAt: inviteCodeExpiry() } });
      toast.success('邀請連結已產生，24 小時內有效，用過一次就失效');
    } catch (err) {
      console.error('[householdInviteCode]', err);
    }
  }

  async function disableCode() {
    try {
      await update.mutateAsync({ id: household.id, patch: { inviteCode: null, inviteCodeExpiresAt: null } });
      toast.success('邀請連結已停用');
    } catch (err) {
      console.error('[householdInviteCode]', err);
    }
  }

  async function copyLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      toast.success('已複製邀請連結');
    } catch {
      toast.error('複製失敗，請手動選取');
    }
  }

  async function setColor(uid: string, color: string) {
    const member = household.members[uid];
    if (!member) return;
    try {
      await update.mutateAsync({ id: household.id, patch: { members: { ...household.members, [uid]: { ...member, color } } } });
    } catch (err) {
      console.error('[householdColor]', err);
    }
  }

  async function setPermission(uid: string, key: MemberPermissionKey, value: boolean) {
    const member = household.members[uid];
    if (!member) return;
    try {
      await update.mutateAsync({
        id: household.id,
        patch: { members: { ...household.members, [uid]: { ...member, permissions: { ...(member.permissions ?? {}), [key]: value } } } },
      });
    } catch (err) {
      console.error('[householdPermission]', err);
    }
  }

  /** 打開＝對方可以讀我的個人「支出」交易。關掉會立刻失效（連同編輯權限一起收回）。 */
  async function toggleLedgerSharing(viewerUid: string, enabled: boolean) {
    if (enabled) {
      const ok = await confirm({
        title: `讓 ${household.members[viewerUid]?.displayName ?? '對方'} 看你的個人支出？`,
        description: '對方會看到你所有的個人支出：金額、類別、備註、付款方式。收入、帳戶餘額、投資與淨值不會分享。隨時可以關掉。',
        confirmText: '開放',
        variant: 'default',
      });
      if (!ok) return;
    }
    try {
      await setSharing.mutateAsync({ household, sharerUid: myUid, viewerUid, enabled, scope: 'view' });
      toast.success(enabled ? '已開放個人支出明細' : '已取消分享');
    } catch (err) {
      console.error('[toggleLedgerSharing]', err);
    }
  }

  /** 打開＝對方可以「修改」我的個人支出（金額 / 類別 / 備註 / 日期、改成共同分攤、刪除）。 */
  async function toggleLedgerEditing(editorUid: string, enabled: boolean) {
    if (enabled) {
      const ok = await confirm({
        title: `讓 ${household.members[editorUid]?.displayName ?? '對方'} 編輯你的個人支出？`,
        description: '對方可以修改你每一筆個人支出的金額、類別、備註與日期，把它標成共同分攤，或刪到回收筒。改金額會連動你的帳戶餘額。對方不能替你新增交易，也看不到收入與帳戶清單。隨時可以關掉。',
        confirmText: '開放編輯',
        variant: 'default',
      });
      if (!ok) return;
    }
    try {
      await setSharing.mutateAsync({ household, sharerUid: myUid, viewerUid: editorUid, enabled, scope: 'edit' });
      toast.success(enabled ? '已開放編輯' : '已收回編輯權限');
    } catch (err) {
      console.error('[toggleLedgerEditing]', err);
    }
  }

  async function handleRemove(uid: string) {
    const m = household.members[uid];
    const ok = await confirm({
      title: `移除 ${m?.displayName ?? uid}？`,
      description: '對方會離開共同帳本，之前記的共同支出保留。若要連登入權限一起收回，再到 設定 → 權限 把 email 從白名單移除。',
      confirmText: '移除',
    });
    if (!ok) return;
    try {
      await removeMember.mutateAsync({ household, uid });
      toast.success('已移除');
    } catch (err) {
      console.error('[householdRemove]', err);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
      <Card>
        <CardHeader><CardTitle className="text-base">成員與權限</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {household.memberIds.map((id) => {
              const m = household.members[id];
              const isOwnerRow = id === household.ownerId;
              const isMe = id === myUid;
              return (
                <li key={id} className="space-y-2 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <MemberChip member={m} suffix={id === myUid ? '（我）' : ''} />
                      <div className="break-all text-xs text-muted-foreground">{m?.email ?? ''}{isOwnerRow ? ' · 建立者（全部權限）' : ''}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {canEdit ? (
                        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="成員顏色">
                          {MEMBER_COLORS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              role="radio"
                              aria-checked={m?.color === c}
                              aria-label={`顏色 ${c}`}
                              onClick={() => void setColor(id, c)}
                              className="flex size-7 items-center justify-center rounded-full"
                            >
                              <span
                                className="size-5 rounded-full ring-2 ring-offset-2 ring-offset-card"
                                style={{ backgroundColor: c, ['--tw-ring-color' as string]: m?.color === c ? 'hsl(var(--foreground))' : 'transparent' }}
                              />
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {amOwner && !isOwnerRow ? (
                        <Button size="icon-sm" variant="ghost" onClick={() => void handleRemove(id)} aria-label="移除成員" disabled={removeMember.isPending}>
                          <Trash2 className="size-4" />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {amOwner && !isOwnerRow ? (
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {(Object.keys(MEMBER_PERMISSION_LABEL) as MemberPermissionKey[]).map((key) => {
                        const value = m?.permissions?.[key] ?? MEMBER_PERMISSION_DEFAULT[key];
                        return (
                          <label key={key} className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs">
                            <span className="min-w-0">
                              <span className="font-medium">{MEMBER_PERMISSION_LABEL[key].label}</span>
                              <span className="block text-[10px] text-muted-foreground">{MEMBER_PERMISSION_LABEL[key].hint}</span>
                            </span>
                            <Switch checked={value} onCheckedChange={(v) => void setPermission(id, key, v)} disabled={update.isPending} />
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                  {!isMe ? (() => {
                    // 開關狀態看權威來源；鏡像沒跟上的話對方的分頁不會出現 → 提示可重新同步
                    const granted = sharedWith.includes(id);
                    const editGranted = granted && editors.includes(id);
                    const mirrored = sharesLedgerWith(household, myUid, id);
                    const editMirrored = canEditLedgerOf(household, id, myUid);
                    const mirrorStale = granted !== mirrored || editGranted !== editMirrored;
                    return (
                      <div className="space-y-1.5">
                        <label className="flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs">
                          <span className="min-w-0">
                            <span className="inline-flex items-center gap-1 font-medium"><Eye className="size-3.5" /> 可以看我的個人支出明細</span>
                            <span className="block text-[10px] text-muted-foreground">
                              對方多一個「你的名字的支出」分頁看你的個人支出（金額 / 類別 / 備註 / 付款方式）。收入、帳戶、投資不分享。
                            </span>
                          </span>
                          <Switch
                            checked={granted}
                            onCheckedChange={(v) => void toggleLedgerSharing(id, v)}
                            disabled={setSharing.isPending || repairMirror.isPending}
                          />
                        </label>
                        {granted ? (
                          <label className="flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs">
                            <span className="min-w-0">
                              <span className="inline-flex items-center gap-1 font-medium"><Pencil className="size-3.5" /> 可以編輯我的個人支出</span>
                              <span className="block text-[10px] text-muted-foreground">
                                對方可以改金額 / 類別 / 備註 / 日期、把一筆標成共同分攤或刪除（連動你的帳戶餘額）。不能替你新增。
                              </span>
                            </span>
                            <Switch
                              checked={editGranted}
                              onCheckedChange={(v) => void toggleLedgerEditing(id, v)}
                              disabled={setSharing.isPending || repairMirror.isPending}
                            />
                          </label>
                        ) : null}
                        {mirrorStale ? (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px]">
                            <span className="inline-flex items-center gap-1">
                              <AlertTriangle className="size-3.5 shrink-0" />
                              權限已更新，但對方端的分頁狀態沒同步到。
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void repairMirror.mutateAsync({ household, sharerUid: myUid })}
                              disabled={repairMirror.isPending}
                            >
                              <RefreshCw className="size-3.5" /> 重新同步
                            </Button>
                          </div>
                        ) : null}
                        {granted ? (
                          <p className="px-1 text-[10px] text-muted-foreground">
                            對方要重新整理一次頁面才會看到新分頁（手機裝成 App 的話從桌面重開）。
                          </p>
                        ) : null}
                      </div>
                    );
                  })() : null}
                </li>
              );
            })}
          </ul>

          {household.pendingInvites.length > 0 ? (
            <div className="space-y-1">
              <Label className="text-xs">等待首次登入</Label>
              <div className="flex flex-wrap gap-1.5">
                {household.pendingInvites.map((e) => (
                  <Badge key={e} variant="outline" className="gap-1">
                    {e}
                    {amOwner ? (
                      <button type="button" onClick={() => void cancelPending(e)} aria-label="取消邀請"><X className="size-3" /></button>
                    ) : null}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {amOwner ? (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center gap-1 text-xs font-medium"><Link2 className="size-3.5" /> 邀請連結（最簡單）</div>
              {inviteLink ? (
                <>
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1.5 text-xs">{inviteLink}</code>
                    <Button size="sm" variant="outline" onClick={() => void copyLink()}><Copy className="size-3.5" /> 複製</Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    把連結傳給對方，用要一起記帳的 Google 帳號登入就會自動加入（不用先加白名單）。
                    連結到 {household.inviteCodeExpiresAt ? formatTW(household.inviteCodeExpiresAt, 'MM/dd HH:mm') : ''} 前有效，對方加入後就自動失效；不用了可提前停用。
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => void regenerateCode()} disabled={update.isPending}><RefreshCw className="size-3.5" /> 重設</Button>
                    <Button size="sm" variant="ghost" onClick={() => void disableCode()} disabled={update.isPending}>停用連結</Button>
                  </div>
                </>
              ) : (
                <>
                  {household.inviteCode ? (
                    <p className="text-[11px] text-muted-foreground">上次的邀請連結已過期或已使用，請重新產生。</p>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => void regenerateCode()} disabled={update.isPending}>
                    <Link2 className="size-3.5" /> 產生邀請連結
                  </Button>
                </>
              )}
            </div>
          ) : null}

          {amOwner ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1 text-xs font-medium"><Mail className="size-3.5" /> 或用 email 邀請</div>
              <form className="flex min-w-0 gap-2" onSubmit={(e) => { e.preventDefault(); void handleInvite(); }}>
                <Input type="email" className="min-w-0" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="伴侶的 Google email" />
                <Button type="submit" disabled={invite.isPending}>
                  {invite.isPending ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />} 邀請
                </Button>
              </form>
              <p className="text-[11px] text-muted-foreground">
                email 要跟對方登入 Google 時用的一模一樣；不確定的話用上面的邀請連結。對方只看得到這個共同帳本、分享給他的旅程與設定。
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">分攤與預算</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>名稱</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" disabled={!canEdit} />
          </div>
          <div>
            <Label>預設分攤比例（%）</Label>
            <div className="mt-1 space-y-2">
              {household.memberIds.map((id) => (
                <div key={id} className="flex min-w-0 items-center justify-between gap-2">
                  <MemberChip member={household.members[id]} suffix={id === myUid ? '（我）' : ''} />
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={ratio[id] ?? ''}
                    onChange={(e) => setRatio({ ...ratio, [id]: e.target.value })}
                    className="h-9 w-24 text-right tabular-nums"
                    disabled={!canEdit}
                  />
                </div>
              ))}
              <p className={ratioOk ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>
                加總 {Math.round(ratioSum)}%{ratioOk ? '' : '（需為 100%）'}
              </p>
            </div>
          </div>
          <div>
            <Label>共同月預算（TWD，選填）</Label>
            <Input type="number" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} className="mt-1" placeholder="例：20000" disabled={!canEdit} />
          </div>
          {canEdit ? (
            <Button onClick={() => void handleSave()} disabled={update.isPending}>
              {update.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} 儲存
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">只有建立者（或被授權「修改設定」的成員）能改這些。</p>
          )}
          {amOwner ? (
            <label className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm">
              <span className="min-w-0">
                <span className="font-medium">新旅程自動分享給伴侶</span>
                <span className="block text-xs text-muted-foreground">建立出遊時自動把其他成員加進分享（唯讀看行程與花費）</span>
              </span>
              <Switch
                checked={household.autoShareTrips === true}
                onCheckedChange={(v) => void update.mutateAsync({ id: household.id, patch: { autoShareTrips: v } })}
                disabled={update.isPending}
              />
            </label>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
