import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { resolveIcon } from '@/lib/icons';
import { formatCurrency } from '@/lib/utils';
import { useCategories } from '@/features/ledger/hooks';
import { useUpdateHousehold } from '../hooks';
import type { Household } from '../types';

interface HouseholdBudgetDialogProps {
  household: Household;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 近 3 個月各類別平均，當作輸入提示 */
  averages?: Record<string, number>;
}

function parseAmount(value: string): number | null {
  if (!value.trim()) return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 共同月預算 + 類別預算（權限同「修改設定」：owner 或 canEditSettings） */
export function HouseholdBudgetDialog({ household, open, onOpenChange, averages = {} }: HouseholdBudgetDialogProps) {
  const update = useUpdateHousehold();
  const { data: categories = [] } = useCategories();
  const expenseCats = useMemo(() => categories.filter((c) => c.type === 'expense' && !c.archivedAt), [categories]);
  const [total, setTotal] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setTotal(household.monthlyBudgetTWD ? String(household.monthlyBudgetTWD) : '');
    setValues(Object.fromEntries(Object.entries(household.categoryBudgets ?? {}).map(([k, v]) => [k, String(v)])));
    // 只在開啟時帶入，避免 snapshot 更新蓋掉輸入中的值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const categorySum = Object.values(values).reduce((sum, value) => sum + (parseAmount(value) ?? 0), 0);
  const totalNum = parseAmount(total);
  const invalid = Object.values(values).some((value) => value.trim() !== '' && parseAmount(value) === null)
    || (total.trim() !== '' && totalNum === null);

  async function save() {
    const categoryBudgets: Record<string, number> = {};
    for (const [key, value] of Object.entries(values)) {
      const amount = parseAmount(value);
      if (amount) categoryBudgets[key] = amount;
    }
    try {
      await update.mutateAsync({ id: household.id, patch: { monthlyBudgetTWD: totalNum, categoryBudgets } });
      toast.success('已更新共同預算');
      onOpenChange(false);
    } catch (error) {
      console.error('[saveHouseholdBudgets]', error);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => { if (!update.isPending) onOpenChange(next); }}
      title="共同預算"
      description="整月總預算與各類別預算；類別留空代表不設限"
      contentClassName="sm:max-w-lg"
      footer={(
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => onOpenChange(false)} disabled={update.isPending}>取消</Button>
          <Button type="button" className="h-12 flex-[2]" onClick={() => void save()} disabled={invalid || update.isPending}>
            {update.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            儲存預算
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="hh-budget-total">每月總預算（TWD）</Label>
          <Input
            id="hh-budget-total"
            type="number"
            inputMode="numeric"
            min={1}
            value={total}
            onChange={(event) => setTotal(event.target.value)}
            placeholder="不設定"
            className="mt-1 tabular-nums"
          />
          {totalNum && categorySum > totalNum ? (
            <p className="mt-1 text-xs text-warning">類別預算合計 {formatCurrency(categorySum)} 超過總預算</p>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">類別預算合計 {formatCurrency(categorySum)}</p>
          )}
        </div>
        <ul className="divide-y rounded-lg border">
          {expenseCats.map((c) => {
            const Icon = resolveIcon(c.icon);
            const avg = averages[c.key];
            return (
              <li key={c.key} className="flex items-center gap-3 p-2.5">
                <Icon className="size-4 shrink-0" style={{ color: c.color }} />
                <div className="min-w-0 flex-1">
                  <div className="break-words text-sm">{c.name}</div>
                  {avg ? <div className="text-[11px] text-muted-foreground">近 3 月平均 {formatCurrency(avg)}</div> : null}
                </div>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  aria-label={`${c.name} 月預算`}
                  placeholder="不設限"
                  value={values[c.key] ?? ''}
                  onChange={(event) => setValues((prev) => ({ ...prev, [c.key]: event.target.value }))}
                  className="w-28 shrink-0 tabular-nums"
                />
              </li>
            );
          })}
        </ul>
      </div>
    </ResponsiveDialog>
  );
}
