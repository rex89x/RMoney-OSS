import { useMemo, useState, type ReactNode } from 'react';
import {
  Activity, BookOpen, Bot, CandlestickChart, ClipboardCheck, Database, FlaskConical, History, LayoutDashboard, RefreshCw, Settings2, Timer, Trophy,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ScrollTabsList } from '@/components/ui/scroll-tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import { isStale } from '../dashboard';
import {
  useBackfillTaifex,
  useRunTaifexDaily,
  useTaifexAccount,
  useTaifexConfig,
  useTaifexLive,
  useTaifexSentiment,
  useTaifexSignals,
} from '../hooks';
import { MODE_LABELS, TAIFEX_PRODUCT_SPECS } from '../options';
import { DEFAULT_TAIFEX_CONFIG, type TaifexAccount } from '../types';
import { TaifexBacktest } from './taifex-backtest';
import { TaifexClaudeDialog } from './taifex-claude-dialog';
import { TaifexGuide } from './taifex-guide';
import { TaifexOrderDialog } from './taifex-order-dialog';
import { TaifexOverview } from './taifex-overview';
import { TaifexPerformance } from './taifex-performance';
import { PaperDisclaimer } from './taifex-parts';
import { TaifexReview } from './taifex-review';
import { TaifexSettings } from './taifex-settings';
import { TaifexSignalDetail } from './taifex-signal-detail';
import { TaifexTech } from './taifex-tech';
import { TaifexTrades } from './taifex-trades';

type TaifexTab = 'overview' | 'tech' | 'performance' | 'review' | 'signal' | 'trades' | 'backtest' | 'settings' | 'guide';

/** /taifex 頁面本體：總覽／盤中技術／績效／週檢討／訊號／交易／回測／設定／說明；下單與 Claude 對話框由這裡持有 */
export function TaifexSim() {
  const account = useTaifexAccount();
  const signals = useTaifexSignals();
  const sentiment = useTaifexSentiment();
  const live = useTaifexLive();
  const configQuery = useTaifexConfig();
  const runDaily = useRunTaifexDaily();
  const backfill = useBackfillTaifex();
  const [tab, setTab] = useState<TaifexTab>('overview');
  const [orderOpen, setOrderOpen] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);

  const config = configQuery.data ?? DEFAULT_TAIFEX_CONFIG;
  const today = formatTW(new Date(), 'yyyy-MM-dd');
  const signalList = useMemo(() => signals.data ?? [], [signals.data]);
  const latestSignal = useMemo(
    () => [...signalList].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null,
    [signalList],
  );
  const acc = account.data ?? null;
  const loading = account.isLoading || signals.isLoading;
  const stale = acc ? isStale(acc.lastBarDate, today) : false;
  const busy = runDaily.isPending || backfill.isPending;

  const needsAccount = (render: (account: TaifexAccount) => ReactNode) => {
    if (loading) return <Skeleton className="h-64 w-full" />;
    if (!acc) {
      return (
        <EmptyState
          icon={CandlestickChart}
          title="還沒有台指期資料"
          description="第一次使用請先回補約 2 年的期交所日 K、三大法人與 PCR（約 1–2 分鐘），完成後會自動建立虛擬帳戶並算出今天的訊號。"
          action={(
            <Button size="sm" disabled={busy} onClick={() => backfill.mutate(24)}>
              <Database className={cn('size-3.5', backfill.isPending && 'animate-pulse')} /> {backfill.isPending ? '回補中…' : '回補歷史資料'}
            </Button>
          )}
        />
      );
    }
    return render(acc);
  };

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as TaifexTab)}>
        <ScrollTabsList
          aria-label="台指期模擬分頁"
          value={tab}
          items={[
            { value: 'overview', label: '總覽', icon: LayoutDashboard },
            { value: 'tech', label: '盤中技術', icon: Timer },
            { value: 'performance', label: '績效', icon: Trophy },
            { value: 'review', label: '週檢討', icon: ClipboardCheck },
            { value: 'signal', label: '訊號', icon: Activity },
            { value: 'trades', label: '交易', icon: History },
            { value: 'backtest', label: '回測', icon: FlaskConical },
            { value: 'settings', label: '設定', icon: Settings2 },
            { value: 'guide', label: '說明', icon: BookOpen },
          ]}
        />
        {tab !== 'guide' ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">{TAIFEX_PRODUCT_SPECS[acc?.product ?? config.product].label}</Badge>
            <Badge variant="outline">{MODE_LABELS[config.mode].label}</Badge>
            <span className={cn('text-muted-foreground', stale && 'text-warning')}>
              {acc?.lastBarDate ? `資料至 ${acc.lastBarDate}` : '尚無資料'}
              {acc?.updatedAt ? ` · 更新於 ${formatTW(acc.updatedAt, 'MM/dd HH:mm')}` : ''}
              {stale ? '（資料偏舊）' : ''}
            </span>
            <Button size="sm" variant="ghost" className="ml-auto h-8" onClick={() => setClaudeOpen(true)}>
              <Bot className="size-3.5" /> Claude 輿情
            </Button>
            <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => runDaily.mutate()}>
              <RefreshCw className={cn('size-3.5', runDaily.isPending && 'animate-spin')} /> 立即更新
            </Button>
          </div>
        ) : null}

        <TabsContent value="overview" className="mt-3 min-w-0">
          {tab === 'overview' ? needsAccount((a) => (
            <TaifexOverview
              account={a}
              signal={latestSignal}
              sentiment={sentiment.data ?? null}
              live={live.data ?? null}
              config={config}
              today={today}
              onOpenOrder={() => setOrderOpen(true)}
              onOpenClaude={() => setClaudeOpen(true)}
            />
          )) : null}
        </TabsContent>
        <TabsContent value="tech" className="mt-3 min-w-0">
          {tab === 'tech' ? <TaifexTech config={config} /> : null}
        </TabsContent>
        <TabsContent value="performance" className="mt-3 min-w-0">
          {tab === 'performance' ? needsAccount((a) => <TaifexPerformance account={a} config={config} />) : null}
        </TabsContent>
        <TabsContent value="review" className="mt-3 min-w-0">
          {tab === 'review' ? <TaifexReview config={config} /> : null}
        </TabsContent>
        <TabsContent value="signal" className="mt-3 min-w-0">
          {tab === 'signal' ? needsAccount(() => <TaifexSignalDetail signals={signalList} />) : null}
        </TabsContent>
        <TabsContent value="trades" className="mt-3 min-w-0">
          {tab === 'trades' ? needsAccount((a) => <TaifexTrades account={a} />) : null}
        </TabsContent>
        <TabsContent value="backtest" className="mt-3 min-w-0">
          {tab === 'backtest' ? <TaifexBacktest /> : null}
        </TabsContent>
        <TabsContent value="settings" className="mt-3 min-w-0">
          {tab === 'settings' ? (configQuery.isLoading ? <Skeleton className="h-64 w-full" /> : <TaifexSettings config={config} account={acc} />) : null}
        </TabsContent>
        <TabsContent value="guide" className="mt-3 min-w-0">
          {tab === 'guide' ? <TaifexGuide /> : null}
        </TabsContent>
      </Tabs>

      <PaperDisclaimer className="mt-6" />

      {acc ? (
        <TaifexOrderDialog open={orderOpen} onOpenChange={setOrderOpen} account={acc} config={config} signal={latestSignal} />
      ) : null}
      <TaifexClaudeDialog open={claudeOpen} onOpenChange={setClaudeOpen} />
    </>
  );
}
