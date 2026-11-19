import { useState } from 'react';
import { Gauge, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { usePortfolioPerformance, type PerformancePeriod } from '../hooks';

const PERIOD_LABEL: Record<PerformancePeriod, string> = {
  ytd: '今年',
  '1y': '1 年',
  '3y': '3 年',
  all: '全部',
};

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const v = value * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function tone(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'text-muted-foreground';
  return value >= 0 ? 'text-emerald-500' : 'text-red-500';
}

function keyLabel(key: string): string {
  return key.replace(/-/g, '/');
}

/** 投資績效卡：XIRR（年化）+ TWR（期間 / 年化），期間可切 YTD / 1Y / 3Y / 全部 */
export function PerformanceCard() {
  const [period, setPeriod] = useState<PerformancePeriod>('ytd');
  const { data, isLoading, error, startKey } = usePortfolioPerformance(period);

  return (
    <Card>
      <CardHeader className="flex flex-col items-start justify-between gap-2 pb-2 sm:flex-row sm:items-center">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="size-4" /> 績效
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="XIRR 與 TWR 說明">
                <Info className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="space-y-2 text-xs leading-relaxed">
              <p><span className="font-medium">XIRR（資金加權）</span>：把每筆買進、賣出、股息與期末市值當現金流算出的年化報酬，反映你的投入時機。</p>
              <p><span className="font-medium">TWR（時間加權）</span>：逐日連乘、排除資金進出影響，只看持股本身的表現，可直接與大盤比較。</p>
              <p className="text-muted-foreground">資料來自每日投資快照；期間未滿一年時 TWR 不年化。期間很短時 XIRR 年化後波動很大，僅供參考。</p>
            </PopoverContent>
          </Popover>
        </CardTitle>
        <Tabs value={period} onValueChange={(v) => setPeriod(v as PerformancePeriod)}>
          <TabsList>
            {(Object.keys(PERIOD_LABEL) as PerformancePeriod[]).map((p) => (
              <TabsTrigger key={p} value={p} className="text-xs">{PERIOD_LABEL[p]}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : error ? (
          <p className="text-sm text-destructive">讀取績效資料失敗：{error instanceof Error ? error.message : '未知錯誤'}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">需要至少 2 筆投資快照才能計算績效。</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Metric label="XIRR（年化）" value={pct(data.xirr)} className={tone(data.xirr)} />
              <Metric label="TWR（期間）" value={pct(data.twr?.periodReturn)} className={tone(data.twr?.periodReturn)} />
              <Metric
                label="TWR（年化）"
                value={data.twr?.annualized != null ? pct(data.twr.annualized) : '未滿一年'}
                className={data.twr?.annualized != null ? tone(data.twr.annualized) : 'text-muted-foreground text-sm'}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              區間 {keyLabel(data.baseKey)} – {keyLabel(data.endKey)}（{Math.round(data.days)} 天）
              {data.coverageShort && startKey ? ` · 快照從 ${keyLabel(data.baseKey)} 才開始，早於此的期間無法計算` : ''}
              {data.days < 30 ? ' · 期間短，年化數字僅供參考' : ''}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface MetricProps {
  label: string;
  value: string;
  className?: string;
}

function Metric({ label, value, className }: MetricProps) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground sm:text-[11px]">{label}</div>
      <div className={cn('text-base font-semibold tabular-nums sm:text-lg', className)}>{value}</div>
    </div>
  );
}
