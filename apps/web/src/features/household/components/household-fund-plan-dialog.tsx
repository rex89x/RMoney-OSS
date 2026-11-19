import { useEffect, useMemo } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { formatCurrency } from '@/lib/utils';
import { useCategories } from '@/features/ledger/hooks';
import { useUpdateHousehold } from '../hooks';
import {
  HouseholdFundPlanSchema,
  emptyFundPlan,
  newFundPlanItemId,
  type HouseholdFundPlanFormValues,
} from '../fund-plan';
import type { Household, HouseholdFundPlan } from '../types';
import { MemberChip } from './member-chip';

interface HouseholdFundPlanDialogProps {
  household: Household;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function planToForm(plan: HouseholdFundPlan, household: Household): HouseholdFundPlanFormValues {
  return {
    enabled: plan.enabled,
    dayOfMonth: plan.dayOfMonth,
    startMonth: plan.startMonth,
    autoRecord: plan.autoRecord,
    contributions: Object.fromEntries(household.memberIds.map((uid) => [uid, plan.contributions[uid] ?? 0])),
    fixedExpenses: plan.fixedExpenses.map((item) => ({ ...item })),
  };
}

/** 設定公基金每月計畫：每人每月投入多少、哪天存、哪些支出固定從公基金扣 */
export function HouseholdFundPlanDialog({ household, open, onOpenChange }: HouseholdFundPlanDialogProps) {
  const update = useUpdateHousehold();
  const { data: categories = [] } = useCategories();
  const expenseCats = useMemo(() => categories.filter((c) => c.type === 'expense' && !c.archivedAt), [categories]);
  const form = useForm<HouseholdFundPlanFormValues>({
    resolver: zodResolver(HouseholdFundPlanSchema),
    defaultValues: planToForm(household.fundPlan ?? emptyFundPlan(household, new Date()), household),
  });
  const fixed = useFieldArray({ control: form.control, name: 'fixedExpenses' });

  useEffect(() => {
    if (open) form.reset(planToForm(household.fundPlan ?? emptyFundPlan(household, new Date()), household));
    // household 物件每次 snapshot 都是新的；只在開啟時重置，避免編輯到一半被蓋掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const contributions = form.watch('contributions');
  const fixedValues = form.watch('fixedExpenses');
  const inflow = Object.values(contributions ?? {}).reduce<number>((sum, value) => sum + (Number(value) || 0), 0);
  const outflow = (fixedValues ?? []).filter((item) => item.enabled).reduce((sum, item) => sum + (Number(item.amountTWD) || 0), 0);

  async function submit(values: HouseholdFundPlanFormValues) {
    try {
      const parsed = HouseholdFundPlanSchema.parse(values);
      const plan: HouseholdFundPlan = {
        enabled: parsed.enabled,
        dayOfMonth: parsed.dayOfMonth,
        startMonth: parsed.startMonth,
        autoRecord: parsed.autoRecord,
        contributions: Object.fromEntries(
          household.memberIds.map((uid) => [uid, Math.max(0, Math.round(parsed.contributions[uid] ?? 0))]),
        ),
        fixedExpenses: parsed.fixedExpenses.map((item) => ({ ...item, name: item.name.trim() })),
      };
      await update.mutateAsync({ id: household.id, patch: { fundPlan: plan } });
      toast.success('已儲存公基金每月計畫');
      onOpenChange(false);
    } catch (error) {
      console.error('[saveHouseholdFundPlan]', error);
    }
  }

  const errors = form.formState.errors;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => { if (!update.isPending) onOpenChange(next); }}
      title="公基金每月計畫"
      description="兩人每月固定投入，部分支出固定從公基金扣款"
      contentClassName="sm:max-w-xl"
      footer={(
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => onOpenChange(false)} disabled={update.isPending}>取消</Button>
          <Button type="submit" form="fund-plan-form" className="h-12 flex-[2]" disabled={update.isPending}>
            {update.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            儲存計畫
          </Button>
        </div>
      )}
    >
      <form id="fund-plan-form" className="space-y-5" onSubmit={form.handleSubmit((values) => void submit(values))}>
        <label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
          <span>
            <span className="font-medium">啟用每月計畫</span>
            <span className="block text-xs text-muted-foreground">關閉後保留設定，但不提醒也不自動記錄</span>
          </span>
          <Controller control={form.control} name="enabled" render={({ field }) => (
            <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="啟用每月計畫" />
          )} />
        </label>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">每月固定存入</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="fund-plan-day">每月幾號存</Label>
              <Input id="fund-plan-day" type="number" inputMode="numeric" min={1} max={31} className="mt-1" {...form.register('dayOfMonth')} />
              {errors.dayOfMonth ? <p className="mt-1 text-xs text-destructive">{errors.dayOfMonth.message}</p> : (
                <p className="mt-1 text-[11px] text-muted-foreground">超過當月天數就用月底</p>
              )}
            </div>
            <div>
              <Label htmlFor="fund-plan-start">從哪個月開始</Label>
              <Input id="fund-plan-start" type="month" className="mt-1" {...form.register('startMonth')} />
              {errors.startMonth ? <p className="mt-1 text-xs text-destructive">{errors.startMonth.message}</p> : (
                <p className="mt-1 text-[11px] text-muted-foreground">之前的月份不會回補</p>
              )}
            </div>
          </div>
          <div className="space-y-2">
            {household.memberIds.map((uid) => (
              <div key={uid} className="flex items-center gap-3">
                <MemberChip member={household.members[uid]} className="min-w-0 flex-1 text-sm" />
                <div className="flex w-40 shrink-0 items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">NT$</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    aria-label={`${household.members[uid]?.displayName ?? uid} 每月投入`}
                    className="tabular-nums"
                    {...form.register(`contributions.${uid}` as const)}
                  />
                </div>
              </div>
            ))}
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 p-3 text-sm">
            <span>
              <span className="font-medium">到日自動記錄存入</span>
              <span className="block text-xs text-muted-foreground">
                適合已設定銀行自動轉帳；關閉時只顯示「待存入」，由各自按「記錄本月存入」
              </span>
            </span>
            <Controller control={form.control} name="autoRecord" render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="到日自動記錄存入" />
            )} />
          </label>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">固定從公基金扣款</h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => fixed.append({
                id: newFundPlanItemId(),
                name: '',
                amountTWD: 0,
                categoryKey: expenseCats[0]?.key ?? '',
                dayOfMonth: Number(form.getValues('dayOfMonth')) || 5,
                enabled: true,
              })}
              disabled={fixed.fields.length >= 20}
            >
              <Plus className="size-4" /> 新增
            </Button>
          </div>
          {fixed.fields.length === 0 ? (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              例如房租、水電、網路、共同訂閱。到日會自動從公基金記一筆共同支出（公基金付款、不分攤欠款），之後一樣可以在交易列表修改或刪除。
            </p>
          ) : (
            <ul className="space-y-2">
              {fixed.fields.map((field, index) => {
                const itemErrors = errors.fixedExpenses?.[index];
                return (
                  <li key={field.id} className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Input placeholder="名稱，例：房租" className="min-w-0 flex-1" {...form.register(`fixedExpenses.${index}.name` as const)} />
                      <Controller control={form.control} name={`fixedExpenses.${index}.enabled` as const} render={({ field: enabledField }) => (
                        <Switch checked={enabledField.value} onCheckedChange={enabledField.onChange} aria-label="啟用此扣款" />
                      )} />
                      <Button type="button" size="icon-sm" variant="ghost" aria-label="移除此扣款" onClick={() => fixed.remove(index)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_6rem]">
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        placeholder="金額"
                        aria-label="金額"
                        className="tabular-nums"
                        {...form.register(`fixedExpenses.${index}.amountTWD` as const)}
                      />
                      <Controller control={form.control} name={`fixedExpenses.${index}.categoryKey` as const} render={({ field: catField }) => (
                        <Select value={catField.value} onValueChange={catField.onChange}>
                          <SelectTrigger aria-label="類別"><SelectValue placeholder="類別" /></SelectTrigger>
                          <SelectContent>
                            {expenseCats.map((c) => <SelectItem key={c.key} value={c.key}>{c.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )} />
                      <div className="col-span-2 flex items-center gap-1.5 sm:col-span-1">
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={31}
                          aria-label="每月幾號"
                          className="tabular-nums"
                          {...form.register(`fixedExpenses.${index}.dayOfMonth` as const)}
                        />
                        <span className="shrink-0 text-xs text-muted-foreground">號</span>
                      </div>
                    </div>
                    {itemErrors ? (
                      <p className="text-xs text-destructive">
                        {itemErrors.name?.message ?? itemErrors.amountTWD?.message ?? itemErrors.categoryKey?.message ?? itemErrors.dayOfMonth?.message}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-3 text-center text-xs">
          <div>
            <div className="text-muted-foreground">每月存入</div>
            <div className="font-semibold tabular-nums text-success">{formatCurrency(inflow)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">固定扣款</div>
            <div className="font-semibold tabular-nums">{formatCurrency(outflow)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">每月可用</div>
            <div className="font-semibold tabular-nums">{formatCurrency(inflow - outflow)}</div>
          </div>
        </div>
      </form>
    </ResponsiveDialog>
  );
}
