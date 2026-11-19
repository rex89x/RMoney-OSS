import { useMemo, useState, type ReactNode } from 'react';
import {
  Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  ArrowDownRight, ArrowUpRight, BarChart3, CalendarDays, ChevronRight, Layers, PiggyBank, Receipt, Scale, TrendingUp,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { useConfirm } from '@/components/ui/confirm';
import { useAuth } from '@/hooks/use-auth';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, formatAxisTWD } from '@/lib/chart-theme';
import { resolveIcon } from '@/lib/icons';
import { formatTW } from '@/lib/tz';
import { cn, formatCurrency } from '@/lib/utils';
import { useCategories, useSoftDeleteTransaction } from '@/features/ledger/hooks';
import type { Transaction } from '@/features/ledger/types';
import { ShareEditDialog } from '@/features/ledger/components/share-edit-dialog';
import { useHouseholdLedger } from '../hooks';
import {
  OTHER_CATEGORY_KEY,
  buildCategoryChanges,
  buildCategoryStack,
  buildFundMonthRows,
  buildMonthlyRows,
  buildPaidVsShare,
  buildPeriodKpis,
  buildWeekdayRows,
  lastMonths,
  topCategoryKeys,
  topExpenses,
} from '../analytics';
import { HOUSEHOLD_FUND_COLOR, memberColor } from '../entries';
import type { Household } from '../types';
import { MemberChip } from './member-chip';
import { HouseholdTxDetailDialog } from './household-tx-detail-dialog';
import { HouseholdEntryDialog } from './household-entry-dialog';

const PERIODS = [
  { months: 3, label: '近 3 個月' },
  { months: 6, label: '近 6 個月' },
  { months: 12, label: '近 12 個月' },
] as const;

/**
 * 共同帳本「分析」分頁：期間比較、趨勢、類別、分工、星期、公基金走勢、大筆支出。
 * 資料全部來自 useHouseholdLedger（近 24 個月），切期間不會多讀 Firestore。
 */
