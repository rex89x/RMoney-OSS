import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cell, Bar, BarChart as ReBarChart, CartesianGrid, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ComposedChart,
} from 'recharts';
import { TrendingUp, PieChart as PieIcon, Calendar, CreditCard, Target, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatCurrency } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import {
  AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, formatAxisTWD,
} from '@/lib/chart-theme';
import { useBudget } from '@/features/ledger/hooks';
import { useAccounts } from '@/features/accounts';
import { effectiveAmountTWD, type Transaction } from '@/features/ledger/types';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import {
  CategoryBars, currentMonthInfo, elapsedDays, isConsumptionExpense, isEarnedIncome, ledgerListHref,
  recentMonthKeys, recentMonthsRange, twDateFromKey, useCategoryLookup, useComparisonRange,
  usePeriodComparison, usePeriodRange, useRangeTransactions, useTodayKey, type PeriodKey,
} from '@/features/analytics';

// -------- 1. 類別分布（水平長條，含與比較期間增減） --------

export function CategoryPieCard({ scope }: { scope: PeriodKey }) {
  const cmp = usePeriodComparison(scope);
  const lookup = useCategoryLookup();
  const navigate = useNavigate();

  const { current, previous } = cmp;
  const rows = useMemo(
    () => [...current.byCategory.entries()].map(([key, value]) => {
      const info = lookup(key);
      return { key, name: info.name, color: info.color, value, prev: previous.byCategory.get(key) ?? 0 };
    }),
    [current.byCategory, previous.byCategory, lookup],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><PieIcon className="size-4" /> 類別分布</span>
          <span className="text-xs font-normal tabular-nums text-muted-foreground">{formatCurrency(cmp.current.expense)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <CategoryBars
          rows={rows}
          compareLabel={`vs ${cmp.comparison.label}`}
          onSelect={(keys) => navigate(ledgerListHref({
            type: 'expense', category: keys, startKey: cmp.range.startKey, endKey: cmp.range.endKey,
          }))}
        />
      </CardContent>
    </Card>
  );
}

// -------- 2. 近 6 個月收支柱狀圖 --------

export function MonthlyIncomeExpenseCard() {
  const today = useTodayKey();
  const { range, monthKeys } = useMemo(() => {
    const tw = twDateFromKey(today);
    return { range: recentMonthsRange(tw, 6), monthKeys: recentMonthKeys(tw, 6) };
  }, [today]);
  const { txs } = useRangeTransactions(range);
  const myShare = useMyExpenseShare();
  const navigate = useNavigate();

  const data = useMemo(() => {
    const months = monthKeys.map((key) => ({ key, month: key.slice(5), income: 0, expense: 0, net: 0 }));
    const idx = new Map(months.map((m, i) => [m.key, i]));
    for (const t of txs) {
      const i = idx.get(formatTW(t.date, 'yyyy-MM'));
      if (i == null) continue;
      if (isEarnedIncome(t)) months[i]!.income += t.amountTWD; // 非空：索引已做邊界 / 長度檢查
      else if (isConsumptionExpense(t)) months[i]!.expense += myShare(t); // 非空：索引已做邊界 / 長度檢查
    }
    for (const m of months) m.net = m.income - m.expense;
    return months;
  }, [txs, myShare, monthKeys]);

  function openMonth(key: string | undefined) {
    if (!key) return;
    const [y, m] = key.split('-').map(Number) as [number, number];
    const last = new Date(y, m, 0).getDate();
    navigate(ledgerListHref({ startKey: `${key}-01`, endKey: `${key}-${String(last).padStart(2, '0')}` }));
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><TrendingUp className="size-4" /> 近 6 個月收支</CardTitle></CardHeader>
      <CardContent className="h-[260px] px-2">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
            <XAxis dataKey="month" {...AXIS_PROPS} fontSize={11} />
            <YAxis {...AXIS_PROPS} width={44} tickFormatter={formatAxisTWD} />
            <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(v: number) => formatCurrency(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
            <Bar dataKey="income" name="收入" fill={CHART_COLORS.income} radius={[4, 4, 0, 0]} cursor="pointer"
              onClick={(item: { payload?: { key?: string } }) => openMonth(item.payload?.key)} />
            <Bar dataKey="expense" name="支出" fill={CHART_COLORS.expense} radius={[4, 4, 0, 0]} cursor="pointer"
              onClick={(item: { payload?: { key?: string } }) => openMonth(item.payload?.key)} />
            <Line type="monotone" dataKey="net" name="結餘" stroke={CHART_COLORS.net} strokeWidth={2} dot />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// -------- 3. 本月每日累積支出（含上月同日對照） --------

export function DailyCumulativeCard() {
  const today = useTodayKey();
  const info = useMemo(() => currentMonthInfo(twDateFromKey(today)), [today]);
  const monthRange = usePeriodRange('thisMonth');
  const prevRange = useComparisonRange('thisMonth');
  const { txs } = useRangeTransactions(monthRange);
  const { txs: prevTxs } = useRangeTransactions(prevRange);
  const { data: budget } = useBudget(info.monthKey);
  const myShare = useMyExpenseShare();

  const data = useMemo(() => {
    const dailyBudget = budget ? budget.total / info.daysInMonth : 0;
    const byDay = (list: Transaction[]) => {
      const map = new Map<number, number>();
      for (const t of list) {
        if (!isConsumptionExpense(t)) continue;
        const d = Number(formatTW(t.date, 'd'));
        map.set(d, (map.get(d) ?? 0) + myShare(t));
      }
      return map;
    };
    const cur = byDay(txs);
    const prev = byDay(prevTxs);
    const days: { day: string; cumulative: number | null; lastMonth: number; budgetLine: number }[] = [];
    let cum = 0;
    let prevCum = 0;
    for (let d = 1; d <= info.daysInMonth; d++) {
      cum += cur.get(d) ?? 0;
      prevCum += prev.get(d) ?? 0;
      days.push({
        day: String(d),
        // 未來的日子不畫本月線，避免看起來像「已經平了」
        cumulative: d <= info.day ? cum : null,
        lastMonth: prevCum,
        budgetLine: dailyBudget * d,
      });
    }
    return days;
  }, [txs, prevTxs, budget, myShare, info]);

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4" /> 本月累積支出</CardTitle></CardHeader>
      <CardContent className="h-[220px] px-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
            <XAxis dataKey="day" {...AXIS_PROPS} interval="preserveStartEnd" minTickGap={10} />
            <YAxis {...AXIS_PROPS} width={44} tickFormatter={formatAxisTWD} />
            <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(v: number) => formatCurrency(v)} labelFormatter={(d) => `${d} 日`} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
            <Line type="monotone" dataKey="cumulative" name="本月" stroke={CHART_COLORS.expense} strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="lastMonth" name="上月" stroke={CHART_COLORS.muted} strokeWidth={1.5} dot={false} />
            {budget && (
              <Line type="monotone" dataKey="budgetLine" name="預算節奏" stroke={CHART_COLORS.net} strokeDasharray="4 4" strokeWidth={1.5} dot={false} />
            )}
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// -------- 4. 支付方式分佈 --------

export function PaymentMethodCard({ scope }: { scope: PeriodKey }) {
  const range = usePeriodRange(scope);
  const { txs } = useRangeTransactions(range);
  const { data: accounts = [] } = useAccounts();
  const myShare = useMyExpenseShare();
  const navigate = useNavigate();

  const data = useMemo(() => {
    const accountName = new Map(accounts.map((account) => [account.id, account.name]));
    const map = new Map<string, { value: number; pm: string | null }>();
    for (const t of txs) {
      if (!isConsumptionExpense(t)) continue;
      const k = t.fromAccountId ? (accountName.get(t.fromAccountId) ?? t.paymentMethod ?? '其他') : (t.paymentMethod || '其他');
      const cur = map.get(k) ?? { value: 0, pm: t.paymentMethod || null };
      cur.value += myShare(t);
      map.set(k, cur);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, value: v.value, pm: v.pm }))
      .sort((a, b) => b.value - a.value);
  }, [accounts, txs, myShare]);

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><CreditCard className="size-4" /> 帳戶支出</CardTitle></CardHeader>
      <CardContent className="h-[220px] px-2">
        {data.length === 0 ? (
          <p className="flex h-full items-center justify-center text-sm text-muted-foreground">尚無資料</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ReBarChart data={data} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} horizontal={false} />
              <XAxis type="number" {...AXIS_PROPS} tickFormatter={formatAxisTWD} />
              <YAxis dataKey="name" type="category" width={76} {...AXIS_PROPS} fontSize={11} />
              <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(v: number) => [formatCurrency(v), '支出']} />
              <Bar
                dataKey="value"
                fill={CHART_COLORS.primary}
                radius={[0, 4, 4, 0]}
                cursor="pointer"
                onClick={(item: { payload?: { pm?: string | null } }) => {
                  const pm = item.payload?.pm;
                  if (pm) navigate(ledgerListHref({ type: 'expense', paymentMethod: pm, startKey: range.startKey, endKey: range.endKey }));
                }}
              />
            </ReBarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// -------- 5. 預算達成圓環 --------

export function BudgetRingCard() {
  const today = useTodayKey();
  const info = useMemo(() => currentMonthInfo(twDateFromKey(today)), [today]);
  const monthRange = usePeriodRange('thisMonth');
  const { txs } = useRangeTransactions(monthRange);
  const { data: budget } = useBudget(info.monthKey);
  const myShare = useMyExpenseShare();

  const spent = useMemo(
    () => txs.filter(isConsumptionExpense).reduce((s, t) => s + myShare(t), 0),
    [txs, myShare],
  );
  const budgetTotal = budget?.total ?? 0;
  const pct = budgetTotal > 0 ? Math.min(100, (spent / budgetTotal) * 100) : 0;
  const remaining = Math.max(0, budgetTotal - spent);

  const paceTarget = budgetTotal * (info.day / info.daysInMonth);
  const pacing = spent - paceTarget;

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Target className="size-4" /> 預算達成</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {!budget ? (
          <p className="text-sm text-muted-foreground">尚未設定本月預算。可到 設定 → 預算 新增。</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-3xl font-semibold tabular-nums">{Math.round(pct)}%</div>
                <div className="text-xs text-muted-foreground">已用 {formatCurrency(spent)}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium tabular-nums">剩 {formatCurrency(remaining)}</div>
                <div className="text-[11px] text-muted-foreground">/ {formatCurrency(budgetTotal)}</div>
              </div>
            </div>
            <Progress value={pct} />
            <div className={`text-xs tabular-nums ${pacing > 0 ? 'text-destructive' : 'text-success'}`}>
              {pacing > 0 ? `超出節奏 ${formatCurrency(pacing)}` : `領先節奏 ${formatCurrency(-pacing)}`}
              <span className="ml-2 text-muted-foreground">（{info.day} / {info.daysInMonth} 天）</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// -------- 6. 頻繁類別 TOP 5 + 平均每日支出 --------

export function StatsCard({ scope }: { scope: PeriodKey }) {
  const today = useTodayKey();
  const range = usePeriodRange(scope);
  const { txs } = useRangeTransactions(range);
  const lookup = useCategoryLookup();
  const myShare = useMyExpenseShare();
  const navigate = useNavigate();
  function jumpToCat(key: string, note?: string) {
    navigate(ledgerListHref({ type: 'expense', category: key, q: note, startKey: range.startKey, endKey: range.endKey }));
  }

  const expenseTxs = useMemo(() => txs.filter(isConsumptionExpense), [txs]);
  const totalExpense = expenseTxs.reduce((s, t) => s + myShare(t), 0);
  // 期間還在進行中就用已經過去的台北日數當分母，不然月初平均會被尚未發生的天數稀釋
  const avgPerDay = totalExpense / elapsedDays(range, twDateFromKey(today));

  const byCategory = useMemo(() => {
    const count = new Map<string, { count: number; sum: number }>();
    for (const t of expenseTxs) {
      const k = t.category || 'other';
      const cur = count.get(k) ?? { count: 0, sum: 0 };
      cur.count++;
      cur.sum += myShare(t);
      count.set(k, cur);
    }
    return Array.from(count.entries())
      .map(([key, v]) => ({ key, name: lookup(key).name, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [expenseTxs, lookup, myShare]);

  const topTxs = useMemo(
    () => [...expenseTxs]
      .sort((a, b) => myShare(b) - myShare(a))
      .slice(0, 3),
    [expenseTxs, myShare],
  );

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Calendar className="size-4" /> 快速統計</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div>
          <div className="text-xs text-muted-foreground">平均每日支出</div>
          <div className="text-2xl font-semibold tabular-nums">{formatCurrency(avgPerDay)}</div>
        </div>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">最頻繁類別（點擊查看）</div>
          <ul className="space-y-0.5 text-sm">
            {byCategory.map((c) => (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => jumpToCat(c.key)}
                  className="flex w-full items-center justify-between rounded-md px-1 py-0.5 hover:bg-muted"
                >
                  <span>{c.name}</span>
                  <span className="tabular-nums text-muted-foreground">{c.count} 筆 · {formatCurrency(c.sum)}</span>
                </button>
              </li>
            ))}
            {byCategory.length === 0 && <li className="text-muted-foreground">無</li>}
          </ul>
        </div>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">最大 3 筆支出（點擊查看）</div>
          <ul className="space-y-0.5 text-sm">
            {topTxs.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => jumpToCat(t.category, t.note ?? undefined)}
                  className="flex w-full items-center justify-between rounded-md px-1 py-0.5 hover:bg-muted"
                >
                  <span className="truncate">{t.note || lookup(t.category).name}</span>
                  <span className="tabular-nums text-destructive">{formatCurrency(myShare(t))}</span>
                </button>
              </li>
            ))}
            {topTxs.length === 0 && <li className="text-muted-foreground">無</li>}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

// -------- 7. 結算狀態 --------

export function SettlementStatusCard({ scope }: { scope: PeriodKey }) {
  const range = usePeriodRange(scope);
  const { txs } = useRangeTransactions(range);
  const myShare = useMyExpenseShare();

  const stats = useMemo(() => {
    let settledTWD = 0;
    let unsettledTWD = 0;
    for (const t of txs) {
      if (t.type !== 'expense') continue;
      if (t.currency === 'TWD') continue;
      if (t.settledAmountTWD != null) settledTWD += myShare(t);
      else unsettledTWD += myShare(t);
    }
    return { settledTWD, unsettledTWD };
  }, [txs, myShare]);

  const total = stats.settledTWD + stats.unsettledTWD;
  const data = [
    { name: '已結算', value: stats.settledTWD, fill: CHART_COLORS.income },
    { name: '估算（未結算）', value: stats.unsettledTWD, fill: CHART_COLORS.warning },
  ];

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base">結算狀態</CardTitle></CardHeader>
      <CardContent className="h-[220px]">
        {total === 0 ? (
          <p className="flex h-full items-center justify-center text-sm text-muted-foreground">此期間沒有外幣支出</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} stroke="none">
                {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Pie>
              <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(v: number) => formatCurrency(v)} />
              <Legend formatter={(v) => <span className="text-xs">{v}</span>} iconSize={8} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function formatMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export { effectiveAmountTWD };
export type { Transaction };
