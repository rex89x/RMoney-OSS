import { useEffect, useMemo, useState } from 'react';
import {
  Area, AreaChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Loader2, Pencil, Target } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useAuth } from '@/hooks/use-auth';
import { cn, formatCurrency } from '@/lib/utils';
import { addTWCalendarMonths, daysBetweenTWDates, formatTW } from '@/lib/tz';
import { useUpdateHousehold } from '@/features/household/hooks';
import { memberColor } from '@/features/household/entries';
import { memberCan, type Household } from '@/features/household/types';
import { monthsToTarget, projectGrowth, requiredMonthly } from '../calc';
import { JointPlanFormSchema } from '../schema';

interface JointPlanCardProps {
  household: Household;
  currentValueTWD: number;
}

const DEFAULT_HORIZON_MONTHS = 60;
const PROJECTION_COLOR = '#3b82f6';
const CONTRIBUTED_COLOR = '#6b7280';

/** 共同投資目標：進度、每人每月投入、月複利試算圖 */
export function JointPlanCard({ household, currentValueTWD }: JointPlanCardProps) {
  const { user } = useAuth();
  const canEdit = memberCan(household, user?.uid, 'canManageInvestments');
  const plan = household.investmentPlan ?? null;
  const [editOpen, setEditOpen] = useState(false);

  const monthlyTotal = plan ? household.memberIds.reduce((s, id) => s + (plan.monthlyContributionTWD[id] ?? 0), 0) : 0;
  const monthsLeft = plan?.targetDate
    ? Math.max(0, Math.round(daysBetweenTWDates(new Date(), plan.targetDate) / 30.4375))
    : null;
  const horizon = monthsLeft != null && monthsLeft > 0 ? monthsLeft : DEFAULT_HORIZON_MONTHS;

  const series = useMemo(() => {
    if (!plan) return [];
    const now = new Date();
    const pts = projectGrowth(currentValueTWD, monthlyTotal, plan.expectedAnnualReturnPct, horizon);
    // 點太多時抽樣（pitfall #13：> 500 點會卡），最多約 120 點
    const step = Math.max(1, Math.ceil(pts.length / 120));
    return pts
      .filter((_p, i) => i % step === 0 || i === pts.length - 1)
      .map((p) => ({
        label: formatTW(addTWCalendarMonths(now, p.month), 'yy/MM'),
        projected: Math.round(p.projectedTWD),
        contributed: Math.round(p.contributedTWD),
      }));
  }, [plan, currentValueTWD, monthlyTotal, horizon]);

  if (!plan) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><Target className="size-4" /> 共同投資目標</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            設一個兩個人一起努力的目標（例如「五年存到 300 萬」），填上每人每月想投入多少，就會試算什麼時候達標、每月還差多少。
          </p>
          {canEdit ? (
            <Button onClick={() => setEditOpen(true)}><Target className="size-4" /> 設定目標</Button>
          ) : <p className="text-xs text-muted-foreground">建立者還沒設定目標。</p>}
        </CardContent>
        <PlanDialog household={household} open={editOpen} onOpenChange={setEditOpen} />
      </Card>
    );
  }

  const pct = plan.targetAmountTWD > 0 ? Math.min(100, (currentValueTWD / plan.targetAmountTWD) * 100) : 0;
  const need = monthsLeft != null ? requiredMonthly(currentValueTWD, plan.targetAmountTWD, plan.expectedAnnualReturnPct, monthsLeft) : null;
  const eta = monthsToTarget(currentValueTWD, monthlyTotal, plan.expectedAnnualReturnPct, plan.targetAmountTWD);
  const onTrack = need != null ? monthlyTotal >= need - 1 : null;
  const projectedEnd = series[series.length - 1]?.projected ?? currentValueTWD;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><Target className="size-4" /> {plan.name}</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            目標 {formatCurrency(plan.targetAmountTWD)}
            {plan.targetDate ? ` · ${formatTW(plan.targetDate, 'yyyy/MM')} 前` : ''}
            {` · 年化假設 ${plan.expectedAnnualReturnPct}%`}
          </p>
        </div>
        {canEdit ? (
          <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}><Pencil className="size-3.5" /> 編輯</Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-2xl font-semibold tabular-nums">{formatCurrency(currentValueTWD)}</span>
            <span className="tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
          </div>
          <Progress value={pct} className="mt-1 h-2" />
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <Stat label="兩人每月投入" value={formatCurrency(monthlyTotal)} hint={household.memberIds.map((id) => `${household.members[id]?.displayName ?? ''} ${formatCurrency(plan.monthlyContributionTWD[id] ?? 0)}`).join(' · ')} />
          <Stat
            label={monthsLeft != null ? '要準時達標每月需' : '照目前投入'}
            value={need != null ? formatCurrency(need) : eta != null ? `${eta} 個月後達標` : '600 個月內達不到'}
            hint={onTrack == null ? undefined : onTrack ? '目前的投入足夠' : `每月還差 ${formatCurrency(Math.max(0, (need ?? 0) - monthlyTotal))}`}
            tone={onTrack == null ? 'plain' : onTrack ? 'good' : 'warn'}
          />
          <Stat
            label="預估達標時間"
            value={eta == null ? '達不到' : eta === 0 ? '已達標' : formatTW(addTWCalendarMonths(new Date(), eta), 'yyyy/MM')}
            hint={`試算 ${horizon} 個月後約 ${formatCurrency(projectedEnd)}`}
          />
        </div>

        {series.length > 1 ? (
          <figure>
            <div className="h-[220px]" role="img" aria-label={`試算：${horizon} 個月後預估 ${formatCurrency(projectedEnd)}，目標 ${formatCurrency(plan.targetAmountTWD)}`}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                    tickFormatter={(v: number) => (v >= 10000 ? `${Math.round(v / 10000)}萬` : String(v))}
                  />
                  <Tooltip
                    formatter={(value: number, name: string) => [formatCurrency(value), name]}
                    contentStyle={{
                      background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8,
                      fontSize: 12, color: 'hsl(var(--popover-foreground))',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine
                    y={plan.targetAmountTWD}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="4 4"
                    label={{ value: '目標', position: 'insideTopLeft', fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  />
                  <Area type="monotone" dataKey="contributed" name="累計投入本金" stroke={CONTRIBUTED_COLOR} fill={CONTRIBUTED_COLOR} fillOpacity={0.08} strokeWidth={2} dot={false} />
                  <Area type="monotone" dataKey="projected" name="預估市值" stroke={PROJECTION_COLOR} fill={PROJECTION_COLOR} fillOpacity={0.15} strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <figcaption className="mt-1 text-[11px] text-muted-foreground">
              以目前市值 + 每月投入、年化 {plan.expectedAnnualReturnPct}% 月複利試算，只是規劃參考，不代表實際報酬。
            </figcaption>
          </figure>
        ) : null}
      </CardContent>
      <PlanDialog household={household} open={editOpen} onOpenChange={setEditOpen} />
    </Card>
  );
}

function Stat({ label, value, hint, tone = 'plain' }: { label: string; value: string; hint?: string | undefined; tone?: 'plain' | 'good' | 'warn' }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', tone === 'good' && 'text-success', tone === 'warn' && 'text-warning')}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function PlanDialog({ household, open, onOpenChange }: { household: Household; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { user } = useAuth();
  const update = useUpdateHousehold();
  const plan = household.investmentPlan ?? null;
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [targetDate, setTargetDate] = useState<Date | null>(null);
  const [annual, setAnnual] = useState('5');
  const [monthly, setMonthly] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(plan?.name ?? '共同投資目標');
    setTarget(plan ? String(plan.targetAmountTWD) : '');
    setTargetDate(plan?.targetDate ?? addTWCalendarMonths(new Date(), DEFAULT_HORIZON_MONTHS));
    setAnnual(String(plan?.expectedAnnualReturnPct ?? 5));
    setMonthly(Object.fromEntries(household.memberIds.map((id) => [id, String(plan?.monthlyContributionTWD[id] ?? 0)])));
    setError(null);
  }, [open, plan, household.memberIds]);

  async function handleSave() {
    const parsed = JointPlanFormSchema.safeParse({
      name,
      targetAmountTWD: target === '' ? undefined : Number(target),
      targetDate,
      expectedAnnualReturnPct: annual === '' ? undefined : Number(annual),
      monthlyContributionTWD: Object.fromEntries(household.memberIds.map((id) => [id, Number(monthly[id] || 0)])),
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '資料不正確'); return; }
    try {
      await update.mutateAsync({ id: household.id, patch: { investmentPlan: parsed.data } });
      toast.success('已儲存共同投資目標');
      onOpenChange(false);
    } catch (err) {
      console.error('[saveJointPlan]', err);
    }
  }

  async function handleClear() {
    try {
      await update.mutateAsync({ id: household.id, patch: { investmentPlan: null } });
      toast.success('已移除目標');
      onOpenChange(false);
    } catch (err) {
      console.error('[clearJointPlan]', err);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => { if (!update.isPending) onOpenChange(next); }}
      title="共同投資目標"
      description="兩個人一起存的目標金額與每月投入"
      contentClassName="sm:max-w-md"
      footer={(
        <div className="flex gap-2">
          {plan ? <Button type="button" variant="ghost" className="h-12" onClick={() => void handleClear()} disabled={update.isPending}>移除</Button> : null}
          <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => onOpenChange(false)} disabled={update.isPending}>取消</Button>
          <Button type="button" className="h-12 flex-[2]" onClick={() => void handleSave()} disabled={update.isPending}>
            {update.isPending ? <Loader2 className="size-4 animate-spin" /> : null} 儲存
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="jp-name">名稱</Label>
          <Input id="jp-name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1" placeholder="買房頭期款" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="jp-target">目標金額（TWD）</Label>
            <Input id="jp-target" type="number" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} className="mt-1 tabular-nums" placeholder="3000000" />
          </div>
          <div>
            <Label>目標日期</Label>
            <div className="mt-1"><DatePicker value={targetDate ?? undefined} onChange={(v) => setTargetDate(v ?? null)} /></div>
          </div>
        </div>
        <div>
          <Label htmlFor="jp-annual">年化報酬假設（%）</Label>
          <Input id="jp-annual" type="number" inputMode="decimal" value={annual} onChange={(e) => setAnnual(e.target.value)} className="mt-1 tabular-nums" />
          <p className="mt-1 text-xs text-muted-foreground">市值型 ETF 長期常用 5–7% 做保守試算。</p>
        </div>
        <div>
          <Label>每人每月投入（TWD）</Label>
          <div className="mt-1 space-y-2">
            {household.memberIds.map((id) => (
              <label key={id} className="flex items-center justify-between gap-2 text-sm">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: memberColor(household, id) }} aria-hidden />
                  {household.members[id]?.displayName ?? id}{id === user?.uid ? '（我）' : ''}
                </span>
                <Input
                  type="number"
                  inputMode="decimal"
                  className="h-9 w-32 text-right tabular-nums"
                  value={monthly[id] ?? ''}
                  onChange={(e) => setMonthly({ ...monthly, [id]: e.target.value })}
                />
              </label>
            ))}
          </div>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </ResponsiveDialog>
  );
}
