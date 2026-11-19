import { AlertTriangle, FlaskConical, LineChart as LineChartIcon, Play, Sigma } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, paletteColor } from '@/lib/chart-theme';
import { formatTW } from '@/lib/tz';
import { useRunStockRadarBacktest, useStockRadarBacktest } from '../hooks';
import { BUCKET_LABELS, MARKET_LABELS, formatPct } from '../options';
import type { StockRadarCurveStats, StockRadarMarket } from '../types';

interface StockRadarBacktestProps {
  market: StockRadarMarket;
}

/** 「回測」：用 5 年日 K 做 walk-forward，驗證價格因子公式過去的表現 */
export function StockRadarBacktest({ market }: StockRadarBacktestProps) {
  const backtest = useStockRadarBacktest(market, true);
  const runBacktest = useRunStockRadarBacktest();
  const data = backtest.data ?? null;

  const runButton = (
    <Button size="sm" variant="outline" disabled={runBacktest.isPending} onClick={() => runBacktest.mutate(market)}>
      <Play className="size-3.5" /> {runBacktest.isPending ? '回測中（約 1–3 分鐘）…' : `重新回測${MARKET_LABELS[market]}`}
    </Button>
  );

  if (backtest.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data || data.periods === 0) {
    return (
      <EmptyState
        icon={FlaskConical}
        title={`還沒有${MARKET_LABELS[market]}回測`}
        description="每週日 20:00 自動用 Yahoo 5 年日 K 回測一次，也可以現在手動執行。"
        action={runButton}
      />
    );
  }

  const strategies: Array<{ key: string; label: string; stats: StockRadarCurveStats }> = [
    { key: 'strategy', label: '雷達策略', stats: data.strategy },
    { key: 'equalWeight', label: '清單等權持有', stats: data.equalWeight },
    { key: 'benchmark', label: `大盤 ${data.benchmarkSymbol}`, stats: data.benchmark },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{data.from} ~ {data.to} · {data.periods} 期 · {data.symbols} 檔 · {data.modelVersion}</span>
        {data.generatedAt ? <span>· 計算於 {formatTW(data.generatedAt, 'MM/dd HH:mm')}</span> : null}
        <span className="ml-auto">{runButton}</span>
      </div>

      <StatGrid>
        <StatTile
          label="平均 IC（20 日）"
          value={data.meanIC === null ? '—' : data.meanIC.toFixed(3)}
          tone={data.meanIC === null ? 'plain' : data.meanIC > 0 ? 'good' : 'bad'}
          hint={`IC > 0 的期數 ${data.icPositiveRate === null ? '—' : `${(data.icPositiveRate * 100).toFixed(0)}%`}`}
        />
        <StatTile
          label="IC t 值"
          value={data.icTStat === null ? '—' : data.icTStat.toFixed(2)}
          tone={data.icTStat !== null && data.icTStat >= 2 ? 'good' : 'plain'}
          hint="期間重疊，t 值會高估，僅供參考"
        />
        <StatTile
          label="策略年化"
          value={formatPct(data.strategy.cagr)}
          tone={(data.strategy.cagr ?? 0) >= (data.benchmark.cagr ?? 0) ? 'good' : 'bad'}
          hint={`大盤 ${formatPct(data.benchmark.cagr)}，已扣交易成本`}
        />
        <StatTile
          label="策略最大回撤"
          value={formatPct(data.strategy.maxDrawdown)}
          tone="warn"
          hint={`大盤 ${formatPct(data.benchmark.maxDrawdown)}`}
        />
      </StatGrid>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><LineChartIcon className="size-4" /> 淨值曲線</CardTitle>
          <p className="text-xs text-muted-foreground">
            雷達策略：每 5 個交易日等權持有分數 ≥ 0 的標的（大盤偏空時 ≥ +0.35），沒有就空手；扣來回成本 × 換手率（{market === 'TW' ? '台股 0.6%' : '美股 0.1%'}）。
          </p>
        </CardHeader>
        <CardContent className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.curve} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" />
              <XAxis dataKey="date" {...AXIS_PROPS} tickFormatter={(v: string) => v.slice(0, 7)} minTickGap={40} />
              <YAxis width={40} {...AXIS_PROPS} domain={['auto', 'auto']} tickFormatter={(v: number) => v.toFixed(1)} />
              <ReferenceLine y={1} stroke={CHART_COLORS.axis} />
              <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number, name: string) => [value.toFixed(3), name]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {strategies.map((s, i) => (
                <Line key={s.key} dataKey={s.key} name={s.label} stroke={paletteColor(i)} strokeWidth={s.key === 'strategy' ? 2 : 1.5} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Sigma className="size-4" /> 分數區間的 20 日超額報酬</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.buckets.map((b) => ({ label: BUCKET_LABELS[b.key].replace(/（.*）/, ''), value: (b.avgExcess20 ?? 0) * 100 }))}>
                  <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" {...AXIS_PROPS} />
                  <YAxis width={40} {...AXIS_PROPS} tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
                  <ReferenceLine y={0} stroke={CHART_COLORS.axis} />
                  <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number) => [`${value.toFixed(2)}%`, '平均超額']} />
                  <Bar dataKey="value" radius={3}>
                    {data.buckets.map((b) => (
                      <Cell key={b.key} fill={(b.avgExcess20 ?? 0) >= 0 ? 'hsl(var(--success))' : 'hsl(var(--destructive))'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {/* 欄位多：手機上橫向捲動，不要把整張卡撐寬 */}
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[420px] whitespace-nowrap text-xs">
                <thead className="text-muted-foreground">
                  <tr><th className="text-left font-normal">分數</th><th className="text-right font-normal">樣本</th><th className="text-right font-normal">平均超額</th><th className="text-right font-normal">勝率</th></tr>
                </thead>
                <tbody className="tabular-nums">
                  {data.buckets.map((b) => (
                    <tr key={b.key} className="border-t">
                      <td className="py-1">{BUCKET_LABELS[b.key]}</td>
                      <td className="text-right">{b.n}</td>
                      <td className="text-right">{formatPct(b.avgExcess20, 2)}</td>
                      <td className="text-right">{b.hitRate === null ? '—' : `${(b.hitRate * 100).toFixed(0)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">分數越高的區間平均超額報酬越高，公式才有排序能力。</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">績效比較</CardTitle>
          </CardHeader>
          <CardContent>
            {/* 欄位多：手機上橫向捲動，不要把整張卡撐寬 */}
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[420px] whitespace-nowrap text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-normal" />
                    <th className="text-right font-normal">總報酬</th>
                    <th className="text-right font-normal">年化</th>
                    <th className="text-right font-normal">波動</th>
                    <th className="text-right font-normal">Sharpe</th>
                    <th className="text-right font-normal">最大回撤</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {strategies.map((s) => (
                    <tr key={s.key} className="border-t">
                      <td className="py-1.5">{s.label}</td>
                      <td className="text-right">{formatPct(s.stats.totalReturn, 0)}</td>
                      <td className="text-right">{formatPct(s.stats.cagr)}</td>
                      <td className="text-right">{formatPct(s.stats.volatility, 1, false)}</td>
                      <td className="text-right">{s.stats.sharpe === null ? '—' : s.stats.sharpe.toFixed(2)}</td>
                      <td className="text-right">{formatPct(s.stats.maxDrawdown)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-1.5 p-4 text-xs text-muted-foreground">
          <p className="flex items-center gap-1.5 font-medium text-foreground"><AlertTriangle className="size-3.5 text-warning" /> 解讀限制</p>
          <p>回測標的是「目前」的持股與自選股，屬於事後挑選（倖存者偏差），結果通常比實際樂觀。</p>
          <p>只含價格因子；籌碼與輿情沒有歷史資料，不在回測內。公式參數沒有用回測結果調整，避免過度擬合（Bailey & López de Prado 2014）。</p>
          {data.skippedSymbols.length ? <p>歷史不足略過：{data.skippedSymbols.join('、')}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
