import { useMemo } from 'react';
import { CheckCircle2, CircleHelp, Gauge, Play, Swords, Target, TriangleAlert, XCircle } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, paletteColor } from '@/lib/chart-theme';
import { formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import { useRunTaifexOptimization, useTaifexAccounts, useTaifexBacktest, useTaifexOptimization, useTaifexTrades } from '../hooks';
import { VARIANT_LABELS, formatParams, formatPctValue, pnlClass } from '../options';
import { leaderboard, perfReport, type TaifexVerdictLevel } from '../perf';
import type { TaifexAccount, TaifexBacktestMetrics, TaifexConfig, TaifexOptimization } from '../types';

interface TaifexPerformanceProps {
  account: TaifexAccount;
  config: TaifexConfig;
}

const VERDICT_STYLE: Record<TaifexVerdictLevel, { icon: typeof CheckCircle2; className: string }> = {
  insufficient: { icon: CircleHelp, className: 'border-muted-foreground/30 bg-muted/40' },
  good: { icon: CheckCircle2, className: 'border-success/40 bg-success/5 text-success' },
  ok: { icon: Gauge, className: 'border-warning/40 bg-warning/5 text-warning' },
  poor: { icon: XCircle, className: 'border-destructive/40 bg-destructive/5 text-destructive' },
};

/** 績效：主帳戶整體評估 → 每月報酬 → 策略競賽 → 報酬最大化（walk-forward）測試 */
export function TaifexPerformance({ account, config }: TaifexPerformanceProps) {
  const trades = useTaifexTrades(true);
  const accounts = useTaifexAccounts(true);
  const backtest = useTaifexBacktest(true);
  const optimization = useTaifexOptimization(true);
  const backtestFull = backtest.data?.variants.full.metrics ?? null;

  const report = useMemo(
    () => perfReport(account, trades.data ?? [], config.maxDrawdownPct, backtestFull),
    [account, trades.data, config.maxDrawdownPct, backtestFull],
  );
  const board = useMemo(
    () => leaderboard(accounts.data ?? [], trades.data ?? [], config.maxDrawdownPct),
    [accounts.data, trades.data, config.maxDrawdownPct],
  );
  const m = report.metrics;
  const style = VERDICT_STYLE[report.verdict.level];
  const VerdictIcon = style.icon;

  return (
    <div className="space-y-4">
      <div className={cn('rounded-xl border p-4', style.className)}>
        <div className="flex items-center gap-2 font-medium">
          <VerdictIcon className="size-5" aria-hidden /> {report.verdict.headline}
        </div>
        <ul className="mt-2 space-y-1 text-xs text-foreground/80">
          {report.verdict.reasons.map((r) => <li key={r} className="flex gap-1.5"><span aria-hidden>·</span>{r}</li>)}
        </ul>
      </div>

      <StatGrid>
        <StatTile
          label="總報酬 / 年化"
          value={`${formatPctValue(m.totalReturnPct, 2)} / ${formatPctValue(m.cagrPct, 1)}`}
          valueClassName={pnlClass(m.totalReturnPct)}
          hint={`${m.days} 個交易日${m.cagrPct === null ? '，未滿 20 天不年化' : ''}`}
        />
        <StatTile
          label="Sharpe / Sortino"
          value={`${m.sharpe === null ? '—' : m.sharpe.toFixed(2)} / ${m.sortino === null ? '—' : m.sortino.toFixed(2)}`}
          hint={backtestFull?.sharpe !== null && backtestFull?.sharpe !== undefined ? `回測 Sharpe ${backtestFull.sharpe.toFixed(2)}` : '每單位風險換到的報酬'}
        />
        <StatTile
          label="最大回撤 / Calmar"
          value={`${m.maxDrawdownPct.toFixed(1)}% / ${m.calmar === null ? '—' : m.calmar.toFixed(2)}`}
          tone={m.maxDrawdownPct > config.maxDrawdownPct * 0.75 ? 'warn' : 'plain'}
          hint={`熔斷上限 ${config.maxDrawdownPct}%`}
        />
        <StatTile
          label="vs 同期大盤"
          value={formatPctValue(m.excessReturnPct, 1)}
          valueClassName={pnlClass(m.excessReturnPct)}
          hint={`大盤 ${formatPctValue(m.benchmarkReturnPct, 1)}；曝險 ${m.exposurePct.toFixed(0)}%`}
        />
      </StatGrid>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">每月報酬</CardTitle></CardHeader>
        <CardContent>
          {report.monthly.length ? (
            <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
              {report.monthly.map((row) => (
                <div key={row.month} className="rounded-lg border p-2 text-center">
                  <div className="text-muted-foreground">{row.month}</div>
                  <div className={cn('font-semibold tabular-nums', pnlClass(row.returnPct))}>{formatPctValue(row.returnPct, 2)}</div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">還沒有完整的月份。</p>}
        </CardContent>
      </Card>

      <Leaderboard accounts={accounts.data ?? []} board={board} loading={accounts.isLoading} maxDd={config.maxDrawdownPct} />

      <OptimizationPanel data={optimization.data ?? null} loading={optimization.isLoading} config={config} />
    </div>
  );
}

function Leaderboard({ accounts, board, loading, maxDd }: {
  accounts: TaifexAccount[];
  board: ReturnType<typeof leaderboard>;
  loading: boolean;
  maxDd: number;
}) {
  // 各帳戶權益換成報酬%，畫在同一張圖（同一天起跑才可比）
  const chart = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    accounts.forEach((a) => {
      a.equityCurve.forEach((p) => {
        const row = byDate.get(p.date) ?? { date: p.date };
        row[a.id] = (p.equity / a.initialCapital - 1) * 100;
        byDate.set(p.date, row);
      });
    });
    return [...byDate.values()].sort((x, y) => String(x.date).localeCompare(String(y.date)));
  }, [accounts]);
  const label = (row: { id: string; variant: keyof typeof VARIANT_LABELS; isMain: boolean }) =>
    row.isMain ? `主帳戶（${VARIANT_LABELS[row.variant].label}）` : VARIANT_LABELS[row.variant].label;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Swords className="size-4" aria-hidden /> 策略競賽</CardTitle>
        <p className="text-xs text-muted-foreground">
          四組參數各自一個虛擬帳戶，同一筆資金、同一套成本與盤中模擬，依總報酬排名（回撤超過 {maxDd}% 的排在後面）。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? <Skeleton className="h-40 w-full" /> : board.length <= 1 ? (
          <p className="text-sm text-muted-foreground">策略變體帳戶會在下一次每日更新（18:00）時建立。</p>
        ) : (
          <>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" />
                  <XAxis dataKey="date" {...AXIS_PROPS} tickFormatter={(v: string) => v.slice(5)} minTickGap={32} />
                  <YAxis width={40} {...AXIS_PROPS} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                  <ReferenceLine y={0} stroke={CHART_COLORS.axis} />
                  <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number, name: string) => [`${value.toFixed(2)}%`, name]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {board.map((row, i) => (
                    <Line key={row.id} dataKey={row.id} name={label(row)} stroke={paletteColor(i)} strokeWidth={row.isMain ? 2.5 : 1.5} dot={false} connectNulls isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <ol className="divide-y text-sm">
              {board.map((row, i) => (
                <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="w-5 text-center font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1 font-medium">
                    {label(row)}
                    {!row.withinDrawdown ? <Badge variant="destructive" className="ml-2 px-1.5 py-0 text-[10px]">回撤超標</Badge> : null}
                  </span>
                  <span className={cn('tabular-nums font-semibold', pnlClass(row.metrics.totalReturnPct))}>{formatPctValue(row.metrics.totalReturnPct, 2)}</span>
                  <span className="w-full pl-8 text-xs text-muted-foreground sm:w-auto sm:pl-0">
                    回撤 {row.metrics.maxDrawdownPct.toFixed(1)}% · Sharpe {row.metrics.sharpe === null ? '—' : row.metrics.sharpe.toFixed(2)} · {row.trades.count} 筆
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function OptimizationPanel({ data, loading, config }: { data: TaifexOptimization | null; loading: boolean; config: TaifexConfig }) {
  const run = useRunTaifexOptimization();
  const runButton = (
    <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
      <Play className="size-3.5" /> {run.isPending ? '最佳化中（約 1 分鐘）…' : '重新最佳化'}
    </Button>
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Target className="size-4" aria-hidden /> 報酬最大化測試（walk-forward）
          <span className="ml-auto">{runButton}</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          36 組參數（進場門檻 × 停損 × 移動停損）。前 60% 歷史挑「回撤 ≤ {config.maxDrawdownPct}% 下報酬最高」的參數，
          再拿它去跑沒看過的後 40%，只有樣本外也贏基準才算有效。每週日 20:00 自動跑。
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loading ? <Skeleton className="h-32 w-full" /> : !data ? (
          <p className="text-muted-foreground">還沒有最佳化結果（需要約 200 根日 K）。</p>
        ) : (
          <>
            <div className={cn('flex items-start gap-2 rounded-lg p-3 text-xs', data.adopt ? 'bg-success/10' : 'bg-muted/50')}>
              {data.adopt ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />}
              <div>
                <p className="font-medium">
                  {data.adopt ? '最佳化參數在樣本外也勝過基準' : '最佳化參數沒有在樣本外勝過基準 — 維持基準參數較穩'}
                </p>
                <p className="text-muted-foreground">
                  樣本內 {data.trainFrom} ~ {data.trainTo}；樣本外 {data.testFrom} ~ {data.testTo}
                  {data.generatedAt ? `；計算於 ${formatTW(data.generatedAt, 'MM/dd HH:mm')}` : ''}
                </p>
              </div>
            </div>
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[520px] whitespace-nowrap text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-normal" />
                    <th className="text-left font-normal">參數</th>
                    <th className="text-right font-normal">樣本內報酬</th>
                    <th className="text-right font-normal">樣本外報酬</th>
                    <th className="text-right font-normal">樣本外回撤</th>
                    <th className="text-right font-normal">樣本外 Sharpe</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  <OptRow label="最佳化" params={data.best?.params ?? {}} is={data.best?.inSample ?? null} oos={data.best?.outOfSample ?? null} />
                  <OptRow label="基準" params={data.baseline?.params ?? {}} is={data.baseline?.inSample ?? null} oos={data.baseline?.outOfSample ?? null} />
                </tbody>
              </table>
            </div>
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <Fact
                label="參數穩定度（樣本內 vs 外排名相關）"
                value={data.stability === null ? '—' : data.stability.toFixed(2)}
                hint={data.stability === null ? '' : data.stability >= 0.5 ? '穩定：樣本內好的參數樣本外也好' : data.stability >= 0 ? '普通：最佳化結果參考就好' : '不穩定：樣本內最佳很可能是運氣'}
              />
              <Fact
                label="報酬最大化的風險建議"
                value={data.suggestedRiskPct === null ? '—' : `每筆 ${data.suggestedRiskPct}%`}
                hint={`目前 ${config.riskPerTradePct}%；讓回測最大回撤落在上限 ${data.maxDrawdownPct}% 的 80%`}
              />
              <Fact label="合格參數組數" value={`${data.variants.filter((v) => v.eligible).length} / ${data.variants.length}`} hint="回撤超標或交易少於 5 筆的被淘汰" />
            </dl>
            <p className="text-[11px] text-muted-foreground">
              「最佳化」策略變體會自動用這組參數跑虛擬帳戶；要讓主帳戶也用，到設定選「最佳化」。
              提高每筆風險會等比例放大報酬與回撤，建議先看策略競賽的實際表現再調。
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function OptRow({ label, params, is, oos }: { label: string; params: Parameters<typeof formatParams>[0]; is: TaifexBacktestMetrics | null; oos: TaifexBacktestMetrics | null }) {
  return (
    <tr className="border-t">
      <td className="py-1.5 font-medium">{label}</td>
      <td>{formatParams(params)}</td>
      <td className={cn('text-right', pnlClass(is?.totalReturnPct))}>{formatPctValue(is?.totalReturnPct, 1)}</td>
      <td className={cn('text-right font-medium', pnlClass(oos?.totalReturnPct))}>{formatPctValue(oos?.totalReturnPct, 1)}</td>
      <td className="text-right">{oos?.maxDrawdownPct === null || oos?.maxDrawdownPct === undefined ? '—' : `-${oos.maxDrawdownPct.toFixed(1)}%`}</td>
      <td className="text-right">{oos?.sharpe === null || oos?.sharpe === undefined ? '—' : oos.sharpe.toFixed(2)}</td>
    </tr>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
      {hint ? <dd className="text-[11px] text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}
