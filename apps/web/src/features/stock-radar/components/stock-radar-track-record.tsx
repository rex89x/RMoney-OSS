import { useMemo, useState } from 'react';
import { ClipboardCheck, LineChart as LineChartIcon, Sigma } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS } from '@/lib/chart-theme';
import { cn } from '@/lib/utils';
import { useStockRadarOutcomes } from '../hooks';
import { ACTION_META, formatPct } from '../options';
import { HORIZONS, joinTrackRecord, summarizeTrackRecord, type Horizon } from '../track-record';
import type { StockRadarMarket, StockRadarRun } from '../types';

interface StockRadarTrackRecordProps {
  runs: StockRadarRun[];
  market: StockRadarMarket;
}

/** 「成績單」：盤前建議的事後表現（從建議隔天開盤進場、相對大盤的超額報酬） */
export function StockRadarTrackRecord({ runs, market }: StockRadarTrackRecordProps) {
  const outcomes = useStockRadarOutcomes(true);
  const [horizon, setHorizon] = useState<Horizon>(5);
  const [version, setVersion] = useState('all');

  const rows = useMemo(
    () => joinTrackRecord(runs, outcomes.data ?? []).filter((row) => row.market === market),
    [runs, outcomes.data, market],
  );
  const versions = useMemo(() => [...new Set(rows.map((row) => row.modelVersion).filter(Boolean))], [rows]);
  const filtered = version === 'all' ? rows : rows.filter((row) => row.modelVersion === version);
  const summary = useMemo(() => summarizeTrackRecord(filtered, horizon), [filtered, horizon]);

  if (outcomes.isLoading) return <Skeleton className="h-64 w-full" />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="成績單累積中"
        description="每天 08:00 評估時會回填過去建議的 1／5／20 個交易日報酬；評估滿一個交易日後開始出現。"
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="flex overflow-hidden rounded-full border" role="radiogroup" aria-label="持有天數">
          {HORIZONS.map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={horizon === h}
              onClick={() => setHorizon(h)}
              className={cn('px-3 py-1', horizon === h ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
            >
              {h} 日
            </button>
          ))}
        </div>
        {versions.length > 1 ? (
          <Select value={version} onValueChange={setVersion}>
            <SelectTrigger className="h-8 w-48 text-xs" aria-label="模型版本"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部模型版本</SelectItem>
              {versions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
        <span className="text-muted-foreground">{summary.samples} 筆樣本 · {summary.icSeries.length} 次評估</span>
      </div>

      <StatGrid>
        <StatTile
          label="方向命中率"
          value={summary.hitRate === null ? '—' : `${(summary.hitRate * 100).toFixed(0)}%`}
          tone={summary.hitRate === null ? 'plain' : summary.hitRate >= 0.5 ? 'good' : 'bad'}
          hint={`看多／看空建議 ${summary.directionalSamples} 筆，50% 為擲硬幣`}
        />
        <StatTile
          label="平均 IC"
          value={summary.meanIC === null ? '—' : summary.meanIC.toFixed(3)}
          tone={summary.meanIC === null ? 'plain' : summary.meanIC > 0 ? 'good' : 'bad'}
          hint="分數與事後報酬的排名相關；> 0.05 已屬不錯"
        />
        <StatTile
          label="IC t 值"
          value={summary.icTStat === null ? '—' : summary.icTStat.toFixed(2)}
          tone={summary.icTStat !== null && Math.abs(summary.icTStat) >= 2 ? 'good' : 'plain'}
          hint="|t| ≥ 2 才比較可能不是運氣"
        />
        <StatTile
          label="輿情增量"
          value={summary.sentimentLift.withSentiment === null || summary.sentimentLift.quantOnly === null
            ? '—'
            : (summary.sentimentLift.withSentiment - summary.sentimentLift.quantOnly).toFixed(3)}
          hint={summary.sentimentLift.periods
            ? `${summary.sentimentLift.periods} 次有輿情：合成 IC − 純量化 IC`
            : '還沒有含輿情的評估'}
        />
      </StatGrid>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><Sigma className="size-4" /> 各動作的 {horizon} 日超額報酬</CardTitle>
          <p className="text-xs text-muted-foreground">相對 {market === 'TW' ? '0050' : 'SPY'}；看多動作希望為正、看空動作希望為負。</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={summary.actions.map((a) => ({ label: ACTION_META[a.action].label, value: (a.avgExcess ?? 0) * 100 }))}>
                <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" {...AXIS_PROPS} />
                <YAxis width={40} {...AXIS_PROPS} tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
                <ReferenceLine y={0} stroke={CHART_COLORS.axis} />
                <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number) => [`${value.toFixed(2)}%`, '平均超額']} />
                <Bar dataKey="value" radius={3}>
                  {summary.actions.map((a) => (
                    <Cell key={a.action} fill={(a.avgExcess ?? 0) >= 0 ? 'hsl(var(--success))' : 'hsl(var(--destructive))'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* 欄位多：手機上橫向捲動，不要把整張卡撐寬 */}
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[420px] whitespace-nowrap text-xs">
              <thead className="text-muted-foreground">
                <tr><th className="text-left font-normal">動作</th><th className="text-right font-normal">樣本</th><th className="text-right font-normal">平均超額</th><th className="text-right font-normal">命中率</th></tr>
              </thead>
              <tbody className="tabular-nums">
                {summary.actions.map((a) => (
                  <tr key={a.action} className="border-t">
                    <td className="py-1">{ACTION_META[a.action].label}</td>
                    <td className="text-right">{a.n}</td>
                    <td className="text-right">{formatPct(a.avgExcess, 2)}</td>
                    <td className="text-right">{a.hitRate === null ? '—' : `${(a.hitRate * 100).toFixed(0)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><LineChartIcon className="size-4" /> 每次評估的 IC</CardTitle>
          <p className="text-xs text-muted-foreground">需要同一天至少 3 檔有報酬。主線為合成分數，虛線為純量化分數。</p>
        </CardHeader>
        <CardContent className="h-56">
          {summary.icSeries.length < 2 ? (
            <p className="text-sm text-muted-foreground">累積 2 次以上評估後顯示。</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={summary.icSeries}>
                <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" />
                <XAxis dataKey="date" {...AXIS_PROPS} tickFormatter={(v: string) => v.slice(5)} minTickGap={24} />
                <YAxis domain={[-1, 1]} width={32} {...AXIS_PROPS} tickFormatter={(v: number) => v.toFixed(1)} />
                <ReferenceLine y={0} stroke={CHART_COLORS.axis} />
                <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number, name: string) => [value.toFixed(3), name]} />
                <Line dataKey="ic" name="合成 IC" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
                <Line dataKey="quantIc" name="純量化 IC" stroke={CHART_COLORS.muted} strokeDasharray="4 3" dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
