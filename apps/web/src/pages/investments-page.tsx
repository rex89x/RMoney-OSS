import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { ScrollTabsList } from '@/components/ui/scroll-tabs';
import { PageHeader } from '@/components/layout/page-header';
import {
  DividendsView, InvestmentDashboard, InvestmentPlanner, PortfolioView, RealizedPnlView, SwingTradingLab, WatchlistView,
} from '@/features/investments';
import { FxView, StockAlerts } from '@/features/fx';
import { ErrorBoundary } from '@/components/error-boundary';
import { JointInvestmentSummaryCard } from '@/features/joint-investments';

export default function InvestmentsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'dashboard';
  function setTab(v: string) {
    const next = new URLSearchParams(params);
    next.set('tab', v);
    setParams(next, { replace: true });
  }

  return (
    <ErrorBoundary scope="Investments">
      <PageHeader title="投資" description="儀表板 / 規劃 / Watchlist / Portfolio / 短波段實驗 / 股息 / 已實現 / 匯率 / 警報" />
      <Tabs value={tab} onValueChange={setTab}>
        <ScrollTabsList
          aria-label="投資分頁"
          value={tab}
          items={[
          { value: 'dashboard', label: '儀表板' },
          { value: 'planner', label: '規劃' },
          { value: 'watchlist', label: 'Watchlist' },
          { value: 'portfolio', label: 'Portfolio' },
          { value: 'swing', label: '短波段' },
          { value: 'dividends', label: '股息' },
          { value: 'realized', label: '已實現' },
          { value: 'alerts', label: '警報' },
          { value: 'fx', label: '匯率' },
          ]}
        />
        <TabsContent value="dashboard">
          <ErrorBoundary scope="JointInvestmentSummary"><JointInvestmentSummaryCard /></ErrorBoundary>
          <InvestmentDashboard />
        </TabsContent>
        <TabsContent value="planner"><InvestmentPlanner /></TabsContent>
        <TabsContent value="watchlist"><WatchlistView /></TabsContent>
        <TabsContent value="portfolio"><PortfolioView /></TabsContent>
        <TabsContent value="swing"><SwingTradingLab /></TabsContent>
        <TabsContent value="dividends"><DividendsView /></TabsContent>
        <TabsContent value="realized"><RealizedPnlView /></TabsContent>
        <TabsContent value="alerts"><StockAlerts /></TabsContent>
        <TabsContent value="fx"><FxView /></TabsContent>
      </Tabs>
    </ErrorBoundary>
  );
}
