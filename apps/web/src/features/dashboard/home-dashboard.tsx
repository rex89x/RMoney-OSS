import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { doc, updateDoc } from 'firebase/firestore';
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  BarChart3, DollarSign, Plane, TrendingUp, Wallet, PiggyBank, Eye, EyeOff, GripVertical, ChevronDown,
  Sun, Activity, LineChart, LayoutGrid, MessageCircleQuestion, type LucideIcon,
} from 'lucide-react';
import {
  Bar, BarChart, ResponsiveContainer, Tooltip, XAxis,
} from 'recharts';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { formatCurrency, formatPercent, sum } from '@/lib/utils';
import { formatDateInput, formatTW, nowTW, startOfTWDay } from '@/lib/tz';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS } from '@/lib/chart-theme';
import { useBudget } from '@/features/ledger/hooks';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import { effectiveAmountTWD } from '@/features/ledger/types';
import { useFxRates } from '@/features/fx/hooks';
import { FxRateCard } from '@/features/fx/components/fx-rate-card';
import { usePortfolio, useStocks } from '@/features/investments/hooks';
import { PortfolioDashboardCard } from '@/features/investments';
import { NetWorthDashboardCard, EmergencyFundCard } from '@/features/net-worth';
import { AccountsOverviewCard } from '@/features/accounts';
import { RentalsDashboardCard } from '@/features/rentals';
import { SubscriptionsDashboardCard } from '@/features/subscriptions';
import { ScheduledPaymentsDashboardCard } from '@/features/scheduled-payments';
import { SavingsGoalsDashboardCard } from '@/features/goals';
import {
  CashflowWaterfallCard, CategoryAnomalyCard, DeltaBadge, MonthStatusCard, MonthlyForecastCard,
  dailyTotals, filterUntilKey, isConsumptionExpense, ledgerListHref, percentChange, rangeFromKeys,
  twDateFromKey, useComparisonRange, usePeriodRange, useRangeTransactions, useTodayKey,
} from '@/features/analytics';
import { TripRecapCard } from '@/features/trips';
import { FlightRadarCard } from '@/features/flight-watches';
import { StockRadarCard } from '@/features/stock-radar';
import { InboxDashboardCard } from '@/features/inbox';
import { HouseholdDashboardCard } from '@/features/household';
import { NotificationBell } from '@/features/notifications/components/notification-bell';
import { useAskStore } from '@/stores/ask-store';
import { DailyBudgetRemainingCard } from './daily-budget-remaining-card';
import { TransactionList } from '@/features/ledger/components/transaction-list';
import { useTrips } from '@/features/trips/hooks';
import { useFxRate } from '@/features/ledger/hooks';
import type { DashboardCardKey, DashboardScope, DashboardSectionKey } from '@/types/global';
import {
  BudgetRingCard, CategoryPieCard, DailyCumulativeCard, MonthlyIncomeExpenseCard,
  PaymentMethodCard, SettlementStatusCard, StatsCard,
} from './analytics-cards';

const SCOPES: { key: DashboardScope; label: string }[] = [
  { key: 'thisMonth', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'thisQuarter', label: '本季' },
  { key: 'ytd', label: 'YTD' },
];

const CARD_OPTIONS: { key: DashboardCardKey; label: string }[] = [
  { key: 'monthStatus', label: '本月狀態（置頂）' },
  { key: 'kpi', label: 'KPI 卡片' },
  { key: 'budgetRing', label: '預算達成' },
  { key: 'categoryPie', label: '類別分布' },
  { key: 'monthlyIncomeExpense', label: '近 6 個月收支' },
  { key: 'dailyCumulative', label: '本月累積支出' },
  { key: 'paymentMethod', label: '支付方式' },
  { key: 'stats', label: '快速統計' },
  { key: 'settlement', label: '結算狀態' },
  { key: 'fxRates', label: '即時匯率' },
  { key: 'portfolioSummary', label: '投資組合總覽' },
  { key: 'netWorth', label: '淨值' },
  { key: 'accountsOverview', label: '資產總覽（帳戶）' },
  { key: 'rentals', label: '租賃資產' },
  { key: 'emergencyFund', label: '應急基金' },
  { key: 'dailyBudgetRemaining', label: '今日剩餘額度' },
  { key: 'subscriptions', label: '訂閱費' },
  { key: 'scheduledPayments', label: '排程支出' },
  { key: 'savingsGoals', label: '目標儲蓄' },
  { key: 'household', label: '共同帳' },
  { key: 'monthlyForecast', label: '月底結餘預測' },
  { key: 'cashflowWaterfall', label: '現金流瀑布' },
  { key: 'tripRecap', label: '出遊回顧' },
  { key: 'topMovers', label: '股票 Top movers' },
  { key: 'upcomingTrip', label: '接下來的行程' },
  { key: 'flightRadar', label: '機票雷達' },
  { key: 'stockRadar', label: '股市雷達' },
  { key: 'sparkline', label: '花費 Spark line' },
  { key: 'recentTransactions', label: '最近 10 筆交易' },
];

