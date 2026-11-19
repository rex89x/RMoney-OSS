import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Target } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, formatCurrency } from '@/lib/utils';
import type { Budget } from '@/features/ledger/types';
import { categoryBudgetPace } from '../metrics';
import type { CategoryInfo } from '../hooks';

interface CategoryBudgetPaceCardProps {
  budget: Budget | null | undefined;
  /** 本月各類別消費支出 */
  byCategory: Map<string, number>;
  monthExpense: number;
  pctElapsed: number;
  lookup: (key: string) => CategoryInfo;
}

const STATUS_LABEL = { over: '已超支', ahead: '超前節奏', ok: '正常' } as const;

/** 各類別預算 vs 時間進度：直線是「照天數現在應該用到哪」 */
export function CategoryBudgetPaceCard({ budget, byCategory, monthExpense, pctElapsed, lookup }: CategoryBudgetPaceCardProps) {
  const rows = useMemo(() => {
    if (!budget) return [];
    const totalRow = categoryBudgetPace(new Map([['__total', monthExpense]]), { __total: budget.total }, pctElapsed);
    return [...totalRow, ...categoryBudgetPace(byCategory, budget.byCategory ?? {}, pctElapsed)];
  }, [budget, byCategory, monthExpense, pctElapsed]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Target className="size-4" /> 本月預算節奏</span>
          <Link to="/settings?tab=budget" className="text-xs font-normal text-muted-foreground hover:text-foreground">設定預算</Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚未設定本月預算。設定總預算或類別預算後，這裡會顯示每一類是否花太快。</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.key}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className={cn('truncate', r.key === '__total' && 'font-medium')}>
                    {r.key === '__total' ? '總預算' : lookup(r.key).name}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums">
                    <span
                      className={cn(
                        'rounded px-1.5 text-[10px] font-medium',
                        r.status === 'over' ? 'bg-destructive/15 text-destructive'
                          : r.status === 'ahead' ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                    <span className="text-muted-foreground">{formatCurrency(r.used)} / {formatCurrency(r.limit)}</span>
                  </span>
                </div>
                <div className="relative mt-1 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn('h-full rounded-full',
                      r.status === 'over' ? 'bg-destructive' : r.status === 'ahead' ? 'bg-warning' : 'bg-primary')}
                    style={{ width: `${Math.min(100, r.pct * 100)}%` }}
                  />
                  <div className="absolute inset-y-0 w-0.5 bg-foreground/60" style={{ left: `${Math.min(100, pctElapsed * 100)}%` }} aria-hidden />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
