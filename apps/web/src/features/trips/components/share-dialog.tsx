import {
  cloneElement, isValidElement, useEffect, useState, type MouseEvent, type ReactElement,
} from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { Check, Mail, Loader2, X, Link2, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { db } from '@/lib/firebase';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { callAppsScript } from '@/lib/apps-script';
import { useUpdateTrip } from '../hooks';
import type { Trip } from '../types';
import { useActiveHousehold } from '@/features/household/hooks';
import { MemberChip } from '@/features/household/components/member-chip';
import { householdTripMembers } from '../known-companions';

interface UserRow {
  uid: string;
  email: string;
  displayName: string | null;
  role: string;
}

export function TripShareDialog({ trip, trigger }: { trip: Trip; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const update = useUpdateTrip();
  const { user: me } = useAuth();
  const household = useActiveHousehold();
  const partners = household ? household.memberIds.filter((id) => id !== me?.uid) : [];

  const sharedWith = new Set(trip.sharedWith ?? []);
  const pending = trip.pendingInvites ?? [];

  useEffect(() => {
    if (!open) return;
    void loadUsers();
  }, [open]);

  async function loadUsers() {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'users'));
      const list: UserRow[] = [];
      snap.forEach((d) => {
        const data = d.data() as Record<string, unknown>;
        list.push({
          uid: d.id,
          email: (data.email as string) ?? '',
          displayName: (data.displayName as string | null) ?? null,
          role: (data.role as string) ?? 'member',
        });
      });
      setUsers(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '讀取使用者失敗');
    } finally {
      setLoading(false);
    }
  }

  async function toggle(uid: string) {
    const next = new Set(trip.sharedWith ?? []);
    const turningOn = !next.has(uid);
    if (turningOn) next.add(uid); else next.delete(uid);
    // 分享給共同帳本成員 = 他就是這趟的旅伴：順便補進成員名單（帶 uid），分攤與共同帳本才對得起來
    const addMembers = turningOn && household && household.memberIds.includes(uid)
      ? householdTripMembers({ memberIds: [uid], members: household.members }, trip.members ?? [])
      : [];
    await update.mutateAsync({
      id: trip.id,
      patch: {
        sharedWith: Array.from(next),
        ...(addMembers.length > 0 ? { members: [...(trip.members ?? []), ...addMembers] } : {}),
      },
    });
  }

  async function handleInvite() {
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      toast.error('請輸入有效 email');
      return;
    }
    setInviting(true);
    try {
      const resp = (await callAppsScript('inviteTripUser', undefined, {
        tripId: trip.id, email,
      })) as { ok: boolean; error?: string };
      if (!resp.ok) throw new Error(resp.error || '邀請失敗');
      toast.success(`已邀請 ${email}，待對方首次登入後自動加入分享`);
      setInviteEmail('');
      // 立即重新拉一次 trip / users
      await Promise.all([loadUsers()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '邀請失敗');
    } finally {
      setInviting(false);
    }
  }

  async function cancelPending(email: string) {
    const next = pending.filter((e) => e !== email);
    await update.mutateAsync({ id: trip.id, patch: { pendingInvites: next } });
  }

  const triggerElement = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<{ onClick?: (event: MouseEvent) => void }>, {
        onClick: (event: MouseEvent) => {
          (trigger as ReactElement<{ onClick?: (event: MouseEvent) => void }>).props.onClick?.(event);
          setOpen(true);
        },
      })
    : trigger;

  return (
    <>
      {triggerElement}
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title="分享此行程"
        description="被分享的使用者只能看這趟旅程（唯讀）。其他系統頁面（記帳 / 投資 / 設定…）對他完全鎖住。邀請 Gmail → 對方用該帳號登入後，自動只能看到這趟旅程。"
        contentClassName="sm:max-w-md"
        footer={<Button variant="outline" onClick={() => setOpen(false)}>完成</Button>}
      >

        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center gap-1 text-xs font-medium">
            <Link2 className="size-3.5" /> 旅程連結
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1.5 text-xs">
              {typeof window !== 'undefined' ? `${window.location.origin}/trips/${trip.id}` : `/trips/${trip.id}`}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                if (typeof window === 'undefined') return;
                const url = `${window.location.origin}/trips/${trip.id}`;
                try {
                  await navigator.clipboard.writeText(url);
                  toast.success('已複製旅程連結');
                } catch {
                  toast.error('複製失敗，請手動選取');
                }
              }}
            >
              <Copy className="size-3.5" /> 複製
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            把連結傳給已邀請的 Gmail 帳號；對方登入後直接進來。
          </p>
        </div>

        {partners.length > 0 ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="text-xs font-medium">共同帳本成員</div>
            <div className="flex flex-wrap gap-1.5">
              {partners.map((uid) => (
                <MemberChip
                  key={uid}
                  member={household?.members[uid]}
                  active={sharedWith.has(uid)}
                  onClick={() => void toggle(uid)}
                  suffix={sharedWith.has(uid) ? ' · 已分享' : ''}
                />
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">點一下即分享 / 取消；對方在「出遊」看得到這趟行程與花費（唯讀）。</p>
          </div>
        ) : null}

        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center gap-1 text-xs font-medium">
            <Mail className="size-3.5" /> 邀請 Google 帳號
          </div>
          <div className="flex gap-2">
            <Input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="friend@gmail.com"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleInvite(); } }}
            />
            <Button onClick={() => void handleInvite()} disabled={inviting || !inviteEmail.trim()}>
              {inviting ? <Loader2 className="size-4 animate-spin" /> : null}
              邀請
            </Button>
          </div>
          {pending.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">待加入（首次登入後自動套用）：</p>
              <ul className="flex flex-wrap gap-1.5">
                {pending.map((e) => (
                  <li key={e} className="inline-flex items-center gap-1 rounded bg-background px-2 py-0.5 text-[11px]">
                    {e}
                    <button
                      type="button"
                      onClick={() => void cancelPending(e)}
                      aria-label="取消邀請"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">載入中…</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-muted-foreground">沒有其他使用者可分享（只有 admin 才能新增）</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
            {users.filter((u) => u.uid !== me?.uid).map((u) => {
              const on = sharedWith.has(u.uid);
              return (
                <li key={u.uid}>
                  <button
                    type="button"
                    onClick={() => void toggle(u.uid)}
                    className={cn(
                      'flex w-full items-center gap-3 p-2 text-left transition-colors hover:bg-muted/50',
                      on && 'bg-primary/5',
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm font-medium">{u.displayName ?? u.email}</div>
                      <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                    </div>
                    <Badge variant="outline" className="shrink-0">{u.role}</Badge>
                    <div className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border', on && 'border-primary bg-primary text-primary-foreground')}>
                      {on && <Check className="size-3" />}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ResponsiveDialog>
    </>
  );
}
