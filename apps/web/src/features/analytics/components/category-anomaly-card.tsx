import { useNavigate } from 'react-router-dom';
import { AlertTriangle, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, cn } from '@/lib/utils';
import { useCategories } from '@/features/ledger/hooks';
import { useCategoryAnomalies } from '../hooks';

export function CategoryAnomalyCard() {
  const anomalies = useCategoryAnomalies();
  const { data: categories = [] } = useCategories();
  const catMap = Object.fromEntries(categories.map((c) => [c.key, c]));
  const navigate = useNavigate();

  if (anomalies.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4 text-amber-500" /> 類別花費異常
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-xs text-muted-foreground">
          本月以下類別花費 vs 過去 6 個月同期間中位數明顯偏高
        </p>
        <ul className="space-y-1.5">
          {anomalies.slice(0, 5).map((a) => (
            <li
              key={a.category}
              onClick={() => navigate(`/ledger?tx_type=expense&tx_category=${encodeURIComponent(a.category)}`)}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-md p-2 text-sm transition-colors hover:bg-muted/50"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigate(`/ledger?tx_type=expense&tx_category=${encodeURIComponent(a.category)}`);
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{catMap[a.category]?.name ?? a.category}</div>
                <div className="text-[11px] text-muted-foreground">
                  本月 {formatCurrency(a.thisMonthSoFar)} vs 中位 {formatCurrency(a.historicalMedian)}
                </div>
              </div>
              <Badge variant={a.level === 'high' ? 'destructive' : 'outline'} className={cn('gap-1', a.level !== 'high' && 'text-amber-500 border-amber-500')}>
                <TrendingUp className="size-3" /> ×{a.ratio.toFixed(1)}
              </Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
