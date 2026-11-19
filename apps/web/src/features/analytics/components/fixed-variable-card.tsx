import { useMemo } from 'react';
import { Repeat } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import type { Transaction } from '@/features/ledger/types';
import { useSubscriptions } from '@/features/subscriptions/hooks';
import { useScheduledPayments } from '@/features/scheduled-payments/hooks';
import { buildFixedExpenseMatcher, splitFixedVariable } from '../metrics';

interface FixedVariableCardProps {
  txs: Transaction[];
  share: (tx: Transaction) => number;
}

/**
 * 固定 vs 變動支出：
 * 固定 = 週期交易（recurringId）或備註含「訂閱」「排程支出」名稱的交易；其餘為變動。
 * 想壓支出時，變動那塊才是短期能調整的。
 */
export function FixedVariableCard({ txs, share }: FixedVariableCardProps) {
  const { data: subs = [] } = useSubscriptions();
  const { data: scheduled = [] } = useScheduledPayments();

  const split = useMemo(() => {
    const isFixed = buildFixedExpenseMatcher([
      ...subs.filter((s) => s.active).flatMap((s) => [s.name, s.vendor]),
      ...scheduled.map((s) => s.name),
    ]);
    return splitFixedVariable(txs, share, isFixed);
  }, [txs, share, subs, scheduled]);

  const total = split.fixed + split.variable;
  const fixedPct = total > 0 ? split.fixed / total : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Repeat className="size-4" /> 固定 vs 變動支出</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">此期間尚無支出</p>
        ) : (
          <>
            <div className="flex h-3 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary" style={{ width: `${fixedPct * 100}%` }} />
              <div className="h-full bg-warning" style={{ width: `${(1 - fixedPct) * 100}%` }} />
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="size-2 rounded-full bg-primary" /> 固定
                </div>
                <div className="font-semibold tabular-nums">{formatCurrency(split.fixed)}</div>
                <div className="text-[11px] text-muted-foreground">{Math.round(fixedPct * 100)}%</div>
              </div>
              <div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="size-2 rounded-full bg-warning" /> 變動
                </div>
                <div className="font-semibold tabular-nums">{formatCurrency(split.variable)}</div>
                <div className="text-[11px] text-muted-foreground">{Math.round((1 - fixedPct) * 100)}%</div>
              </div>
            </div>
            {split.fixedItems.length > 0 ? (
              <ul className="divide-y text-xs">
                {split.fixedItems.slice(0, 6).map((it) => (
                  <li key={it.name} className="flex justify-between py-1.5">
                    <span className="truncate text-muted-foreground">{it.name}</span>
                    <span className="tabular-nums">{formatCurrency(it.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                沒有比對到固定支出。到 設定 → 訂閱 / 排程支出 建立項目，或用週期交易記帳，就能自動歸類。
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
