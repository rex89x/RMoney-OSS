import { useEffect, useState, type ReactNode } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { RotateCcw, Save } from 'lucide-react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useRefreshTaifexCalendar, useResetTaifexPaper, useSaveTaifexConfig } from '../hooks';
import { MODE_LABELS, TAIFEX_PRODUCTS, TAIFEX_PRODUCT_SPECS, VARIANT_LABELS, formatTWD } from '../options';
import { TaifexConfigSchema, type TaifexConfigFormValues } from '../schema';
import { parseHolidayInput } from '../tech';
import { TAIFEX_VARIANT_KEYS, type TaifexAccount, type TaifexConfig, type TaifexMode } from '../types';

interface TaifexSettingsProps {
  config: TaifexConfig;
  account: TaifexAccount | null;
}

function toForm(config: TaifexConfig): TaifexConfigFormValues {
  const spec = TAIFEX_PRODUCT_SPECS[config.product];
  return {
    mode: config.mode,
    product: config.product,
    initialCapital: config.initialCapital,
    riskPerTradePct: config.riskPerTradePct,
    maxContracts: config.maxContracts,
    allowShort: config.allowShort,
    maxDrawdownPct: config.maxDrawdownPct,
    commissionPerSide: config.commissionPerSide ?? spec.commission,
    slippagePoints: config.slippagePoints,
    marginPerContract: config.marginPerContract ?? spec.margin,
    notifyEnabled: config.notifyEnabled,
    strategyVariant: config.strategyVariant,
    intradayEnabled: config.intradayEnabled,
    tech: { ...config.tech },
  };
}

/**
 * 設定只開放資金管理（契約、資金、風險、成本、熔斷）；因子權重與進出場門檻凍結在模型版本，不能在這裡調。
 */
