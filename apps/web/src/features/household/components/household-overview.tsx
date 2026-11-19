import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ArrowRight, ChevronDown, HandCoins, PiggyBank, Scale, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import { cn, formatCurrency } from '@/lib/utils';
import { addTWCalendarMonths, formatTW, monthTWRange, nowTW } from '@/lib/tz';
import { resolveIcon } from '@/lib/icons';
import { useCategories } from '@/features/ledger/hooks';
import { effectiveAmountTWD } from '@/features/ledger/types';
import {
  HOUSEHOLD_LEDGER_MONTHS, useHouseholdFundSummary, useHouseholdLedger, useHouseholdMonthSummary,
} from '../hooks';
import { HOUSEHOLD_FUND_COLOR, memberColor } from '../entries';
import { HOUSEHOLD_FUND_PAYER_ID, memberCan, type Household } from '../types';
import { sharesOfTx } from '../balance';
import { MemberChip } from './member-chip';
import { SettleDialog } from './settle-dialog';
import { HouseholdMonthPulseCard } from './household-month-pulse-card';
import { HouseholdFundTransfersCard } from './household-fund-transfers-card';

interface HouseholdOverviewProps {
  household: Household;
  /** 切到其他分頁（公基金 / 交易） */
  onNavigate?: (tab: string) => void;
}

const TREND_MONTHS = 6;

