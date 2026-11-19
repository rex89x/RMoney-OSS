import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Info,
  Layers,
  RefreshCw,
  Save,
  Settings,
  SkipForward,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn, formatCurrency, formatNumber, formatPercent } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import {
  useLatestSwingSignalRun,
  useLatestSwingPaperSyncRun,
  useRunSwingScan,
  useSwingPaperSummary,
  useStocks,
  useSwingPaperTrades,
  useSwingStrategyConfigs,
  useSyncSwingPaperTrades,
  useUpdateSwingPaperTradeStatus,
  useUpsertSwingStrategyConfig,
} from '../hooks';
import type {
  SwingPaperSummary,
  SwingPaperSyncRun,
  SwingPaperTrade,
  SwingSignalCandidate,
  SwingSignalRun,
  SwingStrategyConfig,
} from '../types';

const DEFAULT_WEIGHTS = {
  return5: 1,
  return10: 1,
  rs20: 1.2,
  breakout20: 1.4,
  volumeRatio20: 1,
  ma5DeviationPenalty: 1,
};

interface ConfigDraft {
  id?: string;
  name: string;
  universeText: string;
  topN: number;
  maxOpenPositions: number;
  maxPositionPctOfAssets: number;
  riskPerTradePct: number;
  virtualCapitalTWD: number;
  perTradeBudgetTWD: number;
  stopLossPct: number;
  atrStopMultiplier: number;
  takeProfitPct: number;
  trailingStopPct: number;
  maxHoldingDays: number;
  minAvgVolume20: number;
  maxMa5DeviationPct: number;
  minimumRewardRiskRatio: number;
  marketTrendFilterEnabled: boolean;
  notifyEnabled: boolean;
}

