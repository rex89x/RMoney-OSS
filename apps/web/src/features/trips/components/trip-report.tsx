import { useCallback, useMemo, useState } from 'react';
import {
  Calendar, Clock, Coins, FileText, MapPin, Printer, Receipt, Sparkles, Users, Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Markdown } from '@/components/ui/markdown';
import { useTransactions, useCategories } from '@/features/ledger/hooks';
import {
  useAllItineraryItems, useItinerary, useItineraryDays,
} from '@/features/itinerary/hooks';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';
import { daysBetweenTWDates, formatTW, startOfTWDay } from '@/lib/tz';
import { effectiveAmountTWD, type Transaction } from '@/features/ledger/types';
import { computeSettlement } from '../settlement';
import { useActiveHousehold } from '@/features/household/hooks';
import { useExpenseBreakdown } from '@/features/ledger/use-my-share';
import { ViewScopeToggle, type ViewScope } from '@/components/ui/view-scope-toggle';
import type { Trip } from '../types';

/**
 * 行程報告書：花費 / 行程 / 天數總結，可列印 / 存 PDF（瀏覽器原生 print → save as PDF）。
 */
export function TripReport({ trip }: { trip: Trip }) {
  const { user } = useAuth();
  const { data: itinerary } = useItinerary(trip.id);
  const { data: days = [] } = useItineraryDays(trip.id);
  const dayIds = useMemo(() => days.map((d) => d.id), [days]);
  const { data: groups = [] } = useAllItineraryItems(trip.id, dayIds);
  const { data: txs = [] } = useTransactions(
    { tripId: trip.id, limit: 500 },
    { enabled: Boolean(user?.uid) },
  );
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.key, c])),
    [categories],
  );

  // 報告書預設「只看我的」：花費總覽 / 分類用我負擔那份；成員分攤表永遠是全員
  const breakdown = useExpenseBreakdown();
  const [viewScope, setViewScope] = useState<ViewScope>('mine');
  const amountOf = useCallback(
    (t: Transaction) => (viewScope === 'mine' ? breakdown(t).shareTWD : effectiveAmountTWD(t)),
    [viewScope, breakdown],
  );
  const stats = useMemo(() => computeStats(trip, txs, amountOf), [trip, txs, amountOf]);
  const household = useActiveHousehold();
  const householdMemberIds = household?.memberIds;
  const settlement = useMemo(
    () => (trip.members && trip.members.length > 0 ? computeSettlement(trip.members, txs, { householdMemberIds }) : null),
    [trip.members, txs, householdMemberIds],
  );

  function handlePrint() {
    if (typeof window !== 'undefined') window.print();
  }

  return (
    <div className="space-y-4">
      {/* 工具列：列印（會 save as PDF） */}
      <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
        <ViewScopeToggle value={viewScope} onChange={setViewScope} mineLabel="只看我負擔的" allLabel="整趟" />
        <Button size="sm" variant="outline" onClick={handlePrint}>
          <Printer className="size-4" /> 列印 / 存成 PDF
        </Button>
      </div>

      <div className="trip-report space-y-4 print:space-y-3">
        <ReportHero trip={trip} stats={stats} />

        <ReportSummary stats={stats} mine={viewScope === 'mine'} />

        {settlement ? (
          <ReportMemberSpending settlement={settlement} catMap={catMap} />
        ) : null}

        <ReportExpensesBreakdown txs={txs} catMap={catMap} totalTWD={stats.totalTWD} amountOf={amountOf} />

        {dayIds.length > 0 && (
          <ReportItinerary
            days={days.map((d, idx) => ({
              dayId: d.id,
              date: d.date,
              theme: d.theme,
              index: idx,
              items: groups.find((g) => g.dayId === d.id)?.items ?? [],
            }))}
          />
        )}

        {(itinerary?.tips?.length || itinerary?.notes) ? (
          <ReportNotes summary={itinerary?.summary} tips={itinerary?.tips ?? []} notes={itinerary?.notes} />
        ) : null}

        <p className="text-center text-[11px] text-muted-foreground print:mt-6">
          本報告由 Personal Hub 產生於 {formatTW(new Date(), 'yyyy/MM/dd HH:mm')}
        </p>
      </div>
    </div>
  );
}

