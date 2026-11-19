import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Store } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import type { Transaction } from '@/features/ledger/types';
import { merchantRanking } from '../metrics';
import { ledgerListHref } from '../drilldown';
import type { CategoryInfo } from '../hooks';

interface MerchantRankingCardProps {
  txs: Transaction[];
  share: (tx: Transaction) => number;
  lookup: (key: string) => CategoryInfo;
  startKey: string;
  endKey: string;
}

/** 商家 / 備註排行：同一家店（備註正規化後相同）合併計算 */
export function MerchantRankingCard({ txs, share, lookup, startKey, endKey }: MerchantRankingCardProps) {
  const navigate = useNavigate();
  const rows = useMemo(() => merchantRanking(txs, share, 10), [txs, share]);
  const max = rows[0]?.amount ?? 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Store className="size-4" /> 商家排行</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">此期間的支出都沒有填備註，無法排行。</p>
        ) : (
          <ol className="space-y-1.5">
            {rows.map((r, i) => (
              <li key={r.name}>
                <button
                  type="button"
                  onClick={() => navigate(ledgerListHref({ type: 'expense', q: r.name, startKey, endKey }))}
                  className="w-full rounded-md px-1 py-0.5 text-left hover:bg-muted/60"
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="w-4 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{i + 1}</span>
                      <span className="truncate">{r.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{lookup(r.category).name} · {r.count} 次</span>
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">{formatCurrency(r.amount)}</span>
                  </div>
                  <div className="ml-6 mt-1 h-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${max > 0 ? (r.amount / max) * 100 : 0}%` }} />
                  </div>
                </button>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
