import { Link } from 'react-router-dom';
import { BellRing, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import { buildFlightAttention, buildPriceLadder } from '../dashboard';
import { useClaudeWatchStatuses, useFlightWatches } from '../hooks';
import { flightWatchTitle } from '../options';

/** 首頁 Dashboard 卡片：目前最便宜的 3 個區段與待處理數量；沒有任何航線時不顯示 */
export function FlightRadarCard() {
  const { data: watches = [] } = useFlightWatches();
  const statuses = useClaudeWatchStatuses(watches);
  if (watches.length === 0) return null;
  const rows = buildPriceLadder(watches.filter((watch) => watch.enabled)).slice(0, 3);
  const attention = buildFlightAttention(watches, statuses.data ?? []).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base"><BellRing className="size-4" /> 機票雷達</CardTitle>
        <Link to="/flights" className="flex items-center text-xs text-muted-foreground">
          查看全部 <ChevronRight className="size-3" />
        </Link>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">還沒有掃描結果。</p>
        ) : rows.map((row) => (
          <div key={row.watch.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 line-clamp-2 break-words">{flightWatchTitle(row.watch)}</span>
            <span className="flex shrink-0 items-center gap-1.5 font-semibold tabular-nums">
              {row.target !== null && row.current <= row.target ? <Badge variant="success">達理想價</Badge> : null}
              {formatCurrency(row.current)}
            </span>
          </div>
        ))}
        {attention > 0 ? (
          <Link to="/flights" className="block text-xs text-warning">{attention} 個項目需要處理</Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
