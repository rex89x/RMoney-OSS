import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plane, History } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { formatTW, nowTW } from '@/lib/tz';
import { useTrips } from '../hooks';
import { useTransactions } from '@/features/ledger/hooks';
import { useExpenseBreakdown } from '@/features/ledger/use-my-share';
import { useAuth } from '@/hooks/use-auth';

/**
 * 過去出遊回顧：依使用者偏好回顧 N 年前同月份的 trips
 * 例：今年 4 月 → 顯示去年 4 月 / 兩年前 4 月去過哪裡、花多少
 */
export function TripRecapCard() {
  const { profile } = useAuth();
  const yearsBack = profile?.preferences?.tripRecapYears ?? 3;
  const { data: trips = [] } = useTrips();
  const navigate = useNavigate();
  const today = useMemo(() => nowTW(), []);
  const thisMonth = today.getMonth();

  const recap = useMemo(() => {
    const out: Array<{ year: number; trips: typeof trips }> = [];
    for (let y = 1; y <= yearsBack; y++) {
      const targetYear = today.getFullYear() - y;
      const matched = trips.filter((t) =>
        Number(formatTW(t.startDate, 'yyyy')) === targetYear &&
        Number(formatTW(t.startDate, 'M')) - 1 === thisMonth);
      if (matched.length > 0) out.push({ year: targetYear, trips: matched });
    }
    return out;
  }, [trips, yearsBack, today, thisMonth]);

  const allMatchedTripIds = recap.flatMap((r) => r.trips.map((t) => t.id));
  // 一次查所有相關 tx（依 startDate 範圍會更精確；先簡化只用 tripId）
  const { data: txs = [] } = useTransactions({ limit: 2000 }, { enabled: allMatchedTripIds.length > 0 });
  const breakdown = useExpenseBreakdown();
  const totalsByTrip = useMemo(() => {
    const m = new Map<string, { total: number; share: number }>();
    for (const t of txs) {
      if (t.deletedAt || t.type !== 'expense' || !t.tripId) continue;
      if (!allMatchedTripIds.includes(t.tripId)) continue;
      const b = breakdown(t);
      const cur = m.get(t.tripId) ?? { total: 0, share: 0 };
      m.set(t.tripId, { total: cur.total + b.totalTWD, share: cur.share + b.shareTWD });
    }
    return m;
  }, [txs, allMatchedTripIds, breakdown]);

  if (recap.length === 0) {
    return null; // 沒有回顧資料就不顯示
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4" /> 出遊回顧（{thisMonth + 1} 月）
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {recap.map(({ year, trips: yearTrips }) => (
          <div key={year} className="space-y-2">
            <Badge variant="outline" className="text-xs">{year} 年（{today.getFullYear() - year} 年前）</Badge>
            {yearTrips.map((t) => {
              const sums = totalsByTrip.get(t.id) ?? { total: 0, share: 0 };
              return (
                <div
                  key={t.id}
                  onClick={() => navigate(`/trips/${t.id}`)}
                  className="flex cursor-pointer items-center gap-3 rounded-md border p-2 transition-colors hover:bg-muted/50"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/trips/${t.id}`); }}
                >
                  <Plane className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {(t.destination ?? []).join(' · ')}
                      {' · '}
                      {formatTW(t.startDate, 'MM/dd')}–{formatTW(t.endDate, 'MM/dd')}
                    </div>
                  </div>
                  <div className="text-right tabular-nums">
                    <div className="text-sm">{formatCurrency(sums.share)}</div>
                    {Math.abs(sums.total - sums.share) > 0.5 ? (
                      <div className="text-[10px] text-muted-foreground">整趟 {formatCurrency(sums.total)}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
