import { useMemo } from 'react';
import { Activity, LineChart as LineChartIcon, ListOrdered } from 'lucide-react';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, paletteColor } from '@/lib/chart-theme';
import { signalChartData } from '../dashboard';
import { FACTOR_LABELS, formatPoints, formatScore, formatTWD } from '../options';
import { TAIFEX_FACTOR_KEYS, TAIFEX_FACTOR_WEIGHTS, TAIFEX_RULES, type TaifexSignal } from '../types';
import { FactorBar, TargetBadge } from './taifex-parts';

interface TaifexSignalDetailProps {
  signals: TaifexSignal[];
}

/** 訊號：走勢 + 因子拆解 + 指標 + 近 20 日訊號表 */
export function TaifexSignalDetail({ signals }: TaifexSignalDetailProps) {
  const chart = useMemo(() => signalChartData(signals), [signals]);
  const latest = useMemo(() => [...signals].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null, [signals]);
  const recent = useMemo(() => [...signals].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20), [signals]);

  if (!latest) return <p className="text-sm text-muted-foreground">還沒有訊號。</p>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><LineChartIcon className="size-4" aria-hidden /> 近月連續走勢</CardTitle>
          <p className="text-xs text-muted-foreground">收盤、EMA20 / EMA60（換月已往回調整後換回真實價格）與持倉中的停損線。</p>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="h-64 sm:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" />
                <XAxis dataKey="date" {...AXIS_PROPS} tickFormatter={(v: string) => v.slice(5)} minTickGap={32} />
                <YAxis width={48} {...AXIS_PROPS} domain={['auto', 'auto']} tickFormatter={(v: number) => Math.round(v).toLocaleString('zh-TW')} />
                <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number, name: string) => [formatPoints(value), name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line dataKey="close" name="收盤" stroke={paletteColor(0)} strokeWidth={2} dot={false} />
                <Line dataKey="ema20" name="EMA20" stroke={paletteColor(1)} strokeWidth={1.25} dot={false} connectNulls />
                <Line dataKey="ema60" name="EMA60" stroke={paletteColor(2)} strokeWidth={1.25} dot={false} connectNulls />
                <Line dataKey="stop" name="停損" stroke={CHART_COLORS.warning} strokeWidth={1.25} strokeDasharray="4 3" dot={false} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis dataKey="date" hide />
                <YAxis width={48} {...AXIS_PROPS} domain={[-1, 1]} ticks={[-1, 0, 1]} />
                <ReferenceLine y={TAIFEX_RULES.entry} stroke={CHART_COLORS.axis} strokeDasharray="3 3" />
                <ReferenceLine y={-TAIFEX_RULES.entry} stroke={CHART_COLORS.axis} strokeDasharray="3 3" />
                <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number) => [formatScore(value), '合成分數']} />
                <Bar dataKey="composite" name="合成分數">
                  {chart.map((p) => (
                    <Cell key={p.date} fill={(p.composite ?? 0) >= 0 ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-muted-foreground">下方長條為每日合成分數，虛線為 ±{TAIFEX_RULES.entry} 進場門檻。</p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4" aria-hidden /> 因子拆解（{latest.date}）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {TAIFEX_FACTOR_KEYS.map((key) => (
              <FactorBar
                key={key}
                label={FACTOR_LABELS[key].label}
                weight={TAIFEX_FACTOR_WEIGHTS[key]}
                score={latest.factors[key].score}
                hint={FACTOR_LABELS[key].desc}
              />
            ))}
            <p className="text-[11px] text-muted-foreground">
              量化分數 {formatScore(latest.quantScore)}（缺資料的因子不計入分母）＋輿情 {formatScore(latest.sentimentAdj)}
              {latest.trending === false ? `，ADX < ${TAIFEX_RULES.adxTrend} 盤整打 6 折` : ''} ＝ 合成 {formatScore(latest.composite)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">指標與籌碼</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <Row label="ATR20（日均真實波幅）" value={`${formatPoints(latest.indicators.atr20)} 點`} />
              <Row label="ADX14（趨勢強度）" value={formatPoints(latest.indicators.adx14)} />
              <Row label="EMA20" value={formatPoints(latest.indicators.ema20)} />
              <Row label="EMA60" value={formatPoints(latest.indicators.ema60)} />
              <Row label="55 日高點" value={formatPoints(latest.indicators.donchianHigh)} />
              <Row label="55 日低點" value={formatPoints(latest.indicators.donchianLow)} />
              <Row label="60 日報酬" value={latest.factors.tsmom.raw === null ? '—' : `${(latest.factors.tsmom.raw * 100).toFixed(1)}%`} />
              <Row label="外資台指期淨未平倉" value={latest.factors.foreignFlow.raw === null ? '—' : `${formatTWD(latest.factors.foreignFlow.raw, true)} 口`} />
              <Row label="選擇權未平倉 PCR" value={latest.factors.pcr.raw === null ? '—' : `${latest.factors.pcr.raw.toFixed(1)}%`} />
              <Row label="契約" value={latest.contract ?? '—'} />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><ListOrdered className="size-4" aria-hidden /> 近 20 日訊號</CardTitle></CardHeader>
        <CardContent>
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[520px] whitespace-nowrap text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left font-normal">日期</th>
                  <th className="text-right font-normal">收盤</th>
                  <th className="text-right font-normal">量化</th>
                  <th className="text-right font-normal">輿情</th>
                  <th className="text-right font-normal">合成</th>
                  <th className="pl-3 text-left font-normal">建議</th>
                  <th className="text-left font-normal">事件</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {recent.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="py-1.5">{s.date}</td>
                    <td className="text-right">{formatPoints(s.close)}</td>
                    <td className="text-right">{formatScore(s.quantScore)}</td>
                    <td className="text-right">{formatScore(s.sentimentAdj)}</td>
                    <td className="text-right font-medium">{formatScore(s.composite)}</td>
                    <td className="pl-3"><TargetBadge target={s.desired} kind="position" className="py-0" /></td>
                    <td>{s.eventRisk ? '暫停開倉' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </>
  );
}
