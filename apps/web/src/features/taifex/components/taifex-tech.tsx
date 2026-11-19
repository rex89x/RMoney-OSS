import { useMemo, useState } from 'react';
import { CalendarOff, CircleHelp, Clock, Gauge, History, LineChart as LineChartIcon, Moon, RefreshCw, RotateCcw, Sun, Timer, Trophy } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, formatAxisTWD, paletteColor } from '@/lib/chart-theme';
import { formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import { taifexSessionNow, useResetTaifexTech, useRunTaifexTech, useTaifexTech, useTaifexTechTrades } from '../hooks';
import { TAIFEX_PRODUCT_SPECS, formatPoints, formatScore, formatTWD, pnlClass } from '../options';
import {
  SESSION_LABELS,
  TAIFEX_TECH_BOT_IDS,
  TAIFEX_TECH_FACTOR_KEYS,
  TAIFEX_TECH_RULES,
  TECH_ACTION_LABELS,
  TECH_EXIT_LABELS,
  TECH_FACTOR_LABELS,
  TECH_MIN_TRADES,
  rankTechBots,
  techBucketRows,
  techCurve,
  techVerdict,
  type TaifexSessionKind,
  type TaifexTechBot,
  type TaifexTechBotId,
  type TaifexTechStatView,
  type TaifexTechStatus,
} from '../tech';
import type { TaifexConfig } from '../types';
import { FactorBar, TargetBadge } from './taifex-parts';

interface TaifexTechProps {
  config: TaifexConfig;
}

type SessionFilter = TaifexSessionKind | 'all';

const FILTERS: Array<{ value: SessionFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'day', label: '日盤' },
  { value: 'night', label: '夜盤' },
];

const TRADES_SHOWN = 30;

