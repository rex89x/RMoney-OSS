import { useEffect, useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { AccountSelect, useAccounts } from '@/features/accounts';
import { useCategories } from '@/features/ledger/hooks';
import { dateInputToTWDate, formatDateInput, formatTW, startOfTWDay } from '@/lib/tz';
import { formatCurrency } from '@/lib/utils';
import { useCreateInstallmentPlan } from '../hooks';
import { InstallmentPlanFormSchema, type InstallmentPlanFormValues, type InstallmentPlanFormInput } from '../schema';
import { installmentPeriodDate, splitInstallmentAmounts } from '../schedule';
import { INSTALLMENT_PERIOD_OPTIONS } from '../types';

interface InstallmentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function defaultValues(): InstallmentPlanFormValues {
  return {
    title: '',
    totalAmountTWD: 0,
    periods: 12,
    feeTWD: 0,
    cardAccountId: '',
    category: '',
    startDate: startOfTWDay(),
    note: '',
  };
}

/** DatePicker 回傳的是瀏覽器本地午夜；轉成台北當天 00:00（pitfall #21） */
function toTWDay(d: Date): Date {
  return dateInputToTWDate(formatDateInput(d)) ?? startOfTWDay(d);
}

export function InstallmentFormDialog({ open, onOpenChange }: InstallmentFormDialogProps) {
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();
  const create = useCreateInstallmentPlan();
  const cardAccounts = useMemo(
    () => accounts.filter((a) => a.type === 'credit_card' && a.active !== false && !a.archivedAt),
    [accounts],
  );
  const expenseCategories = useMemo(
    () => categories.filter((c) => c.type === 'expense' && !c.archivedAt),
    [categories],
  );

  const form = useForm<InstallmentPlanFormInput, unknown, InstallmentPlanFormValues>({
    resolver: zodResolver(InstallmentPlanFormSchema),
    defaultValues: defaultValues(),
  });
  const { register, control, handleSubmit, formState: { errors }, reset, watch, setValue, getValues } = form;

  useEffect(() => {
    if (open) reset(defaultValues());
  }, [open, reset]);

  // 預設帶第一張信用卡 / 第一個支出類別
  useEffect(() => {
    if (!open) return;
    const firstCard = cardAccounts[0];
    if (!getValues('cardAccountId') && firstCard) setValue('cardAccountId', firstCard.id);
    const firstCategory = expenseCategories.find((c) => c.key === 'shopping') ?? expenseCategories[0];
    if (!getValues('category') && firstCategory) setValue('category', firstCategory.key);
  }, [open, cardAccounts, expenseCategories, getValues, setValue]);

  const total = Number(watch('totalAmountTWD')) || 0;
  const fee = Number(watch('feeTWD')) || 0;
  const periods = Math.round(Number(watch('periods')) || 0);
  const startDate = watch('startDate');
  const preview = useMemo(() => {
    if (total <= 0 || periods < 2) return null;
    const amounts = splitInstallmentAmounts(total + fee, periods);
    return {
      first: amounts[0] ?? 0,
      last: amounts[amounts.length - 1] ?? 0,
      lastDate: startDate ? installmentPeriodDate(startDate, periods) : null,
    };
  }, [total, fee, periods, startDate]);

  async function onSubmit(values: InstallmentPlanFormValues) {
    try {
      await create.mutateAsync({
        title: values.title,
        totalAmountTWD: values.totalAmountTWD,
        periods: values.periods,
        feeTWD: values.feeTWD,
        cardAccountId: values.cardAccountId,
        category: values.category,
        startDate: values.startDate,
        note: values.note?.trim() || null,
      });
      onOpenChange(false);
    } catch (err) {
      // toast 已在 mutation onError 處理
      console.error('[installmentFormSubmit]', err);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="新增分期"
      description="每期在入帳日自動記一筆支出到信用卡帳戶（Apps Script 每天 01:00 執行）。"
      footer={
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>取消</Button>
          <Button className="flex-1" onClick={() => void handleSubmit(onSubmit)()} disabled={create.isPending}>
            建立
          </Button>
        </div>
      }
    >
      {cardAccounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          尚未建立信用卡帳戶。先到「設定 → 帳戶」新增信用卡，才能建立分期。
        </p>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void handleSubmit(onSubmit)(); }}>
          <div>
            <Label htmlFor="inst-title">品名</Label>
            <Input id="inst-title" placeholder="MacBook / 冷氣 / 機票" autoFocus {...register('title')} />
            {errors.title ? <p className="mt-1 text-xs text-destructive">{errors.title.message}</p> : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="inst-total">總金額（TWD）</Label>
              <Input id="inst-total" type="number" inputMode="numeric" {...register('totalAmountTWD')} />
              {errors.totalAmountTWD ? <p className="mt-1 text-xs text-destructive">{errors.totalAmountTWD.message}</p> : null}
            </div>
            <div>
              <Label htmlFor="inst-fee">手續費 / 利息總額</Label>
              <Input id="inst-fee" type="number" inputMode="numeric" placeholder="0% 分期填 0" {...register('feeTWD')} />
              {errors.feeTWD ? <p className="mt-1 text-xs text-destructive">{errors.feeTWD.message}</p> : null}
            </div>
          </div>
          <div>
            <Label htmlFor="inst-periods">期數</Label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {INSTALLMENT_PERIOD_OPTIONS.map((n) => (
                <Button
                  key={n}
                  type="button"
                  size="sm"
                  variant={periods === n ? 'default' : 'outline'}
                  onClick={() => setValue('periods', n, { shouldValidate: true })}
                >
                  {n} 期
                </Button>
              ))}
              <Input id="inst-periods" type="number" inputMode="numeric" className="h-9 w-20" {...register('periods')} />
            </div>
            {errors.periods ? <p className="mt-1 text-xs text-destructive">{errors.periods.message}</p> : null}
          </div>
          <div>
            <Label>信用卡</Label>
            <Controller
              control={control}
              name="cardAccountId"
              render={({ field }) => (
                <AccountSelect value={field.value} onValueChange={field.onChange} accounts={cardAccounts} placeholder="選擇信用卡帳戶" />
              )}
            />
            {errors.cardAccountId ? <p className="mt-1 text-xs text-destructive">{errors.cardAccountId.message}</p> : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>類別</Label>
              <Controller
                control={control}
                name="category"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="mt-1 h-11"><SelectValue placeholder="選擇類別" /></SelectTrigger>
                    <SelectContent>
                      {expenseCategories.map((c) => (
                        <SelectItem key={c.key} value={c.key}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.category ? <p className="mt-1 text-xs text-destructive">{errors.category.message}</p> : null}
            </div>
            <div>
              <Label>第 1 期入帳日</Label>
              <div className="mt-1">
                <Controller
                  control={control}
                  name="startDate"
                  render={({ field }) => (
                    <DatePicker value={field.value} onChange={(d) => { if (d) field.onChange(toTWDay(d)); }} clearable={false} />
                  )}
                />
              </div>
            </div>
          </div>
          <div>
            <Label htmlFor="inst-note">備註（選填）</Label>
            <Textarea id="inst-note" rows={2} {...register('note')} />
          </div>
          {preview ? (
            <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
              每期 <span className="font-medium text-foreground">{formatCurrency(preview.first)}</span>
              {preview.last !== preview.first ? <>，最後一期 {formatCurrency(preview.last)}</> : null}
              {preview.lastDate ? <> · 繳到 {formatTW(preview.lastDate, 'yyyy/MM/dd')}</> : null}
              {fee > 0 ? <> · 含手續費 {formatCurrency(fee)}</> : null}
            </div>
          ) : null}
        </form>
      )}
    </ResponsiveDialog>
  );
}