export function HouseholdInsights({ household }: { household: Household }) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const { txs, fundEntries, isLoading } = useHouseholdLedger(household);
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c])), [categories]);
  const [months, setMonths] = useState<number>(6);
  const softDelete = useSoftDeleteTransaction();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<Transaction | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [splitTx, setSplitTx] = useState<Transaction | null>(null);

  const memberIds = household.memberIds;
  const budget = household.monthlyBudgetTWD ?? null;
  const data = useMemo(() => {
    const current = lastMonths(months);
    const previous = lastMonths(months, months);
    const currentRows = buildMonthlyRows(txs, memberIds, current);
    const previousRows = buildMonthlyRows(txs, memberIds, previous);
    const start = current[0]?.start ?? new Date();
    const end = current[current.length - 1]?.end ?? new Date();
    const keys = topCategoryKeys(currentRows, 5);
    return {
      start,
      end,
      currentRows,
      kpis: buildPeriodKpis(currentRows, previousRows, budget),
      categoryKeys: keys,
      stack: buildCategoryStack(currentRows, keys),
      changes: buildCategoryChanges(currentRows, previousRows).slice(0, 10),
      paid: buildPaidVsShare(txs, fundEntries, memberIds, start, end),
      weekdays: buildWeekdayRows(txs, memberIds, start, end),
      fund: buildFundMonthRows(fundEntries, txs, current),
      top: topExpenses(txs, memberIds, start, end, 8),
    };
  }, [txs, fundEntries, memberIds, months, budget]);

  async function handleDelete(tx: Transaction) {
    const accepted = await confirm({
      title: '刪除這筆共同支出？',
      description: `${catMap[tx.category]?.name ?? tx.category} ${formatCurrency(tx.amountTWD)}${tx.note ? ` · ${tx.note}` : ''}`,
      confirmText: '刪除',
    });
    if (!accepted) return;
    try {
      await softDelete.mutateAsync(tx.id);
      toast.success('已刪除');
      setDetail(null);
    } catch (error) {
      console.error('[insightsDeleteTx]', error);
      toast.error(error instanceof Error ? error.message : '刪除失敗');
    }
  }

  if (isLoading) return <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}</div>;

  const { kpis } = data;
  const hasData = kpis.count > 0;
  const categoryName = (key: string) => (key === OTHER_CATEGORY_KEY ? '其他' : catMap[key]?.name ?? key);
  const categoryColor = (key: string) => (key === OTHER_CATEGORY_KEY ? CHART_COLORS.muted : catMap[key]?.color ?? CHART_COLORS.primary);
  const maxPaid = Math.max(1, ...data.paid.flatMap((row) => [row.paidTWD, row.shareTWD, row.contributedTWD]));
  const maxChange = Math.max(1, ...data.changes.map((row) => Math.max(row.currentTWD, row.previousTWD)));
  const busiestDay = [...data.weekdays].sort((a, b) => b.totalTWD - a.totalTWD)[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="分析期間">
        {PERIODS.map((period) => (
          <button
            key={period.months}
            type="button"
            role="radio"
            aria-checked={months === period.months}
            onClick={() => setMonths(period.months)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              months === period.months ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
            )}
          >
            {period.label}
          </button>
        ))}
        <span className="self-center text-[11px] text-muted-foreground">
          {formatTW(data.start, 'yyyy/M/d')} – {formatTW(data.end, 'yyyy/M/d')}，與前 {months} 個月比較
        </span>
      </div>

      <StatGrid>
        <StatTile
          label="期間共同支出"
          value={formatCurrency(kpis.totalTWD)}
          hint={kpis.changePct === null ? '前一段期間沒有資料' : `比前期 ${kpis.changePct >= 0 ? '+' : ''}${kpis.changePct.toFixed(0)}%`}
          tone={kpis.changePct !== null && kpis.changePct > 10 ? 'warn' : 'plain'}
        />
        <StatTile label="每月平均" value={formatCurrency(kpis.monthlyAvgTWD)} hint={budget ? `月預算 ${formatCurrency(budget)}` : '尚未設定月預算'} />
        <StatTile label="筆數 / 平均每筆" value={`${kpis.count} 筆`} hint={`平均 ${formatCurrency(kpis.avgTicketTWD)}`} />
        <StatTile
          label={kpis.monthsWithinBudget !== null ? '預算達成' : '公基金支付比例'}
          value={kpis.monthsWithinBudget !== null ? `${kpis.monthsWithinBudget} / ${data.currentRows.length} 月` : `${Math.round(kpis.fundShare * 100)}%`}
          hint={kpis.monthsWithinBudget !== null ? `公基金支付 ${Math.round(kpis.fundShare * 100)}%` : '共同支出中由公基金付的比例'}
          tone={kpis.monthsWithinBudget !== null && kpis.monthsWithinBudget < data.currentRows.length ? 'warn' : 'plain'}
        />
      </StatGrid>

      {!hasData ? (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">這段期間還沒有共同支出，記幾筆之後這裡就會出現趨勢與分析。</CardContent></Card>
      ) : (
        <>
          <Section icon={TrendingUp} title="每月共同支出" description="長條 = 每月總額，折線 = 近 3 個月移動平均；虛線是月預算">
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data.currentRows} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
                  <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={8} />
                  <YAxis {...AXIS_PROPS} width={48} tickFormatter={formatAxisTWD} />
                  <Tooltip
                    {...CHART_TOOLTIP_PROPS}
                    formatter={(value: number, key: string) => [formatCurrency(value), key === 'movingAvgTWD' ? '3 個月平均' : '共同支出']}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value: string) => (value === 'movingAvgTWD' ? '3 個月平均' : '共同支出')} />
                  <Bar dataKey="totalTWD" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
                  <Line type="monotone" dataKey="movingAvgTWD" stroke={CHART_COLORS.axis} strokeWidth={2} dot={false} isAnimationActive={false} />
                  {budget ? (
                    <ReferenceLine
                      y={budget}
                      stroke={CHART_COLORS.warning}
                      strokeDasharray="4 4"
                      label={{ value: '預算', position: 'insideTopRight', fontSize: 10, fill: CHART_COLORS.axis }}
                    />
                  ) : null}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Section>

          <div className="grid gap-4 xl:grid-cols-2">
            <Section icon={Layers} title="類別趨勢" description="前 5 大類別每月花費，其餘併成「其他」">
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.stack} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                    <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={8} />
                    <YAxis {...AXIS_PROPS} width={48} tickFormatter={formatAxisTWD} />
                    <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number, key: string) => [formatCurrency(value), categoryName(key)]} />
                    <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value: string) => categoryName(value)} />
                    {[...data.categoryKeys, OTHER_CATEGORY_KEY].map((key, index, all) => (
                      <Bar
                        key={key}
                        dataKey={key}
                        stackId="cat"
                        fill={categoryColor(key)}
                        stroke="hsl(var(--card))"
                        strokeWidth={1}
                        radius={index === all.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                        maxBarSize={36}
                        isAnimationActive={false}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Section>

            <Section icon={BarChart3} title="類別變化" description={`本期 vs 前 ${months} 個月（前 10 大類別）`}>
              <ul className="space-y-2.5">
                {data.changes.map((row) => {
                  const Icon = resolveIcon(catMap[row.key]?.icon);
                  const up = row.diffTWD > 0;
                  return (
                    <li key={row.key} className="text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Icon className="size-3.5 shrink-0" style={{ color: catMap[row.key]?.color }} />
                          <span className="break-words font-medium">{categoryName(row.key)}</span>
                          <span className="shrink-0 text-muted-foreground">{Math.round(row.share * 100)}%</span>
                        </span>
                        <span className="shrink-0 text-right tabular-nums">
                          {formatCurrency(row.currentTWD)}
                          <span className={cn('ml-1.5 inline-flex items-center', up ? 'text-destructive' : row.diffTWD < 0 ? 'text-success' : 'text-muted-foreground')}>
                            {up ? <ArrowUpRight className="size-3" /> : row.diffTWD < 0 ? <ArrowDownRight className="size-3" /> : null}
                            {row.diffPct === null ? (row.currentTWD > 0 ? '新' : '—') : `${Math.abs(row.diffPct).toFixed(0)}%`}
                          </span>
                        </span>
                      </div>
                      <div className="mt-1 space-y-0.5" aria-hidden>
                        <div className="h-1.5 rounded-full bg-muted">
                          <div className="h-full rounded-full" style={{ width: `${(row.currentTWD / maxChange) * 100}%`, backgroundColor: catMap[row.key]?.color ?? CHART_COLORS.primary }} />
                        </div>
                        <div className="h-1 rounded-full bg-muted">
                          <div className="h-full rounded-full bg-muted-foreground/40" style={{ width: `${(row.previousTWD / maxChange) * 100}%` }} />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-[11px] text-muted-foreground">粗條 = 本期，細灰條 = 前期，同一把尺。</p>
            </Section>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Section icon={Scale} title="兩人分工" description="期間內各自付了多少、依分攤應負擔多少、存了多少公基金">
              <div className="space-y-4">
                {data.paid.map((row) => {
                  const color = memberColor(household, row.uid);
                  const diff = row.paidTWD - row.shareTWD;
                  return (
                    <div key={row.uid} className="space-y-1.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <MemberChip member={household.members[row.uid]} suffix={row.uid === myUid ? '（我）' : ''} className="text-xs" />
                        <span className={cn('tabular-nums', diff > 0.5 ? 'text-success' : diff < -0.5 ? 'text-destructive' : 'text-muted-foreground')}>
                          {diff > 0.5 ? `多墊 ${formatCurrency(diff)}` : diff < -0.5 ? `少付 ${formatCurrency(-diff)}` : '剛好'}
                        </span>
                      </div>
                      <BarRow label="實際付款" value={row.paidTWD} max={maxPaid} color={color} />
                      <BarRow label="應負擔" value={row.shareTWD} max={maxPaid} color={color} faded />
                      <BarRow label="存公基金" value={row.contributedTWD} max={maxPaid} color={HOUSEHOLD_FUND_COLOR} />
                    </div>
                  );
                })}
                <p className="text-[11px] text-muted-foreground">公基金付的支出不算任何人的負擔；「多墊／少付」未扣除已結算轉帳，實際欠款看總覽「誰欠誰」。</p>
              </div>
            </Section>

            <Section
              icon={CalendarDays}
              title="星期幾花最多"
              description={busiestDay && busiestDay.totalTWD > 0 ? `${busiestDay.label}最多，共 ${formatCurrency(busiestDay.totalTWD)}（${busiestDay.count} 筆）` : '期間內每個星期幾的總額'}
            >
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.weekdays} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                    <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" {...AXIS_PROPS} />
                    <YAxis {...AXIS_PROPS} width={48} tickFormatter={formatAxisTWD} />
                    <Tooltip
                      {...CHART_TOOLTIP_PROPS}
                      formatter={(value: number, _key: string, item: { payload?: { count?: number } }) => [
                        `${formatCurrency(value)}（${item.payload?.count ?? 0} 筆）`, '共同支出',
                      ]}
                    />
                    <Bar dataKey="totalTWD" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} maxBarSize={32} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Section>
          </div>
        </>
      )}

      {fundEntries.length > 0 || data.fund.some((row) => row.spentTWD > 0) ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Section icon={PiggyBank} title="公基金餘額走勢" description="每月底的累計餘額">
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.fund} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
                  <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={8} padding={{ left: 8, right: 8 }} />
                  <YAxis {...AXIS_PROPS} width={48} tickFormatter={formatAxisTWD} />
                  <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number) => [formatCurrency(value), '月底餘額']} />
                  <ReferenceLine y={0} stroke={CHART_COLORS.axis} />
                  <Line
                    type="monotone"
                    dataKey="balanceTWD"
                    stroke={HOUSEHOLD_FUND_COLOR}
                    strokeWidth={2}
                    dot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Section>
          <Section icon={PiggyBank} title="公基金存入 vs 支出" description="每月存進多少、從公基金付出多少">
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.fund} margin={{ top: 8, right: 8, left: 4, bottom: 0 }} barGap={2}>
                  <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={8} />
                  <YAxis {...AXIS_PROPS} width={48} tickFormatter={formatAxisTWD} />
                  <Tooltip
                    {...CHART_TOOLTIP_PROPS}
                    formatter={(value: number, key: string) => [formatCurrency(value), key === 'contributedTWD' ? '存入' : '支出']}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value: string) => (value === 'contributedTWD' ? '存入' : '支出')} />
                  <Bar dataKey="contributedTWD" fill={CHART_COLORS.income} radius={[4, 4, 0, 0]} maxBarSize={20} isAnimationActive={false} />
                  <Bar dataKey="spentTWD" fill={CHART_COLORS.expense} radius={[4, 4, 0, 0]} maxBarSize={20} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Section>
        </div>
      ) : null}

      {data.top.length > 0 ? (
        <Section icon={Receipt} title="期間大筆支出" description="點一下可以看明細或修改">
          <ul className="divide-y rounded-lg border">
            {data.top.map(({ tx, amountTWD }) => {
              const category = catMap[tx.category];
              const Icon = resolveIcon(category?.icon);
              return (
                <li key={tx.id}>
                  <button type="button" onClick={() => setDetail(tx)} className="flex w-full items-center gap-3 p-3 text-left text-sm hover:bg-muted/50">
                    <Icon className="size-4 shrink-0" style={{ color: category?.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="break-words font-medium">
                        {category?.name ?? tx.category}
                        {tx.note ? <span className="ml-1 text-xs font-normal text-muted-foreground">· {tx.note}</span> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">{formatTW(tx.date, 'yyyy/M/d (EEE)')}</div>
                    </div>
                    <span className="shrink-0 font-semibold tabular-nums">{formatCurrency(amountTWD)}</span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      <HouseholdTxDetailDialog
        household={household}
        tx={detail}
        open={Boolean(detail)}
        onOpenChange={(next) => { if (!next) setDetail(null); }}
        onEdit={(tx) => { setDetail(null); setEditing(tx); }}
        onEditSplit={(tx) => { setDetail(null); setSplitTx(tx); }}
        onDelete={(tx) => void handleDelete(tx)}
        deleting={softDelete.isPending}
      />
      <ShareEditDialog tx={splitTx} onClose={() => setSplitTx(null)} />
      <HouseholdEntryDialog household={household} open={Boolean(editing)} onOpenChange={(next) => { if (!next) setEditing(null); }} tx={editing} />
    </div>
  );
}

function Section({ icon: Icon, title, description, children }: {
  icon: typeof TrendingUp;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Icon className="size-4" /> {title}</CardTitle>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

function BarRow({ label, value, max, color, faded = false }: { label: string; value: number; max: number; color: string; faded?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="h-2 min-w-0 flex-1 rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${(value / max) * 100}%`, backgroundColor: color, opacity: faded ? 0.45 : 1 }} />
      </div>
      <span className="w-20 shrink-0 text-right text-[11px] tabular-nums">{formatCurrency(value)}</span>
    </div>
  );
}
