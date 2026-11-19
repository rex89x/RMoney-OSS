import { useEffect, useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { AlertTriangle, Bot, Calculator, RefreshCw, Save, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { formatTW } from '@/lib/tz';
import { calculateAiForecast, estimateAiScenario } from '../forecast';
import {
  defaultAiBudgetConfig,
  useAiBudgetConfig,
  useAiUsageSummary,
  useSaveAiBudgetConfig,
} from '../hooks';
import {
  AI_FEATURE_LABELS,
  CLAUDE_MODEL_LABELS,
  claudeModelLabel,
  formatTokens,
  formatUSD,
} from '../labels';
import {
  AiBudgetConfigSchema,
  AiScenarioSchema,
  type AiBudgetConfigFormValues,
  type AiScenarioFormValues,
} from '../schema';
import { CLAUDE_MODELS, type AiScenarioInput } from '../types';

interface MetricProps {
  label: string;
  value: string;
  hint?: string;
}

function Metric({ label, value, hint }: MetricProps) {
  return (
    <div className="min-w-0 rounded-xl border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

interface ModelSelectProps {
  value: string;
  onChange: (value: string) => void;
}

function ModelSelect({ value, onChange }: ModelSelectProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        {CLAUDE_MODELS.map((model) => (
          <SelectItem key={model} value={model}>{CLAUDE_MODEL_LABELS[model].label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AiBudgetPanel() {
  const { user } = useAuth();
  const [cycleOffset, setCycleOffset] = useState(0);
  const configQuery = useAiBudgetConfig();
  const usageQuery = useAiUsageSummary(cycleOffset);
  const saveConfig = useSaveAiBudgetConfig();
  const fallbackConfig = useMemo(() => defaultAiBudgetConfig(user?.uid ?? ''), [user?.uid]);
  const config = configQuery.data ?? fallbackConfig;
  const summary = usageQuery.data;

  const budgetForm = useForm<AiBudgetConfigFormValues>({
    resolver: zodResolver(AiBudgetConfigSchema),
    defaultValues: {
      monthlyCreditUSD: fallbackConfig.monthlyCreditUSD,
      cycleResetDay: fallbackConfig.cycleResetDay,
      warningPercent: fallbackConfig.warningPercent,
      hardStopEnabled: fallbackConfig.hardStopEnabled,
      defaultModel: fallbackConfig.defaultModel,
      fastModel: fallbackConfig.fastModel,
    },
  });
  const scenarioForm = useForm<AiScenarioFormValues>({
    resolver: zodResolver(AiScenarioSchema),
    defaultValues: {
      model: 'claude-opus-5-5',
      monthlyRequests: 100,
      inputTokensPerRequest: 3000,
      outputTokensPerRequest: 2000,
      webSearchesPerMonth: 0,
    },
  });

  useEffect(() => {
    budgetForm.reset({
      monthlyCreditUSD: config.monthlyCreditUSD,
      cycleResetDay: config.cycleResetDay,
      warningPercent: config.warningPercent,
      hardStopEnabled: config.hardStopEnabled,
      defaultModel: config.defaultModel,
      fastModel: config.fastModel,
    });
  }, [budgetForm, config]);

  const scenario = AiScenarioSchema.safeParse(scenarioForm.watch());
  const simulation = scenario.success ? estimateAiScenario(scenario.data as AiScenarioInput) : null;
  const forecast = useMemo(() => (summary ? calculateAiForecast(summary) : null), [summary]);
  const usdToTwd = summary?.usdToTwd ?? 32;

  async function submitBudget(values: AiBudgetConfigFormValues) {
    if (!user) return;
    try {
      const parsed = AiBudgetConfigSchema.parse(values);
      await saveConfig.mutateAsync({
        ...config,
        id: user.uid,
        userId: user.uid,
        ...parsed,
        updatedAt: new Date(),
      });
    } catch (error) {
      console.error('[saveAiBudgetConfig]', error);
    }
  }

  const usagePercent = Math.min(100, forecast?.usagePercent ?? 0);
  const overPace = (forecast?.projectedUsagePercent ?? 0) > 100;
  const breakdown = Object.entries(summary?.byFeature ?? {})
    .sort(([, a], [, b]) => b.costUSD - a.costUSD);
  const models = Object.entries(summary?.byModel ?? {})
    .sort(([, a], [, b]) => b.costUSD - a.costUSD);
  const cycleLabel = summary
    ? `${formatTW(summary.cycleStart, 'yyyy/MM/dd')} – ${formatTW(new Date(new Date(summary.cycleEnd).getTime() - 1), 'MM/dd')}`
    : '';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <Bot className="size-5" /> Claude API 額度
              </CardTitle>
              <CardDescription className="mt-1">
                依每次回應的 usage 與官方牌價估算；實際扣款以 Anthropic Console 為準。
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={String(cycleOffset)} onValueChange={(value) => setCycleOffset(Number(value))}>
                <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">本期</SelectItem>
                  <SelectItem value="-1">上一期</SelectItem>
                  <SelectItem value="-2">前兩期</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void usageQuery.refetch()}
                disabled={usageQuery.isFetching}
              >
                <RefreshCw className={`size-4 ${usageQuery.isFetching ? 'animate-spin' : ''}`} />
                更新
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {usageQuery.isError ? (
            <p className="rounded-xl border border-destructive/50 p-3 text-sm text-destructive">
              {usageQuery.error instanceof Error ? usageQuery.error.message : '無法取得 Claude 用量'}
            </p>
          ) : null}
          {summary && !summary.apiKeyConfigured ? (
            <p className="flex items-start gap-2 rounded-xl border border-amber-500/50 p-3 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                Apps Script 尚未設定 <code>ANTHROPIC_API_KEY</code>，所有 AI 功能目前無法使用。請到 Apps Script →
                專案設定 → Script Properties 新增。
              </span>
            </p>
          ) : null}
          {summary ? (
            <p className="text-sm text-muted-foreground">
              計費週期 {cycleLabel}（每月 {summary.resetDay} 號重置）
              {cycleOffset === 0 && forecast ? `，剩 ${forecast.daysLeft} 天` : ''}
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label={cycleOffset === 0 ? '本期已用' : '該期用量'}
              value={formatUSD(forecast?.spentUSD ?? 0)}
              hint={`約 NT$${Math.round((forecast?.spentUSD ?? 0) * usdToTwd).toLocaleString('zh-TW')}`}
            />
            <Metric
              label="剩餘額度"
              value={formatUSD(forecast?.remainingUSD ?? config.monthlyCreditUSD)}
              hint={`每期額度 ${formatUSD(summary?.creditUSD ?? config.monthlyCreditUSD, 0)}`}
            />
            <Metric
              label={cycleOffset === 0 ? '期末預估' : '期末總計'}
              value={formatUSD(forecast?.projectedUSD ?? 0)}
              hint={cycleOffset === 0
                ? `照目前速度約用 ${Math.round(forecast?.projectedUsagePercent ?? 0)}%`
                : undefined}
            />
            <Metric
              label="API 呼叫"
              value={formatTokens(summary?.totals.requests ?? 0)}
              hint={`${formatTokens(summary?.totals.totalTokens ?? 0)} tokens`}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>額度使用率</span>
              <span className="tabular-nums">{Math.round(forecast?.usagePercent ?? 0)}%</span>
            </div>
            <Progress value={usagePercent} />
            {cycleOffset === 0 && forecast && forecast.daysLeft > 0 ? (
              <p className={`text-xs ${overPace ? 'text-destructive' : 'text-muted-foreground'}`}>
                {overPace
                  ? `照目前速度會在重置前用完；剩下 ${forecast.daysLeft} 天平均每天建議 ≤ ${formatUSD(forecast.dailyAllowanceUSD)}`
                  : `剩下 ${forecast.daysLeft} 天平均每天可用 ${formatUSD(forecast.dailyAllowanceUSD)}`}
              </p>
            ) : null}
          </div>

          <div className="grid gap-3 text-sm md:grid-cols-2">
            <div className="min-w-0 rounded-xl border p-3">
              <p className="font-medium">用量組成</p>
              <p className="mt-1 text-muted-foreground">
                Input {formatTokens(summary?.totals.inputTokens ?? 0)} · Cache read{' '}
                {formatTokens(summary?.totals.cacheReadTokens ?? 0)} · Output（含 thinking）{' '}
                {formatTokens(summary?.totals.outputTokens ?? 0)}
              </p>
              <p className="mt-1 text-muted-foreground">
                Web search {formatTokens(summary?.totals.webSearchRequests ?? 0)} 次（US$0.01 / 次）
              </p>
            </div>
            <div className="min-w-0 rounded-xl border p-3">
              <p className="font-medium">使用中的模型</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <Badge variant="secondary">一般：{claudeModelLabel(summary?.defaultModel ?? config.defaultModel)}</Badge>
                <Badge variant="secondary">快速：{claudeModelLabel(summary?.fastModel ?? config.fastModel)}</Badge>
              </div>
              {models.length > 0 ? (
                <p className="mt-2 text-muted-foreground">
                  {models.map(([model, row]) => `${claudeModelLabel(model)} ${formatUSD(row.costUSD)}`).join(' · ')}
                </p>
              ) : null}
            </div>
          </div>

          {breakdown.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr><th className="p-3">功能</th><th className="p-3 text-right">次數</th><th className="p-3 text-right">Tokens</th><th className="p-3 text-right">估算費用</th></tr>
                </thead>
                <tbody className="divide-y">
                  {breakdown.map(([feature, row]) => (
                    <tr key={feature}>
                      <td className="p-3">{AI_FEATURE_LABELS[feature] ?? feature}</td>
                      <td className="p-3 text-right tabular-nums">{formatTokens(row.requests)}</td>
                      <td className="p-3 text-right tabular-nums">{formatTokens(row.totalTokens)}</td>
                      <td className="p-3 text-right tabular-nums">{formatUSD(row.costUSD)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              這一期還沒有 Claude 呼叫紀錄。部署後的每一次 Claude 呼叫都會自動累計在這裡。
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldAlert className="size-5" /> 額度與模型設定</CardTitle>
            <CardDescription>達警示門檻會發通知；開啟硬停止後，本期估算用完就拒絕新的 Claude 請求。</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={budgetForm.handleSubmit(submitBudget)}>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <Label htmlFor="ai-credit">每期額度（USD）</Label>
                  <Input id="ai-credit" type="number" min="1" step="1" {...budgetForm.register('monthlyCreditUSD')} />
                  <p className="mt-1 text-xs text-destructive">{budgetForm.formState.errors.monthlyCreditUSD?.message}</p>
                </div>
                <div>
                  <Label htmlFor="ai-reset-day">每月重置日</Label>
                  <Input id="ai-reset-day" type="number" min="1" max="28" {...budgetForm.register('cycleResetDay')} />
                  <p className="mt-1 text-xs text-destructive">{budgetForm.formState.errors.cycleResetDay?.message}</p>
                </div>
                <div>
                  <Label htmlFor="ai-warning-percent">警示門檻（%）</Label>
                  <Input id="ai-warning-percent" type="number" min="1" max="100" {...budgetForm.register('warningPercent')} />
                  <p className="mt-1 text-xs text-destructive">{budgetForm.formState.errors.warningPercent?.message}</p>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Controller
                  control={budgetForm.control}
                  name="defaultModel"
                  render={({ field }) => (
                    <div className="min-w-0">
                      <Label>一般模型</Label>
                      <ModelSelect value={field.value} onChange={field.onChange} />
                      <p className="mt-1 text-xs text-muted-foreground">行程、財務問答、AI 分析、機票搜尋</p>
                    </div>
                  )}
                />
                <Controller
                  control={budgetForm.control}
                  name="fastModel"
                  render={({ field }) => (
                    <div className="min-w-0">
                      <Label>快速模型</Label>
                      <ModelSelect value={field.value} onChange={field.onChange} />
                      <p className="mt-1 text-xs text-muted-foreground">收據辨識、匯入解析、Telegram 記帳</p>
                    </div>
                  )}
                />
              </div>
              <Controller
                control={budgetForm.control}
                name="hardStopEnabled"
                render={({ field }) => (
                  <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
                    <div className="min-w-0">
                      <Label>額度用完後停止 Claude</Label>
                      <p className="text-xs text-muted-foreground">預設關閉，避免行程或記帳到一半被擋下。</p>
                    </div>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </div>
                )}
              />
              <Button type="submit" disabled={saveConfig.isPending}>
                <Save className="size-4" /> 儲存設定
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Calculator className="size-5" /> 使用量試算</CardTitle>
            <CardDescription>輸入預期的每期呼叫次數與平均 tokens，先評估成本。Output 請把 thinking 一起算進去。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Controller
              control={scenarioForm.control}
              name="model"
              render={({ field }) => (
                <div>
                  <Label>模型</Label>
                  <ModelSelect value={field.value} onChange={field.onChange} />
                </div>
              )}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label>每期呼叫次數</Label><Input type="number" min="0" {...scenarioForm.register('monthlyRequests')} /></div>
              <div><Label>每次 input tokens</Label><Input type="number" min="0" {...scenarioForm.register('inputTokensPerRequest')} /></div>
              <div><Label>每次 output tokens</Label><Input type="number" min="0" {...scenarioForm.register('outputTokensPerRequest')} /></div>
              <div><Label>每期 web search 次數</Label><Input type="number" min="0" {...scenarioForm.register('webSearchesPerMonth')} /></div>
            </div>
            <div className="rounded-xl bg-muted p-4">
              <p className="text-sm text-muted-foreground">試算每期費用</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{formatUSD(simulation?.costUSD ?? 0)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                每次約 {formatUSD(simulation?.perRequestUSD ?? 0, 4)} · 占額度{' '}
                {Math.round((simulation?.costUSD ?? 0) / (config.monthlyCreditUSD || 100) * 100)}%
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
