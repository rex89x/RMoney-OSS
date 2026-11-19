import { useMemo } from 'react';
import { AlertTriangle, FlaskConical, LineChart as LineChartIcon, Play } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, formatAxisTWD, paletteColor } from '@/lib/chart-theme';
import { formatTW } from '@/lib/tz';
import { useRunTaifexBacktest, useTaifexBacktest } from '../hooks';
import { TAIFEX_PRODUCT_SPECS, formatPctValue, formatTWD } from '../options';
import type { TaifexBacktestMetrics, TaifexBacktestVariantKey } from '../types';

const VARIANTS: Array<{ key: TaifexBacktestVariantKey; label: string; desc: string }> = [
  { key: 'full', label: '完整策略', desc: '趨勢 + 通道 + 動能 + 外資 + PCR' },
  { key: 'trendOnly', label: '純趨勢', desc: '只用趨勢 / 通道 / 動能，檢查籌碼因子是否有增量' },
  { key: 'buyHold', label: '大盤持有', desc: '近月連續、不含槓桿（100% 名目曝險）' },
];

/** 回測：與虛擬帳戶共用同一套步進函式，三組對照 */
export function TaifexBacktest() {
  const backtest = useTaifexBacktest(true);
  const run = useRunTaifexBacktest();
  const data = backtest.data ?? null;

  const chart = useMemo(() => {
    if (!data) return [];
    const byDate = new Map<string, Record<string, number | string>>();
    VARIANTS.forEach(({ key }) => {
      data.variants[key].curve.forEach((p) => {
        const row = byDate.get(p.date) ?? { date: p.date };
        row[key] = p.equity;
        byDate.set(p.date, row);
      });
    });
    return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [data]);

  const runButton = (
    <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
      <Play className="size-3.5" /> {run.isPending ? '回測中…' : '重新回測'}
    </Button>
  );

  if (backtest.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data || !data.variants.full.metrics) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="還沒有回測"
        description="每週日 20:00 自動用已存的期交所日 K 回測，也可以現在手動執行（需先有歷史資料）。"
        action={runButton}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{data.from} ~ {data.to} · {data.bars} 根日 K · 外資資料 {data.flowDays} 天 · {data.modelVersion}</span>
        <span>· {TAIFEX_PRODUCT_SPECS[data.product].label}、起始 {formatTWD(data.initialCapital)}、每筆風險 {data.riskPerTradePct}%</span>
        {data.generatedAt ? <span>· 計算於 {formatTW(data.generatedAt, 'MM/dd HH:mm')}</span> : null}
        <span className="ml-auto">{runButton}</span>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><LineChartIcon className="size-4" aria-hidden /> 權益曲線</CardTitle>
          <p className="text-xs text-muted-foreground">隔日開盤成交、停損以當日高低價檢查（跳空以開盤價），已扣手續費、滑價、期交稅、換月成本。</p>
        </CardHeader>
        <CardContent className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" />
              <XAxis dataKey="date" {...AXIS_PROPS} tickFormatter={(v: string) => v.slice(0, 7)} minTickGap={40} />
              <YAxis width={48} {...AXIS_PROPS} domain={['auto', 'auto']} tickFormatter={formatAxisTWD} />
              <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number, name: string) => [formatTWD(value), name]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {VARIANTS.map((v, i) => (
                <Line key={v.key} dataKey={v.key} name={v.label} stroke={paletteColor(i)} strokeWidth={v.key === 'full' ? 2 : 1.5} dot={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">績效比較</CardTitle></CardHeader>
        <CardContent>
          {/* 手機：每組策略一張指標卡；桌面才用完整表格 */}
          <div className="space-y-3 sm:hidden">
            {VARIANTS.map((v) => <MetricsCard key={v.key} label={v.label} desc={v.desc} metrics={data.variants[v.key].metrics} />)}
          </div>
          <div className="-mx-1 hidden overflow-x-auto px-1 sm:block">
            <table className="w-full min-w-[640px] whitespace-nowrap text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left font-normal" />
                  <th className="text-right font-normal">總報酬</th>
                  <th className="text-right font-normal">年化</th>
                  <th className="text-right font-normal">Sharpe</th>
                  <th className="text-right font-normal">最大回撤</th>
                  <th className="text-right font-normal">交易</th>
                  <th className="text-right font-normal">勝率</th>
                  <th className="text-right font-normal">獲利因子</th>
                  <th className="text-right font-normal">曝險</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {VARIANTS.map((v) => <MetricsRow key={v.key} label={v.label} desc={v.desc} metrics={data.variants[v.key].metrics} />)}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 rounded-xl border p-3 text-xs leading-relaxed text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="space-y-1">
          <p>參數凍結在 {data.modelVersion}，回測結果只用來檢查邏輯與風險，不會拿來調參（避免過度擬合）。</p>
          <p>限制：樣本約 2 年、只有一個市場；輿情沒有歷史資料所以不在回測內；保證金與手續費以設定值估算。看到好看的數字也請先用虛擬帳戶跑滿 3 個月再考慮實單。</p>
        </div>
      </div>
    </div>
  );
}

function MetricsRow({ label, desc, metrics }: { label: string; desc: string; metrics: TaifexBacktestMetrics | null }) {
  if (!metrics) return null;
  return (
    <tr className="border-t align-top">
      <td className="py-1.5">
        <div className="font-medium">{label}</div>
        <div className="text-[10px] text-muted-foreground">{desc}</div>
      </td>
      <td className="text-right">{formatPctValue(metrics.totalReturnPct, 1)}</td>
      <td className="text-right">{formatPctValue(metrics.cagrPct, 1)}</td>
      <td className="text-right">{metrics.sharpe === null ? '—' : metrics.sharpe.toFixed(2)}</td>
      <td className="text-right">{metrics.maxDrawdownPct === null ? '—' : `-${metrics.maxDrawdownPct.toFixed(1)}%`}</td>
      <td className="text-right">{metrics.trades || '—'}</td>
      <td className="text-right">{metrics.winRatePct === null ? '—' : `${metrics.winRatePct.toFixed(0)}%`}</td>
      <td className="text-right">{metrics.profitFactor === null ? '—' : metrics.profitFactor.toFixed(2)}</td>
      <td className="text-right">{metrics.exposurePct === null ? '—' : `${metrics.exposurePct.toFixed(0)}%`}</td>
    </tr>
  );
}

function MetricsCard({ label, desc, metrics }: { label: string; desc: string; metrics: TaifexBacktestMetrics | null }) {
  if (!metrics) return null;
  const items: Array<[string, string]> = [
    ['總報酬', formatPctValue(metrics.totalReturnPct, 1)],
    ['年化', formatPctValue(metrics.cagrPct, 1)],
    ['Sharpe', metrics.sharpe === null ? '—' : metrics.sharpe.toFixed(2)],
    ['最大回撤', metrics.maxDrawdownPct === null ? '—' : `-${metrics.maxDrawdownPct.toFixed(1)}%`],
    ['交易 / 勝率', `${metrics.trades || '—'} / ${metrics.winRatePct === null ? '—' : `${metrics.winRatePct.toFixed(0)}%`}`],
    ['曝險', metrics.exposurePct === null ? '—' : `${metrics.exposurePct.toFixed(0)}%`],
  ];
  return (
    <div className="rounded-lg border p-3">
      <div className="text-sm font-medium">{label}</div>
      <div className="text-[11px] text-muted-foreground">{desc}</div>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