interface Stats {
  totalDays: number;
  totalTWD: number;
  countTx: number;
  byCurrency: Array<{ currency: string; total: number; totalTWD: number }>;
  byCategory: Array<{ category: string; totalTWD: number; pct: number; count: number }>;
  prepaidTWD: number;
  prepaidPendingTWD: number;
  perDayTWD: number;
  budgetUsedPct: number;
}

/** amountOf：每筆要算多少（整筆 or 我負擔那份）；原幣金額按同比例縮放 */
function computeStats(trip: Trip, txs: Transaction[], amountOf: (t: Transaction) => number): Stats {
  const valid = txs.filter((t) => t.type === 'expense' && !t.deletedAt);
  const totalTWD = valid.reduce((s, t) => s + amountOf(t), 0);
  const countTx = valid.length;

  const byCurrencyMap = new Map<string, { total: number; totalTWD: number }>();
  for (const t of valid) {
    const cur = byCurrencyMap.get(t.currency) ?? { total: 0, totalTWD: 0 };
    const eff = effectiveAmountTWD(t);
    const mine = amountOf(t);
    cur.total += eff > 0 ? t.amount * (mine / eff) : 0;
    cur.totalTWD += mine;
    byCurrencyMap.set(t.currency, cur);
  }
  const byCurrency = Array.from(byCurrencyMap.entries())
    .map(([currency, v]) => ({ currency, ...v }))
    .sort((a, b) => b.totalTWD - a.totalTWD);

  const byCategoryMap = new Map<string, { totalTWD: number; count: number }>();
  for (const t of valid) {
    const cur = byCategoryMap.get(t.category) ?? { totalTWD: 0, count: 0 };
    cur.totalTWD += amountOf(t);
    cur.count += 1;
    byCategoryMap.set(t.category, cur);
  }
  const byCategory = Array.from(byCategoryMap.entries())
    .map(([category, v]) => ({
      category,
      totalTWD: v.totalTWD,
      count: v.count,
      pct: totalTWD > 0 ? (v.totalTWD / totalTWD) * 100 : 0,
    }))
    .sort((a, b) => b.totalTWD - a.totalTWD);

  const prepaidTWD = valid.filter((t) => t.prepaid).reduce((s, t) => s + effectiveAmountTWD(t), 0);
  const prepaidPendingTWD = valid
    .filter((t) => t.prepaid && t.splitMode === 'i-paid-others' && !t.loanSettledAt)
    .reduce((s, t) => {
      const eff = effectiveAmountTWD(t);
      const due = t.myShareTWD == null ? eff : Math.max(0, eff - t.myShareTWD);
      return s + due;
    }, 0);

  const start = startOfTWDay(trip.startDate);
  const end = startOfTWDay(trip.endDate);
  const totalDays = Math.max(1, daysBetweenTWDates(start, end) + 1);
  const perDayTWD = totalDays > 0 ? totalTWD / totalDays : 0;
  const budgetUsedPct = trip.budget > 0 ? (totalTWD / trip.budget) * 100 : 0;

  return {
    totalDays,
    totalTWD,
    countTx,
    byCurrency,
    byCategory,
    prepaidTWD,
    prepaidPendingTWD,
    perDayTWD,
    budgetUsedPct,
  };
}

