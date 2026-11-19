import { useMemo, useState } from 'react';
import { Trash2, Receipt, Filter } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useConfirm } from '@/components/ui/confirm';
import { formatCurrency, formatNumber, formatPercent, cn } from '@/lib/utils';
import { formatTW, nowTW } from '@/lib/tz';
import { useDeleteRealizedLot, useRealizedLots } from '../hooks';
import { COST_BASIS_LABEL } from '../cost-basis';
import { CostBasisSetting } from './cost-basis-setting';

export function RealizedPnlView() {
  const { data: lots = [] } = useRealizedLots();
  const del = useDeleteRealizedLot();
  const confirm = useConfirm();
  const [year, setYear] = useState<string>(String(nowTW().getFullYear()));

  const years = useMemo(() => {
    const set = new Set<string>();
    lots.forEach((l) => set.add(formatTW(l.sellDate, 'yyyy')));
    set.add(String(nowTW().getFullYear()));
    return [...set].sort((a, b) => Number(b) - Number(a));
  }, [lots]);

  const filtered = useMemo(
    () => lots.filter((l) => formatTW(l.sellDate, 'yyyy') === year),
    [lots, year],
  );

  const total = filtered.reduce((s, l) => s + l.realizedPnlTWD, 0);
  const positive = filtered.filter((l) => l.realizedPnlTWD >= 0).reduce((s, l) => s + l.realizedPnlTWD, 0);
  const negative = filtered.filter((l) => l.realizedPnlTWD < 0).reduce((s, l) => s + l.realizedPnlTWD, 0);

  async function handleDelete(id: string) {
    const ok = await confirm({ title: '刪除已實現紀錄？', description: '此動作無法復原', confirmText: '刪除' });
    if (ok) await del.mutateAsync(id);
  }

  return (
    <div className="space-y-4">
      <CostBasisSetting />

      <div className="grid grid-cols-3 gap-2">
        <Card><CardContent className="p-3">
          <div className="text-[11px] text-muted-foreground">{year} 已實現</div>
          <div className={cn('text-lg font-semibold tabular-nums', total >= 0 ? 'text-emerald-500' : 'text-red-500')}>
            {total >= 0 ? '+' : ''}{formatCurrency(total)}
          </div>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <div className="text-[11px] text-muted-foreground">獲利合計</div>
          <div className="text-base tabular-nums text-emerald-500">+{formatCurrency(positive)}</div>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <div className="text-[11px] text-muted-foreground">虧損合計</div>
          <div className="text-base tabular-nums text-red-500">{formatCurrency(negative)}</div>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 pb-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base"><Receipt className="size-4" /> 已實現紀錄</CardTitle>
          <div className="flex items-center gap-1">
            <Filter className="size-3 text-muted-foreground" />
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">{year} 年無紀錄。每次「賣出」會自動產生一筆。</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {filtered.map((l) => {
                const pct = l.costTWD ? (l.realizedPnlTWD / l.costTWD) * 100 : 0;
                return (
                  <li key={l.id} className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 font-medium">
                        <span>{l.symbol}</span>
                        <Badge variant="outline" className="text-[10px]">{l.market}</Badge>
                        <Badge variant="secondary" className="text-[10px]">
                          {COST_BASIS_LABEL[l.costBasisMethod ?? 'average']}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatTW(l.sellDate, 'yyyy/MM/dd')} · {l.shares} × {l.sellPrice} {l.currency}
                        （成本 {formatNumber(l.avgCost, 4)}{l.buyDate ? ` · ${formatTW(l.buyDate, 'yyyy/MM/dd')} 買進批次` : ''}）
                      </div>
                      {l.costBasisFallback ? (
                        <div className="text-[11px] text-amber-600 dark:text-amber-400">
                          已設定 FIFO，但此持倉缺完整買進批次紀錄，改用平均成本
                        </div>
                      ) : null}
                    </div>
                    <div className="text-right">
                      <div className={cn('text-sm font-medium tabular-nums', l.realizedPnlTWD >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                        {l.realizedPnlTWD >= 0 ? '+' : ''}{formatCurrency(l.realizedPnlTWD)}
                      </div>
                      <div className="text-[10px] text-muted-foreground">{formatPercent(pct)}</div>
                    </div>
                    <Button size="icon-sm" variant="ghost" onClick={() => void handleDelete(l.id)} aria-label="刪除">
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
