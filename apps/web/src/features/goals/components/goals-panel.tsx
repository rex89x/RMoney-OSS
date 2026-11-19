import { useMemo, useState } from 'react';
import { Plus, Target, Trash2, Plane, HeartHandshake } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { useConfirm } from '@/components/ui/confirm';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useAuth } from '@/hooks/use-auth';
import { useActiveHousehold, type Household } from '@/features/household';
import {
  useAddContribution, useArchiveGoal, useDeleteContribution, useGoalContribs,
  useGoalEta, useGoals, useHouseholdGoals, useUpsertGoal,
} from '../hooks';
import { requiredMonthlyTWD, type SavingsGoal } from '../types';
import { monthTWRange, nowTW } from '@/lib/tz';
import { memberCan } from '@/features/household';

const PRESET_COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];

interface GoalsPanelProps {
  /** 只顯示這個共同帳本的目標（/shared 頁、member 模式用；member 不能 list 全部 savings_goals） */
  householdId?: string | null;
}

export function GoalsPanel({ householdId }: GoalsPanelProps = {}) {
  const scoped = householdId != null;
  const household = useActiveHousehold();
  const allQ = useGoals({ enabled: !scoped });
  const hhQ = useHouseholdGoals(scoped ? householdId : null);
  const goals = useMemo(() => (scoped ? hhQ.data ?? [] : allQ.data ?? []), [scoped, hhQ.data, allQ.data]);
  const isLoading = scoped ? hhQ.isLoading : allQ.isLoading;
  const { user: authUser } = useAuth();
  // member 模式（scoped）要看 household 權限；owner 自己的面板永遠可以
  const canManage = !scoped || memberCan(household, authUser?.uid, 'canManageGoals');
  const upsert = useUpsertGoal();
  const archive = useArchiveGoal();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<SavingsGoal | null>(null);
  const [contribFor, setContribFor] = useState<SavingsGoal | null>(null);

  function startNew() {
    setEditing({
      id: '', name: '', targetTWD: 0, currentTWD: 0, targetDate: null,
      icon: null, color: PRESET_COLORS[goals.length % PRESET_COLORS.length] ?? '#10b981',
      archivedAt: null, householdId: scoped ? householdId : null, monthlyPlanTWD: null, createdAt: new Date(), updatedAt: new Date(),
    });
  }

  async function handleSave() {
    if (!editing) return;
    if (!editing.name.trim()) { toast.error('請輸入名稱'); return; }
    if (editing.targetTWD <= 0) { toast.error('目標金額需 > 0'); return; }
    try {
      await upsert.mutateAsync({
        input: {
          name: editing.name.trim(),
          targetTWD: editing.targetTWD,
          currentTWD: editing.currentTWD,
          targetDate: editing.targetDate ?? null,
          icon: editing.icon,
          color: editing.color,
          archivedAt: null,
          householdId: editing.householdId ?? null,
          monthlyPlanTWD: editing.monthlyPlanTWD && editing.monthlyPlanTWD > 0 ? Math.round(editing.monthlyPlanTWD) : null,
        },
        id: editing.id || undefined,
      });
      toast.success('已儲存');
      setEditing(null);
    } catch (err) {
      console.error('[goalSave]', err);
      toast.error(err instanceof Error ? err.message : '目標儲存失敗');
    }
  }

  async function handleArchive(g: SavingsGoal) {
    const ok = await confirm({ title: '封存目標？', description: g.name, confirmText: '封存' });
    if (!ok) return;
    try {
      await archive.mutateAsync(g.id);
      toast.success('已封存');
    } catch (err) {
      console.error('[goalArchive]', err);
      toast.error(err instanceof Error ? err.message : '目標封存失敗');
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            {scoped ? <HeartHandshake className="size-4" /> : <Target className="size-4" />} {scoped ? '共同目標' : '目標儲蓄'}
          </CardTitle>
          <Button size="sm" variant="outline" onClick={startNew} disabled={!canManage}><Plus className="size-4" /> 新增</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? <p className="text-sm text-muted-foreground">載入中…</p> : goals.length === 0 ? (
            <p className="text-sm text-muted-foreground">{scoped ? '還沒有共同目標 — 例如「旅遊基金 NT$ 100,000」，兩人都能存入' : '尚未建立任何目標 — 例如「2027 出國基金 NT$ 200,000」'}</p>
          ) : (
            goals.map((g) => (
              <GoalRow
                key={g.id}
                goal={g}
                household={g.householdId && household?.id === g.householdId ? household : null}
                canManage={canManage}
                onEdit={() => { if (canManage) setEditing({ ...g }); }}
                onArchive={() => void handleArchive(g)}
                onAddContrib={() => setContribFor(g)}
              />
            ))
          )}
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        title={editing && editing.id ? '編輯目標' : '新增目標'}
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
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例：日本旅遊基金" autoFocus />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><Label>目標金額（TWD）</Label>
                <Input type="number" inputMode="decimal" value={Number.isFinite(editing.targetTWD) ? editing.targetTWD : ''}
                  onChange={(e) => setEditing({ ...editing, targetTWD: Number(e.target.value) })} />
              </div>
              <div><Label>目標日期（選填）</Label>
                <DatePicker value={editing.targetDate ?? null} onChange={(d) => setEditing({ ...editing, targetDate: d })} />
              </div>
            </div>
            <div>
              <Label>每月計畫存入（TWD，選填）</Label>
              <Input type="number" inputMode="decimal" value={editing.monthlyPlanTWD ?? ''} placeholder={(() => { const r = requiredMonthlyTWD(editing); return r != null && r > 0 ? `依目標日期需 ${Math.round(r).toLocaleString()} / 月` : '例：5000'; })()}
                onChange={(e) => setEditing({ ...editing, monthlyPlanTWD: e.target.value === '' ? null : Number(e.target.value) })} />
              {editing.householdId && household ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  共同目標：依分攤比例 {household.memberIds.map((id) => `${household.members[id]?.displayName ?? id} ${Math.round(((editing.monthlyPlanTWD ?? 0) * (household.splitRatio[id] ?? 0)) / 100).toLocaleString()}`).join(' · ')} / 月
                </p>
              ) : null}
            </div>
            {household && !scoped ? (
              <label className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <span>
                  <span className="font-medium">共同目標</span>
                  <span className="block text-xs text-muted-foreground">放進「{household.name}」，兩人都能存入、看到進度</span>
                </span>
                <Switch
                  checked={Boolean(editing.householdId)}
                  onCheckedChange={(v) => setEditing({ ...editing, householdId: v ? household.id : null })}
                />
              </label>
            ) : null}
            <div>
              <Label>顏色</Label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button key={c} type="button" onClick={() => setEditing({ ...editing, color: c })}
                    className={cn('size-7 rounded-full border-2 transition-transform',
                      editing.color === c ? 'scale-110 ring-2 ring-offset-2 ring-offset-background' : 'border-transparent')}
                    style={{ backgroundColor: c, borderColor: c }} aria-label={c} />
                ))}
              </div>
            </div>
          </div>
        )}
      </ResponsiveDialog>

      <ResponsiveDialog
        open={!!contribFor}
        onOpenChange={(o) => { if (!o) setContribFor(null); }}
        title={contribFor ? `${contribFor.name} — 紀錄存入` : '紀錄存入'}
      >
        {contribFor && <ContributionForm goal={contribFor} household={contribFor.householdId && household?.id === contribFor.householdId ? household : null} onClose={() => setContribFor(null)} />}
      </ResponsiveDialog>
    </>
  );
}

