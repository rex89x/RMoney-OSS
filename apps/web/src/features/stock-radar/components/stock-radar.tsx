import { useMemo, useState } from 'react';
import { BookOpen, Bot, ClipboardCheck, FlaskConical, LayoutDashboard, LineChart as LineChartIcon, Radar, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ScrollTabsList } from '@/components/ui/scroll-tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import { latestRunByMarket } from '../dashboard';
import { useRunStockRadar, useStockRadarRuns } from '../hooks';
import { MARKET_LABELS } from '../options';
import type { StockRadarMarket } from '../types';
import { StockClaudeDialog } from './stock-claude-dialog';
import { StockRadarBacktest } from './stock-radar-backtest';
import { StockRadarGuide } from './stock-radar-guide';
import { StockRadarSymbol } from './stock-radar-symbol';
import { StockRadarToday } from './stock-radar-today';
import { StockRadarTrackRecord } from './stock-radar-track-record';

type StockRadarTab = 'today' | 'symbol' | 'track' | 'backtest' | 'guide';

const MARKETS: StockRadarMarket[] = ['TW', 'US'];

/** /stock-radar 頁面本體：市場切換 + 今日／個股／成績單／回測／使用說明；Claude 排程對話框由這裡持有 */
export function StockRadar() {
  const { data: runs = [], isLoading } = useStockRadarRuns();
  const runNow = useRunStockRadar();
  const [tab, setTab] = useState<StockRadarTab>('today');
  const [market, setMarket] = useState<StockRadarMarket>('TW');
  const [symbol, setSymbol] = useState<string | null>(null);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const latest = useMemo(() => latestRunByMarket(runs), [runs]);
  const run = latest[market] ?? null;

  const openSymbol = (next: string) => {
    setSymbol(next);
    setTab('symbol');
  };

  return (
    <>
    <Tabs value={tab} onValueChange={(value) => setTab(value as StockRadarTab)}>
      <ScrollTabsList
        aria-label="股市雷達分頁"
        value={tab}
        items={[
          { value: 'today', label: '今日', icon: LayoutDashboard },
          { value: 'symbol', label: '個股', icon: LineChartIcon },
          { value: 'track', label: '成績單', icon: ClipboardCheck },
          { value: 'backtest', label: '回測', icon: FlaskConical },
          { value: 'guide', label: '使用說明', icon: BookOpen },
        ]}
      />
      {tab !== 'guide' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <div className="flex overflow-hidden rounded-full border" role="radiogroup" aria-label="市場">
            {MARKETS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={market === value}
                onClick={() => { setMarket(value); setSymbol(null); }}
                className={cn('px-4 py-2 lg:px-3 lg:py-1', market === value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
              >
                {MARKET_LABELS[value]}
              </button>
            ))}
          </div>
          <span className="text-muted-foreground">
            {run?.generatedAt ? `評估於 ${formatTW(run.generatedAt, 'MM/dd HH:mm')}` : '尚未評估'}
            {run?.status === 'partial' ? '（逾時，部分標的未評估）' : ''}
          </span>
          <Button size="sm" variant="ghost" className="ml-auto h-8" onClick={() => setClaudeOpen(true)}>
            <Bot className="size-3.5" /> Claude 排程
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={runNow.isPending}
            onClick={() => runNow.mutate(market)}
          >
            <RefreshCw className={cn('size-3.5', runNow.isPending && 'animate-spin')} /> 重新評估
          </Button>
        </div>
      ) : null}

      <TabsContent value="today" className="mt-3 min-w-0">
        {tab === 'today' ? (
          isLoading ? <Skeleton className="h-64 w-full" /> : run && run.items.length > 0 ? (
            <StockRadarToday run={run} runs={runs} onOpenSymbol={openSymbol} onOpenClaude={() => setClaudeOpen(true)} />
          ) : <NoRun market={market} onRun={() => runNow.mutate(market)} running={runNow.isPending} />
        ) : null}
      </TabsContent>
      <TabsContent value="symbol" className="mt-3 min-w-0">
        {tab === 'symbol' ? (
          run ? <StockRadarSymbol run={run} runs={runs} symbol={symbol} onSymbolChange={setSymbol} /> : <NoRun market={market} onRun={() => runNow.mutate(market)} running={runNow.isPending} />
        ) : null}
      </TabsContent>
      <TabsContent value="track" className="mt-3 min-w-0">
        {tab === 'track' ? <StockRadarTrackRecord runs={runs} market={market} /> : null}
      </TabsContent>
      <TabsContent value="backtest" className="mt-3 min-w-0">
        {tab === 'backtest' ? <StockRadarBacktest market={market} /> : null}
      </TabsContent>
      <TabsContent value="guide" className="mt-3 min-w-0">
        {tab === 'guide' ? <StockRadarGuide /> : null}
      </TabsContent>
    </Tabs>
    <StockClaudeDialog open={claudeOpen} onOpenChange={setClaudeOpen} latest={latest} />
    </>
  );
}

function NoRun({ market, onRun, running }: { market: StockRadarMarket; onRun: () => void; running: boolean }) {
  return (
    <EmptyState
      icon={Radar}
      title={`還沒有${MARKET_LABELS[market]}評估結果`}
      description="每天 08:00 自動評估持股與自選股；第一次使用可以現在立即評估（新股票會先補 2 年日 K，約 1 分鐘）。"
      action={(
        <Button size="sm" disabled={running} onClick={onRun}>
          <RefreshCw className={cn('size-3.5', running && 'animate-spin')} /> {running ? '評估中…' : '立即評估'}
        </Button>
      )}
    />
  );
}