const DEFAULT_ORDER: DashboardCardKey[] = CARD_OPTIONS.map((o) => o.key);
/** 固定在最上方、不參與分段排序的卡片 */
const PINNED_TOP: DashboardCardKey = 'monthStatus';

/** 首頁分段：今日焦點 / 現金流 / 投資 / 更多（預設折疊）。自訂順序與隱藏設定仍套用在段內。 */
const SECTIONS: { key: DashboardSectionKey; label: string; icon: LucideIcon; cards: DashboardCardKey[] }[] = [
  { key: 'focus', label: '今日焦點', icon: Sun, cards: ['kpi', 'dailyBudgetRemaining', 'monthlyForecast', 'upcomingTrip', 'flightRadar'] },
  { key: 'cashflow', label: '現金流', icon: Activity, cards: ['recentTransactions', 'budgetRing', 'categoryPie', 'dailyCumulative', 'monthlyIncomeExpense', 'cashflowWaterfall', 'household', 'subscriptions', 'scheduledPayments', 'savingsGoals', 'emergencyFund'] },
  { key: 'invest', label: '投資', icon: LineChart, cards: ['stockRadar', 'portfolioSummary', 'netWorth', 'accountsOverview', 'topMovers', 'fxRates'] },
  { key: 'more', label: '更多', icon: LayoutGrid, cards: ['paymentMethod', 'stats', 'settlement', 'sparkline', 'rentals', 'tripRecap'] },
];
const SECTION_OF: Record<DashboardCardKey, DashboardSectionKey> = Object.fromEntries(
  SECTIONS.flatMap((s) => s.cards.map((c) => [c, s.key])),
) as Record<DashboardCardKey, DashboardSectionKey>;
const DEFAULT_COLLAPSED: DashboardSectionKey[] = ['more'];