function GoalRow({
  goal, household, canManage, onEdit, onArchive, onAddContrib,
}: {
  goal: SavingsGoal;
  household: Household | null;
  canManage: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onAddContrib: () => void;
}) {
  const eta = useGoalEta(goal);
  const { data: contribs = [] } = useGoalContribs(household || goal.monthlyPlanTWD ? goal.id : null);
  const monthRange = useMemo(() => { const n = nowTW(); return monthTWRange(n.getFullYear(), n.getMonth() + 1); }, []);
  const thisMonthTWD = useMemo(
    () => contribs.filter((c) => c.date >= monthRange.start && c.date <= monthRange.end).reduce((s, c) => s + c.amountTWD, 0),
    [contribs, monthRange],
  );
  const required = requiredMonthlyTWD(goal);
  const byMember = useMemo(() => {
    if (!household) return [];
    const sums: Record<string, number> = {};
    for (const c of contribs) if (c.byUid) sums[c.byUid] = (sums[c.byUid] ?? 0) + c.amountTWD;
    return household.memberIds.map((id) => ({ id, name: household.members[id]?.displayName ?? id, sum: sums[id] ?? 0 }));
  }, [household, contribs]);
  const pct = goal.targetTWD ? Math.min(100, (goal.currentTWD / goal.targetTWD) * 100) : 0;
  const reached = pct >= 100;
  const targetMissed = goal.targetDate && eta.date && eta.date.getTime() > goal.targetDate.getTime();

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: (goal.color ?? '#10b981') + '20', color: goal.color ?? '#10b981' }}>
          {goal.name.toLowerCase().includes('出國') || goal.name.toLowerCase().includes('旅') ? <Plane className="size-4" /> : <Target className="size-4" />}
        </span>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onEdit}>
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{goal.name}</span>
            {goal.householdId ? <Badge variant="secondary" className="text-[10px]">共同</Badge> : null}
            {reached ? <Badge variant="success" className="text-[10px]">達成</Badge> : null}
            {targetMissed ? <Badge variant="destructive" className="text-[10px]">恐落後</Badge> : null}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatCurrency(goal.currentTWD)} / {formatCurrency(goal.targetTWD)} ({formatPercent(pct, 0)})
            {goal.targetDate ? ` · 截止 ${formatTW(goal.targetDate, 'yyyy/MM/dd')}` : ''}
          </div>
        </button>
        <Button size="icon-sm" variant="ghost" onClick={onArchive} aria-label="封存" disabled={!canManage}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Progress value={pct} className="mt-2 h-1.5" />
      {byMember.length > 0 ? (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {byMember.map((m) => `${m.name} ${formatCurrency(m.sum)}`).join(' · ')}
        </div>
      ) : null}
      {goal.monthlyPlanTWD ? (
        <div className={cn('mt-1 text-[11px]', thisMonthTWD >= goal.monthlyPlanTWD ? 'text-success' : 'text-muted-foreground')}>
          本月已存 {formatCurrency(thisMonthTWD)} / 計畫 {formatCurrency(goal.monthlyPlanTWD)}
          {required != null && required > goal.monthlyPlanTWD ? ` · 要準時達標需 ${formatCurrency(required)} / 月` : ''}
        </div>
      ) : required != null && required > 0 && !reached ? (
        <div className="mt-1 text-[11px] text-muted-foreground">要在目標日期前達標，每月需存 {formatCurrency(required)}</div>
      ) : null}
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {eta.monthsLeft > 0 && eta.date
            ? `預估 ${eta.monthsLeft.toFixed(1)} 個月達成 (${formatTW(eta.date, 'yyyy/MM')})`
            : eta.monthsLeft === 0 ? '已達成' : '尚無存入紀錄'}
        </span>
        <Button size="sm" variant="outline" onClick={onAddContrib} disabled={!canManage}><Plus className="size-3" /> 存入</Button>
      </div>
    </div>
  );
}