/** 總覽 dashboard：KPI、誰欠誰、近半年趨勢、本月類別 */
export function HouseholdOverview({ household, onNavigate }: HouseholdOverviewProps) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const { txs, balances, debts, settlements, isLoading } = useHouseholdLedger(household);
  const { summary, isLoading: monthLoading, range, txs: monthTxs } = useHouseholdMonthSummary(household);
  // 本月我負擔：分攤後我那份（公基金付的 = 0）
  const myMonthShare = useMemo(
    () => monthTxs.reduce((s, t) => s + (sharesOfTx(t, household.memberIds)[myUid] ?? 0), 0),
    [monthTxs, household.memberIds, myUid],
  );
  const { summary: fund } = useHouseholdFundSummary(household);
  const { data: categories = [] } = useCategories();
  const [settleOpen, setSettleOpen] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c])), [categories]);
  const debt = debts[0] ?? null;
  const budget = household.monthlyBudgetTWD ?? null;
  const budgetPct = budget && budget > 0 ? Math.min(100, (summary.totalTWD / budget) * 100) : null;

  const settledByMember = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of household.memberIds) out[id] = 0;
    for (const s of settlements) {
      out[s.fromUid] = (out[s.fromUid] ?? 0) + s.amountTWD;
      out[s.toUid] = (out[s.toUid] ?? 0) - s.amountTWD;
    }
    return out;
  }, [settlements, household.memberIds]);

  /** 近 6 個月共同支出，依付款人堆疊 */
  const trend = useMemo(() => {
    const now = nowTW();
    const months = Array.from({ length: TREND_MONTHS }, (_, i) => {
      const d = addTWCalendarMonths(now, -(TREND_MONTHS - 1 - i));
      return monthTWRange(d.getFullYear(), d.getMonth() + 1);
    });
    return months.map((m) => {
      const row: Record<string, string | number> = { month: formatTW(m.start, 'M月') };
      for (const id of household.memberIds) row[id] = 0;
      row[HOUSEHOLD_FUND_PAYER_ID] = 0;
      let total = 0;
      for (const tx of txs) {
        if (tx.date < m.start || tx.date > m.end) continue;
        const amount = effectiveAmountTWD(tx);
        const payer = tx.paidByUid ?? tx.userId;
        row[payer] = (Number(row[payer]) || 0) + amount;
        total += amount;
      }
      row.total = total;
      return row;
    });
  }, [txs, household.memberIds]);

  const trendHasData = trend.some((row) => Number(row.total) > 0);
  const payerSeries = useMemo(() => [
    ...household.memberIds.map((id) => ({
      key: id,
      name: `${household.members[id]?.displayName ?? id}${id === myUid ? '（我）' : ''}`,
      color: memberColor(household, id),
    })),
    { key: HOUSEHOLD_FUND_PAYER_ID, name: '公基金', color: HOUSEHOLD_FUND_COLOR },
  ], [household, myUid]);

  const debtLabel = !debt
    ? '兩不相欠'
    : debt.toUid === myUid
      ? `${household.members[debt.fromUid]?.displayName ?? '對方'} 還要付你`
      : debt.fromUid === myUid
        ? `你還要付 ${household.members[debt.toUid]?.displayName ?? '對方'}`
        : '待結算';

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatTile
          label="本月共同支出"
          value={formatCurrency(summary.totalTWD, 'TWD')}
          hint={`${summary.count} 筆 · ${formatTW(range.start, 'M/d')}–${formatTW(range.end, 'M/d')}`}
          loading={monthLoading}
        />
        <StatTile
          label="本月我負擔"
          value={formatCurrency(myMonthShare, 'TWD')}
          hint={summary.totalTWD > 0 ? `占共同支出 ${Math.round((myMonthShare / summary.totalTWD) * 100)}%` : '分攤後我那份'}
          loading={monthLoading}
        />
        <StatTile
          label={budget ? '本月預算剩餘' : '共同月預算'}
          value={budget ? formatCurrency(Math.max(0, budget - summary.totalTWD), 'TWD') : '未設定'}
          hint={budget ? `預算 ${formatCurrency(budget, 'TWD')} · 已用 ${Math.round(budgetPct ?? 0)}%` : '到「設定」可以設一個'}
          tone={budgetPct != null && budgetPct >= 100 ? 'bad' : budgetPct != null && budgetPct >= 80 ? 'warn' : 'plain'}
          loading={monthLoading}
        />
        <StatTile
          label={debtLabel}
          value={debt ? formatCurrency(debt.amountTWD, 'TWD') : '—'}
          hint={debt ? '按「結算」記一筆實際轉帳' : '目前沒有待結算金額'}
          tone={debt && debt.fromUid === myUid ? 'bad' : debt ? 'good' : 'plain'}
          loading={isLoading}
        />
        <StatTile
          label="公基金餘額"
          value={formatCurrency(fund.balanceTWD)}
          hint={fund.outstandingTWD > 0 ? `待撥還代墊 ${formatCurrency(fund.outstandingTWD)}` : `累計存入 ${formatCurrency(fund.contributionsTWD)}`}
          tone={fund.balanceTWD < 0 ? 'bad' : 'plain'}
          loading={isLoading}
          onClick={onNavigate ? () => onNavigate('fund') : undefined}
        />
      </StatGrid>

      <HouseholdFundTransfersCard household={household} compact />

      <HouseholdMonthPulseCard household={household} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Scale className="size-4" /> 誰欠誰</CardTitle>
            <Button
              size="sm"
              onClick={() => setSettleOpen(true)}
              disabled={!debt || !memberCan(household, myUid, 'canSettle')}
              title={memberCan(household, myUid, 'canSettle') ? undefined : '建立者沒有開放你結算'}
            >
              <HandCoins className="size-4" /> 結算
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? <Skeleton className="h-16" /> : debt ? (
              <div className="rounded-xl border bg-muted/30 p-4">
                <div className="flex items-center justify-center gap-3 text-sm">
                  <MemberChip member={household.members[debt.fromUid]} suffix={debt.fromUid === myUid ? '（我）' : ''} />
                  <ArrowRight className="size-4 text-muted-foreground" />
                  <MemberChip member={household.members[debt.toUid]} suffix={debt.toUid === myUid ? '（我）' : ''} />
                </div>
                <div className="mt-2 text-center text-2xl font-semibold tabular-nums">{formatCurrency(debt.amountTWD, 'TWD')}</div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">目前兩不相欠</div>
            )}

            <button
              type="button"
              onClick={() => setShowBreakdown((v) => !v)}
              className="flex w-full items-center justify-between rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              <span>怎麼算出來的</span>
              <ChevronDown className={cn('size-4 transition-transform', showBreakdown && 'rotate-180')} />
            </button>
            <ul className="space-y-2">
              {household.memberIds.map((id) => {
                const b = balances[id];
                const paid = b?.paidTWD ?? 0;
                const share = b?.shareTWD ?? 0;
                const settled = settledByMember[id] ?? 0;
                const net = b?.netTWD ?? 0;
                return (
                  <li key={id} className="rounded-md border p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <MemberChip member={household.members[id]} suffix={id === myUid ? '（我）' : ''} className="text-xs" />
                      <span className={cn(
                        'font-medium tabular-nums',
                        net > 0.5 ? 'text-success' : net < -0.5 ? 'text-destructive' : 'text-muted-foreground',
                      )}>
                        {net > 0.5 ? `別人欠 ${formatCurrency(net, 'TWD')}` : net < -0.5 ? `欠別人 ${formatCurrency(-net, 'TWD')}` : '兩不相欠'}
                      </span>
                    </div>
                    {showBreakdown ? (
                      <dl className="mt-1.5 space-y-0.5 text-muted-foreground">
                        <div className="flex justify-between"><dt>墊付共同支出</dt><dd className="tabular-nums">+{formatCurrency(paid, 'TWD')}</dd></div>
                        <div className="flex justify-between"><dt>自己應負擔</dt><dd className="tabular-nums">−{formatCurrency(share, 'TWD')}</dd></div>
                        <div className="flex justify-between"><dt>已結算轉帳</dt><dd className="tabular-nums">{settled >= 0 ? '+' : '−'}{formatCurrency(Math.abs(settled), 'TWD')}</dd></div>
                        <div className="flex justify-between border-t pt-0.5 font-medium text-foreground"><dt>淨額</dt><dd className="tabular-nums">{formatCurrency(net, 'TWD')}</dd></div>
                      </dl>
                    ) : (
                      <div className="mt-0.5 tabular-nums text-muted-foreground">
                        墊付 {formatCurrency(paid, 'TWD')} · 應付 {formatCurrency(share, 'TWD')}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              以近 {HOUSEHOLD_LEDGER_MONTHS} 個月的共同支出計算；公基金支付的支出不列入。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><TrendingUp className="size-4" /> 近 {TREND_MONTHS} 個月共同支出</CardTitle>
            <p className="text-xs text-muted-foreground">依付款人堆疊，看得出誰先墊得多</p>
          </CardHeader>
          <CardContent>
            {!trendHasData ? (
              <p className="py-10 text-center text-sm text-muted-foreground">還沒有足夠的資料</p>
            ) : (
              <>
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={trend} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="month" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        width={56}
                        tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
                      />
                      <Tooltip
                        cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                        formatter={(value: number, name: string) => [formatCurrency(value, 'TWD'), name]}
                        contentStyle={{
                          background: 'hsl(var(--popover))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: 8,
                          fontSize: 12,
                          color: 'hsl(var(--popover-foreground))',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value: string) => <span className="text-foreground">{value}</span>} />
                      {payerSeries.map((series, index) => (
                        <Bar
                          key={series.key}
                          dataKey={series.key}
                          name={series.name}
                          stackId="payer"
                          fill={series.color}
                          stroke="hsl(var(--card))"
                          strokeWidth={2}
                          radius={index === payerSeries.length - 1 ? [4, 4, 0, 0] : undefined}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <ul className="mt-2 space-y-1 text-xs">
                  {trend.slice().reverse().slice(0, 3).map((row) => (
                    <li key={String(row.month)} className="flex items-center justify-between text-muted-foreground">
                      <span>{String(row.month)}</span>
                      <span className="tabular-nums">{formatCurrency(Number(row.total), 'TWD')}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base">本月類別分布</CardTitle>
          {onNavigate ? (
            <Button size="sm" variant="ghost" onClick={() => onNavigate('txs')}>看全部交易</Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3">
          {monthLoading ? <Skeleton className="h-24" /> : (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {household.memberIds.map((id) => (
                  <span key={id} className="inline-flex items-center gap-1">
                    <MemberChip member={household.members[id]} className="text-xs" />
                    付了 {formatCurrency(summary.byPayer[id] ?? 0, 'TWD')}
                  </span>
                ))}
                {(summary.byPayer[HOUSEHOLD_FUND_PAYER_ID] ?? 0) > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <PiggyBank className="size-3.5" style={{ color: HOUSEHOLD_FUND_COLOR }} />
                    公基金付了 {formatCurrency(summary.byPayer[HOUSEHOLD_FUND_PAYER_ID] ?? 0, 'TWD')}
                  </span>
                ) : null}
              </div>
              {summary.byCategory.length === 0 ? (
                <p className="text-sm text-muted-foreground">本月還沒有共同支出</p>
              ) : (
                <ul className="space-y-1.5">
                  {summary.byCategory.slice(0, 8).map((row) => {
                    const cat = catMap[row.key];
                    const Icon = resolveIcon(cat?.icon);
                    const pct = summary.totalTWD > 0 ? (row.totalTWD / summary.totalTWD) * 100 : 0;
                    return (
                      <li key={row.key} className="text-xs">
                        <div className="flex items-center justify-between">
                          <span className="inline-flex items-center gap-1.5">
                            <Icon className="size-3.5" style={{ color: cat?.color }} />
                            {cat?.name ?? row.key}
                          </span>
                          <span className="tabular-nums">
                            {formatCurrency(row.totalTWD, 'TWD')}
                            <span className="ml-1 text-muted-foreground">({Math.round(pct)}%)</span>
                          </span>
                        </div>
                        <Progress value={pct} className="mt-0.5 h-1" indicatorStyle={{ backgroundColor: cat?.color }} />
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <SettleDialog household={household} debt={debt} open={settleOpen} onOpenChange={setSettleOpen} />
    </div>
  );
}