export function TaifexSettings({ config, account }: TaifexSettingsProps) {
  const confirm = useConfirm();
  const save = useSaveTaifexConfig();
  const reset = useResetTaifexPaper();
  const refreshCalendar = useRefreshTaifexCalendar();
  const [holidayText, setHolidayText] = useState(config.tech.extraHolidays.join('\n'));
  const holidayInput = parseHolidayInput(holidayText);
  const form = useForm<TaifexConfigFormValues>({ resolver: zodResolver(TaifexConfigSchema), defaultValues: toForm(config) });
  const errors = form.formState.errors;
  const product = useWatch({ control: form.control, name: 'product' });

  useEffect(() => {
    form.reset(toForm(config));
    setHolidayText(config.tech.extraHolidays.join('\n'));
  }, [config, form]);

  const submit = form.handleSubmit((values) => {
    const parsed = TaifexConfigSchema.parse(values);
    const holidaysChanged = parsed.tech.extraHolidays.join(',') !== config.tech.extraHolidays.join(',');
    save.mutate(parsed, {
      // 後端休市表有 6 小時快取，改了自訂休市日要請它重抓才會立刻生效
      onSuccess: () => { if (holidaysChanged) refreshCalendar.mutate(); },
    });
  });

  function handleHolidayText(text: string) {
    setHolidayText(text);
    form.setValue('tech.extraHolidays', parseHolidayInput(text).dates, { shouldDirty: true });
  }

  function handleProductChange(next: string, onChange: (v: string) => void) {
    onChange(next);
    const spec = TAIFEX_PRODUCT_SPECS[next as keyof typeof TAIFEX_PRODUCT_SPECS];
    // 換契約時把手續費 / 保證金帶入該契約的預設值，避免沿用大台的數字
    form.setValue('commissionPerSide', spec.commission, { shouldDirty: true });
    form.setValue('marginPerContract', spec.margin, { shouldDirty: true });
  }

  async function handleReset() {
    const ok = await confirm({
      title: '重置虛擬帳戶？',
      description: '持倉會以最後收盤價平倉（記為「帳戶重置」），以目前設定的契約與起始資金重新開始。舊交易紀錄會保留，但不再計入新帳戶。',
      confirmText: '重置',
    });
    if (ok) reset.mutate();
  }

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">交易模式</CardTitle></CardHeader>
          <CardContent>
            <Controller
              control={form.control}
              name="mode"
              render={({ field }) => (
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="交易模式">
                  {(Object.keys(MODE_LABELS) as TaifexMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={field.value === mode}
                      onClick={() => field.onChange(mode)}
                      className={`rounded-lg border p-3 text-left text-sm ${field.value === mode ? 'border-primary bg-primary/10' : 'hover:bg-muted'}`}
                    >
                      <div className="font-medium">{MODE_LABELS[mode].label}</div>
                      <div className="text-xs text-muted-foreground">{MODE_LABELS[mode].desc}</div>
                    </button>
                  ))}
                </div>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">主帳戶策略與盤中模擬</CardTitle>
            <p className="text-xs text-muted-foreground">四種策略變體都會各自跑一個虛擬帳戶（績效分頁的策略競賽）；這裡選主帳戶要跟哪一組參數。</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <Controller
              control={form.control}
              name="strategyVariant"
              render={({ field }) => (
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="主帳戶策略">
                  {TAIFEX_VARIANT_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={field.value === key}
                      onClick={() => field.onChange(key)}
                      className={`rounded-lg border p-3 text-left text-sm ${field.value === key ? 'border-primary bg-primary/10' : 'hover:bg-muted'}`}
                    >
                      <div className="font-medium">{VARIANT_LABELS[key].label}</div>
                      <div className="text-xs text-muted-foreground">{VARIANT_LABELS[key].desc}</div>
                    </button>
                  ))}
                </div>
              )}
            />
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <Label htmlFor="tf-intraday">盤中模擬（每 5 分鐘）</Label>
                <p className="text-xs text-muted-foreground">日盤 08:45–13:45 用即時報價成交待成交單、盤中觸發停損、接近停損提醒；關閉則只在 18:00 用日 K 結算。國定假日自動略過</p>
              </div>
              <Controller control={form.control} name="intradayEnabled" render={({ field }) => (
                <Switch id="tf-intraday" checked={field.value} onCheckedChange={field.onChange} />
              )} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">盤中技術模擬（日盤 + 夜盤）</CardTitle>
            <p className="text-xs text-muted-foreground">
              每 5 分鐘取樣一次，四個監控頻率（5 / 15 / 30 / 60 分）各用同一套技術指標虛擬進出場，結果在「盤中技術」分頁。與上面的日線波段帳戶互不影響。
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <SwitchRow id="tf-tech" label="啟用技術模擬" desc="關閉後不再取樣與模擬，既有紀錄保留">
              <Controller control={form.control} name="tech.enabled" render={({ field }) => (
                <Switch id="tf-tech" checked={field.value} onCheckedChange={field.onChange} />
              )} />
            </SwitchRow>
            <div className="grid gap-3 sm:grid-cols-2">
              <SwitchRow id="tf-tech-day" label="日盤" desc="平日 08:45–13:45">
                <Controller control={form.control} name="tech.day" render={({ field }) => (
                  <Switch id="tf-tech-day" checked={field.value} onCheckedChange={field.onChange} />
                )} />
              </SwitchRow>
              <SwitchRow id="tf-tech-night" label="夜盤" desc="平日 15:00–隔日 05:00">
                <Controller control={form.control} name="tech.night" render={({ field }) => (
                  <Switch id="tf-tech-night" checked={field.value} onCheckedChange={field.onChange} />
                )} />
              </SwitchRow>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="tf-tech-contracts" label="每次進場口數" error={errors.tech?.contracts?.message} hint="契約與成本沿用下方設定；固定口數方便比較各頻率">
                <Input id="tf-tech-contracts" type="number" inputMode="numeric" {...form.register('tech.contracts')} />
              </Field>
              <SwitchRow id="tf-tech-notify" label="進出場推播" desc="每次虛擬進出場都通知；夜盤可能在半夜響，預設關閉">
                <Controller control={form.control} name="tech.notify" render={({ field }) => (
                  <Switch id="tf-tech-notify" checked={field.value} onCheckedChange={field.onChange} />
                )} />
              </SwitchRow>
            </div>
            <Field
              id="tf-tech-holidays"
              label="自訂休市日"
              error={holidayInput.invalid.length ? `看不懂的日期：${holidayInput.invalid.slice(0, 3).join('、')}` : errors.tech?.extraHolidays?.message}
              hint="週末與證交所公告的休市日會自動略過；臨時休市（例如颱風假）可在這裡補上，一行一個 yyyy-MM-dd"
            >
              <Textarea id="tf-tech-holidays" rows={2} value={holidayText} placeholder="2026-07-08" onChange={(e) => handleHolidayText(e.target.value)} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">契約與資金</CardTitle>
            <p className="text-xs text-muted-foreground">契約與起始資金在「重置帳戶」後才套用到虛擬帳戶。</p>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>契約</Label>
              <Controller
                control={form.control}
                name="product"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={(v) => handleProductChange(v, field.onChange)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TAIFEX_PRODUCTS.map((p) => (
                        <SelectItem key={p} value={p}>{TAIFEX_PRODUCT_SPECS[p].name}・每點 {TAIFEX_PRODUCT_SPECS[p].pointValue} 元</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <Field id="tf-capital" label="起始資金（元）" error={errors.initialCapital?.message}>
              <Input id="tf-capital" type="number" inputMode="numeric" step={10000} {...form.register('initialCapital')} />
            </Field>
            <Field id="tf-risk" label="每筆風險（% 權益）" error={errors.riskPerTradePct?.message} hint="停損被打到時最多虧掉權益的幾 %；文獻常用 0.5–2%">
              <Input id="tf-risk" type="number" step={0.1} {...form.register('riskPerTradePct')} />
            </Field>
            <Field id="tf-max" label="最大口數" error={errors.maxContracts?.message}>
              <Input id="tf-max" type="number" inputMode="numeric" {...form.register('maxContracts')} />
            </Field>
            <Field id="tf-dd" label="熔斷回撤（%）" error={errors.maxDrawdownPct?.message} hint="權益從高點回落達此比例 → 平倉並暫停新進場">
              <Input id="tf-dd" type="number" step={1} {...form.register('maxDrawdownPct')} />
            </Field>
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <Label htmlFor="tf-short">允許放空</Label>
                <p className="text-xs text-muted-foreground">關閉後只做多，空方訊號改為空手</p>
              </div>
              <Controller control={form.control} name="allowShort" render={({ field }) => (
                <Switch id="tf-short" checked={field.value} onCheckedChange={field.onChange} />
              )} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">成本模型</CardTitle>
            <p className="text-xs text-muted-foreground">期交稅固定為契約價值的十萬分之二（單邊）。保證金預設為估計值，請依期交所最新公告調整。</p>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <Field id="tf-fee" label="手續費（每口單邊，元）" error={errors.commissionPerSide?.message}>
              <Input id="tf-fee" type="number" {...form.register('commissionPerSide')} />
            </Field>
            <Field id="tf-slip" label="滑價（每口單邊，點）" error={errors.slippagePoints?.message}>
              <Input id="tf-slip" type="number" step={0.5} {...form.register('slippagePoints')} />
            </Field>
            <Field id="tf-margin" label="原始保證金（每口，元）" error={errors.marginPerContract?.message}
              hint={`${TAIFEX_PRODUCT_SPECS[product].label}預設 ${formatTWD(TAIFEX_PRODUCT_SPECS[product].margin)}`}>
              <Input id="tf-margin" type="number" step={500} {...form.register('marginPerContract')} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div>
              <Label htmlFor="tf-notify">Telegram 推播</Label>
              <p className="text-xs text-muted-foreground">每日 18:00 訊號、成交、停損、熔斷與盤前否決（也受「設定 → 通知」的總開關控制）</p>
            </div>
            <Controller control={form.control} name="notifyEnabled" render={({ field }) => (
              <Switch id="tf-notify" checked={field.value} onCheckedChange={field.onChange} />
            )} />
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending}><Save className="size-4" /> {save.isPending ? '儲存中…' : '儲存設定'}</Button>
        </div>
      </form>

      <Card className="border-destructive/30">
        <CardHeader className="pb-2"><CardTitle className="text-base">重置虛擬帳戶</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {account
              ? `目前第 ${account.epoch} 輪：${TAIFEX_PRODUCT_SPECS[account.product].label}、起始 ${formatTWD(account.initialCapital)}，自 ${account.startDate ?? '—'} 起。`
              : '帳戶尚未建立。'}
            換契約或起始資金後，需要重置才會生效。
          </p>
          <Button variant="destructive" size="sm" disabled={!account || reset.isPending} onClick={() => void handleReset()}>
            <RotateCcw className="size-4" /> {reset.isPending ? '重置中…' : '重置帳戶'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function SwitchRow({ id, label, desc, children }: { id: string; label: string; desc: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      {children}
    </div>
  );
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
