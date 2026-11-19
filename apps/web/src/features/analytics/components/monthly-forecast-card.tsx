import { TrendingUp, TrendingDown, Sparkles, AlertTriangle, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, cn } from '@/lib/utils';
import { useMonthlyForecast } from '../hooks';

export function MonthlyForecastCard() {
  const f = useMonthlyForecast();

  if (!f) return <Card><CardContent className="py-3"><Skeleton className="h-20" /></CardContent></Card>;

  // 以「月底剩多少現金」為主指標；若沒有 currentLiquid 提供，退回原本的淨流
  const hasEnding = f.expectedEndingLiquid != null;
  const headlineValue = hasEnding ? f.expectedEndingLiquid! : f.expectedNet;
  const headlinePositive = headlineValue >= 0;
  const showSign = !hasEnding;
  const overBudget = (f.expectedOverBudget ?? 0) > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" /> 月底預測
          {overBudget && <Badge variant="destructive" className="ml-auto gap-1 text-[10px]"><AlertTriangle className="size-3" /> 預估超支</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] text-muted-foreground">
              {hasEnding ? '預估月底現金' : '預估本月淨流'}
            </div>
            <div className={cn('text-lg font-semibold tabular-nums', headlinePositive ? 'text-emerald-500' : 'text-red-500')}>
              {headlinePositive ? <TrendingUp className="inline size-4" /> : <TrendingDown className="inline size-4" />}
              {' '}{showSign && headlinePositive ? '+' : ''}{formatCurrency(headlineValue)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">預估月支出</div>
            <div className="text-lg font-semibold tabular-nums">{formatCurrency(f.expectedTotalExpense)}</div>
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground">
          已支出 {formatCurrency(f.spentSoFar)} / 預估全月 {formatCurrency(f.expectedTotalExpense)}
          （月已過 {Math.round(f.pctElapsed * 100)}%、剩 {f.daysLeft} 天）
        </div>
        {f.excludedExpenseTWD > 0 ? (
          <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 size-3 shrink-0" />
            已排除 {formatCurrency(f.excludedExpenseTWD)} 一次性資產轉換（租賃購入等），不算進日常支出節奏
          </p>
        ) : null}
        {overBudget && (
          <p className="text-xs text-red-500">
            預估超支 {formatCurrency(f.expectedOverBudget!)}（依目前花費節奏推算）
          </p>
        )}
      </CardContent>
    </Card>
  );
}
