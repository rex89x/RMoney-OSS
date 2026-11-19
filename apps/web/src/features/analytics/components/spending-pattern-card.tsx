import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, formatCurrency } from '@/lib/utils';
import type { Transaction } from '@/features/ledger/types';
import { dailyTotals, weekdayTotals } from '../metrics';
import { daysBetweenKeys } from '../periods';
import { ledgerListHref } from '../drilldown';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

interface SpendingPatternCardProps {
  txs: Transaction[];
  share: (tx: Transaction) => number;
  startKey: string;
  endKey: string;
}

interface DayCell {
  key: string;
  day: number;
  value: number;
}

/** 消費習慣：星期幾分布 + （區間 ≤ 62 天時）日曆熱圖，點日期看當天交易 */
export function SpendingPatternCard({ txs, share, startKey, endKey }: SpendingPatternCardProps) {
  const navigate = useNavigate();
  const weekday = useMemo(() => weekdayTotals(txs, share), [txs, share]);
  const weekdayMax = Math.max(...weekday, 0);
  const weekdayTotal = weekday.reduce((s, v) => s + v, 0);
  const topWeekday = weekdayTotal > 0 ? weekday.indexOf(weekdayMax) : -1;

  const calendar = useMemo(() => {
    const span = daysBetweenKeys(startKey, endKey) + 1;
    if (span > 62) return null;
    const totals = dailyTotals(txs, share);
    const [sy, sm, sd] = startKey.split('-').map(Number) as [number, number, number];
    const startUtc = Date.UTC(sy, sm - 1, sd);
    const lead = (new Date(startUtc).getUTCDay() + 6) % 7; // 週一為第一欄
    const cells: Array<DayCell | null> = Array.from({ length: lead }, () => null);
    let max = 0;
    for (let i = 0; i < span; i++) {
      const d = new Date(startUtc + i * 86400000);
      // Date.UTC 建出的純日期，toISOString 不會跨日
      const key = d.toISOString().slice(0, 10);
      const value = totals.get(key) ?? 0;
      max = Math.max(max, value);
      cells.push({ key, day: d.getUTCDate(), value });
    }
    return { cells, max };
  }, [txs, share, startKey, endKey]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><CalendarDays className="size-4" /> 消費習慣</span>
          {topWeekday >= 0 ? (
            <span className="text-xs font-normal text-muted-foreground">週{WEEKDAYS[topWeekday]}花最多</span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-1.5">
          {weekday.map((v, i) => (
            <div key={WEEKDAYS[i]} className="flex flex-1 flex-col items-center gap-1">
              <div
                className={cn('w-full rounded-t', i === topWeekday ? 'bg-primary' : 'bg-primary/40')}
                style={{ height: `${weekdayMax > 0 ? Math.max(2, Math.round((v / weekdayMax) * 80)) : 2}px` }}
                title={`週${WEEKDAYS[i]} ${formatCurrency(v)}`}
              />
              <span className="text-[10px] text-muted-foreground">{WEEKDAYS[i]}</span>
            </div>
          ))}
        </div>

        {calendar ? (
          <div>
            <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
              {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {calendar.cells.map((c, i) => c == null ? <span key={`pad-${i}`} /> : (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => navigate(ledgerListHref({ type: 'expense', startKey: c.key, endKey: c.key }))}
                  title={`${c.key} ${formatCurrency(c.value)}`}
                  className="relative aspect-square rounded text-[10px] tabular-nums ring-1 ring-inset ring-border/60 hover:ring-foreground/40"
                  style={c.value > 0 && calendar.max > 0
                    ? { background: `hsl(var(--chart-expense) / ${0.12 + 0.75 * (c.value / calendar.max)})` }
                    : undefined}
                >
                  <span className={cn('absolute left-1 top-0.5', c.value > calendar.max * 0.6 && 'text-white')}>{c.day}</span>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">顏色越深花越多，點日期看當天交易</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
