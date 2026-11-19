import { useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  Bell,
  CalendarClock,
  CheckCircle2,
  Pencil,
  PiggyBank,
  Plus,
  Save,
  Target,
  TrendingUp,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useConfirm } from '@/components/ui/confirm';
import { cn, formatCurrency, formatPercent } from '@/lib/utils';
import { addTWCalendarYears, formatTW } from '@/lib/tz';
import {
  useArchiveInvestmentPlan,
  useInvestmentPlans,
  useLatestSnapshot,
  useUpsertInvestmentPlan,
} from '../hooks';
import { isRetirementPlan } from '../retirement';
import type { InvestmentPlan, InvestmentPlanFunding, InvestmentPlanRisk } from '../types';

interface PlannerFormState {
  name: string;
  targetAmountTWD: string;
  targetDate: Date;
  monthlyContributionTWD: string;
  expectedAnnualReturnPct: string;
  currentAmountTWD: string;
  fundingSource: InvestmentPlanFunding;
  riskLevel: InvestmentPlanRisk;
  notes: string;
  alertEnabled: boolean;
  isRetirement: boolean;
}

interface PlanMetrics {
  current: number;
  monthsLeft: number;
  projected: number;
  projectedGap: number;
  requiredMonthly: number;
  progressPct: number;
  onTrack: boolean;
}

const RISK_LABEL: Record<InvestmentPlanRisk, string> = {
  conservative: '保守',
  balanced: '平衡',
  growth: '成長',
};

