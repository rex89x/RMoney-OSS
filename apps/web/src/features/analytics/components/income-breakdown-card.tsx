import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Coins } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import { PASSIVE_INCOME_CATEGORIES } from '../metrics';
import { ledgerListHref } from '../drilldown';
import type { CategoryInfo } from '../hooks';
import { CategoryBars } from './category-bars';

interface IncomeBreakdownCardProps {
  incomeByCategory: Map<string, number>;
  prevIncomeByCategory: Map<string, number>;
  compareLabel: string;
  lookup: (key: string) => CategoryInfo;
  startKey: string;
  endKey: string;
}

/** 收入來源 + 被動收入（投資收益 / 租金）佔比 */
export function IncomeBreakdownCard({
  incomeByCategory, prevIncomeByCategory, compareLabel, lookup, startKey, endKey,
}: IncomeBreakdownCardProps) {
  const navigate = useNavigate();
  const { rows, total, passive } = useMemo(() => {
    let total = 0;
    let passive = 0;
    const rows = [...incomeByCategory.entries()].map(([key, value]) => {
      total += value;
      if (PASSIVE_INCOME_CATEGORIES.includes(key)) passive += value;
      const info = lookup(key);
      return { key, name: info.name, color: info.color, value, prev: prevIncomeByCategory.get(key) ?? 0 };
    });
    return { rows, total, passive };
  }, [incomeByCategory, prevIncomeByCategory, lookup]);

  const passivePct = total > 0 ? passive / total : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Coins className="size-4" /> 收入來源</span>
          <span className="text-xs font-normal text-muted-foreground">合計 {formatCurrency(total)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {total > 0 ? (
          <div className="rounded-lg bg-muted/40 p-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">被動收入（投資收益 + 租金）</span>
              <span className="font-medium tabular-nums">{formatCurrency(passive)} · {Math.round(passivePct * 100)}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-success" style={{ width: `${passivePct * 100}%` }} />
            </div>
          </div>
        ) : null}
        <CategoryBars
          rows={rows}
          goodWhen="up"
          compareLabel={compareLabel}
          emptyText="此期間沒有收入紀錄"
          onSelect={(keys) => navigate(ledgerListHref({ type: 'income', category: keys, startKey, endKey }))}
        />
      </CardContent>
    </Card>
  );
}
