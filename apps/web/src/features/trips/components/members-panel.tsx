import { useState } from 'react';
import { UserPlus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useConfirm } from '@/components/ui/confirm';
import { useUpdateTrip } from '../hooks';
import type { Trip, TripMember } from '../types';
import { companionToMember, useKnownCompanions, type KnownCompanion } from '../known-companions';
import { cn } from '@/lib/utils';

const COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4', '#f97316'];

export function MembersPanel({ trip }: { trip: Trip }) {
  const update = useUpdateTrip();
  const confirm = useConfirm();
  const members = trip.members ?? [];
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const companions = useKnownCompanions();
  const memberKeys = new Set(members.map((m) => m.uid ?? m.name));
  const suggestions = companions.filter((c) => !memberKeys.has(c.id) && !members.some((m) => m.name === c.name));
  const householdMissing = suggestions.filter((c) => c.source === 'household');

  /** 一鍵加入常用旅伴（共同帳本成員會帶 uid，分攤與共同帳本才對得起來） */
  async function addCompanions(list: KnownCompanion[]) {
    if (list.length === 0) return;
    const next: TripMember[] = [...members];
    list.forEach((c, i) => {
      next.push(companionToMember(c, COLORS[(members.length + i) % COLORS.length]));
    });
    try {
      await update.mutateAsync({ id: trip.id, patch: { members: next } });
      toast.success(list.length === 1 ? `已加入 ${list[0]?.name}` : `已加入 ${list.length} 位旅伴`);
    } catch (err) {
      console.error('[addCompanions]', err);
      toast.error(err instanceof Error ? err.message : '加入失敗');
    }
  }

  async function addMember() {
    if (!name.trim()) return;
    if (members.some((m) => m.name === name.trim())) {
      toast.error('已有同名成員');
      return;
    }
    const next: TripMember[] = [
      ...members,
      {
        name: name.trim(),
        email: email.trim() || undefined,
        color: COLORS[members.length % COLORS.length],
      },
    ];
    await update.mutateAsync({ id: trip.id, patch: { members: next } });
    setName('');
    setEmail('');
    setDialogOpen(false);
  }

  async function removeMember(i: number) {
    const m = members[i];
    if (!m) return;
    const ok = await confirm({
      title: '移除成員',
      description: `${m.name} 會從這趟分攤名單中移除。已紀錄的代墊 / 應付不會自動修正，請手動調整關聯交易。`,
      confirmText: '移除',
    });
    if (!ok) return;
    const next = members.filter((_, idx) => idx !== i);
    await update.mutateAsync({ id: trip.id, patch: { members: next } });
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="size-4" /> 成員（分攤對象）
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            <UserPlus className="size-4" /> 新增成員
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            分攤用名單。新增後，新增花費時就能指定誰先付。名字可與 app 使用者無關（例如旅伴還沒有帳號）。
          </p>

          {householdMissing.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
              <span>共同帳本的 {householdMissing.map((c) => c.name).join('、')} 還不在成員裡；加入後這趟的共同支出會自動算到兩人身上。</span>
              <Button size="sm" variant="outline" onClick={() => void addCompanions(householdMissing)} disabled={update.isPending}>
                <UserPlus className="size-3.5" /> 加入共同帳本成員
              </Button>
            </div>
          ) : null}

          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚無成員。新增後才能做分攤。</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {members.map((m, i) => (
                <li key={i} className="flex items-center gap-3 p-2 text-sm">
                  <span
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium text-white"
                    style={{ backgroundColor: m.color ?? COLORS[i % COLORS.length] }}
                  >
                    {m.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{m.name}</div>
                    {m.email && <div className="truncate text-xs text-muted-foreground">{m.email}</div>}
                  </div>
                  {m.uid && <Badge variant="secondary">已連結帳號</Badge>}
                  <Button size="icon-sm" variant="ghost" onClick={() => void removeMember(i)}>
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="新增成員"
        description="加入旅伴名字以便分攤花費"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button className="flex-1" onClick={() => void addMember()} disabled={!name.trim() || update.isPending}>
              新增
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {suggestions.length > 0 ? (
            <div>
              <Label className="text-xs">常用旅伴（點一下直接加入）</Label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {suggestions.slice(0, 12).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { void addCompanions([c]); setDialogOpen(false); }}
                    disabled={update.isPending}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors hover:bg-muted',
                      c.source === 'household' && 'border-primary/40 bg-primary/5',
                    )}
                    title={c.source === 'household' ? '共同帳本成員' : `${c.tripCount} 趟 · 最近：${c.lastTripName ?? ''}`}
                  >
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: c.color ?? '#94a3b8' }} aria-hidden />
                    {c.name}
                    <span className="text-[10px] text-muted-foreground">{c.source === 'household' ? '共同' : `${c.tripCount} 趟`}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">或在下面輸入新的名字。</p>
            </div>
          ) : null}
          <div>
            <Label className="text-xs">名字</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="小明"
              autoFocus={suggestions.length === 0}
            />
          </div>
          <div>
            <Label className="text-xs">Email（選填，未來連結帳號用）</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ming@example.com" />
          </div>
        </div>
      </ResponsiveDialog>
    </>
  );
}
