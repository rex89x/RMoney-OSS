import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatPercent, cn } from '@/lib/utils';
import { useDividends, usePortfolioSnapshots, useRealizedLots, useStockCandles } from '../hooks';
import { buildPortfolioFlows, twr } from '../performance';

type BenchmarkKey = '0050' | 'SPY';

/**
 * Portfolio 用 TWR 累積指數（排除買進 / 賣出 / 股息等資金進出），大盤用收盤價，
 * 兩者都標準化到首個共同日 = 100，才是同一把尺的比較（不再用 totalValueTWD，
 * 否則加碼會被誤算成「贏大盤」）。
 */
export function BenchmarkComparison() {
  const [bench, setBench] = useState<BenchmarkKey>('0050');
  const days = 90;
  const { data: snapshots = [], isLoading } = usePortfolioSnapshots(days);
  const { data: candles = [] } = useStockCandles(bench, days);
  const { data: realized = [] } = useRealizedLots();
  const { data: dividends = [] } = useDividends();

  const twrIndexByDate = useMemo(() => {
    const series = buildPortfolioFlows(snapshots, realized, dividends);
    const result = twr(series.points, series.flows);
    const out = new Map<string, number>();
    if (!result) return out;
    // twr 的 series 與 points 同順序（都依日期排序），keys 與 points 平行
    result.series.forEach((p, i) => {
      const key = series.keys[i];
      if (key) out.set(key, p.index);
    });
    return out;
  }, [snapshots, realized, dividends]);

  const data = useMemo(() => {
    if (twrIndexByDate.size === 0 || candles.length === 0) return [];
    const candleByDate = new Map(candles.map((c) => [c.date, c.close]));
    // 最早的共同日（快照與大盤日 K 都有）當基準
    const common = snapshots.filter((s) => candleByDate.has(s.date) && twrIndexByDate.has(s.date));
    const first = common[0];
    if (!first) return [];
    const baseCandle = candleByDate.get(first.date) ?? 0;
    const baseIndex = twrIndexByDate.get(first.date) ?? 0;
    if (!(baseCandle > 0) || !(baseIndex > 0)) return [];
    return common.map((s) => ({
      date: s.date,
      portfolio: ((twrIndexByDate.get(s.date) ?? baseIndex) / baseIndex) * 100,
      benchmark: ((candleByDate.get(s.date) ?? baseCandle) / baseCandle) * 100,
    }));
  }, [snapshots, candles, twrIndexByDate]);

  if (isLoading) return <Skeleton className="h-64" />;

  if (data.length < 2) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4" /> 持倉 vs 大盤</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">需至少 2 筆 portfolio snapshot 與對應大盤日 K 才能畫出比較曲線。</p>
        </CardContent>
      </Card>
    );
  }

  const last = data[data.length - 1]!; // 非空：索引已做邊界 / 長度檢查
  const portfolioRet = last.portfolio - 100;
  const benchRet = last.benchmark - 100;
  const alpha = portfolioRet - benchRet;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4" /> 持倉 vs 大盤
        </CardTitle>
        <Tabs value={bench} onValueChange={(v) => setBench(v as BenchmarkKey)}>
          <TabsList>
            <TabsTrigger value="0050" className="text-xs">0050</TabsTrigger>
            <TabsTrigger value="SPY" className="text-xs">SPY</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-[10px] text-muted-foreground">Portfolio（TWR）</div>
            <div className={cn('font-semibold', portfolioRet >= 0 ? 'text-emerald-500' : 'text-red-500')}>
              {formatPercent(portfolioRet, 1)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">{bench}</div>
            <div className={cn('font-semibold', benchRet >= 0 ? 'text-emerald-500' : 'text-red-500')}>
              {formatPercent(benchRet, 1)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">Alpha</div>
            <div className={cn('font-semibold', alpha >= 0 ? 'text-emerald-500' : 'text-red-500')}>
              {alpha >= 0 ? '+' : ''}{alpha.toFixed(1)}%
            </div>
          </div>
        </div>
        <div className="h-[220px] -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} minTickGap={20} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => v.toFixed(0)} domain={['dataMin', 'dataMax']} width={36} />
              <Tooltip formatter={(v: number, n) => [`${v.toFixed(1)}`, n === 'portfolio' ? 'Portfolio' : bench]} />
              <Legend formatter={(v) => <span className="text-xs">{v === 'portfolio' ? 'Portfolio' : bench}</span>} />
              <Line type="monotone" dataKey="portfolio" stroke="#8b5cf6" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="benchmark" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="text-[11px] text-muted-foreground">標準化首日 = 100；Portfolio 用時間加權報酬（TWR），已排除加碼 / 賣出 / 股息的資金進出，大盤為收盤價（不含息）。需要 stocks/{bench}/candles 已存在（可用 backfillCandles 回填）。</p>
      </CardContent>
    </Card>
  );
}
