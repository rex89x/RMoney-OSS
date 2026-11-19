import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TechnicalChart, type TechnicalSeries } from '@/features/investments/components/technical-chart';
import { useBackfillCandles } from '@/features/investments/hooks';
import { fxFractionDigits } from '@/lib/utils';
import { useFxCandles } from '../hooks';
import type { FxRate } from '../types';

interface FxChartProps {
  rates: FxRate[];
}

export function FxChart({ rates }: FxChartProps) {
  const pairs = useMemo(() => {
    const fromRates = rates.map((r) => r.id);
    const defaults = ['USD_TWD', 'EUR_TWD', 'JPY_TWD', 'CNY_TWD'];
    return Array.from(new Set([...fromRates, ...defaults]));
  }, [rates]);

  const [pair, setPair] = useState<string>(pairs[0] ?? 'USD_TWD');
  const { data: candles = [] } = useFxCandles(pair, 400);
  const backfill = useBackfillCandles();

  const series: TechnicalSeries[] = useMemo(
    () => candles.map((c) => ({
      date: c.date,
      open: c.rate,
      high: c.rate,
      low: c.rate,
      close: c.rate,
    })),
    [candles],
  );

  // 小幣對（JPY/TWD、CNY/TWD ≈ 0.x）要更多 fraction digits 才看得到變動
  const precision = useMemo(() => {
    const sample = candles.length > 0
      ? candles[Math.floor(candles.length / 2)]?.rate
      : undefined;
    return sample ? fxFractionDigits(sample) : 4;
  }, [candles]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">匯率技術分析</CardTitle>
        <div className="flex items-center gap-2">
          <Select value={pair} onValueChange={setPair}>
            <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {pairs.map((p) => (
                <SelectItem key={p} value={p}>{p.replace('_', ' / ')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void backfill.mutateAsync({ scope: 'fx', pair, days: 365 })}
            disabled={backfill.isPending}
          >
            <Download className={backfill.isPending ? 'size-4 animate-spin' : 'size-4'} /> 回填
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <TechnicalChart
          data={series}
          showVolume={false}
          pricePrecision={precision}
          defaultRange="6M"
          defaultIndicators={['sma20', 'sma60']}
        />
      </CardContent>
    </Card>
  );
}