function ReportHero({ trip, stats }: { trip: Trip; stats: Stats }) {
  return (
    <Card className="overflow-hidden border-2 print:border print:shadow-none">
      <div
        className={cn(
          'relative h-32 w-full bg-cover bg-center print:h-24',
          !trip.coverImage && 'bg-gradient-to-br from-primary/40 via-purple-500/30 to-pink-500/30',
        )}
        style={trip.coverImage ? { backgroundImage: `url(${JSON.stringify(trip.coverImage).slice(1, -1)})` } : undefined}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent print:hidden" />
      </div>
      <CardContent className="space-y-3 p-4 print:p-3">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">行程報告書 · Trip Report</p>
          <h1 className="text-2xl font-bold leading-tight print:text-xl">{trip.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3.5" /> {trip.destination.join(' · ')}
          </span>
          <span className="inline-flex items-center gap-1">
            <Calendar className="size-3.5" />
            {formatTW(trip.startDate, 'yyyy/MM/dd')} – {formatTW(trip.endDate, 'yyyy/MM/dd')}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5" /> {stats.totalDays} 天
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function ReportSummary({ stats, mine }: { stats: Stats; mine: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" /> 總覽
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 print:grid-cols-4">
          <Stat icon={Wallet} label={mine ? '我負擔' : '總花費'} value={formatCurrency(stats.totalTWD)} sub={`${stats.countTx} 筆${mine ? ' · 分攤後' : ''}`} />
          <Stat icon={Calendar} label="平均每日" value={formatCurrency(Math.round(stats.perDayTWD))} sub={`${stats.totalDays} 天`} />
          <Stat
            icon={Coins}
            label="預付款"
            value={formatCurrency(stats.prepaidTWD)}
            sub={stats.prepaidPendingTWD > 0 ? `待收 ${formatCurrency(stats.prepaidPendingTWD)}` : '已結清'}
          />
          <Stat
            icon={Receipt}
            label="預算使用"
            value={formatPercent(Math.min(stats.budgetUsedPct, 999), 0)}
            sub=""
          />
        </div>
        {stats.byCurrency.length > 1 && (
          <div className="mt-3 grid gap-2 sm:grid-cols-3 print:grid-cols-3">
            {stats.byCurrency.map((c) => (
              <div key={c.currency} className="rounded-md border p-2 text-xs">
                <div className="text-muted-foreground">{c.currency}</div>
                <div className="text-sm font-semibold tabular-nums">{c.total.toLocaleString()}</div>
                <div className="text-muted-foreground">≈ {formatCurrency(c.totalTWD)}</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  icon: Icon, label, value, sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className="size-3" /> {label}
      </div>
      <div className="mt-0.5 truncate text-base font-semibold tabular-nums">{value}</div>
      {sub ? <div className="text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function ReportExpensesBreakdown({
  txs, catMap, totalTWD, amountOf,
}: {
  txs: ReturnType<typeof useTransactions>['data'] extends infer T
    ? T extends Array<infer U> ? U[] : never
    : never;
  catMap: Record<string, { name?: string; color?: string }>;
  totalTWD: number;
  amountOf: (t: Transaction) => number;
}) {
  const valid = (txs ?? []).filter((t) => t.type === 'expense' && !t.deletedAt);
  if (valid.length === 0) return null;
  const byCategory = new Map<string, { totalTWD: number; count: number }>();
  for (const t of valid) {
    const cur = byCategory.get(t.category) ?? { totalTWD: 0, count: 0 };
    cur.totalTWD += amountOf(t);
    cur.count += 1;
    byCategory.set(t.category, cur);
  }
  const rows = Array.from(byCategory.entries())
    .map(([key, v]) => ({
      key,
      name: catMap[key]?.name ?? key,
      color: catMap[key]?.color ?? '#94a3b8',
      ...v,
      pct: totalTWD > 0 ? (v.totalTWD / totalTWD) * 100 : 0,
    }))
    .sort((a, b) => b.totalTWD - a.totalTWD);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="size-4" /> 花費分類
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: r.color }} />
                  {r.name}
                  <span className="text-xs text-muted-foreground">（{r.count}）</span>
                </span>
                <span className="tabular-nums">
                  {formatCurrency(r.totalTWD)} · {formatPercent(r.pct, 0)}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, r.pct)}%`, backgroundColor: r.color }}
                />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ReportMemberSpending({
  settlement,
  catMap,
}: {
  settlement: ReturnType<typeof computeSettlement>;
  catMap: Record<string, { name?: string; color?: string }>;
}) {
  if (settlement.balances.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4" /> 成員花費
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2 print:grid-cols-2">
          {settlement.balances.map((b) => (
            <section key={b.id} className="rounded-md border p-3 print:break-inside-avoid">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">{b.name}</div>
                  <div className="text-xs text-muted-foreground">
                    應付 {formatCurrency(b.share)} · {formatPercent(b.sharePct, 1)}
                  </div>
                </div>
                <div className="text-right text-xs tabular-nums">
                  <div className="text-muted-foreground">淨額</div>
                  <div className={b.net > 0 ? 'font-semibold text-success' : b.net < 0 ? 'font-semibold text-destructive' : ''}>
                    {b.net > 0 ? '+' : ''}{formatCurrency(b.net)}
                  </div>
                </div>
              </div>

              <div className="mb-2 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md bg-muted/40 p-2">
                  <div className="text-muted-foreground">代墊</div>
                  <div className="font-medium tabular-nums">{formatCurrency(b.paid)}</div>
                </div>
                <div className="rounded-md bg-muted/40 p-2">
                  <div className="text-muted-foreground">筆數</div>
                  <div className="font-medium tabular-nums">{b.txCount}</div>
                </div>
              </div>

              {b.categories.length > 0 ? (
                <ul className="mb-2 space-y-1 text-xs">
                  {b.categories.slice(0, 4).map((c) => (
                    <li key={c.category} className="flex items-center justify-between gap-2">
                      <span className="truncate">{catMap[c.category]?.name ?? c.category}</span>
                      <span className="shrink-0 tabular-nums">
                        {formatCurrency(c.amountTWD)} · {formatPercent(c.pctOfMemberShare, 1)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              <ul className="space-y-1 text-[11px] text-muted-foreground">
                {b.details.slice(0, 6).map((d) => (
                  <li key={`${b.id}-${d.txId}`} className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate">
                      {formatTW(d.date, 'MM/dd')} · {catMap[d.category]?.name ?? d.category}
                      {d.note ? ` · ${d.note}` : ''}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatCurrency(d.shareTWD)} · {formatPercent(d.sharePctOfTx, 0)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {settlement.transfers.length > 0 ? (
          <div className="rounded-md border p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">建議結清</div>
            <ul className="space-y-1 text-sm">
              {settlement.transfers.map((t, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span>{t.fromName} → {t.toName}</span>
                  <span className="font-medium tabular-nums">{formatCurrency(t.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReportItinerary({
  days,
}: {
  days: Array<{
    dayId: string;
    date: string;
    theme?: string;
    index: number;
    items: Array<{
      id: string;
      title: string;
      startTime?: string;
      endTime?: string;
      placeName?: string;
      address?: string;
      type?: string;
      estimatedCost?: number;
      notes?: string;
    }>;
  }>;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Calendar className="size-4" /> 行程明細
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {days.map((d) => (
            <div key={d.dayId} className="rounded-md border p-3 print:break-inside-avoid">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold">
                    Day {d.index + 1}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">{d.date}</span>
                  </div>
                  {d.theme ? <div className="text-xs text-muted-foreground">{d.theme}</div> : null}
                </div>
                <span className="text-xs text-muted-foreground">{d.items.length} 項</span>
              </div>
              {d.items.length === 0 ? (
                <p className="text-xs text-muted-foreground">這天沒有安排</p>
              ) : (
                <ul className="space-y-1.5">
                  {d.items.map((it) => (
                    <li key={it.id} className="flex items-start gap-2 text-sm">
                      <div className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">
                        {it.startTime ? <span className="font-medium text-foreground">{it.startTime}</span> : '—'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{it.title}</div>
                        {(it.placeName || it.address) && (
                          <div className="text-[11px] text-muted-foreground">
                            <MapPin className="mr-0.5 inline size-2.5" />
                            {it.placeName ?? it.address}
                          </div>
                        )}
                        {it.notes ? (
                          <div className="text-[11px] text-muted-foreground">{it.notes}</div>
                        ) : null}
                      </div>
                      {it.estimatedCost != null ? (
                        <div className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          ~{formatCurrency(it.estimatedCost)}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ReportNotes({
  summary, tips, notes,
}: { summary?: string; tips: string[]; notes?: string }) {
  return (
    <Card className="print:break-before-page">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="size-4" /> 筆記與小撇步
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {summary ? <p className="text-sm">{summary}</p> : null}
        {tips.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">小撇步</div>
            <ul className="space-y-1 text-sm">
              {tips.map((t, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {notes ? (
          <div className="rounded-md border bg-muted/20 p-3">
            <Markdown>{notes}</Markdown>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