export function HomeDashboard() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const openAsk = useAskStore((s) => s.openAsk);
  const tw = nowTW();
  const prefs = profile?.preferences?.dashboard ?? {};
  const [scope, setScope] = useState<DashboardScope>(prefs.scope ?? 'thisMonth');
  const [hiddenCards, setHiddenCards] = useState<DashboardCardKey[]>(prefs.hiddenCards ?? []);
  const [collapsed, setCollapsed] = useState<DashboardSectionKey[]>(prefs.collapsedSections ?? DEFAULT_COLLAPSED);
  const [order, setOrder] = useState<DashboardCardKey[]>(() => {
    const saved = prefs.order ?? [];
    // 確保所有 key 都在 order 裡（新版本加入的 key 自動補到結尾）
    return [...saved.filter((k) => DEFAULT_ORDER.includes(k)),
            ...DEFAULT_ORDER.filter((k) => !saved.includes(k))];
  });

  const todayKey = useTodayKey();
  const range = usePeriodRange(scope);
  const comparison = useComparisonRange(scope);
  const { startKey, endKey, label: scopeLabel } = range;

  // 預算跟著 scope 月份走（thisMonth 預設、lastMonth 取上月、其他用本月當 reference）
  const budgetMonthKey = useMemo(() => {
    const refDate = scope === 'lastMonth'
      ? new Date(tw.getFullYear(), tw.getMonth() - 1, 1)
      : tw;
    return `${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, '0')}`;
  }, [scope, tw]);

  const { txs, isLoading: txLoading } = useRangeTransactions(range);
  const { txs: prevTxsAll } = useRangeTransactions(comparison);
  // 近 7 天花費：獨立查詢，月初 / 選上月時也看得到真正的最近 7 天
  const last7Range = useMemo(() => {
    const tw7 = twDateFromKey(todayKey);
    const s7 = new Date(tw7.getFullYear(), tw7.getMonth(), tw7.getDate() - 6);
    return rangeFromKeys(formatDateInput(s7), todayKey);
  }, [todayKey]);
  const { txs: last7Txs } = useRangeTransactions(last7Range);
  const { data: budget } = useBudget(budgetMonthKey);
  const { data: rates = [] } = useFxRates();
  const { data: stocks = [] } = useStocks();
  const { data: portfolio = [] } = usePortfolio();
  const { data: trips = [] } = useTrips();
  const { data: usdRate = 31 } = useFxRate('USD');

  const myShare = useMyExpenseShare();
  // 消費支出口徑（排除對帳調整 / 租賃購入 / 共同帳結算），與分析頁、預測一致
  const expenseTxs = useMemo(() => txs.filter(isConsumptionExpense), [txs]);
  const totalExpense = sum(expenseTxs, (t) => myShare(t));
  const prevExpense = useMemo(
    () => sum(filterUntilKey(prevTxsAll, comparison.cutoffKey).filter(isConsumptionExpense), (t) => myShare(t)),
    [prevTxsAll, comparison.cutoffKey, myShare],
  );
  // 整筆合計（含幫別人墊的）：與「我負擔」有差時在 KPI 說明標出
  const totalExpenseFull = sum(expenseTxs, (t) => effectiveAmountTWD(t));
  // 預算使用率永遠用「預算那個月」的支出（季 / 年 scope 時是本月）
  const budgetRange = usePeriodRange(scope === 'lastMonth' ? 'lastMonth' : 'thisMonth');
  const { txs: budgetMonthTxs } = useRangeTransactions(budgetRange);
  const budgetSpent = useMemo(
    () => sum(budgetMonthTxs.filter(isConsumptionExpense), (t) => myShare(t)),
    [budgetMonthTxs, myShare],
  );
  const unsettled = txs.filter((t) => t.type === 'expense' && t.settledAmountTWD == null && t.currency !== 'TWD');
  const unsettledTotal = sum(unsettled, (t) => myShare(t));
  const budgetPct = budget && budget.total > 0 ? (budgetSpent / budget.total) * 100 : 0;

  const totalAssets = useMemo(() => {
    return sum(portfolio, (p) => {
      const s = stocks.find((st) => st.symbol === p.symbol);
      const current = s?.currentPrice ?? p.avgCost;
      const value = current * p.shares;
      return p.currency === 'USD' ? value * usdRate : value;
    });
  }, [portfolio, stocks, usdRate]);

  const topMoversTw = useMemo(
    () => stocks.filter((s) => s.market === 'TW').sort((a, b) => b.changePercent - a.changePercent).slice(0, 5),
    [stocks],
  );
  const topMoversUs = useMemo(
    () => stocks.filter((s) => s.market === 'US').sort((a, b) => b.changePercent - a.changePercent).slice(0, 5),
    [stocks],
  );

  const upcomingTrip = useMemo(() => {
    const today = startOfTWDay().getTime();
    const toMs = (d: unknown): number => {
      if (d instanceof Date) return startOfTWDay(d).getTime();
      if (typeof d === 'string' || typeof d === 'number') return startOfTWDay(d).getTime();
      return 0;
    };
    // 顯示「目前正在進行 (today <= endDate)」或「即將開始 (today < startDate)」的最近一筆
    const candidate = trips
      .filter((t) => {
        if (t.status === 'done') return false;
        const endMs = toMs(t.endDate ?? t.startDate);
        return endMs >= today;
      })
      .sort((a, b) => toMs(a.startDate) - toMs(b.startDate))[0] ?? null;
    if (!candidate) return null;
    const startMs = toMs(candidate.startDate);
    return { trip: candidate, inProgress: startMs <= today };
  }, [trips]);

  const sparkline = useMemo(() => {
    const map = new Map<string, number>();
    // 以「台北日」為 bucket key，避免使用者在 UTC+8 之外時 bucket 對不上
    const tw7 = twDateFromKey(todayKey);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(tw7.getFullYear(), tw7.getMonth(), tw7.getDate() - i);
      map.set(formatDateInput(d), 0);
    }
    for (const [day, v] of dailyTotals(last7Txs, myShare)) {
      if (map.has(day)) map.set(day, (map.get(day) ?? 0) + v);
    }
    return Array.from(map.entries()).map(([day, value]) => ({ key: day, day: day.slice(5).replace('-', '/'), value }));
  }, [last7Txs, myShare, todayKey]);

  const greeting = useMemo(() => {
    const hour = tw.getHours();
    if (hour < 5) return 'Late night';
    if (hour < 11) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, [tw]);

  const displayName = profile?.displayName ?? profile?.email?.split('@')[0] ?? 'Owner';

  function isHidden(k: DashboardCardKey) { return hiddenCards.includes(k); }

  async function savePrefs(next: Partial<{ scope: DashboardScope; hiddenCards: DashboardCardKey[]; order: DashboardCardKey[]; collapsedSections: DashboardSectionKey[] }>) {
    if (!user) return;
    const merged = {
      scope: next.scope ?? scope,
      hiddenCards: next.hiddenCards ?? hiddenCards,
      order: next.order ?? order,
      collapsedSections: next.collapsedSections ?? collapsed,
    };
    try {
      await updateDoc(doc(db, 'users', user.uid), { 'preferences.dashboard': merged });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '儲存失敗');
    }
  }

  function toggleSection(k: DashboardSectionKey) {
    const next = collapsed.includes(k) ? collapsed.filter((x) => x !== k) : [...collapsed, k];
    setCollapsed(next);
    void savePrefs({ collapsedSections: next });
  }

  function toggleCard(k: DashboardCardKey) {
    const next = hiddenCards.includes(k) ? hiddenCards.filter((x) => x !== k) : [...hiddenCards, k];
    setHiddenCards(next);
    void savePrefs({ hiddenCards: next });
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [dragEnabled, setDragEnabled] = useState(false);

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(active.id as DashboardCardKey);
    const to = order.indexOf(over.id as DashboardCardKey);
    if (from < 0 || to < 0) return;
    const next = arrayMove(order, from, to);
    setOrder(next);
    void savePrefs({ order: next });
  }

  const visibleOrder = order.filter((k) => !isHidden(k) && k !== PINNED_TOP);

  // cards renderer
  function renderCard(k: DashboardCardKey): React.ReactNode {
    switch (k) {
      case 'kpi':
        return (
          <div className="grid gap-3 md:grid-cols-4">
            <KpiCard
              icon={PiggyBank}
              label="投資市值"
              value={formatCurrency(totalAssets)}
              sub={`${portfolio.length} 檔持倉`}
              to="/investments"
            />
            <KpiCard
              icon={Wallet}
              label={`支出（${scopeLabel}）`}
              value={txLoading ? undefined : formatCurrency(totalExpense)}
              sub={Math.abs(totalExpenseFull - totalExpense) > 0.5
                ? `${expenseTxs.length} 筆 · 整筆 ${formatCurrency(totalExpenseFull)}，已扣他人分攤`
                : `${expenseTxs.length} 筆`}
              extra={txLoading ? null : (
                <DeltaBadge value={percentChange(totalExpense, prevExpense)} goodWhen="down" suffix={`vs ${comparison.label}`} />
              )}
              to={ledgerListHref({ type: 'expense', startKey, endKey })}
            />
            <KpiCard
              icon={BarChart3}
              label={`預算使用率（${budgetMonthKey.slice(5)} 月）`}
              value={budget ? `${Math.round(budgetPct)}%` : '未設定'}
              sub={budget ? `/ ${formatCurrency(budget.total)}` : '可在記帳 > 預算設定'}
              to="/settings?tab=budget"
            />
            <KpiCard
              icon={Wallet}
              label="未結算（估算）"
              value={formatCurrency(unsettledTotal)}
              sub={`${unsettled.length} 筆 · 多幣別刷卡待帳單`}
              to="/ledger?tx_settleStatus=unsettled&tx_type=expense"
            />
          </div>
        );
      case 'budgetRing': return <BudgetRingCard />;
      case 'categoryPie': return <CategoryPieCard scope={scope} />;
      case 'monthlyIncomeExpense': return <MonthlyIncomeExpenseCard />;
      case 'dailyCumulative': return <DailyCumulativeCard />;
      case 'paymentMethod': return <PaymentMethodCard scope={scope} />;
      case 'stats': return <StatsCard scope={scope} />;
      case 'settlement': return <SettlementStatusCard scope={scope} />;
      case 'recentTransactions':
        // SPEC §5.4.4：首頁最近 10 筆交易（點列可直接編輯，與記帳頁同一個元件）
        return (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>最近 10 筆交易</CardTitle>
              <Button asChild size="sm" variant="ghost"><Link to="/ledger">全部</Link></Button>
            </CardHeader>
            <CardContent>
              <TransactionList filters={{ limit: 10 }} emptyHint="還沒有交易，點右下角 + 記一筆" />
            </CardContent>
          </Card>
        );
      case 'fxRates':
        return (
          <Card>
            <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
              <CardTitle className="flex items-center gap-2 text-base">
                <DollarSign className="size-4" /> 即時匯率
              </CardTitle>
              <Link to="/fx" className="text-xs text-muted-foreground">查看全部</Link>
            </CardHeader>
            <CardContent>
              {rates.length === 0 ? (
                <Skeleton className="h-12 w-full" />
              ) : (
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {rates.slice(0, 4).map((r) => (
                    <FxRateCard key={r.id} rate={r} compact />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      case 'portfolioSummary':
        return <PortfolioDashboardCard />;
      case 'netWorth':
        return <NetWorthDashboardCard />;
      case 'accountsOverview':
        return <AccountsOverviewCard />;
      case 'rentals':
        return <RentalsDashboardCard />;
      case 'emergencyFund':
        return <EmergencyFundCard />;
      case 'dailyBudgetRemaining':
        return <DailyBudgetRemainingCard />;
      case 'subscriptions':
        return <SubscriptionsDashboardCard />;
      case 'scheduledPayments':
        return <ScheduledPaymentsDashboardCard />;
      case 'savingsGoals':
        return <SavingsGoalsDashboardCard />;
      case 'household':
        return <HouseholdDashboardCard />;
      case 'monthlyForecast':
        return (
          <div className="space-y-3">
            <MonthlyForecastCard />
            <CategoryAnomalyCard />
          </div>
        );
      case 'cashflowWaterfall':
        return <CashflowWaterfallCard />;
      case 'tripRecap':
        return <TripRecapCard />;
      case 'flightRadar':
        return <FlightRadarCard />;
      case 'stockRadar':
        return <StockRadarCard />;
      case 'topMovers':
        return (
          <Card>
            <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="size-4" /> Top movers
              </CardTitle>
              <Link to="/investments" className="text-xs text-muted-foreground">查看全部</Link>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <TopMoversList market="TW" items={topMoversTw} />
              <TopMoversList market="US" items={topMoversUs} />
            </CardContent>
          </Card>
        );
      case 'upcomingTrip':
        if (!upcomingTrip) return null;
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plane className="size-4" />
                {upcomingTrip.inProgress ? '進行中的行程' : '接下來的行程'}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{upcomingTrip.trip.name}</div>
                <div className="text-sm text-muted-foreground">
                  {upcomingTrip.trip.destination.join(' · ')} · {formatTW(upcomingTrip.trip.startDate, 'yyyy/MM/dd')}
                  {upcomingTrip.trip.endDate
                    ? ` – ${formatTW(upcomingTrip.trip.endDate, 'MM/dd')}`
                    : ''}
                </div>
              </div>
              <Link to={`/trips/${upcomingTrip.trip.id}`} className="text-sm text-primary">查看</Link>
            </CardContent>
          </Card>
        );
      case 'sparkline':
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="size-4" /> 近 7 天花費
              </CardTitle>
            </CardHeader>
            <CardContent className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sparkline}>
                  <XAxis dataKey="day" {...AXIS_PROPS} />
                  <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(v: number) => [formatCurrency(v), '支出']} />
                  <Bar
                    dataKey="value"
                    fill={CHART_COLORS.expense}
                    radius={[4, 4, 0, 0]}
                    cursor="pointer"
                    onClick={(item: { payload?: { key?: string } }) => {
                      const k = item.payload?.key;
                      if (k) navigate(ledgerListHref({ type: 'expense', startKey: k, endKey: k }));
                    }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        );
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex w-full items-start justify-between gap-2 sm:w-auto">
          <div>
            <p className="text-sm text-muted-foreground">
              {greeting}, {displayName}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              {formatTW(new Date(), 'yyyy/MM/dd (eee)')}
            </h1>
          </div>
          {/* 手機沒有側欄：通知鈴鐺放在首頁標題旁（桌面在側欄頂部） */}
          <NotificationBell className="lg:hidden" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {SCOPES.map((s) => (
              <button key={s.key} type="button"
                onClick={() => { setScope(s.key); void savePrefs({ scope: s.key }); }}
                className={cn(
                  'h-8 rounded-md px-2.5 text-xs font-medium transition-colors',
                  scope === s.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                )}>
                {s.label}
              </button>
            ))}
          </div>
          <Badge variant="outline">{scopeLabel}</Badge>
          <Button size="sm" variant="outline" onClick={() => openAsk()}>
            <MessageCircleQuestion className="size-4" /> 問一下
          </Button>
          <Button size="sm" variant={dragEnabled ? 'default' : 'outline'} onClick={() => setDragEnabled((v) => !v)}>
            <GripVertical className="size-4" /> {dragEnabled ? '完成排序' : '排序'}
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline">
                {hiddenCards.length > 0 ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                卡片
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-60 p-2">
              <div className="mb-2 text-xs font-medium">顯示卡片</div>
              <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                {CARD_OPTIONS.map((c) => {
                  const hidden = isHidden(c.key);
                  return (
                    <li key={c.key}>
                      <button type="button" onClick={() => toggleCard(c.key)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors',
                          hidden ? 'text-muted-foreground' : 'bg-primary/10 text-primary',
                        )}>
                        <span>{c.label}</span>
                        {hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {isHidden(PINNED_TOP) ? null : <MonthStatusCard />}

      <InboxDashboardCard />

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        {SECTIONS.map((section) => {
          const keys = visibleOrder.filter((k) => SECTION_OF[k] === section.key);
          if (keys.length === 0) return null;
          const isCollapsed = collapsed.includes(section.key) && !dragEnabled;
          const SectionIcon = section.icon;
          return (
            <section key={section.key} className="space-y-3">
              <button
                type="button"
                onClick={() => toggleSection(section.key)}
                className="-my-2 flex w-full items-center gap-2 px-1 py-2 text-left text-sm font-semibold text-muted-foreground hover:text-foreground"
                aria-expanded={!isCollapsed}
              >
                <SectionIcon className="size-4" />
                <span>{section.label}</span>
                <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium">{keys.length}</span>
                <ChevronDown className={cn('ml-auto size-4 transition-transform', isCollapsed && '-rotate-90')} />
              </button>
              {isCollapsed ? null : (
                <SortableContext items={keys} strategy={rectSortingStrategy} disabled={!dragEnabled}>
                  <div className="grid gap-4">
                    {keys.map((k) => (
                      <SortableCard key={k} id={k} enabled={dragEnabled}>
                        {renderCard(k)}
                      </SortableCard>
                    ))}
                  </div>
                </SortableContext>
              )}
            </section>
          );
        })}
      </DndContext>
    </div>
  );
}

function SortableCard({ id, enabled, children }: { id: DashboardCardKey; enabled: boolean; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !enabled });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className={cn('relative', enabled && 'ring-1 ring-dashed ring-border rounded-lg')}>
      {enabled ? (
        <div
          {...attributes}
          {...listeners}
          className="absolute left-1 top-1 z-10 cursor-grab touch-none rounded-md bg-background/80 p-2 text-muted-foreground shadow-sm backdrop-blur hover:bg-muted lg:p-1"
          aria-label="拖曳"
        >
          <GripVertical className="size-4" />
        </div>
      ) : null}
      {children}
    </div>
  );
}

function TopMoversList({ market, items }: {
  market: 'TW' | 'US';
  items: Array<{ symbol: string; changePercent: number }>;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">{market === 'TW' ? '台股' : '美股'}</div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">尚無資料</p>
      ) : (
        <ul className="space-y-0.5 text-sm">
          {items.map((s) => (
            <li key={s.symbol} className="flex items-center justify-between">
              <Link to={`/investments/${encodeURIComponent(s.symbol)}`}>
                <span className="font-medium">{s.symbol}</span>
              </Link>
              <span className={s.changePercent >= 0 ? 'text-success' : 'text-destructive'}>
                {formatPercent(s.changePercent)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KpiCard({
  icon: Icon, label, value, sub, to, extra,
}: { icon: typeof BarChart3; label: string; value?: string; sub?: string; to?: string; extra?: React.ReactNode }) {
  const inner = (
    <Card className={cn('relative overflow-hidden transition-shadow hover:shadow-md', to && 'cursor-pointer')}>
      <div className="pointer-events-none absolute -right-6 -top-6 size-24 rounded-full bg-primary/5" />
      <CardContent className="relative p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-muted-foreground">{label}</div>
          <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Icon className="size-4" />
          </div>
        </div>
        {value ? (
          <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
        ) : (
          <Skeleton className="mt-2 h-7 w-24" />
        )}
        {extra ? <div className="mt-1">{extra}</div> : null}
        {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}
