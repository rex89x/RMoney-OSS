import { useEffect, useMemo, useState } from 'react';
import { Check, Gift, Loader2, Plus, Split, Trash2, User } from 'lucide-react';
import { toast } from 'sonner';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DatePicker } from '@/components/ui/date-picker';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useConfirm } from '@/components/ui/confirm';
import { useCreatePayoutGroup, useDeletePayoutGroup, useUpdatePayoutGroup } from '../hooks';
import {
  calculateSharedPayoutParticipants,
  participantBaseAmountTWD,
  participantSharedContributionTWD,
  type PayoutGroup,
  type PayoutParticipant,
} from '../types';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 編輯現有 group；沒填則新增 */
  group?: PayoutGroup | null;
}

interface ParticipantForm extends PayoutParticipant {
  amountInput: string; // 字串以容納編輯狀態
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function PayoutGroupDialog({ open, onOpenChange, group }: Props) {
  const { profile } = useAuth();
  const create = useCreatePayoutGroup();
  const update = useUpdatePayoutGroup();
  const del = useDeletePayoutGroup();
  const confirm = useConfirm();

  const [title, setTitle] = useState('');
  const [date, setDate] = useState<Date>(() => new Date());
  const [note, setNote] = useState('');
  const [participants, setParticipants] = useState<ParticipantForm[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  useEffect(() => {
    if (!open) return;
    if (group) {
      setTitle(group.title);
      setDate(group.date);
      setNote(group.note ?? '');
      setParticipants(group.participants.map((p) => ({
        ...p,
        amountInput: String(participantBaseAmountTWD(p)),
      })));
      // 推測自己 id：name 等於 displayName 或 email-prefix
      const myName = profile?.displayName ?? (profile?.email?.split('@')[0] ?? '');
      const me = group.participants.find((p) => p.name === myName);
      setSelfId(me?.id ?? null);
    } else {
      setTitle('');
      setDate(new Date());
      setNote('');
      const myName = profile?.displayName ?? (profile?.email?.split('@')[0] ?? '我');
      const myId = uid();
      setParticipants([
        {
          id: myId,
          name: myName,
          amountTWD: 0,
          baseAmountTWD: 0,
          sharedByOthers: false,
          amountInput: '0',
          paidAt: new Date(),
          paymentMethod: null,
          note: null,
        },
      ]);
      setSelfId(myId);
    }
    setDraftName('');
  }, [open, group, profile]);

  const totalTWD = useMemo(
    () => participants.reduce((s, p) => s + (parseFloat(p.amountInput) || 0), 0),
    [participants],
  );

  const calculatedParticipants = useMemo(
    () => calculateParticipants(participants),
    [participants],
  );

  const sharedSummary = useMemo(() => {
    const sharedTotal = calculatedParticipants
      .filter((p) => p.sharedByOthers)
      .reduce((sum, p) => sum + participantBaseAmountTWD(p), 0);
    const payerCount = calculatedParticipants.filter((p) => !p.sharedByOthers).length;
    return { sharedTotal, payerCount };
  }, [calculatedParticipants]);

  function addParticipant() {
    const name = draftName.trim();
    if (!name) {
      toast.error('請輸入姓名');
      return;
    }
    setParticipants((arr) => [
      ...arr,
      {
        id: uid(),
        name,
        amountTWD: 0,
        baseAmountTWD: 0,
        sharedByOthers: false,
        amountInput: '0',
        paidAt: null,
        paymentMethod: null,
        note: null,
      },
    ]);
    setDraftName('');
  }

  function removeParticipant(id: string) {
    setParticipants((arr) => arr.filter((p) => p.id !== id));
    if (selfId === id) setSelfId(null);
  }

  function patchParticipant(id: string, patch: Partial<ParticipantForm>) {
    setParticipants((arr) => arr.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function splitEvenly() {
    if (participants.length === 0) return;
    const totalInputs = participants.map((p) => parseFloat(p.amountInput) || 0);
    const sum = totalInputs.reduce((s, x) => s + x, 0);
    if (sum <= 0) {
      toast.error('請先填總額：把任一人金額填成總計，再按平均分');
      return;
    }
    const per = round2(sum / participants.length);
    let acc = 0;
    setParticipants((arr) => arr.map((p, i) => {
      const v = i === arr.length - 1 ? round2(sum - acc) : per;
      acc += v;
      return { ...p, amountTWD: v, amountInput: String(v) };
    }));
  }

  function splitFromTotal(totalStr: string) {
    const total = parseFloat(totalStr) || 0;
    if (participants.length === 0 || total <= 0) return;
    const per = round2(total / participants.length);
    let acc = 0;
    setParticipants((arr) => arr.map((p, i) => {
      const v = i === arr.length - 1 ? round2(total - acc) : per;
      acc += v;
      return { ...p, amountTWD: v, amountInput: String(v) };
    }));
  }

  function togglePaid(id: string) {
    patchParticipant(id, {
      paidAt: participants.find((p) => p.id === id)?.paidAt ? null : new Date(),
    });
  }

  async function handleSave() {
    if (!title.trim()) { toast.error('請輸入團名'); return; }
    if (participants.length === 0) { toast.error('至少要有一位參與者'); return; }
    const cleaned = participants.map(({ amountInput: _amountInput, ...p }) => {
      return {
        ...p,
        baseAmountTWD: parseFloat(_amountInput) || 0,
        amountTWD: parseFloat(_amountInput) || 0,
      } as PayoutParticipant;
    });
    const sharedTotal = cleaned
      .filter((p) => p.sharedByOthers)
      .reduce((sum, p) => sum + participantBaseAmountTWD(p), 0);
    const payerCount = cleaned.filter((p) => !p.sharedByOthers).length;
    if (sharedTotal > 0 && payerCount === 0) {
      toast.error('至少要保留一位同仁來分攤生日金額');
      return;
    }
    const calculated = calculateSharedPayoutParticipants(cleaned);
    const totalNum = cleaned.reduce((s, p) => s + participantBaseAmountTWD(p), 0);

    try {
      if (group) {
        await update.mutateAsync({
          id: group.id,
          patch: {
            title: title.trim(),
            date,
            totalAmountTWD: totalNum,
            note: note.trim() || null,
            participants: calculated,
            selfParticipantId: selfId ?? null,
          },
        });
        toast.success('已更新');
      } else {
        await create.mutateAsync({
          title: title.trim(),
          date,
          totalAmountTWD: totalNum,
          note: note.trim() || null,
          participants: calculated,
          selfParticipantId: selfId ?? null,
        });
      }
      onOpenChange(false);
    } catch (err) {
      console.error('[payoutGroupSave]', err);
      toast.error(err instanceof Error ? err.message : '墊付團儲存失敗');
    }
  }

  async function handleDelete() {
    if (!group) return;
    const ok = await confirm({
      title: '刪除這個墊付團？',
      description: `${group.title} — 連動的記帳會進回收筒（7 天可復原）`,
      confirmText: '刪除',
    });
    if (!ok) return;
    try {
      await del.mutateAsync(group.id);
      onOpenChange(false);
    } catch (err) {
      console.error('[payoutGroupDelete]', err);
      toast.error(err instanceof Error ? err.message : '墊付團刪除失敗');
    }
  }

  const pending = participants.length === 0 || !title.trim() || create.isPending || update.isPending;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={group ? '編輯墊付團' : '新增墊付團'}
      description="記下我先付了多少、誰各分多少、誰已經繳給我了。"
      contentClassName="sm:max-w-xl"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {group ? (
            <Button variant="ghost" onClick={() => void handleDelete()} disabled={del.isPending}>
              <Trash2 className="size-4" /> 刪除
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button onClick={() => void handleSave()} disabled={pending}>
              {(create.isPending || update.isPending) ? <Loader2 className="size-4 animate-spin" /> : null}
              儲存
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>團名</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：5/3 下午茶" />
          </div>
          <div>
            <Label>日期</Label>
            <DatePicker value={date} onChange={(d) => d && setDate(d)} clearable={false} />
          </div>
        </div>

        <div>
          <Label>備註</Label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={1} placeholder="店名、地點…" />
        </div>

        <div className="rounded-md border p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">參與者明細</div>
            <div className="text-xs text-muted-foreground tabular-nums">
              加總 NT${formatNum(totalTWD)}
            </div>
          </div>

          {/* 一鍵：先輸入總額再均分 */}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <Label className="text-xs">總額快速均分</Label>
            <Input
              type="number"
              inputMode="decimal"
              placeholder="例如 1500"
              className="h-8 w-28"
              onBlur={(e) => splitFromTotal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  splitFromTotal((e.target as HTMLInputElement).value);
                }
              }}
            />
            <Button size="sm" variant="outline" onClick={splitEvenly}>
              <Split className="size-3" /> 已填的均分
            </Button>
          </div>
          {sharedSummary.sharedTotal > 0 ? (
            <div className="mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
              {sharedSummary.payerCount > 0
                ? `分攤 NT${formatNum(sharedSummary.sharedTotal)} 給 ${sharedSummary.payerCount} 位同仁；生日者應收為 0。`
                : '至少要保留一位同仁來分攤生日金額。'}
            </div>
          ) : null}

          <ul className="space-y-1.5">
            {participants.map((p) => {
              const isSelf = selfId === p.id;
              const calculated = calculatedParticipants.find((x) => x.id === p.id) ?? p;
              const contribution = participantSharedContributionTWD(calculated);
              return (
                <li
                  key={p.id}
                  className={cn(
                    'grid grid-cols-[24px,minmax(0,1fr),86px,auto,auto,auto] items-center gap-2 rounded-md border p-2 text-sm',
                    p.paidAt && 'bg-emerald-500/5',
                    isSelf && 'border-primary/60',
                    p.sharedByOthers && 'border-amber-500/50 bg-amber-500/5',
                  )}
                >
                  <button
                    type="button"
                    aria-label={p.paidAt ? '標記未繳' : '標記已繳'}
                    onClick={() => togglePaid(p.id)}
                    className={cn(
                      'flex size-6 items-center justify-center rounded-full border',
                      p.paidAt ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {p.paidAt ? <Check className="size-3.5" /> : null}
                  </button>
                  <div className="min-w-0">
                    <Input
                      value={p.name}
                      onChange={(e) => patchParticipant(p.id, { name: e.target.value })}
                      placeholder="姓名"
                      className="h-8 text-sm"
                    />
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      應收 NT${formatNum(calculated.amountTWD)}
                      {p.sharedByOthers ? ' · 由其他同仁分攤' : contribution > 0 ? ` · 含分攤 NT${formatNum(contribution)}` : ''}
                    </div>
                  </div>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={p.amountInput}
                    onChange={(e) => patchParticipant(p.id, { amountInput: e.target.value })}
                    className="h-8 text-right text-sm tabular-nums"
                  />
                  <button
                    type="button"
                    onClick={() => patchParticipant(p.id, { sharedByOthers: !p.sharedByOthers })}
                    title={p.sharedByOthers ? '取消由其他同仁分攤' : '這位的金額由其他同仁分攤'}
                    className={cn(
                      'rounded-md p-1 text-muted-foreground hover:bg-muted',
                      p.sharedByOthers && 'bg-amber-500/10 text-amber-600',
                    )}
                  >
                    <Gift className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelfId(isSelf ? null : p.id)}
                    title={isSelf ? '我（取消）' : '標記為我'}
                    className={cn(
                      'rounded-md p-1 text-muted-foreground hover:bg-muted',
                      isSelf && 'bg-primary/10 text-primary',
                    )}
                  >
                    <User className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeParticipant(p.id)}
                    aria-label="移除"
                    className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-2 flex gap-2">
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="加參與者姓名"
              className="h-9 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addParticipant();
                }
              }}
            />
            <Button type="button" variant="outline" onClick={addParticipant} disabled={!draftName.trim()}>
              <Plus className="size-4" /> 加入
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            點 ○ 切換已繳；點禮物表示該位金額由其他同仁分攤；點頭像把該位設為「我」。
          </p>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatNum(n: number): string {
  return Math.round(n).toLocaleString();
}

function calculateParticipants(participants: ParticipantForm[]): PayoutParticipant[] {
  return calculateSharedPayoutParticipants(participants.map(({ amountInput, ...p }) => ({
    ...p,
    baseAmountTWD: parseFloat(amountInput) || 0,
    amountTWD: parseFloat(amountInput) || 0,
  })));
}
