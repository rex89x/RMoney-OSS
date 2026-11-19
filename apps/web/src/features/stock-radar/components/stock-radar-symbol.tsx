import { useMemo } from 'react';
import { BarChart3, ExternalLink, LineChart as LineChartIcon, Newspaper, ShieldAlert } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS } from '@/lib/chart-theme';
import { symbolHistory } from '../dashboard';
import {
  EVENT_TYPE_LABELS,
  FACTOR_META,
  SENTIMENT_RULES,
  SURPRISE_LABELS,
  formatFactorRaw,
  formatPrice,
  formatScore,
  reasonLabel,
} from '../options';
import {
  STOCK_RADAR_FACTOR_KEYS,
  TW_ONLY_FACTOR_KEYS,
  type StockRadarItem,
  type StockRadarMarket,
  type StockRadarRun,
} from '../types';
import { ActionBadge, ScoreBar } from './score-display';

interface StockRadarSymbolProps {
  run: StockRadarRun;
  runs: StockRadarRun[];
  symbol: string | null;
  onSymbolChange: (symbol: string) => void;
}

/** 「個股」分頁：因子拆解、分數走勢、風控數字 */
export function StockRadarSymbol({ run, runs, symbol, onSymbolChange }: StockRadarSymbolProps) {
  const selected = run.items.find((item) => item.symbol === symbol) ?? run.items[0] ?? null;
  const history = useMemo(
    () => (selected ? symbolHistory(runs, run.market, selected.symbol) : []),
    [runs, run.market, selected],
  );

  if (!selected) {
    return <EmptyState icon={BarChart3} title="沒有評估標的" description="把股票加入持股或自選股後，下次評估就會出現。" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={selected.symbol} onValueChange={onSymbolChange}>
          <SelectTrigger className="h-9 w-56" aria-label="選擇標的"><SelectValue /></SelectTrigger>
          <SelectContent>
            {run.items.map((item) => (
              <SelectItem key={item.symbol} value={item.symbol}>
                {item.symbol} {item.name !== item.symbol ? item.name : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ActionBadge action={selected.action} />
        <ScoreBar score={selected.composite} />
        <span className="text-xs text-muted-foreground">
          量化 {formatScore(selected.quantScore)}
          {selected.sentimentAdj ? ` ${selected.sentimentAdj > 0 ? '+' : '−'} 輿情 ${Math.abs(selected.sentimentAdj).toFixed(2)}` : ''}
          {' · '}因子覆蓋 {(selected.coverage * 100).toFixed(0)}% · 收盤 {formatPrice(selected.close, selected.currency)}（{selected.priceDate ?? '—'}）
        </span>
      </div>
      {selected.reasons.length > 0 ? (
        <p className="text-xs text-muted-foreground">判定依據：{selected.reasons.map(reasonLabel).join('、')}</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <FactorChart item={selected} market={run.market} />
        <RiskCard item={selected} />
      </div>
      <SentimentCard item={selected} />
      <HistoryChart history={history} currency={selected.currency} />
    </div>
  );
}

function FactorChart({ item, market }: { item: StockRadarItem; market: StockRadarMarket }) {
  const keys = STOCK_RADAR_FACTOR_KEYS.filter((key) => market === 'TW' || !TW_ONLY_FACTOR_KEYS.includes(key));
  const rows = keys.map((key) => ({
    key,
    label: FACTOR_META[key].label,
    score: item.factors[key]?.score ?? null,
    raw: item.factors[key]?.raw ?? null,
  }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="size-4" /> 因子拆解</CardTitle>
        <p className="text-xs text-muted-foreground">
          每個因子轉成 -1 ~ +1，量化分數為加權平均（動能、52 週高點、趨勢權重 1；反轉、低波動、法人籌碼 0.5；融資 0.25）。灰色為缺資料、不計入。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={market === 'TW' ? 'h-64' : 'h-52'}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows.map((row) => ({ ...row, score: row.score ?? 0 }))} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" domain={[-1, 1]} {...AXIS_PROPS} tickFormatter={(v: number) => v.toFixed(1)} />
              <YAxis type="category" dataKey="label" width={88} {...AXIS_PROPS} />
              <ReferenceLine x={0} stroke={CHART_COLORS.axis} />
              <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number) => [formatScore(value), '分數']} />
              <Bar dataKey="score" radius={3}>
                {rows.map((row) => (
                  <Cell
                    key={row.key}
                    fill={row.score === null ? CHART_COLORS.muted : row.score >= 0 ? 'hsl(var(--success))' : 'hsl(var(--destructive))'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <ul className="space-y-1.5 text-xs">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span>
                <span className="font-medium">{row.label}</span>
                <span className="ml-1.5 text-muted-foreground">{FACTOR_META[row.key].description}</span>
              </span>
              <span className="tabular-nums text-muted-foreground">
                {formatFactorRaw(row.key, row.raw)} → {formatScore(row.score)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RiskCard({ item }: { item: StockRadarItem }) {
  const m = item.metrics;
  const stopDistance = m?.chandelierStop && item.close ? (item.close / m.chandelierStop - 1) * 100 : null;
  const rows: Array<[string, string]> = [
    ['吊燈停損（22 日高 − 3×ATR）', m?.chandelierStop ? `${formatPrice(m.chandelierStop, item.currency)}（距離 ${stopDistance === null ? '—' : `${stopDistance.toFixed(1)}%`}）` : '—'],
    ['ATR14', m?.atr14 ? formatPrice(m.atr14, item.currency) : '—'],
    ['60 日年化波動', m?.vol60 === null || m?.vol60 === undefined ? '—' : `${(m.vol60 * 100).toFixed(1)}%`],
    ['200 日均線', m?.ma200 ? formatPrice(m.ma200, item.currency) : '—'],
    ['52 週最高', m?.high52 ? formatPrice(m.high52, item.currency) : '—'],
    ['歷史 K 線', m ? `${m.historyDays} 根` : '—'],
  ];
  if (item.held) {
    rows.unshift(
      ['持有股數', item.shares.toLocaleString()],
      ['平均成本', formatPrice(item.avgCost, item.currency)],
      ['未實現損益', item.unrealizedPct === null ? '—' : `${item.unrealizedPct >= 0 ? '+' : ''}${item.unrealizedPct.toFixed(1)}%`],
      ['占股票部位', item.weightPct === null ? '—' : `${item.weightPct.toFixed(1)}%`],
    );
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="size-4" /> 持股與風控</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 py-1.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function SentimentCard({ item }: { item: StockRadarItem }) {
  const sentiment = item.sentiment;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Newspaper className="size-4" /> 盤前輿情（Claude）</CardTitle>
        <p className="text-xs text-muted-foreground">
          加減分 = 輿情 × 信心 × {SENTIMENT_RULES.weight}，財報優於／低於預期 ±{SENTIMENT_RULES.pead}，上限 ±{SENTIMENT_RULES.maxAdj}；沒有來源不計分。
        </p>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!sentiment ? (
          <p className="text-muted-foreground">今天沒有這檔的輿情推送。</p>
        ) : (
          <>
            <p>
              輿情 <span className={sentiment.score > 0 ? 'text-success' : sentiment.score < 0 ? 'text-destructive' : ''}>{formatScore(sentiment.score)}</span>
              <span className="ml-2 text-xs text-muted-foreground">信心 {(sentiment.confidence * 100).toFixed(0)}% · 對分數 {formatScore(item.sentimentAdj)}</span>
              {sentiment.earningsSurprise ? <span className="ml-2 text-xs text-muted-foreground">{SURPRISE_LABELS[sentiment.earningsSurprise]}</span> : null}
            </p>
            {sentiment.summary ? <p className="text-muted-foreground">{sentiment.summary}</p> : null}
            {sentiment.catalysts.length ? <p className="text-xs">題材：{sentiment.catalysts.join('、')}</p> : null}
            {sentiment.riskEvents.length ? (
              <ul className="space-y-0.5 text-xs">
                {sentiment.riskEvents.map((event, index) => (
                  <li key={`${event.type}-${index}`} className={item.eventRisk ? 'text-warning' : 'text-muted-foreground'}>
                    {EVENT_TYPE_LABELS[event.type]}{event.date ? ` ${event.date}` : ''}{event.note ? `：${event.note}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {sentiment.sources.length ? (
              <ul className="space-y-0.5 text-xs">
                {sentiment.sources.map((source) => (
                  <li key={source.url}>
                    <a href={source.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                      <ExternalLink className="size-3" /> {source.title}
                    </a>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-warning">沒有可查證的來源，未計入分數。</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryChart({ history, currency }: { history: ReturnType<typeof symbolHistory>; currency: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><LineChartIcon className="size-4" /> 分數與股價走勢</CardTitle>
        <p className="text-xs text-muted-foreground">每天盤前評估一點；累積幾天後就能看出分數轉折是否領先股價。</p>
      </CardHeader>
      <CardContent className="h-64">
        {history.length < 2 ? (
          <p className="text-sm text-muted-foreground">評估滿 2 天後顯示走勢。</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" />
              <XAxis dataKey="date" {...AXIS_PROPS} tickFormatter={(v: string) => v.slice(5)} minTickGap={24} />
              <YAxis yAxisId="score" domain={[-1, 1]} width={32} {...AXIS_PROPS} tickFormatter={(v: number) => v.toFixed(1)} />
              <YAxis yAxisId="price" orientation="right" domain={['auto', 'auto']} width={48} {...AXIS_PROPS} />
              <ReferenceLine yAxisId="score" y={0} stroke={CHART_COLORS.axis} />
              <Tooltip
                {...CHART_TOOLTIP_PROPS}
                formatter={(value: number, name: string) => [name === '綜合分數' ? formatScore(value) : formatPrice(value, currency), name]}
              />
              <Line yAxisId="score" dataKey="composite" name="綜合分數" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} connectNulls />
              <Line yAxisId="price" dataKey="close" name="收盤價" stroke={CHART_COLORS.muted} strokeWidth={1.5} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