export function SwingTradingLab() {
  const { data: configs = [], isLoading: configsLoading } = useSwingStrategyConfigs();
  const { data: latestRun, isLoading: runLoading } = useLatestSwingSignalRun();
  const { data: latestSyncRun, isLoading: syncRunLoading } = useLatestSwingPaperSyncRun();
  const { data: trades = [], isLoading: tradesLoading } = useSwingPaperTrades(120);
  const { data: summary } = useSwingPaperSummary();
  const { data: stocks = [] } = useStocks();
  const saveConfig = useUpsertSwingStrategyConfig();
  const runScan = useRunSwingScan();
  const syncTrades = useSyncSwingPaperTrades();
  const updateTrade = useUpdateSwingPaperTradeStatus();

  const activeConfig = configs.find((c) => c.active) ?? configs[0] ?? null;
  const defaultUniverse = useMemo(
    () => stocks
      .filter((s) => s.market === 'TW' && /^\d{4}$/.test(s.symbol))
      .map((s) => s.symbol)
      .slice(0, 120)
      .join(', '),
    [stocks],
  );
  const [draft, setDraft] = useState<ConfigDraft>(() => makeDraft(null, defaultUniverse));
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    setDraft(makeDraft(activeConfig, defaultUniverse));
  }, [activeConfig, defaultUniverse]);

  const openTrades = trades.filter((t) => t.status === 'planned' || t.status === 'open');
  const closedTrades = trades.filter((t) => t.status === 'closed');
  const fallbackStats = useMemo(() => computeStats(closedTrades), [closedTrades]);
  const stats = summary ?? fallbackStats;

  if (configsLoading || runLoading || syncRunLoading || tradesLoading) {
    return <div className="space-y-3"><Skeleton className="h-36" /><Skeleton className="h-72" /><Skeleton className="h-52" /></div>;
  }

  async function handleSave() {
    const universeSymbols = draft.universeText
      .split(/[\s,，、]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s, idx, arr) => /^\d{4}$/.test(s) && arr.indexOf(s) === idx);
    await saveConfig.mutateAsync({
      id: draft.id,
      config: {
        name: draft.name.trim() || '短波段實驗',
        active: true,
        universeSymbols,
        topN: draft.topN,
        maxOpenPositions: draft.maxOpenPositions,
        maxPositionPctOfAssets: draft.maxPositionPctOfAssets,
        riskPerTradePct: draft.riskPerTradePct,
        virtualCapitalTWD: draft.virtualCapitalTWD,
        perTradeBudgetTWD: draft.perTradeBudgetTWD,
        stopLossPct: draft.stopLossPct,
        atrStopMultiplier: draft.atrStopMultiplier,
        takeProfitPct: draft.takeProfitPct,
        trailingStopPct: draft.trailingStopPct,
        maxHoldingDays: draft.maxHoldingDays,
        minAvgVolume20: draft.minAvgVolume20,
        maxMa5DeviationPct: draft.maxMa5DeviationPct,
        minimumRewardRiskRatio: draft.minimumRewardRiskRatio,
        marketTrendFilterEnabled: draft.marketTrendFilterEnabled,
        weights: activeConfig?.weights ?? DEFAULT_WEIGHTS,
        notifyEnabled: draft.notifyEnabled,
      },
    });
  }

  return (
    <div className="space-y-4">
      {/* Header with KPIs */}
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-3 pb-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4" /> 短波段實驗
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => syncTrades.mutate()} disabled={syncTrades.isPending}>
              <RefreshCw className={cn('size-4', syncTrades.isPending && 'animate-spin')} /> 同步紙上交易
            </Button>
            <Button size="sm" onClick={() => runScan.mutate()} disabled={runScan.isPending}>
              <Target className="size-4" /> 盤後掃描
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <Kpi label="虛擬淨值" value={summary ? formatCurrency(summary.equityTWD) : '-'} tone={(summary?.totalReturnPct ?? 0) >= 0 ? 'good' : 'bad'} />
          <Kpi label="勝率" value={formatPercent(stats.winRate, 1)} tone={stats.winRate >= 50 ? 'good' : 'neutral'} />
          <Kpi label="期望值" value={formatPercent(summary?.expectancyPct ?? fallbackStats.expectancy, 2)} tone={(summary?.expectancyPct ?? fallbackStats.expectancy) > 0 ? 'good' : 'bad'} />
          <Kpi label="Profit Factor" value={stats.profitFactor ? formatNumber(stats.profitFactor, 2) : '-'} tone={stats.profitFactor > 1.3 ? 'good' : 'neutral'} />
        </CardContent>
      </Card>

      {/* Active Strategy Overview */}
      <ActiveStrategyCard
        config={activeConfig}
        latestRunDate={latestRun?.runDate}
        latestSyncRun={latestSyncRun ?? null}
        summary={summary ?? null}
        onToggleSettings={() => setShowSettings((v) => !v)}
        showSettings={showSettings}
      />
      {closedTrades.length < 30 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>目前僅有 {closedTrades.length} 筆已出場樣本，尚不足以判定策略優劣；至少累積 30 筆後再比較勝率、期望值與最大回撤。</span>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <LatestSignals run={latestRun} />
          {summary ? <PerformanceSummary summary={summary} /> : null}
          <PaperTrades
            title="紙上持倉"
            trades={openTrades}
            onSkip={(trade) => updateTrade.mutate({ id: trade.id, patch: { status: 'skipped', notes: 'manual skip' } })}
            actionPending={updateTrade.isPending}
            showUnrealized
          />
          <PaperTrades title="歷史交易" trades={closedTrades.slice(0, 30)} />
        </div>
        <div className={cn('space-y-4', !showSettings && 'hidden xl:block')}>
          <StrategySettings
            draft={draft}
            setDraft={setDraft}
            onSave={handleSave}
            isSaving={saveConfig.isPending}
            activeConfig={activeConfig}
          />
        </div>
      </div>
    </div>
  );
}

