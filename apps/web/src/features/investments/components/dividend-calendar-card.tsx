import { useMemo, useState } from 'react';
import { CalendarDays, Receipt, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { callAppsScript } from '@/lib/apps-script';
import { cn, formatCurrency } from '@/lib/utils';
import { daysBetweenTWDates, nowTW, formatTWDateInput } from '@/lib/tz';
import { useDividends, usePortfolio, useRealizedLots, useStocks } from '../hooks';
import {
  estimateDividendTax, NHI_RATE, NHI_THRESHOLD_TWD, OVERSEAS_REPORT_THRESHOLD, AMT_EXEMPTION,
} from '../tax';

/** 持倉標的的除權息預告（台股），含預估現金股利 */
export function DividendCalendarCard() {
  const { data: stocks = [] } = useStocks();
  const { data: portfolio = [] } = usePortfolio();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const upcoming = useMemo(() => {
    const today = formatTWDateInput(new Date());
    const byShares = new Map(portfolio.map((p) => [p.symbol, p.shares]));
    return stocks
      .filter((s) => s.upcomingDividend && s.upcomingDividend.exDate >= today)
      .map((s) => {
        const ud = s.upcomingDividend!;
        const shares = byShares.get(s.symbol) ?? 0;
        const estCash = ud.cashPerShare * shares;
        return {
          symbol: s.symbol,
          name: s.name,
          exDate: ud.exDate,
          days: daysBetweenTWDates(new Date(), `${ud.exDate}T12:00:00+08:00`),
          cashPerShare: ud.cashPerShare,
          stockPerShare: ud.stockPerShare,
          shares,
          estCash,
          held: shares > 0,
        };
      })
      .sort((a, b) => a.exDate.localeCompare(b.exDate));
  }, [stocks, portfolio]);

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await callAppsScript<{ updated?: number }>('updateDividendCalendar');
      if (!res.ok) throw new Error(res.error ?? '更新失敗');
      void qc.invalidateQueries({ queryKey: ['stocks'] });
      toast.success(`已更新除權息預告（${String(res.updated ?? 0)} 檔）`);
    } catch (err) {
      console.error('[updateDividendCalendar]', err);
      toast.error(err instanceof Error ? err.message : '更新失敗');
    } finally {
      setRefreshing(false);
    }
  }

  const heldTotal = upcoming.filter((u) => u.held).reduce((s, u) => s + u.estCash, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><CalendarDays className="size-4" /> 除權息日曆（台股）</span>
          <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} /> 更新
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">追蹤的台股目前沒有除權息預告。每日 18:00 會自動抓 TWSE / TPEx 公告。</p>
        ) : (
          <ul className="divide-y rounded-xl border text-sm">
            {upcoming.map((u) => (
              <li key={u.symbol} className={cn('flex items-center gap-3 p-3', !u.held && 'opacity-60')}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{u.symbol}</span>
                    <span className="truncate text-muted-foreground">{u.name}</span>
                    {!u.held ? <Badge variant="outline" className="text-[10px]">觀察</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {u.exDate} · {u.days === 0 ? '今天除息' : u.days > 0 ? `${u.days} 天後` : ''}
                    {u.cashPerShare ? ` · 現金 ${u.cashPerShare}/股` : ''}
                    {u.stockPerShare ? ` · 股票 ${u.stockPerShare}` : ''}
                  </div>
                </div>
                {u.held && u.estCash > 0 ? (
                  <div className="text-right">
                    <div className="tabular-nums">{formatCurrency(u.estCash)}</div>
                    {u.estCash >= NHI_THRESHOLD_TWD ? (
                      <div className="text-[10px] text-amber-600 dark:text-amber-400">
                        健保 {formatCurrency(u.estCash * NHI_RATE)}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {heldTotal > 0 ? (
          <p className="text-xs text-muted-foreground">持倉預估現金股利合計 {formatCurrency(heldTotal)}（未扣稅與健保）</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** 年度股利稅務試算 */
export function DividendTaxCard() {
  const { data: dividends = [] } = useDividends();
  const { data: lots = [] } = useRealizedLots();
  const thisYear = nowTW().getFullYear();
  const [year, setYear] = useState(thisYear);
  const years = useMemo(() => {
    const set = new Set<number>([thisYear, thisYear - 1]);
    for (const d of dividends) set.add(new Date(d.payDate.getTime() + 8 * 3600000).getUTCFullYear());
    return Array.from(set).sort((a, b) => b - a);
  }, [dividends, thisYear]);
  const est = useMemo(() => estimateDividendTax(year, dividends, lots), [year, dividends, lots]);
  const combinedBetter = est.creditIfCombinedTWD > 0 && est.taxIfSeparateTWD > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Receipt className="size-4" /> 股利稅務試算</span>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
          </Select>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-2">
          <Stat label="台股股利" value={formatCurrency(est.twDividendTWD)} sub={`${est.twDividendCount} 筆`} />
          <Stat
            label="二代健保補充保費"
            value={formatCurrency(est.nhiSupplementTWD)}
            sub={`單筆 ≥ ${formatCurrency(NHI_THRESHOLD_TWD)} 的 ${est.nhiHitCount} 筆 × ${(NHI_RATE * 100).toFixed(2)}%`}
          />
          <Stat label="合併計稅可抵減（8.5%，上限 8 萬）" value={formatCurrency(est.creditIfCombinedTWD)} sub="適合稅率 ≤ 20% 的情況" />
          <Stat label="分離課稅（28%）" value={formatCurrency(est.taxIfSeparateTWD)} sub="適合最高稅率 30% 以上的情況" />
        </div>
        {combinedBetter ? (
          <p className="text-xs text-muted-foreground">
            兩制擇一：合併計稅時股利併入所得，若你的邊際稅率在 20% 以下，8.5% 抵減通常較有利；30% 以上才考慮分離課稅。
          </p>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <Stat label="美股股利（實收）" value={formatCurrency(est.usDividendTWD)} />
          <Stat label="美股已實現損益" value={formatCurrency(est.usRealizedGainTWD)} />
        </div>
        <div className={cn('rounded-lg border p-3 text-xs', est.mustReportOverseas ? 'border-amber-500/50 bg-amber-500/5' : '')}>
          <div className="flex items-center justify-between">
            <span>海外所得合計</span>
            <span className="tabular-nums font-medium">{formatCurrency(est.overseasIncomeTWD)}</span>
          </div>
          <p className="mt-1 text-muted-foreground">
            {est.mustReportOverseas
              ? `≥ ${formatCurrency(OVERSEAS_REPORT_THRESHOLD)}，須申報基本所得額`
              : `< ${formatCurrency(OVERSEAS_REPORT_THRESHOLD)}，免申報`}
            {est.nearAmt ? `；已達基本所得額免稅額 ${formatCurrency(AMT_EXEMPTION)}，可能需繳基本稅額` : ''}
          </p>
        </div>
        <p className="text-[11px] text-muted-foreground">
          依 app 內的股息與已實現紀錄計算，僅供估算；申報請以券商對帳單與國稅局憑單為準。
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub ? <div className="text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
