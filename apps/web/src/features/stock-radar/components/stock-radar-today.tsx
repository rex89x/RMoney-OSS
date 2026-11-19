import { useMemo } from 'react';
import { Activity, ArrowRight, Bot, CalendarClock, Gauge, ListChecks, Newspaper, ScatterChart as ScatterIcon } from 'lucide-react';
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS } from '@/lib/chart-theme';
import { formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import { buildOverview, changedActions, groupByAction } from '../dashboard';
import { ACTION_META, REGIME_META, formatPrice, formatScore, reasonLabel } from '../options';
import type { StockRadarItem, StockRadarRun } from '../types';
import { ActionBadge, ScoreBar, TONE_TEXT } from './score-display';

interface StockRadarTodayProps {
  run: StockRadarRun;
  runs: StockRadarRun[];
  onOpenSymbol: (symbol: string) => void;
  onOpenClaude: () => void;
}

/** 「今日」分頁：大盤 regime、KPI、行動清單、持股健康度 */
export function StockRadarToday({ run, runs, onOpenSymbol, onOpenClaude }: StockRadarTodayProps) {
  const overview = useMemo(() => buildOverview(run.items), [run.items]);
  const groups = useMemo(() => groupByAction(run.items), [run.items]);
  const changes = useMemo(() => changedActions(runs, run.market), [runs, run.market]);
  const regime = REGIME_META[run.effectiveRegime];
  const downgraded = run.effectiveRegime !== run.regime;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
          <div className="flex items-center gap-2">
            <Gauge className="size-5 text-muted-foreground" aria-hidden />
            <span className="text-sm text-muted-foreground">大盤 {run.benchmark.symbol}</span>
            <span className={cn('text-lg font-semibold', TONE_TEXT[regime.tone])}>{regime.label}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            收盤 {formatPrice(run.benchmark.close, run.market === 'TW' ? 'TWD' : 'USD')}
            {' · '}200 日均線 {formatPrice(run.benchmark.ma200, run.market === 'TW' ? 'TWD' : 'USD')}
            {' · '}12-1 動能 {run.benchmark.mom12_1 === null ? '—' : `${(run.benchmark.mom12_1 * 100).toFixed(1)}%`}
          </div>
          <p className="w-full text-xs text-muted-foreground">
            {regime.description}
            {downgraded ? `（價格訊號為${REGIME_META[run.regime].label}，因市場輿情明顯偏空下修一級）` : ''}
          </p>
        </CardContent>
      </Card>

      <SentimentStatus run={run} onOpenClaude={onOpenClaude} />

      <StatGrid>
        <StatTile label="持股檔數" value={overview.held} hint={`追蹤 ${run.items.length} 檔`} />
        <StatTile
          label="需要處理"
          value={overview.needsAction}
          tone={overview.needsAction > 0 ? 'warn' : 'plain'}
          hint="建議減碼或出場的持股"
        />
        <StatTile
          label="加碼／買進候選"
          value={`${overview.addCandidates}／${overview.buyCandidates}`}
          tone={overview.addCandidates + overview.buyCandidates > 0 ? 'good' : 'plain'}
        />
        <StatTile
          label="持股加權分數"
          value={formatScore(overview.weightedScore)}
          tone={overview.weightedScore === null ? 'plain' : overview.weightedScore >= 0 ? 'good' : 'bad'}
          hint={overview.weakWeightPct > 0 ? `${overview.weakWeightPct.toFixed(0)}% 部位分數為負` : '依市值加權'}
        />
      </StatGrid>

      {changes.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4" /> 與上次評估相比</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {changes.map((change) => (
              <button
                key={change.symbol}
                type="button"
                onClick={() => onOpenSymbol(change.symbol)}
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs hover:bg-muted"
              >
                <span className="font-medium">{change.symbol}</span>
                <span className="text-muted-foreground">{ACTION_META[change.from].label}</span>
                <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
                <span className={TONE_TEXT[ACTION_META[change.to].tone]}>{ACTION_META[change.to].label}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><ListChecks className="size-4" /> 今日行動清單</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {groups.map((group) => (
            <section key={group.action} className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ActionBadge action={group.action} />
                <span>{group.items.length} 檔</span>
              </div>
              <ul className="divide-y">
                {group.items.map((item) => (
                  <ActionRow key={item.symbol} item={item} onOpen={() => onOpenSymbol(item.symbol)} />
                ))}
              </ul>
            </section>
          ))}
        </CardContent>
      </Card>

      <HoldingHealthChart items={run.items} onOpenSymbol={onOpenSymbol} />
    </div>
  );
}

function ActionRow({ item, onOpen }: { item: StockRadarItem; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2 text-left hover:bg-muted/40"
      >
        <span className="min-w-0 flex-1">
          <span className="font-medium">{item.symbol}</span>
          <span className="ml-1.5 truncate text-xs text-muted-foreground">{item.name !== item.symbol ? item.name : ''}</span>
          {item.eventRisk ? <CalendarClock className="ml-1.5 inline size-3.5 text-warning" aria-label="近期重大事件" /> : null}
        </span>
        {item.sentiment ? (
          <span className={cn('text-[11px] tabular-nums', item.sentimentAdj > 0 ? 'text-success' : item.sentimentAdj < 0 ? 'text-destructive' : 'text-muted-foreground')}>
            輿情 {formatScore(item.sentimentAdj)}
          </span>
        ) : null}
        <ScoreBar score={item.composite} />
        <span className="w-full text-xs text-muted-foreground sm:w-auto sm:min-w-48 sm:text-right">
          {item.held ? (
            <>
              占比 {item.weightPct === null ? '—' : `${item.weightPct.toFixed(1)}%`}
              {' · '}
              <span className={cn(item.unrealizedPct !== null && (item.unrealizedPct >= 0 ? 'text-success' : 'text-destructive'))}>
                未實現 {item.unrealizedPct === null ? '—' : `${item.unrealizedPct >= 0 ? '+' : ''}${item.unrealizedPct.toFixed(1)}%`}
              </span>
            </>
          ) : '自選股'}
          {item.metrics?.chandelierStop ? ` · 停損 ${formatPrice(item.metrics.chandelierStop, item.currency)}` : ''}
        </span>
        {item.reasons.length > 0 ? (
          <span className="w-full text-[11px] text-muted-foreground">
            {item.reasons.map(reasonLabel).join('、')}
          </span>
        ) : null}
        {item.sentiment?.summary ? (
          <span className="line-clamp-2 w-full text-[11px] text-muted-foreground">{item.sentiment.summary}</span>
        ) : null}
      </button>
    </li>
  );
}

/** Claude 輿情是否已推送 + 市場整體輿情 */
function SentimentStatus({ run, onOpenClaude }: { run: StockRadarRun; onOpenClaude: () => void }) {
  const view = run.marketView;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Newspaper className="size-4" /> 盤前輿情</CardTitle>
        <span className="text-xs text-muted-foreground">
          {run.sentimentCount > 0
            ? `Claude 已分析 ${run.sentimentCount} 檔${run.sentimentAt ? `（${formatTW(run.sentimentAt, 'MM/dd HH:mm')}）` : ''}`
            : '今天還沒收到 Claude 推送，目前只有量化結果'}
        </span>
        <Button size="sm" variant="outline" className="ml-auto h-7" onClick={onOpenClaude}>
          <Bot className="size-3.5" /> Claude 排程
        </Button>
      </CardHeader>
      {view ? (
        <CardContent className="space-y-1.5 text-sm">
          <p>
            <span className={cn('mr-2 font-semibold tabular-nums', view.sentiment > 0 ? 'text-success' : view.sentiment < 0 ? 'text-destructive' : '')}>
              {formatScore(view.sentiment)}
            </span>
            <span className="text-xs text-muted-foreground">信心 {(view.confidence * 100).toFixed(0)}%</span>
          </p>
          {view.summary ? <p className="text-muted-foreground">{view.summary}</p> : null}
          {view.events.length ? <p className="text-xs text-muted-foreground">事件：{view.events.join('、')}</p> : null}
          {view.sources.length ? (
            <p className="flex flex-wrap gap-x-3 text-xs">
              {view.sources.map((source) => (
                <a key={source.url} href={source.url} target="_blank" rel="noreferrer noopener" className="text-primary underline-offset-2 hover:underline">
                  {source.title}
                </a>
              ))}
            </p>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

/** 持股健康度：X = 綜合分數、Y = 占股票部位比例。右上＝重倉且強勢，左上＝重倉但轉弱（優先處理） */
function HoldingHealthChart({ items, onOpenSymbol }: { items: StockRadarItem[]; onOpenSymbol: (symbol: string) => void }) {
  const points = useMemo(() => items
    .filter((item) => item.held && item.composite !== null && item.weightPct !== null)
    .map((item) => ({
      symbol: item.symbol,
      score: item.composite ?? 0,
      weight: item.weightPct ?? 0,
      value: item.marketValueTWD ?? 0,
    })), [items]);
  if (points.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><ScatterIcon className="size-4" /> 持股健康度</CardTitle>
        <p className="text-xs text-muted-foreground">越靠左上（重倉但分數轉弱）越需要優先檢視；點選圓點看個股分析。</p>
      </CardHeader>
      <CardContent className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" />
            <XAxis type="number" dataKey="score" domain={[-1, 1]} name="綜合分數" {...AXIS_PROPS} tickFormatter={(v: number) => v.toFixed(1)} />
            <YAxis type="number" dataKey="weight" name="占比" unit="%" width={40} {...AXIS_PROPS} />
            <ZAxis type="number" dataKey="value" range={[60, 400]} />
            <ReferenceLine x={0} stroke={CHART_COLORS.axis} />
            <Tooltip
              {...CHART_TOOLTIP_PROPS}
              formatter={(value: number, name: string) => [name === '占比' ? `${value.toFixed(1)}%` : formatScore(value), name]}
              labelFormatter={() => ''}
            />
            <Scatter
              data={points}
              fill={CHART_COLORS.primary}
              onClick={(point: { symbol?: string }) => { if (point.symbol) onOpenSymbol(point.symbol); }}
              className="cursor-pointer"
            />
          </ScatterChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