function ContributionForm({ goal, household, onClose }: { goal: SavingsGoal; household: Household | null; onClose: () => void }) {
  const { user } = useAuth();
  const [date, setDate] = useState<Date>(new Date());
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const add = useAddContribution();
  const { data: contribs = [] } = useGoalContribs(goal.id);
  const del = useDeleteContribution();

  async function submit() {
    const v = Number(amount);
    if (!v || v <= 0) { toast.error('請輸入有效金額'); return; }
    try {
      await add.mutateAsync({
        goalId: goal.id,
        input: { date, amountTWD: v, note: note.trim() || null, byUid: goal.householdId ? user?.uid ?? null : null },
      });
      toast.success('已紀錄');
      setAmount('');
      setNote('');
      setDate(new Date());
    } catch (err) {
      console.error('[goalContributionSave]', err);
      toast.error(err instanceof Error ? err.message : '存入紀錄失敗');
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><Label>金額</Label>
          <Input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5000" autoFocus />
        </div>
        <div><Label>日期</Label>
          <DatePicker value={date} onChange={(d) => d && setDate(d)} clearable={false} />
        </div>
      </div>
      <div><Label>備註</Label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：Q2 獎金撥入" />
      </div>
      <Button onClick={() => void submit()} disabled={add.isPending} className="w-full">紀錄存入</Button>
      <div className="text-xs font-medium">過去紀錄</div>
      {contribs.length === 0 ? <p className="text-xs text-muted-foreground">尚無紀錄</p> : (
        <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm">
          {contribs.slice(0, 50).map((c) => (
            <li key={c.id} className="flex items-center gap-2 p-2">
              <span className="text-xs text-muted-foreground">{formatTW(c.date, 'yyyy/MM/dd')}</span>
              <span className="flex-1 tabular-nums">+{formatCurrency(c.amountTWD)}</span>
              {household && c.byUid ? <span className="text-xs text-muted-foreground">{household.members[c.byUid]?.displayName ?? '?'}</span> : null}
              {c.note ? <span className="truncate text-xs text-muted-foreground">{c.note}</span> : null}
              <Button size="icon-sm" variant="ghost" onClick={() => void del.mutateAsync({ goalId: goal.id, contribId: c.id, amountTWD: c.amountTWD })} aria-label="刪除">
                <Trash2 className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="outline" onClick={onClose} className="w-full">關閉</Button>
    </div>
  );
}