function ActiveStrategyCard({
  config,
  latestRunDate,
  latestSyncRun,
  summary,
  onToggleSettings,
  showSettings,
}: {
  config: SwingStrategyConfig | null;
  latestRunDate?: string;
  latestSyncRun: SwingPaperSyncRun | null;
  summary: SwingPaperSummary | null;
  onToggleSettings: () => void;
  showSettings: boolean;
}) {
  const [showUniverse, setShowUniverse] = useState(false);

  if (!config) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-6">
          <Info className="size-5 text-muted-foreground" />
          <div>
            <div className="font-medium">尚未設定策略</div>
            <div className="text-sm text-muted-foreground">請在右側策略設定區填寫股票池與參數後儲存。</div>
          </div>
          <Button variant="outline" size="sm" className="ml-auto xl:hidden" onClick={onToggleSettings}>
            <Settings className="size-4" /> 設定
          </Button>
        </CardContent>
      </Card>
    );
  }

  const symbolCount = config.universeSymbols.length;

  return (
    <Card>
      <CardHeader className="flex flex-col items-start gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Layers className="size-4" />
          <CardTitle className="text-base">{config.name}</CardTitle>
          <Badge variant="secondary">{config.active ? '啟用中' : '停用'}</Badge>
          <Badge variant="outline">風險調整 v2</Badge>
          {config.notifyEnabled ? (
            <Bell className="size-3.5 text-muted-foreground" />
          ) : (
            <BellOff className="size-3.5 text-muted-foreground" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            更新於 {formatTW(config.updatedAt, 'MM/dd HH:mm')}
          </span>
          <Button variant="outline" size="sm" className="xl:hidden" onClick={onToggleSettings}>
            <Settings className="size-4" /> {showSettings ? '收合' : '設定'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Key parameters grid */}
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-6">
          <ParamBadge label="本金" value={formatCurrency(config.virtualCapitalTWD)} />
          <ParamBadge label="單筆" value={formatCurrency(config.perTradeBudgetTWD)} />
          <ParamBadge label="每筆風險" value={`${config.riskPerTradePct}%`} />
          <ParamBadge label="停損" value={`${config.stopLossPct}%`} />
          <ParamBadge label="停利" value={`${config.takeProfitPct}%`} />
          <ParamBadge label="移動停利" value={`${config.trailingStopPct}%`} />
          <ParamBadge label="最長持有" value={`${config.maxHoldingDays} 天`} />
          <ParamBadge label="Top N" value={`${config.topN}`} />
          <ParamBadge label="最多持倉" value={`${config.maxOpenPositions}`} />
          <ParamBadge label="ATR 倍數" value={`${config.atrStopMultiplier}`} />
          <ParamBadge label="最低風報比" value={`${config.minimumRewardRiskRatio}`} />
          <ParamBadge label="大盤濾網" value={config.marketTrendFilterEnabled ? '啟用' : '停用'} />
          <ParamBadge label="MA5乖離上限" value={`${config.maxMa5DeviationPct}%`} />
          <ParamBadge label="20日均量門檻" value={formatNumber(config.minAvgVolume20, 0)} />
          {latestRunDate ? <ParamBadge label="最近掃描" value={latestRunDate} /> : null}
          {latestSyncRun ? <ParamBadge label="最近同步" value={latestSyncRun.runDate} /> : null}
        </div>

        {/* Universe symbols */}
        <div>
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setShowUniverse((v) => !v)}
          >
            股票池
            <Badge variant="outline" className="text-xs">{symbolCount} 檔</Badge>
            {showUniverse ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
          {showUniverse ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {config.universeSymbols.map((sym) => (
                <Badge key={sym} variant="outline" className="font-mono text-xs tabular-nums">{sym}</Badge>
              ))}
              {symbolCount === 0 ? (
                <span className="text-xs text-muted-foreground">尚未設定股票池</span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Quick stats row */}
        {summary ? (
          <>
            <Separator />
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span>持有中 <span className="font-medium text-foreground">{summary.openTrades}</span></span>
              <span>已出場 <span className="font-medium text-foreground">{summary.closedTrades}</span></span>
              <span>略過 <span className="font-medium text-foreground">{summary.skippedTrades}</span></span>
              <span>
                已實現{' '}
                <span className={cn('font-medium', summary.realizedPnlTWD >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                  {formatCurrency(summary.realizedPnlTWD)}
                </span>
              </span>
              <span>
                未實現{' '}
                <span className={cn('font-medium', summary.unrealizedPnlTWD >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                  {formatCurrency(summary.unrealizedPnlTWD)}
                </span>
              </span>
            </div>
          </>
        ) : null}
        {latestSyncRun ? (
          <>
            <Separator />
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span>紙上同步 <span className="font-medium text-foreground">{latestSyncRun.status}</span></span>
              <span>掃描交易 <span className="font-medium text-foreground">{latestSyncRun.scanned}</span></span>
              <span>開倉 <span className="font-medium text-foreground">{latestSyncRun.opened}</span></span>
              <span>出場 <span className="font-medium text-foreground">{latestSyncRun.closed}</span></span>
              <span>無 K 線 <span className="font-medium text-foreground">{latestSyncRun.noCandles}</span></span>
              <span>無進場 K <span className="font-medium text-foreground">{latestSyncRun.noEntryCandle}</span></span>
              <span>時間 <span className="font-medium text-foreground">{formatTW(latestSyncRun.generatedAt, 'MM/dd HH:mm')}</span></span>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ParamBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted px-2.5 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}

function makeDraft(config: SwingStrategyConfig | null, fallbackUniverse: string): ConfigDraft {
  return {
    id: config?.id,
    name: config?.name ?? '短波段實驗',
    universeText: config?.universeSymbols.join(', ') || fallbackUniverse,
    topN: config?.topN ?? 8,
    maxOpenPositions: config?.maxOpenPositions ?? 5,
    maxPositionPctOfAssets: config?.maxPositionPctOfAssets ?? 5,
    riskPerTradePct: config?.riskPerTradePct ?? 0.75,
    virtualCapitalTWD: config?.virtualCapitalTWD ?? 100000,
    perTradeBudgetTWD: config?.perTradeBudgetTWD ?? 20000,
    stopLossPct: config?.stopLossPct ?? 4,
    atrStopMultiplier: config?.atrStopMultiplier ?? 1.5,
    takeProfitPct: config?.takeProfitPct ?? 8,
    trailingStopPct: config?.trailingStopPct ?? 4,
    maxHoldingDays: config?.maxHoldingDays ?? 5,
    minAvgVolume20: config?.minAvgVolume20 ?? 500000,
    maxMa5DeviationPct: config?.maxMa5DeviationPct ?? 8,
    minimumRewardRiskRatio: config?.minimumRewardRiskRatio ?? 1.5,
    marketTrendFilterEnabled: config?.marketTrendFilterEnabled ?? true,
    notifyEnabled: config?.notifyEnabled ?? true,
  };
}

function Kpi({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn(
        'mt-1 text-xl font-semibold tabular-nums',
        tone === 'good' && 'text-emerald-500',
        tone === 'bad' && 'text-red-500',
      )}>
        {value}
      </div>
    </div>
  );
}

function PerformanceSummary({ summary }: { summary: SwingPaperSummary }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="size-4" /> 虛擬盤成效
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        <Metric label="本金" value={formatCurrency(summary.virtualCapitalTWD)} />
        <Metric label="已實現" value={formatCurrency(summary.realizedPnlTWD)} tone={summary.realizedPnlTWD >= 0 ? 'good' : 'bad'} />
        <Metric label="未實現" value={formatCurrency(summary.unrealizedPnlTWD)} tone={summary.unrealizedPnlTWD >= 0 ? 'good' : 'bad'} />
        <Metric label="總報酬" value={formatPercent(summary.totalReturnPct, 2)} tone={summary.totalReturnPct >= 0 ? 'good' : 'bad'} />
        <Metric label="最大回撤" value={formatPercent(-summary.maxDrawdownPct, 2)} tone={summary.maxDrawdownPct <= 8 ? 'neutral' : 'bad'} />
        <Metric label="最大連虧" value={`${summary.maxConsecutiveLosses} 筆`} tone={summary.maxConsecutiveLosses <= 3 ? 'neutral' : 'bad'} />
        <Metric label="平均獲利" value={formatPercent(summary.averageWinPct, 2)} tone={summary.averageWinPct > 0 ? 'good' : 'neutral'} />
        <Metric label="平均虧損" value={formatPercent(-summary.averageLossPct, 2)} tone="bad" />
        <Metric label="持有中 / 已出場 / 略過" value={`${summary.openTrades} / ${summary.closedTrades} / ${summary.skippedTrades}`} />
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad' | 'neutral';
}) {
  return (
    <div className="rounded-md bg-muted p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn(
        'mt-1 font-medium tabular-nums',
        tone === 'good' && 'text-emerald-500',
        tone === 'bad' && 'text-red-500',
      )}>
        {value}
      </div>
    </div>
  );
}

function LatestSignals({ run }: { run?: SwingSignalRun | null }) {
  const candidates = run?.candidates ?? [];
  const benchmarkReturn20 = run?.benchmarkReturn20;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><BarChart3 className="size-4" /> 最新候選</span>
          <div className="flex items-center gap-2">
            {run?.configName ? <Badge variant="outline" className="text-xs font-normal">{run.configName}</Badge> : null}
            {run?.status && run.status !== 'ok' ? <Badge variant="warning">{signalStatusLabel(run.status)}</Badge> : null}
            {run?.runDate ? <span className="text-xs font-normal text-muted-foreground">{run.runDate}</span> : null}
          </div>
        </CardTitle>
        {typeof benchmarkReturn20 === 'number' ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              0050 近20日{' '}
              <span className={cn('font-medium', benchmarkReturn20 >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                {formatPercent(benchmarkReturn20, 2)}
              </span>
            </span>
            {typeof run?.marketTrendUp === 'boolean' ? (
              <Badge variant={run.marketTrendUp ? 'success' : 'warning'}>
                {run.marketTrendUp ? '大盤偏多' : '大盤濾網未通過'}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="px-0">
        {candidates.length === 0 ? (
          <div className="space-y-2 px-4 py-8 text-center text-sm text-muted-foreground">
            <div>{run ? '本次掃描沒有候選。' : '尚無掃描結果。先儲存策略設定後執行盤後掃描。'}</div>
            {run ? (
              <div className="text-xs">
                掃描 {run.scanned ?? 0} · 合格 {run.eligible ?? 0}
                {typeof run.insufficientData === 'number' ? ` · 資料不足 ${run.insufficientData}` : ''}
                {typeof run.filteredLowVolume === 'number' ? ` · 量能過濾 ${run.filteredLowVolume}` : ''}
                {typeof run.filteredTrend === 'number' ? ` · 趨勢過濾 ${run.filteredTrend}` : ''}
                {typeof run.filteredRewardRisk === 'number' ? ` · 風報比過濾 ${run.filteredRewardRisk}` : ''}
                {run.reason ? ` · ${signalReasonLabel(run.reason)}` : ''}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="divide-y">
            {candidates.map((c) => <CandidateRow key={c.symbol} candidate={c} />)}
          </div>
        )}
        {run?.generatedAt ? (
          <div className="px-4 pt-3 text-[11px] text-muted-foreground">
            產生時間：{formatTW(run.generatedAt, 'yyyy/MM/dd HH:mm')} · 僅供紙上交易實驗
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CandidateRow({ candidate }: { candidate: SwingSignalCandidate }) {
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[48px_minmax(0,1fr)_140px] sm:items-center">
      <div className="text-sm font-semibold text-muted-foreground">#{candidate.rank}</div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{candidate.symbol}</span>
          <span className="truncate text-sm text-muted-foreground">{candidate.name}</span>
          {candidate.breakout20 ? <Badge variant="secondary">突破</Badge> : null}
          {candidate.notes?.map((note) => (
            <Badge key={note} variant="outline" className="text-[11px]">{note}</Badge>
          ))}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>收盤 {formatNumber(candidate.close, 2)}</span>
          <span>相對0050 {formatPercent(candidate.rs20, 1)}</span>
          <span>5日 {formatPercent(candidate.return5, 1)}</span>
          <span>10日 {formatPercent(candidate.return10, 1)}</span>
          <span>量比 {formatNumber(candidate.volumeRatio20, 2)}x</span>
          <span>MA5乖離 {formatPercent(candidate.ma5DeviationPct, 1)}</span>
          <span>ATR {formatNumber(candidate.atr14, 2)}</span>
          {typeof candidate.rewardRiskRatio === 'number' ? <span>風報比 {formatNumber(candidate.rewardRiskRatio, 2)}</span> : null}
        </div>
      </div>
      <div className="text-sm tabular-nums sm:text-right">
        <div className="font-medium">綜合分數 {formatNumber(candidate.score, 2)}</div>
        <div className="text-xs text-muted-foreground">
          停損 {formatNumber(candidate.suggestedStopPrice, 2)}
        </div>
        <div className="text-xs text-muted-foreground">
          停利 {formatNumber(candidate.suggestedTakeProfitPrice, 2)}
        </div>
      </div>
    </div>
  );
}

function PaperTrades({
  title,
  trades,
  onSkip,
  actionPending,
  showUnrealized,
}: {
  title: string;
  trades: SwingPaperTrade[];
  onSkip?: (trade: SwingPaperTrade) => void;
  actionPending?: boolean;
  showUnrealized?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="size-4" /> {title}
          {trades.length > 0 ? <Badge variant="outline" className="text-xs">{trades.length}</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {trades.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">目前沒有資料。</div>
        ) : (
          <div className="divide-y">
            {trades.map((trade) => (
              <TradeRow
                key={trade.id}
                trade={trade}
                onSkip={onSkip}
                actionPending={actionPending}
                showUnrealized={showUnrealized}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TradeRow({
  trade,
  onSkip,
  actionPending,
  showUnrealized,
}: {
  trade: SwingPaperTrade;
  onSkip?: (trade: SwingPaperTrade) => void;
  actionPending?: boolean;
  showUnrealized?: boolean;
}) {
  const pnl = trade.realizedPnlTWD ?? trade.unrealizedPnlTWD ?? 0;
  const returnPct = trade.netReturnPct ?? (trade.grossReturnPct ?? null);
  const isPositive = (returnPct ?? 0) > 0;
  const isNegative = (returnPct ?? 0) < 0;

  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{trade.symbol}</span>
          <span className="truncate text-sm text-muted-foreground">{trade.name}</span>
          <Badge variant={trade.status === 'closed' ? 'secondary' : trade.status === 'open' ? 'default' : 'outline'}>
            {statusLabel(trade.status)}
          </Badge>
          {trade.exitReason ? (
            <Badge variant="outline" className="text-[11px]">{exitReasonLabel(trade.exitReason)}</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {returnPct !== null ? (
            <div className={cn(
              'flex items-center gap-1 text-sm font-semibold tabular-nums',
              isPositive && 'text-emerald-500',
              isNegative && 'text-red-500',
            )}>
              {isPositive ? <TrendingUp className="size-3.5" /> : isNegative ? <TrendingDown className="size-3.5" /> : null}
              {formatPercent(returnPct, 2)}
            </div>
          ) : null}
          {onSkip && trade.status === 'planned' ? (
            <Button size="icon-sm" variant="ghost" onClick={() => onSkip(trade)} disabled={actionPending} aria-label="略過">
              <SkipForward className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{trade.shares} 股</span>
        <span>進場 {trade.entryDate ?? trade.plannedEntryDate}{trade.status === 'planned' ? ' (預定)' : ''}</span>
        <span>進價 {trade.entryPrice ? formatNumber(trade.entryPrice, 2) : '-'}</span>
        {trade.stopPrice ? <span>停損 {formatNumber(trade.stopPrice, 2)}</span> : null}
        {trade.takeProfitPrice ? <span>停利 {formatNumber(trade.takeProfitPrice, 2)}</span> : null}
        {trade.exitDate ? <span>出場 {trade.exitDate}</span> : null}
        {trade.exitPrice ? <span>出價 {formatNumber(trade.exitPrice, 2)}</span> : null}
        {trade.holdingDays > 0 ? <span>{trade.holdingDays} 天</span> : null}
        {pnl !== 0 ? (
          <span className={cn('font-medium', pnl > 0 ? 'text-emerald-500' : 'text-red-500')}>
            {showUnrealized && trade.status !== 'closed' ? '未實現 ' : ''}
            {formatCurrency(pnl)}
          </span>
        ) : null}
        {trade.maxFavorablePct !== null ? <span>MFE {formatPercent(trade.maxFavorablePct, 1)}</span> : null}
        {trade.maxAdversePct !== null ? <span>MAE {formatPercent(trade.maxAdversePct, 1)}</span> : null}
      </div>
    </div>
  );
}

function StrategySettings({
  draft,
  setDraft,
  onSave,
  isSaving,
  activeConfig,
}: {
  draft: ConfigDraft;
  setDraft: (draft: ConfigDraft) => void;
  onSave: () => void;
  isSaving: boolean;
  activeConfig: SwingStrategyConfig | null;
}) {
  function setNumber(key: keyof ConfigDraft, value: string) {
    setDraft({ ...draft, [key]: Number(value) });
  }

  const parsedSymbols = draft.universeText
    .split(/[\s,，、]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s, idx, arr) => /^\d{4}$/.test(s) && arr.indexOf(s) === idx);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Settings className="size-4" /> 策略設定</CardTitle>
        {activeConfig ? (
          <div className="text-xs text-muted-foreground">
            ID: {activeConfig.id}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">名稱</span>
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">股票池</span>
            <span className="text-xs text-muted-foreground">{parsedSymbols.length} 檔</span>
          </div>
          <Textarea
            value={draft.universeText}
            onChange={(e) => setDraft({ ...draft, universeText: e.target.value })}
            className="min-h-[96px] font-mono text-xs"
            placeholder="輸入 4 碼台股代號，以逗號或空格分隔"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Top N" value={draft.topN} onChange={(v) => setNumber('topN', v)} />
          <NumberField label="最多持有" value={draft.maxOpenPositions} onChange={(v) => setNumber('maxOpenPositions', v)} />
          <NumberField label="虛擬本金" value={draft.virtualCapitalTWD} onChange={(v) => setNumber('virtualCapitalTWD', v)} />
          <NumberField label="單筆預算" value={draft.perTradeBudgetTWD} onChange={(v) => setNumber('perTradeBudgetTWD', v)} />
          <NumberField label="每筆風險 %" value={draft.riskPerTradePct} step="0.05" onChange={(v) => setNumber('riskPerTradePct', v)} />
          <NumberField label="停損 %" value={draft.stopLossPct} onChange={(v) => setNumber('stopLossPct', v)} />
          <NumberField label="停利 %" value={draft.takeProfitPct} onChange={(v) => setNumber('takeProfitPct', v)} />
          <NumberField label="ATR 倍數" value={draft.atrStopMultiplier} step="0.1" onChange={(v) => setNumber('atrStopMultiplier', v)} />
          <NumberField label="移動停利 %" value={draft.trailingStopPct} onChange={(v) => setNumber('trailingStopPct', v)} />
          <NumberField label="持有天數" value={draft.maxHoldingDays} onChange={(v) => setNumber('maxHoldingDays', v)} />
          <NumberField label="MA5乖離上限" value={draft.maxMa5DeviationPct} onChange={(v) => setNumber('maxMa5DeviationPct', v)} />
          <NumberField label="最低風報比" value={draft.minimumRewardRiskRatio} step="0.1" onChange={(v) => setNumber('minimumRewardRiskRatio', v)} />
        </div>
        <NumberField label="20日均量門檻" value={draft.minAvgVolume20} onChange={(v) => setNumber('minAvgVolume20', v)} />
        <div className="flex items-center justify-between rounded-md bg-muted p-3">
          <div>
            <div className="text-sm">0050 大盤趨勢濾網</div>
            <div className="text-xs text-muted-foreground">0050 未站上20日均線或近20日為負時不建立新部位</div>
          </div>
          <Switch
            checked={draft.marketTrendFilterEnabled}
            onCheckedChange={(checked) => setDraft({ ...draft, marketTrendFilterEnabled: checked })}
          />
        </div>
        <div className="flex items-center justify-between rounded-md bg-muted p-3">
          <span className="text-sm">Telegram 通知</span>
          <Switch
            checked={draft.notifyEnabled}
            onCheckedChange={(checked) => setDraft({ ...draft, notifyEnabled: checked })}
          />
        </div>
        <Button className="w-full" onClick={onSave} disabled={isSaving}>
          {isSaving ? <RefreshCw className="size-4 animate-spin" /> : <Save className="size-4" />} 儲存設定
        </Button>
        <div className="flex items-start gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
          <Check className="mt-0.5 size-4 shrink-0" />
          <span>此模組只做盤後候選與紙上交易紀錄，不會寫入正式持倉，也不會自動下單。</span>
        </div>
      </CardContent>
    </Card>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step = '1',
}: {
  label: string;
  value: number;
  onChange: (value: string) => void;
  step?: string;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input type="number" value={value} step={step} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function computeStats(trades: SwingPaperTrade[]) {
  const returns = trades
    .map((t) => t.netReturnPct)
    .filter((v): v is number => typeof v === 'number');
  const wins = returns.filter((v) => v > 0);
  const losses = returns.filter((v) => v < 0);
  const winRate = returns.length ? (wins.length / returns.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((s, v) => s + v, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 0;
  const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;
  const grossProfit = wins.reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
  return {
    winRate,
    expectancy,
    profitFactor: grossLoss ? grossProfit / grossLoss : 0,
  };
}

function statusLabel(status: SwingPaperTrade['status']) {
  if (status === 'planned') return '待進場';
  if (status === 'open') return '持有中';
  if (status === 'closed') return '已出場';
  return '略過';
}

function exitReasonLabel(reason: SwingPaperTrade['exitReason']) {
  if (reason === 'stop_loss') return '停損';
  if (reason === 'take_profit') return '停利';
  if (reason === 'trailing_stop') return '移動停利';
  if (reason === 'time_exit') return '時間出場';
  if (reason === 'manual_skip') return '手動略過';
  return '-';
}

function signalStatusLabel(status: NonNullable<SwingSignalRun['status']>) {
  if (status === 'no_candidates') return '無候選';
  if (status === 'no_config') return '尚未設定';
  if (status === 'lock_busy') return '掃描忙碌';
  return '完成';
}

function signalReasonLabel(reason: string) {
  if (reason === 'market-trend-filter-blocked') return '大盤趨勢濾網未通過';
  if (reason === 'no-symbol-passed-filters-or-data-requirements') return '沒有標的通過全部條件';
  if (reason === 'no-active-swing-strategy-config') return '沒有啟用中的策略';
  if (reason === 'could-not-acquire-script-lock') return '掃描程序忙碌';
  return reason;
}
