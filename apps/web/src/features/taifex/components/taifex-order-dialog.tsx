import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { cn } from '@/lib/utils';
import { usePlaceTaifexOrder } from '../hooks';
import { TAIFEX_PRODUCT_SPECS, TARGET_LABELS, formatPoints, formatTWD } from '../options';
import { TaifexOrderSchema, type TaifexOrderFormValues } from '../schema';
import type { TaifexAccount, TaifexConfig, TaifexSignal, TaifexTarget } from '../types';
import { PaperDisclaimer } from './taifex-parts';

interface TaifexOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: TaifexAccount;
  config: TaifexConfig;
  signal: TaifexSignal | null;
}

const TARGETS: TaifexTarget[] = ['long', 'short', 'flat'];

/**
 * 手動虛擬單：指定「目標部位」（多 N 口 / 空 N 口 / 平倉），下一個交易日開盤價成交。
 * 與自動單同一套成交、成本、停損邏輯；手動單優先，自動模式不會覆蓋。
 */
export function TaifexOrderDialog({ open, onOpenChange, account, config, signal }: TaifexOrderDialogProps) {
  const place = usePlaceTaifexOrder();
  const spec = TAIFEX_PRODUCT_SPECS[account.product];
  const form = useForm<TaifexOrderFormValues>({
    resolver: zodResolver(TaifexOrderSchema),
    defaultValues: { target: 'long', contracts: 1, note: '' },
  });
  const target = useWatch({ control: form.control, name: 'target' });
  const contracts = Number(useWatch({ control: form.control, name: 'contracts' }) ?? 0);

  useEffect(() => {
    if (!open) return;
    const suggested = signal?.suggestedContracts ?? 0;
    form.reset({
      target: signal && signal.desired !== 'flat' ? signal.desired : account.position ? 'flat' : 'long',
      contracts: suggested > 0 ? suggested : account.position?.contracts ?? 1,
      note: '',
    });
  }, [open, signal, account.position, form]);

  const atr = signal?.indicators.atr20 ?? null;
  const stopPoints = atr ? atr * 2 : null;
  const price = account.lastClose;
  const riskTWD = stopPoints && target !== 'flat' ? stopPoints * spec.pointValue * contracts : null;
  const marginTWD = target !== 'flat' ? (config.marginPerContract ?? spec.margin) * contracts : null;

  const submit = form.handleSubmit((values) => {
    const parsed = TaifexOrderSchema.parse(values);
    place.mutate(parsed, { onSuccess: () => onOpenChange(false) });
  });

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="手動虛擬單"
      description={`${spec.name} · 下一個交易日開盤價成交`}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void submit()} disabled={place.isPending || (target === 'short' && !config.allowShort) || (account.halted && target !== 'flat')}>
            {place.isPending ? '送出中…' : '送出虛擬單'}
          </Button>
        </div>
      )}
    >
      <form className="space-y-4 text-sm" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="space-y-1.5">
          <Label>目標部位</Label>
          <Controller
            control={form.control}
            name="target"
            render={({ field }) => (
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="目標部位">
                {TARGETS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={field.value === value}
                    disabled={value === 'short' && !config.allowShort}
                    onClick={() => field.onChange(value)}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-sm disabled:opacity-40',
                      field.value === value ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-muted',
                    )}
                  >
                    {value === 'flat' ? '全部平倉' : TARGET_LABELS[value]}
                  </button>
                ))}
              </div>
            )}
          />
          <p className="text-[11px] text-muted-foreground">
            填的是成交後的「目標部位」：目前多 3 口、目標多 1 口 → 平 2 口；目前多單、目標做空 → 先平再反手。
          </p>
        </div>

        {target !== 'flat' ? (
          <div className="space-y-1.5">
            <Label htmlFor="taifex-order-contracts">口數（上限 {config.maxContracts}）</Label>
            <Input id="taifex-order-contracts" type="number" inputMode="numeric" min={1} max={config.maxContracts} {...form.register('contracts')} />
            <p className="text-xs text-destructive">{form.formState.errors.contracts?.message}</p>
            {signal && signal.suggestedContracts > 0 ? (
              <p className="text-[11px] text-muted-foreground">策略依風險預算建議 {signal.suggestedContracts} 口。</p>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="taifex-order-note">備註（選填）</Label>
          <Input id="taifex-order-note" maxLength={100} placeholder="為什麼下這張單？之後檢討用" {...form.register('note')} />
        </div>

        {target !== 'flat' ? (
          <dl className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-3 text-xs">
            <dt className="text-muted-foreground">參考價（最新收盤）</dt><dd className="text-right tabular-nums">{formatPoints(price)}</dd>
            <dt className="text-muted-foreground">初始停損距離（2×ATR）</dt><dd className="text-right tabular-nums">{stopPoints ? `${formatPoints(stopPoints)} 點` : '—'}</dd>
            <dt className="text-muted-foreground">停損風險</dt><dd className="text-right tabular-nums">{formatTWD(riskTWD)}（{riskTWD ? `${(riskTWD / account.equity * 100).toFixed(1)}%` : '—'}）</dd>
            <dt className="text-muted-foreground">原始保證金（估）</dt><dd className="text-right tabular-nums">{formatTWD(marginTWD)}</dd>
          </dl>
        ) : null}
        {account.halted && target !== 'flat' ? <p className="text-xs text-destructive">帳戶已熔斷，只能平倉；請先解除熔斷。</p> : null}
        <PaperDisclaimer />
      </form>
    </ResponsiveDialog>
  );
}