export function InvestmentPlanner() {
  const { data: plans = [], isLoading } = useInvestmentPlans();
  const { data: latest } = useLatestSnapshot();
  const upsert = useUpsertInvestmentPlan();
  const archive = useArchiveInvestmentPlan();
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PlannerFormState>(() => emptyForm());

  const latestPortfolioValue = latest?.totalValueTWD ?? 0;
  const activePlan = plans.find((plan) => plan.id === editingId) ?? null;

  function startCreate(template?: 'retirement') {
    setEditingId('new');
    setForm(template === 'retirement' ? retirementForm() : emptyForm());
  }

  function startEdit(plan: InvestmentPlan) {
    setEditingId(plan.id);
    setForm({
      name: plan.name,
      targetAmountTWD: String(plan.targetAmountTWD),
      targetDate: plan.targetDate,
      monthlyContributionTWD: String(plan.monthlyContributionTWD),
      expectedAnnualReturnPct: String(plan.expectedAnnualReturnPct),
      currentAmountTWD: plan.currentAmountTWD === null ? '' : String(plan.currentAmountTWD),
      fundingSource: plan.fundingSource,
      riskLevel: plan.riskLevel,
      notes: plan.notes ?? '',
      alertEnabled: plan.alertEnabled,
      isRetirement: isRetirementPlan(plan),
    });
  }

  async function savePlan() {
    const parsed = parseForm(form);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    await upsert.mutateAsync({
      plan: parsed.plan,
      id: activePlan?.id,
    });
    setEditingId(null);
  }

  async function archivePlan(plan: InvestmentPlan) {
    const ok = await confirm({
      title: '封存投資計畫',
      description: `${plan.name} 會從追蹤清單移除，歷史資料仍保留。`,
      confirmText: '封存',
    });
    if (ok) await archive.mutateAsync(plan.id);
  }

  const overview = useMemo(() => {
    if (!plans.length) return null;
    const metrics = plans.map((plan) => calcPlanMetrics(plan, latestPortfolioValue));
    const target = plans.reduce((sum, plan) => sum + plan.targetAmountTWD, 0);
    const projected = metrics.reduce((sum, m) => sum + m.projected, 0);
    const required = metrics.reduce((sum, m) => sum + m.requiredMonthly, 0);
    const onTrack = metrics.filter((m) => m.onTrack).length;
    return { target, projected, required, onTrack };
  }, [latestPortfolioValue, plans]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <PlannerKpi label="計畫數" value={`${plans.length}`} icon={Target} />
        <PlannerKpi label="目標總額" value={overview ? formatCurrency(overview.target) : formatCurrency(0)} icon={PiggyBank} />
        <PlannerKpi label="建議月投入" value={overview ? formatCurrency(overview.required) : formatCurrency(0)} icon={TrendingUp} />
        <PlannerKpi
          label="達標狀態"
          value={overview ? `${overview.onTrack}/${plans.length}` : '0/0'}
          icon={CheckCircle2}
          tone={overview && overview.onTrack < plans.length ? 'warn' : 'success'}
        />
      </div>

      {editingId ? (
        <PlanForm
          form={form}
          latestPortfolioValue={latestPortfolioValue}
          isPending={upsert.isPending}
          onChange={setForm}
          onCancel={() => setEditingId(null)}
          onSave={() => void savePlan()}
        />
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => startCreate()} className="w-full sm:w-auto">
            <Plus className="size-4" /> 新增投資計畫
          </Button>
          <Button variant="outline" onClick={() => startCreate('retirement')} className="w-full sm:w-auto">
            <PiggyBank className="size-4" /> 建立退休規劃
          </Button>
        </div>
      )}

      {isLoading ? (
        <Card><CardContent className="p-4 text-sm text-muted-foreground">載入中...</CardContent></Card>
      ) : plans.length === 0 ? (
        <EmptyState icon={Target} title="尚無投資計畫" description="建立退休、買房、教育基金或長期資產目標後，系統會追蹤缺口與每月投入建議。" />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              latestPortfolioValue={latestPortfolioValue}
              onEdit={() => startEdit(plan)}
              onArchive={() => void archivePlan(plan)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanForm({
  form,
  latestPortfolioValue,
  isPending,
  onChange,
  onCancel,
  onSave,
}: {
  form: PlannerFormState;
  latestPortfolioValue: number;
  isPending: boolean;
  onChange: (next: PlannerFormState) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const preview = useMemo(() => {
    const parsed = parseForm(form);
    if (!parsed.ok) return null;
    return calcPlanMetrics(parsed.plan as InvestmentPlan, latestPortfolioValue);
  }, [form, latestPortfolioValue]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="size-4" /> 投資理財規劃
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="計畫名稱">
            <Input value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} placeholder="退休金 / 買房頭期款" />
          </Field>
          <Field label="目標日期">
            <DatePicker value={form.targetDate} onChange={(date) => onChange({ ...form, targetDate: date ?? form.targetDate })} clearable={false} />
          </Field>
          <Field label="目標金額 (TWD)">
            <Input inputMode="decimal" type="number" value={form.targetAmountTWD} onChange={(e) => onChange({ ...form, targetAmountTWD: e.target.value })} />
          </Field>
          <Field label="每月投入 (TWD)">
            <Input inputMode="decimal" type="number" value={form.monthlyContributionTWD} onChange={(e) => onChange({ ...form, monthlyContributionTWD: e.target.value })} />
          </Field>
          <Field label="預期年化報酬 (%)">
            <Input inputMode="decimal" type="number" step="0.1" value={form.expectedAnnualReturnPct} onChange={(e) => onChange({ ...form, expectedAnnualReturnPct: e.target.value })} />
          </Field>
          <Field label="目前金額">
            <Input
              inputMode="decimal"
              type="number"
              value={form.currentAmountTWD}
              onChange={(e) => onChange({ ...form, currentAmountTWD: e.target.value })}
              placeholder={form.fundingSource === 'portfolio' ? `使用投資快照 ${formatCurrency(latestPortfolioValue)}` : '手動輸入目前累積'}
            />
          </Field>
          <Field label="資金來源">
            <Select value={form.fundingSource} onValueChange={(v) => onChange({ ...form, fundingSource: v as InvestmentPlanFunding })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="portfolio">投資組合快照</SelectItem>
                <SelectItem value="manual">手動金額</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="風險屬性">
            <Select value={form.riskLevel} onValueChange={(v) => onChange({ ...form, riskLevel: v as InvestmentPlanRisk })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">保守</SelectItem>
                <SelectItem value="balanced">平衡</SelectItem>
                <SelectItem value="growth">成長</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="備註">
          <Textarea value={form.notes} onChange={(e) => onChange({ ...form, notes: e.target.value })} rows={3} />
        </Field>
        <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
          <span className="flex items-center gap-2"><Bell className="size-4 text-muted-foreground" /> Telegram 月度追蹤提醒</span>
          <Switch checked={form.alertEnabled} onCheckedChange={(checked) => onChange({ ...form, alertEnabled: checked })} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
          <span className="flex items-center gap-2"><PiggyBank className="size-4 text-muted-foreground" /> 這是退休規劃（理財健檢會計入）</span>
          <Switch checked={form.isRetirement} onCheckedChange={(checked) => onChange({ ...form, isRetirement: checked })} />
        </label>
        {preview ? (
          <div className="grid grid-cols-3 gap-2 rounded-md bg-muted/40 p-3 text-xs">
            <Preview label="目前進度" value={formatPercent(preview.progressPct, 1)} />
            <Preview label="預估到期" value={formatCurrency(preview.projected)} />
            <Preview label="建議月投入" value={formatCurrency(preview.requiredMonthly)} />
          </div>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button onClick={onSave} disabled={isPending}>
            <Save className="size-4" /> 儲存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PlanCard({
  plan,
  latestPortfolioValue,
  onEdit,
  onArchive,
}: {
  plan: InvestmentPlan;
  latestPortfolioValue: number;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const metrics = calcPlanMetrics(plan, latestPortfolioValue);
  const chartData = [
    { name: '目前', value: metrics.current },
    { name: '預估', value: metrics.projected },
    { name: '目標', value: plan.targetAmountTWD },
  ];
  return (
    <Card>
      <CardHeader className="space-y-2 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{plan.name}</CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><CalendarClock className="size-3" /> {formatTW(plan.targetDate, 'yyyy/MM/dd')}</span>
              <span>{RISK_LABEL[plan.riskLevel]}</span>
              {plan.alertEnabled ? <span className="inline-flex items-center gap-1"><Bell className="size-3" /> 月度提醒</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label="編輯計畫"><Pencil className="size-4" /></Button>
            <Button size="icon-sm" variant="ghost" onClick={onArchive} aria-label="封存計畫"><Archive className="size-4" /></Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Preview label="目標" value={formatCurrency(plan.targetAmountTWD)} />
          <Preview label="目前" value={formatCurrency(metrics.current)} />
          <Preview label="缺口" value={formatCurrency(Math.max(0, plan.targetAmountTWD - metrics.current))} />
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, metrics.progressPct)}%` }} />
        </div>
        <div className={cn(
          'flex items-start gap-2 rounded-md p-2 text-xs',
          metrics.onTrack ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
        )}>
          {metrics.onTrack ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
          <span>
            {metrics.onTrack
              ? `照目前每月 ${formatCurrency(plan.monthlyContributionTWD)} 投入，預估可達 ${formatCurrency(metrics.projected)}。`
              : `預估缺口 ${formatCurrency(metrics.projectedGap)}，建議每月至少投入 ${formatCurrency(metrics.requiredMonthly)}。`}
          </span>
        </div>
        <div className="h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis width={48} tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v / 10000)}萬`} />
              <Tooltip formatter={(v: number) => [formatCurrency(v), '金額']} />
              <ReferenceLine y={plan.targetAmountTWD} stroke="#64748b" strokeDasharray="4 4" />
              <Bar dataKey="value" fill="#2563eb" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Preview label="剩餘月份" value={`${metrics.monthsLeft}`} />
          <Preview label="年化假設" value={formatPercent(plan.expectedAnnualReturnPct, 1)} />
          <Preview label="目前月投入" value={formatCurrency(plan.monthlyContributionTWD)} />
          <Preview label="需提高" value={formatCurrency(Math.max(0, metrics.requiredMonthly - plan.monthlyContributionTWD))} />
        </div>
        {plan.notes ? <p className="text-xs text-muted-foreground">{plan.notes}</p> : null}
      </CardContent>
    </Card>
  );
}

function PlannerKpi({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  tone?: 'success' | 'warn';
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground"><Icon className="size-3" /> {label}</div>
        <div className={cn(
          'mt-1 truncate text-lg font-semibold tabular-nums',
          tone === 'success' && 'text-emerald-500',
          tone === 'warn' && 'text-amber-500',
        )}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Preview({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-background/70 p-2">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate font-medium tabular-nums">{value}</div>
    </div>
  );
}

function emptyForm(): PlannerFormState {
  return {
    name: '',
    targetAmountTWD: '',
    targetDate: addTWCalendarYears(new Date(), 5),
    monthlyContributionTWD: '',
    expectedAnnualReturnPct: '5',
    currentAmountTWD: '',
    fundingSource: 'portfolio',
    riskLevel: 'balanced',
    notes: '',
    alertEnabled: true,
    isRetirement: false,
  };
}

function retirementForm(): PlannerFormState {
  return {
    ...emptyForm(),
    name: '退休準備金',
    isRetirement: true,
    targetDate: addTWCalendarYears(new Date(), 20),
    expectedAnnualReturnPct: '5',
    riskLevel: 'balanced',
    notes: '請依預計退休年齡、退休後年度支出與其他退休收入，定期檢視目標金額。',
  };
}

function parseForm(form: PlannerFormState):
  | { ok: true; plan: Omit<InvestmentPlan, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'archivedAt'> }
  | { ok: false; error: string } {
  const targetAmountTWD = Number(form.targetAmountTWD);
  const monthlyContributionTWD = Number(form.monthlyContributionTWD);
  const expectedAnnualReturnPct = Number(form.expectedAnnualReturnPct);
  const currentAmountTWD = form.currentAmountTWD.trim() ? Number(form.currentAmountTWD) : null;
  if (!form.name.trim()) return { ok: false, error: '請輸入計畫名稱' };
  if (!Number.isFinite(targetAmountTWD) || targetAmountTWD <= 0) return { ok: false, error: '目標金額必須大於 0' };
  if (!Number.isFinite(monthlyContributionTWD) || monthlyContributionTWD < 0) return { ok: false, error: '每月投入不可小於 0' };
  if (!Number.isFinite(expectedAnnualReturnPct) || expectedAnnualReturnPct < -50 || expectedAnnualReturnPct > 100) {
    return { ok: false, error: '預期年化報酬需介於 -50% 到 100%' };
  }
  if (currentAmountTWD !== null && (!Number.isFinite(currentAmountTWD) || currentAmountTWD < 0)) {
    return { ok: false, error: '目前金額不可小於 0' };
  }
  return {
    ok: true,
    plan: {
      name: form.name.trim(),
      targetAmountTWD,
      targetDate: form.targetDate,
      monthlyContributionTWD,
      expectedAnnualReturnPct,
      currentAmountTWD,
      fundingSource: form.fundingSource,
      riskLevel: form.riskLevel,
      notes: form.notes.trim() || null,
      alertEnabled: form.alertEnabled,
      isRetirement: form.isRetirement,
    },
  };
}

function calcPlanMetrics(plan: InvestmentPlan, latestPortfolioValue: number): PlanMetrics {
  const current = plan.currentAmountTWD ?? (plan.fundingSource === 'portfolio' ? latestPortfolioValue : 0);
  const monthsLeft = Math.max(1, monthsBetween(new Date(), plan.targetDate));
  const monthlyRate = plan.expectedAnnualReturnPct / 100 / 12;
  const projected = futureValue(current, plan.monthlyContributionTWD, monthlyRate, monthsLeft);
  const projectedGap = Math.max(0, plan.targetAmountTWD - projected);
  const requiredMonthly = requiredMonthlyContribution(current, plan.targetAmountTWD, monthlyRate, monthsLeft);
  return {
    current,
    monthsLeft,
    projected,
    projectedGap,
    requiredMonthly,
    progressPct: plan.targetAmountTWD > 0 ? (current / plan.targetAmountTWD) * 100 : 0,
    onTrack: projected >= plan.targetAmountTWD,
  };
}

function monthsBetween(from: Date, to: Date): number {
  const years = to.getFullYear() - from.getFullYear();
  const months = years * 12 + (to.getMonth() - from.getMonth());
  return months + (to.getDate() >= from.getDate() ? 0 : -1);
}

function futureValue(current: number, monthlyContribution: number, monthlyRate: number, months: number): number {
  if (Math.abs(monthlyRate) < 0.000001) return current + monthlyContribution * months;
  const growth = Math.pow(1 + monthlyRate, months);
  return current * growth + monthlyContribution * ((growth - 1) / monthlyRate);
}

function requiredMonthlyContribution(current: number, target: number, monthlyRate: number, months: number): number {
  if (months <= 0) return Math.max(0, target - current);
  if (Math.abs(monthlyRate) < 0.000001) return Math.max(0, (target - current) / months);
  const growth = Math.pow(1 + monthlyRate, months);
  const futureCurrent = current * growth;
  const annuityFactor = (growth - 1) / monthlyRate;
  return Math.max(0, (target - futureCurrent) / annuityFactor);
}
