import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { CalendarRange, Printer, TrendingUp, TrendingDown, Plane, Landmark, Wallet, Store } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/layout/page-header';
import { cn, formatCurrency, formatPercent } from '@/lib/utils';
import { formatTW, nowTW } from '@/lib/tz';
import { useAnnualReview } from '../use-annual-review';

function delta(cur: number, prev: number): { text: string; up: boolean | null } {
  if (!prev) return { text: '去年無資料', up: null };
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  return { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% vs 去年`, up: pct >= 0 };
}

export function AnnualReview() {
  const thisYear = nowTW().getFullYear();
  const [year, setYear] = useState(thisYear);
  const years = useMemo(() => [thisYear, thisYear - 1, thisYear - 2, thisYear - 3], [thisYear]);
  const r = useAnnualReview(year);

  const incomeDelta = delta(r.totals.income, r.prevTotals.income);
  const expenseDelta = delta(r.totals.expense, r.prevTotals.expense);
  const nwDelta = r.netWorth.startTWD != null && r.netWorth.endTWD != null ? r.netWorth.endTWD - r.netWorth.startTWD : null;
  const investDelta = r.invest.startValueTWD != null && r.invest.endValueTWD != null ? r.invest.endValueTWD - r.invest.startValueTWD : null;
  const contribution = r.invest.startCostTWD != null && r.invest.endCostTWD != null ? r.invest.endCostTWD - r.invest.startCostTWD : null;

  return (
    <div className="space-y-4 print:space-y-3">
      <PageHeader
        title={`${year} 年度回顧`}
        description={year === thisYear ? '到今天為止的累計；與去年同期整年比較' : '整年彙整'}
        className="print:mb-2"
        actions={
          <div className="flex items-center gap-2 print:hidden">
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger className="h-9 w-24"><SelectValue /></SelectTrigger>
              <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => window.print()}><Printer className="size-4" /> 列印 / PDF</Button>
          </div>
        }
      />

      {r.isLoading ? (
        <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-64" /><Skeleton className="h-48" /></div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <Kpi label="收入" value={formatCurrency(r.totals.income)} sub={incomeDelta.text} up={incomeDelta.up} />
            <Kpi label="支出" value={formatCurrency(r.totals.expense)} sub={expenseDelta.text} up={expenseDelta.up === null ? null : !expenseDelta.up} />
            <Kpi
              label="儲蓄率"
              value={r.totals.savingsRate == null ? '—' : formatPercent(r.totals.savingsRate * 100, 0)}
              sub={r.prevTotals.savingsRate == null ? '去年無資料' : `去年 ${formatPercent(r.prevTotals.savingsRate * 100, 0)}`}
              up={r.totals.savingsRate != null && r.prevTotals.savingsRate != null ? r.totals.savingsRate >= r.prevTotals.savingsRate : null}
            />
            <Kpi
              label="淨值變化"
              value={nwDelta == null ? '—' : `${nwDelta >= 0 ? '+' : ''}${formatCurrency(nwDelta)}`}
              sub={r.netWorth.startMonth && r.netWorth.endMonth ? `${r.netWorth.startMonth} → ${r.netWorth.endMonth}` : '尚無淨值快照'}
              up={nwDelta == null ? null : nwDelta >= 0}
            />
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><CalendarRange className="size-4" /> 月度收支</CardTitle></CardHeader>
            <CardContent className="h-[240px] px-0 pr-4 sm:px-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={r.months}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} width={44} />
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  <Legend formatter={(v) => <span className="text-xs">{v === 'income' ? '收入' : '支出'}</span>} />
                  <Bar dataKey="income" name="income" fill="#10b981" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="expense" name="expense" fill="#f59e0b" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Wallet className="size-4" /> 支出類別 vs 去年</CardTitle></CardHeader>
              <CardContent>
                {r.categories.length === 0 ? <p className="text-sm text-muted-foreground">沒有支出</p> : (
                  <ul className="divide-y text-sm">
                    {r.categories.slice(0, 10).map((c) => {
                      const d = delta(c.amount, c.prevAmount);
                      return (
                        <li key={c.key} className="flex items-center gap-2 py-1.5">
                          <span className="size-2 rounded-full" style={{ backgroundColor: c.color }} />
                          <span className="flex-1 truncate">{c.name}</span>
                          <span className="tabular-nums">{formatCurrency(c.amount)}</span>
                          <span className={cn('w-24 text-right text-[11px] tabular-nums', d.up === null ? 'text-muted-foreground' : d.up ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}>
                            {d.text.replace(' vs 去年', '')}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Store className="size-4" /> 最常花錢的地方</CardTitle></CardHeader>
              <CardContent>
                {r.merchants.length === 0 ? <p className="text-sm text-muted-foreground">交易沒有備註，無法統計</p> : (
                  <ul className="divide-y text-sm">
                    {r.merchants.map((m) => (
                      <li key={m.note} className="flex items-center gap-2 py-1.5">
                        <span className="flex-1 truncate">{m.note}</span>
                        <span className="text-[11px] text-muted-foreground">{m.count} 次</span>
                        <span className="tabular-nums">{formatCurrency(m.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><TrendingUp className="size-4" /> 投資</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {r.invest.startValueTWD == null || r.invest.endValueTWD == null ? (
                  <p className="text-muted-foreground">這一年沒有投資快照。</p>
                ) : (
                  <>
                    <Row label="年初市值" value={formatCurrency(r.invest.startValueTWD)} />
                    <Row label="年末市值" value={formatCurrency(r.invest.endValueTWD)} />
                    <Row label="市值變動" value={signed(investDelta)} tone={investDelta} />
                    <Row label="新投入成本" value={signed(contribution)} />
                    <Row label="股息" value={formatCurrency(r.invest.dividendsTWD)} />
                    <Row label="已實現損益" value={signed(r.invest.realizedTWD)} tone={r.invest.realizedTWD} />
                    <div className="border-t pt-2">
                      <Row label="估算投資收益" value={signed(r.invest.gainTWD)} tone={r.invest.gainTWD} strong />
                      {r.invest.returnPct != null ? (
                        <p className="text-[11px] text-muted-foreground">約 {formatPercent(r.invest.returnPct, 1)}（市值變動 − 新投入 + 股息 + 已實現，以年初市值加半年投入為基準）</p>
                      ) : null}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Plane className="size-4" /> 出遊</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {r.trips.length === 0 ? <p className="text-muted-foreground">這一年沒有出遊紀錄。</p> : (
                  <>
                    <Row label={`${r.trips.length} 趟 · 共 ${r.trips.reduce((s, t) => s + t.days, 0)} 天`} value={formatCurrency(r.tripSpendTotal)} strong />
                    <ul className="divide-y">
                      {r.trips.map((t) => (
                        <li key={t.id} className="flex items-center gap-2 py-1.5">
                          <div className="min-w-0 flex-1">
                            <Link to={`/trips/${t.id}`} className="block truncate font-medium hover:underline">{t.name}</Link>
                            <div className="text-[11px] text-muted-foreground">{formatTW(t.startDate, 'MM/dd')} · {t.days} 天{t.destination ? ` · ${t.destination}` : ''}</div>
                          </div>
                          <span className="tabular-nums">{formatCurrency(t.spend)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {r.netWorth.startTWD != null && r.netWorth.endTWD != null ? (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Landmark className="size-4" /> 淨值</CardTitle></CardHeader>
              <CardContent className="grid gap-2 text-sm sm:grid-cols-3">
                <Row label={`${r.netWorth.startMonth}`} value={formatCurrency(r.netWorth.startTWD)} />
                <Row label={`${r.netWorth.endMonth}`} value={formatCurrency(r.netWorth.endTWD)} />
                <Row label="變化" value={signed(nwDelta)} tone={nwDelta} strong />
                {investDelta != null && nwDelta != null ? (
                  <p className="text-[11px] text-muted-foreground sm:col-span-3">
                    其中投資市值變動 {signed(investDelta)}，其餘 {signed(nwDelta - investDelta)} 來自現金流、負債與其他資產。
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

function signed(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : '-'}${formatCurrency(Math.abs(v))}`;
}

function Kpi({ label, value, sub, up }: { label: string; value: string; sub?: string; up: boolean | null }) {
  const Icon = up === null ? null : up ? TrendingUp : TrendingDown;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
        {sub ? (
          <div className={cn('mt-0.5 flex items-center gap-1 text-[11px]', up === null ? 'text-muted-foreground' : up ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
            {Icon ? <Icon className="size-3" /> : null}{sub}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Row({ label, value, tone, strong }: { label: string; value: string; tone?: number | null; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cn('text-muted-foreground', strong && 'font-medium text-foreground')}>{label}</span>
      <span className={cn('tabular-nums', strong && 'font-semibold', tone != null && tone > 0 && 'text-emerald-600 dark:text-emerald-400', tone != null && tone < 0 && 'text-red-600 dark:text-red-400')}>{value}</span>
    </div>
  );
}