function freqLabel(interval: number): string {
  return `每 ${interval} 分`;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(0)}%`;
}

/**
 * 盤中技術模擬：日盤 / 夜盤每 5 分鐘取樣，4 個監控頻率的虛擬機器人用同一套技術指標進出場。
 * 這一頁回答三個問題：多久看一次盤比較好、日盤還是夜盤、開盤後多久進場。休市時不模擬。
 */
export function TaifexTech({ config }: TaifexTechProps) {
  const confirm = useConfirm();
  const tech = useTaifexTech(true);
  const trades = useTaifexTechTrades(true);
  const run = useRunTaifexTech();
  const reset = useResetTaifexTech();
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [selected, setSelected] = useState<TaifexTechBotId>('m5');

  const doc = tech.data ?? null;
  const rows = useMemo(() => rankTechBots(doc?.bots ?? []), [doc]);
  const verdict = useMemo(() => techVerdict(rows), [rows]);
  const curve = useMemo(() => techCurve(doc?.sessions ?? [], filter), [doc, filter]);
  const buckets = useMemo(() => techBucketRows(doc?.bots ?? []).filter((b) => filter === 'all' || b.session === filter), [doc, filter]);
  const tradeList = useMemo(
    () => (trades.data ?? []).filter((t) => (!doc || t.epoch === doc.epoch) && (filter === 'all' || t.session === filter)).slice(0, TRADES_SHOWN),
    [trades.data, doc, filter],
  );

  if (tech.isLoading) return <Skeleton className="h-64 w-full" />;

  const hasBots = Boolean(doc && doc.bots.some((b) => b.checks > 0));
  const bot = doc?.bots.find((b) => b.id === selected) ?? null;

  async function handleReset() {
    const ok = await confirm({
      title: '重置盤中技術模擬？',
      description: '四個監控頻率的部位、交易紀錄與累計統計都會清空，從下一個交易時段重新累積。5 分 K 會保留，指標不必重新暖機。',
      confirmText: '重置',
    });
    if (ok) reset.mutate();
  }

  return (
    <div className="space-y-4">
      <StatusCard status={doc?.status ?? null} config={config} running={run.isPending} onRun={() => run.mutate()} />

      {!hasBots ? (
        <EmptyState
          icon={Timer}
          title="還沒有模擬紀錄"
          description="日盤（08:45–13:45）與夜盤（15:00–隔日 05:00）每 5 分鐘自動取樣一次。5 分頻率約 3 小時後開始決策，60 分頻率要累積約 2 個交易日。休市日不會模擬。"
        />
      ) : (
        <>
          <div className={cn('rounded-xl border p-4', verdict.level === 'ok' ? 'border-primary/30 bg-primary/5' : 'border-muted-foreground/30 bg-muted/40')}>
            <div className="flex items-start gap-2 font-medium">
              {verdict.level === 'ok' ? <Trophy className="mt-0.5 size-5 shrink-0" aria-hidden /> : <CircleHelp className="mt-0.5 size-5 shrink-0" aria-hidden />}
              <span className="min-w-0">{verdict.headline}</span>
            </div>
            {verdict.notes.length ? (
              <ul className="mt-2 space-y-1 text-xs text-foreground/80">
                {verdict.notes.map((n) => <li key={n} className="flex gap-1.5"><span aria-hidden>·</span>{n}</li>)}
              </ul>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border p-0.5" role="radiogroup" aria-label="時段篩選">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  role="radio"
                  aria-checked={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className={cn('rounded-md px-3 py-1 text-xs', filter === f.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              {doc ? `${TAIFEX_PRODUCT_SPECS[doc.product].label} ${doc.contracts} 口 · 第 ${doc.epoch} 輪${doc.startDate ? ` · 自 ${doc.startDate}` : ''} · ${doc.modelVersion}` : ''}
            </span>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base"><Gauge className="size-4" aria-hidden /> 監控頻率比較</CardTitle>
              <p className="text-xs text-muted-foreground">
                四個機器人用同一套指標，只差在多久看一次盤。停損等同掛在交易所，每 5 分鐘都會檢查；進出場決策只在各自的監控時間做。少於 {TECH_MIN_TRADES} 筆交易的排名僅供參考。
              </p>
            </CardHeader>
            <CardContent>
              <ol className="divide-y text-sm">
                {rows.map((row, i) => {
                  const view = filter === 'all' ? row.all : row[filter];
                  return (
                    <li key={row.bot.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(row.bot.id)}
                        aria-pressed={selected === row.bot.id}
                        className={cn('flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 py-2 text-left hover:bg-muted/50', selected === row.bot.id && 'bg-muted/60')}
                      >
                        <span className="w-5 text-center font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
                        <span className="min-w-0 flex-1 font-medium">
                          {freqLabel(row.bot.interval)}
                          {!row.enoughSample ? <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[10px]">樣本不足</Badge> : null}
                          {row.bot.position ? <TargetBadge target={row.bot.position.side} kind="position" contracts={row.bot.position.contracts} className="ml-2 py-0" /> : null}
                        </span>
                        <span className={cn('tabular-nums font-semibold', pnlClass(view.net))}>{formatTWD(view.net, true)}</span>
                        <span className="w-full pl-8 text-xs text-muted-foreground sm:w-auto sm:pl-0">
                          {view.n} 筆 · 勝率 {pct(view.winRatePct)} · 獲利因子 {view.profitFactor === null ? '—' : view.profitFactor.toFixed(2)}
                          {filter === 'all' ? ` · 回撤 ${formatTWD(row.bot.maxDrawdown)} · 查看 ${row.bot.checks} 次（每次 ${formatTWD(row.netPerCheck, true)}）` : ` · 每筆 ${formatTWD(view.avgNet, true)}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base"><LineChartIcon className="size-4" aria-hidden /> 累計淨損益（每個時段一點）</CardTitle>
            </CardHeader>
            <CardContent>
              {curve.length >= 2 ? (
                <div className="h-56 w-full sm:h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={curve} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={32} />
                      <YAxis {...AXIS_PROPS} width={44} tickFormatter={formatAxisTWD} />
                      <ReferenceLine y={0} stroke={CHART_COLORS.axis} strokeDasharray="2 2" />
                      <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number, name: string) => [`${formatTWD(value, true)} 元`, name]} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {TAIFEX_TECH_BOT_IDS.map((id, i) => (
                        <Line key={id} dataKey={id} name={freqLabel(Number(id.slice(1)))} stroke={paletteColor(i)} strokeWidth={id === selected ? 2.5 : 1.5} dot={false} isAnimationActive={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">累積兩個以上的交易時段後會出現曲線。</p>
              )}
            </CardContent>
          </Card>

          <SessionCompare bots={doc?.bots ?? []} />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base"><Clock className="size-4" aria-hidden /> 開盤後多久進場比較好</CardTitle>
              <p className="text-xs text-muted-foreground">依「進場時間」分段統計每筆平均淨損益（四個頻率合計與各自的數字）。某一段長期為負，代表那段時間的訊號不值得跟。</p>
            </CardHeader>
            <CardContent>
              <div className="-mx-1 overflow-x-auto px-1">
                <table className="w-full min-w-[520px] whitespace-nowrap text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left font-normal">進場時間</th>
                      <th className="text-right font-normal">筆數</th>
                      <th className="text-right font-normal">勝率</th>
                      <th className="text-right font-normal">每筆平均</th>
                      {TAIFEX_TECH_BOT_IDS.map((id) => <th key={id} className="text-right font-normal">{id.slice(1)} 分</th>)}
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {buckets.map((b) => (
                      <tr key={b.id} className="border-t">
                        <td className="py-1.5">{b.label}</td>
                        <td className="text-right">{b.total.n}</td>
                        <td className="text-right">{pct(b.total.winRatePct)}</td>
                        <td className={cn('text-right font-medium', pnlClass(b.total.avgNet))}>{formatTWD(b.total.avgNet, true)}</td>
                        {TAIFEX_TECH_BOT_IDS.map((id) => (
                          <td key={id} className={cn('text-right', pnlClass(b.byBot[id].avgNet))}>
                            {b.byBot[id].n ? formatTWD(b.byBot[id].avgNet, true) : '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {bot ? <BotDetail bot={bot} /> : null}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base"><History className="size-4" aria-hidden /> 最近模擬交易</CardTitle>
            </CardHeader>
            <CardContent>
              {trades.isLoading ? <Skeleton className="h-24 w-full" /> : tradeList.length ? (
                <ul className="divide-y text-xs">
                  {tradeList.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 py-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{t.interval} 分</Badge>
                          <TargetBadge target={t.side} kind="position" contracts={t.contracts} className="py-0" />
                          <span className="text-muted-foreground">{SESSION_LABELS[t.session]}・{TECH_EXIT_LABELS[t.reason]}{t.estimated ? '・推估價' : ''}</span>
                        </div>
                        <div className="tabular-nums text-muted-foreground">
                          {t.entryTime.slice(5)} → {t.exitTime.slice(11) || t.exitTime} · {formatPoints(t.entryPrice)} → {formatPoints(t.exitPrice)}
                        </div>
                      </div>
                      <div className="text-right tabular-nums">
                        <div className={cn('font-semibold', pnlClass(t.netPnl))}>{formatTWD(t.netPnl, true)}</div>
                        <div className={cn('text-[11px]', pnlClass(t.points))}>{formatPoints(t.points, true)} 點</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">這個篩選條件下還沒有交易。</p>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 p-4">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              調整演算法（升版本）後請重置，新舊規則的成績才不會混在一起。
            </p>
            <Button variant="destructive" size="sm" disabled={reset.isPending} onClick={() => void handleReset()}>
              <RotateCcw className="size-4" /> {reset.isPending ? '重置中…' : '重置技術模擬'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function nextLabel(next: TaifexTechStatus['next']): string {
  if (!next) return '';
  return `下次開盤：${next.date.slice(5)} ${next.time} ${SESSION_LABELS[next.session]}`;
}

interface StatusCardProps {
  status: TaifexTechStatus | null;
  config: TaifexConfig;
  running: boolean;
  onRun: () => void;
}

/** 目前時段：交易中 / 休市（原因）/ 下次開盤；休市時不提供「立即模擬」 */
function StatusCard({ status, config, running, onRun }: StatusCardProps) {
  const clock = taifexSessionNow();
  const live = status?.state === 'running' && clock !== null;
  const holiday = status?.state === 'closed' && status.reason === 'holiday';
  const Icon = live ? (status?.session === 'night' ? Moon : Sun) : CalendarOff;
  const title = live
    ? status?.label ?? ''
    : status?.state === 'closed'
      ? holiday ? `休市：${status.label}` : status.label || '休市'
      : status?.state === 'disabled'
        ? '模擬已關閉'
        : status?.state === 'stale' || status?.state === 'no-quote'
          ? status.label
          : clock ? '等待下一筆報價' : '非交易時段';
  return (
    <Card>
      <CardContent className="space-y-2 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Icon className="size-4 shrink-0" aria-hidden />
          <span className="font-medium">{title}</span>
          <Badge variant={live ? 'success' : status?.state === 'stale' || status?.state === 'no-quote' ? 'warning' : 'secondary'}>
            {live ? '模擬中' : status?.state === 'stale' || status?.state === 'no-quote' ? '暫停' : '未模擬'}
          </Badge>
          {status?.estimated && live ? <Badge variant="warning">推估價</Badge> : null}
          <Button size="sm" variant="ghost" className="ml-auto h-8" disabled={running || clock === null} onClick={onRun}>
            <RefreshCw className={cn('size-3.5', running && 'animate-spin')} /> 立即模擬一次
          </Button>
        </div>
        {live && status ? (
          <p className="text-xs text-muted-foreground">
            <span className="text-base font-semibold tabular-nums text-foreground">{formatPoints(status.price)}</span>
            {' '}· {status.contract ?? ''} · {status.time} 更新 · 距收盤 {status.toClose ?? '—'} 分
            {status.source ? ` · 來源 ${status.source}` : ''}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {status?.state === 'no-quote'
              ? '夜盤報價需要在 Apps Script 設定 FUGLE_API_KEY，或期交所行情資訊網可連線；日盤另有加權指數 + 基差推估。'
              : status?.state === 'stale'
                ? '報價時間超過 45 分鐘沒有更新，視為臨時休市（例如颱風假），不進行模擬。'
                : status?.state === 'disabled'
                  ? '到「設定」開啟盤中技術模擬，或個別開啟日盤 / 夜盤。'
                  : '週末、國定假日與非交易時段不會模擬，也不會動到任何部位。'}
            {status?.next ? ` ${nextLabel(status.next)}` : ''}
          </p>
        )}
        {!config.tech.enabled || !config.tech.day || !config.tech.night ? (
          <p className="text-[11px] text-muted-foreground">
            目前設定：{!config.tech.enabled ? '技術模擬關閉' : `${config.tech.day ? '' : '日盤關閉'}${!config.tech.day && !config.tech.night ? '、' : ''}${config.tech.night ? '' : '夜盤關閉'}`}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function statHint(view: TaifexTechStatView): string {
  return `${view.n} 筆 · 勝率 ${pct(view.winRatePct)} · 每筆 ${formatTWD(view.avgNet, true)}`;
}

/** 日盤 vs 夜盤：每個頻率各自的淨損益 */
function SessionCompare({ bots }: { bots: TaifexTechBot[] }) {
  const rows = rankTechBots(bots).sort((a, b) => a.bot.interval - b.bot.interval);
  const dayNet = rows.reduce((s, r) => s + r.day.net, 0);
  const nightNet = rows.reduce((s, r) => s + r.night.net, 0);
  const dayN = rows.reduce((s, r) => s + r.day.n, 0);
  const nightN = rows.reduce((s, r) => s + r.night.n, 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Sun className="size-4" aria-hidden /> 日盤 vs 夜盤</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <StatGrid className="lg:grid-cols-2">
          <StatTile label="日盤合計（四個頻率）" value={formatTWD(dayNet, true)} valueClassName={pnlClass(dayNet)} hint={`${dayN} 筆 · 08:45–13:45`} />
          <StatTile label="夜盤合計（四個頻率）" value={formatTWD(nightNet, true)} valueClassName={pnlClass(nightNet)} hint={`${nightN} 筆 · 15:00–05:00`} />
        </StatGrid>
        <ul className="divide-y text-xs">
          {rows.map((r) => (
            <li key={r.bot.id} className="grid grid-cols-[4.5rem_1fr_1fr] items-center gap-2 py-2">
              <span className="font-medium">{freqLabel(r.bot.interval)}</span>
              <span className="min-w-0">
                <span className={cn('block font-semibold tabular-nums', pnlClass(r.day.net))}>{formatTWD(r.day.net, true)}</span>
                <span className="block truncate text-muted-foreground">{statHint(r.day)}</span>
              </span>
              <span className="min-w-0">
                <span className={cn('block font-semibold tabular-nums', pnlClass(r.night.net))}>{formatTWD(r.night.net, true)}</span>
                <span className="block truncate text-muted-foreground">{statHint(r.night)}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** 單一頻率：目前部位、最近一次查看盤面時的指標與判斷、最近幾次決策 */
function BotDetail({ bot }: { bot: TaifexTechBot }) {
  const d = bot.lastDecision;
  const recent = [...bot.decisions].reverse().slice(0, 8);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Timer className="size-4" aria-hidden /> {freqLabel(bot.interval)}鐘：最近一次判斷
          {bot.position ? <TargetBadge target={bot.position.side} kind="position" contracts={bot.position.contracts} /> : <TargetBadge target="flat" kind="position" />}
        </CardTitle>
        <p className="text-xs text-muted-foreground">在上方「監控頻率比較」點選其他頻率可切換。</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {bot.position ? (
          <p className="text-xs">
            成本 <span className="tabular-nums">{formatPoints(bot.position.entryPrice)}</span>（{bot.position.entryTime.slice(5)}）· 停損{' '}
            <span className="tabular-nums">{formatPoints(bot.position.stop)}</span> · 未實現{' '}
            <span className={cn('font-semibold tabular-nums', pnlClass(bot.position.unrealized))}>{formatTWD(bot.position.unrealized, true)}</span>
          </p>
        ) : null}
        {d ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-2xl font-semibold tabular-nums">{formatScore(d.score)}</span>
              <span className="text-xs text-muted-foreground">
                {d.t.slice(5)} · 價格 {formatPoints(d.price)} · {TECH_ACTION_LABELS[d.action]} · {d.reason}
              </span>
            </div>
            {d.factors && d.indicators ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {TAIFEX_TECH_FACTOR_KEYS.map((key) => (
                    <FactorBar key={key} label={TECH_FACTOR_LABELS[key].label} score={d.factors ? d.factors[key] : null} weight={TAIFEX_TECH_RULES.weights[key]} hint={TECH_FACTOR_LABELS[key].desc} />
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <Cell label={`EMA${TAIFEX_TECH_RULES.emaFast} / EMA${TAIFEX_TECH_RULES.emaSlow}`} value={`${formatPoints(d.indicators.emaFast)} / ${formatPoints(d.indicators.emaSlow)}`} />
                  <Cell label={`RSI${TAIFEX_TECH_RULES.rsi}`} value={d.indicators.rsi.toFixed(1)} />
                  <Cell label="MACD 柱狀體" value={formatPoints(d.indicators.macdHist, true)} />
                  <Cell label={`ATR${TAIFEX_TECH_RULES.atr}`} value={formatPoints(d.indicators.atr)} />
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                K 棒還不夠（目前 {d.bars ?? 0} 根，需要 {TAIFEX_TECH_RULES.minBars} 根 {bot.interval} 分 K）才會開始算指標。
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">這個頻率還沒到第一次監控時間。</p>
        )}
        {recent.length ? (
          <ul className="divide-y text-xs">
            {recent.map((r) => (
              <li key={r.t} className="flex items-center gap-2 py-1.5 tabular-nums">
                <span className="w-24 shrink-0 text-muted-foreground">{formatTW(new Date(`${r.t.replace(' ', 'T')}:00+08:00`), 'MM/dd HH:mm')}</span>
                <span className="w-16 shrink-0">{formatPoints(r.price)}</span>
                <span className="w-12 shrink-0">{formatScore(r.score)}</span>
                <span className={cn('min-w-0 flex-1 truncate', r.action === 'hold' && 'text-muted-foreground')}>{TECH_ACTION_LABELS[r.action]}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 p-2">
      <p className="truncate text-muted-foreground">{label}</p>
      <p className="truncate font-medium tabular-nums">{value}</p>
    </div>
  );
}
