import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, Trash2, RefreshCw, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { DateRangePicker } from '@/components/ui/date-picker';
import { useConfirm } from '@/components/ui/confirm';
import { formatNumber, formatPercent, cn } from '@/lib/utils';
import {
  dateInputToTWBoundary,
  formatDateInput,
  formatTW,
  parseDateInput,
} from '@/lib/tz';
import {
  useBackfillCandles, useDeleteHistoryRange, useRefreshStocks, useStock, useStockCandles,
} from '../hooks';
import { TechnicalChart } from './technical-chart';

export function StockDetailPage() {
  const { symbol = '' } = useParams();
  const { data: stock } = useStock(symbol);
  const { data: candles = [] } = useStockCandles(symbol, 400);
  const deleteRange = useDeleteHistoryRange();
  const refresh = useRefreshStocks();
  const backfill = useBackfillCandles();
  const confirm = useConfirm();
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  async function handleDeleteRange() {
    if (!startDate || !endDate) return;
    const start = dateInputToTWBoundary(startDate, 'start');
    const end = dateInputToTWBoundary(endDate, 'end');
    if (!start || !end) return;
    const ok = await confirm({
      title: '刪除歷史價格區間',
      description: `${symbol} 在 ${startDate} ~ ${endDate} 的所有快照會被刪除，無法復原。`,
      confirmText: '刪除',
    });
    if (!ok) return;
    await deleteRange.mutateAsync({
      symbol,
      start,
      end,
    });
    setStartDate('');
    setEndDate('');
  }

  if (!stock) {
    return <div className="p-6 text-muted-foreground">載入中…</div>;
  }

  const positive = stock.change >= 0;

  return (
    <div className="space-y-4">
      <Link to="/investments" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ChevronLeft className="size-4" /> 回到列表
      </Link>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              {stock.symbol}
              <span className="text-sm font-normal text-muted-foreground">{stock.name}</span>
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh.mutateAsync()}
              disabled={refresh.isPending}
            >
              <RefreshCw className={refresh.isPending ? 'size-4 animate-spin' : 'size-4'} /> 更新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-4xl font-semibold tabular-nums">{formatNumber(stock.currentPrice)}</span>
            <span className={cn('text-base font-medium', positive ? 'text-success' : 'text-destructive')}>
              {positive ? '+' : ''}{formatNumber(stock.change)} ({formatPercent(stock.changePercent)})
            </span>
            {stock.updatedAt ? (
              <span className="text-xs text-muted-foreground">
                {formatTW(stock.updatedAt, 'MM/dd HH:mm')}
              </span>
            ) : null}
          </div>

          <div className="grid grid-cols-4 gap-3 text-sm">
            <Stat label="開盤" value={formatNumber(stock.open)} />
            <Stat label="最高" value={formatNumber(stock.high)} />
            <Stat label="最低" value={formatNumber(stock.low)} />
            <Stat label="成交量" value={formatNumber(stock.volume, 0)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <CardTitle className="text-base">技術分析</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void backfill.mutateAsync({ scope: stock.market === 'TW' ? 'tw' : 'us', symbol, months: 12 })}
            disabled={backfill.isPending}
          >
            <Download className={backfill.isPending ? 'size-4 animate-spin' : 'size-4'} /> 回填 K 線
          </Button>
        </CardHeader>
        <CardContent>
          <TechnicalChart
            data={candles}
            pricePrecision={stock.currency === 'USD' ? 2 : 2}
            showVolume
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">刪除歷史區間</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div>
            <Label>區間</Label>
            <DateRangePicker
              value={{
                from: parseDateInput(startDate) ?? undefined,
                to: parseDateInput(endDate) ?? undefined,
              }}
              onChange={(range) => {
                setStartDate(range?.from ? formatDateInput(range.from) : '');
                setEndDate(range?.to ? formatDateInput(range.to) : '');
              }}
            />
          </div>
          <div className="flex items-end">
            <Button
              variant="destructive"
              onClick={handleDeleteRange}
              disabled={deleteRange.isPending || !startDate || !endDate}
            >
              <Trash2 className="size-4" /> 刪除
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}
