import { AlertTriangle, Ban, CalendarClock, Clock, Newspaper, OctagonPause, PlayCircle, Wallet, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import { summarizeAccount, upcomingEvents } from '../dashboard';
import { useCancelTaifexOrder, useResumeTaifexPaper } from '../hooks';
import {
  DRIVER_LABELS,
  EVENT_TYPE_LABELS,
  IMPORTANCE_LABELS,
  SIZING_LIMIT_LABELS,
  TAIFEX_PRODUCT_SPECS,
  formatPctValue,
  formatPoints,
  formatScore,
  formatTWD,
  pnlClass,
} from '../options';
import type { TaifexAccount, TaifexConfig, TaifexLiveDoc, TaifexSentiment, TaifexSignal } from '../types';
import { TaifexLiveCard } from './taifex-live-card';
import { CompositeGauge, TargetBadge } from './taifex-parts';
import { TaifexTicketCard } from './taifex-ticket-card';

interface TaifexOverviewProps {
  account: TaifexAccount;
  signal: TaifexSignal | null;
  sentiment: TaifexSentiment | null;
  live: TaifexLiveDoc | null;
  config: TaifexConfig;
  today: string;
  onOpenOrder: () => void;
  onOpenClaude: () => void;
}

/** 總覽：一眼看懂「今天該做什麼 → 為什麼 → 風險在哪」 */
export function TaifexOverview({ account, signal, sentiment, live, config, today, onOpenOrder, onOpenClaude }: TaifexOverviewProps) {
  const summary = summarizeAccount(account);
  const spec = TAIFEX_PRODUCT_SPECS[account.product];
  const events = upcomingEvents(sentiment, today);
  const productMismatch = config.product !== account.product;

  return (
    <div className="space-y-4">
      <StatusBanners account={account} productMismatch={productMismatch} configProductLabel={TAIFEX_PRODUCT_SPECS[config.product].label} />

      <div className="grid gap-4 lg:grid-cols-2">
        <TaifexLiveCard live={live} account={account} config={config} today={today} />
        <TaifexTicketCard ticket={account.ticket} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SignalCard signal={signal} account={account} />
        <PositionCard account={account} summary={summary} spec={spec} onOpenOrder={onOpenOrder} />
      </div>

      <StatGrid>
        <StatTile
          label="帳戶權益"
          value={formatTWD(account.equity)}
          hint={`起始 ${formatTWD(account.initialCapital)} · ${spec.label}`}
        />
        <StatTile
          label="累積報酬"
          value={formatPctValue(summary.returnPct, 2)}
          valueClassName={pnlClass(summary.returnPct)}
          hint={`已實現 ${formatTWD(account.realizedPnl, true)}，成本 ${formatTWD(account.totalCosts)}`}
        />
        <StatTile
          label="目前回撤 / 最大回撤"
          value={`${summary.drawdownPct.toFixed(1)}% / ${account.maxDrawdownPct.toFixed(1)}%`}
          tone={summary.drawdownPct >= config.maxDrawdownPct * 0.75 ? 'warn' : 'plain'}
          hint={`熔斷門檻 ${config.maxDrawdownPct}%`}
        />
        <StatTile
          label="交易次數 / 勝率"
          value={`${account.tradeCount} / ${summary.winRatePct === null ? '—' : `${summary.winRatePct.toFixed(0)}%`}`}
          hint={account.startDate ? `自 ${account.startDate} 起` : undefined}
        />
      </StatGrid>

      <SentimentCard sentiment={sentiment} events={events} today={today} onOpenClaude={onOpenClaude} />
    </div>
  );
}

function StatusBanners({ account, productMismatch, configProductLabel }: { account: TaifexAccount; productMismatch: boolean; configProductLabel: string }) {
  const confirm = useConfirm();
  const resume = useResumeTaifexPaper();
  return (
    <>
      {account.halted ? (
        <div className="flex flex-wrap items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <OctagonPause className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-destructive">帳戶已熔斷，暫停新進場</p>
            <p className="text-xs text-muted-foreground">{account.haltReason ?? '回撤達門檻'}。先檢討最近的交易再決定是否解除。</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={resume.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: '解除熔斷？',
                description: '回撤基準會重設為目前權益，策略恢復產生新進場訊號。',
                confirmText: '解除',
                variant: 'default',
              });
              if (ok) resume.mutate();
            }}
          >
            <PlayCircle className="size-4" /> 解除熔斷
          </Button>
        </div>
      ) : null}
      {account.lastVeto ? (
        <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-xs">
          <Ban className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span><span className="font-medium">{account.lastVeto.date} 盤前否決：</span>{account.lastVeto.reason}</span>
        </div>
      ) : null}
      {productMismatch ? (
        <div className="flex items-start gap-2 rounded-xl border p-3 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          設定已改為{configProductLabel}，但帳戶仍以{TAIFEX_PRODUCT_SPECS[account.product].label}計算；到「設定」重置帳戶後才會套用。
        </div>
      ) : null}
    </>
  );
}

function SignalCard({ signal, account }: { signal: TaifexSignal | null; account: TaifexAccount }) {
  if (!signal) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">今日訊號</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">還沒有訊號，按右上「立即更新」或等 18:00 排程。</CardContent>
      </Card>
    );
  }
  const currentSide = account.position?.side ?? 'flat';
  const changes = signal.desired !== currentSide;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          今日訊號
          <span className="text-xs font-normal text-muted-foreground">{signal.date} 收盤 {formatPoints(signal.close)} · {signal.contract ?? ''}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <CompositeGauge composite={signal.composite} />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">建議部位</span>
          <TargetBadge target={signal.desired} kind="position" />
          {changes ? <Badge variant="warning">與目前部位不同</Badge> : <span className="text-xs text-muted-foreground">維持現狀</span>}
        </div>
        {signal.reasons.length || signal.decisionReasons.length ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {[...signal.decisionReasons, ...signal.reasons].map((reason) => (
              <li key={reason} className="flex gap-1.5"><span aria-hidden>·</span>{reason}</li>
            ))}
          </ul>
        ) : null}
        {signal.eventRisk ? (
          <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 p-2 text-xs">
            <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            下一個交易日有重大事件：{signal.riskEvents.map((e) => e.note || EVENT_TYPE_LABELS[e.type]).join('、')}，暫停新開倉。
          </p>
        ) : null}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Metric label="量化分數" value={formatScore(signal.quantScore)} />
          <Metric label="輿情加減" value={formatScore(signal.sentimentAdj)} />
          <Metric label="涵蓋率" value={`${Math.round(signal.coverage * 100)}%`} />
        </div>
        {signal.desired !== 'flat' && signal.suggestedContracts > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            建議 {signal.suggestedContracts} 口（{SIZING_LIMIT_LABELS[signal.sizingLimitedBy ?? 'risk'] ?? ''}），初始停損 {formatPoints(signal.stopPoints)} 點。
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums">{value}</p>
    </div>
  );
}

interface PositionCardProps {
  account: TaifexAccount;
  summary: ReturnType<typeof summarizeAccount>;
  spec: (typeof TAIFEX_PRODUCT_SPECS)[keyof typeof TAIFEX_PRODUCT_SPECS];
  onOpenOrder: () => void;
}

function PositionCard({ account, summary, spec, onOpenOrder }: PositionCardProps) {
  const confirm = useConfirm();
  const cancel = useCancelTaifexOrder();
  const pos = account.position;
  const pending = account.pending;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="size-4" aria-hidden /> 虛擬部位
          <span className="text-xs font-normal text-muted-foreground">{spec.label} · 每點 {spec.pointValue} 元</span>
          <Button size="sm" variant="outline" className="ml-auto h-8" onClick={onOpenOrder}>手動下單</Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {pos ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <TargetBadge target={pos.side} kind="position" contracts={pos.contracts} />
              <span className="text-xs text-muted-foreground">{pos.entryDate} 進場 · 持有 {pos.bars} 天 · {pos.source === 'manual' ? '手動' : '自動'}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <Metric label="成本" value={formatPoints(pos.entryPrice)} />
              <Metric label="最新收盤" value={formatPoints(account.lastClose)} />
              <Metric label="停損" value={formatPoints(pos.stop)} />
              <Metric label="距停損" value={`${formatPoints(summary.stopDistancePoints)} 點`} />
            </div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span>
                未實現損益{' '}
                <span className={cn('font-semibold tabular-nums', pnlClass(summary.unrealizedPnl))}>{formatTWD(summary.unrealizedPnl, true)}</span>
                <span className="text-xs text-muted-foreground">（{formatPoints(summary.unrealizedPoints, true)} 點）</span>
              </span>
              <span className="text-xs text-muted-foreground">停損風險 {formatTWD(summary.riskToStop)} · 名目價值 {formatTWD(summary.notional)}</span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">目前空手。</p>
        )}

        {pending ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs">
            <Clock className="size-3.5 text-primary" aria-hidden />
            <span className="font-medium">下一個交易日開盤待成交：</span>
            <TargetBadge target={pending.target} kind="position" contracts={pending.contracts} />
            <span className="text-muted-foreground">{pending.source === 'manual' ? '手動' : '自動'}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7"
              disabled={cancel.isPending}
              onClick={async () => {
                const ok = await confirm({ title: '取消待成交單？', description: '自動模式下，今晚 18:00 若訊號不變會重新產生。', confirmText: '取消單' });
                if (ok) cancel.mutate();
              }}
            >
              <X className="size-3.5" /> 取消
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">沒有待成交單。</p>
        )}
      </CardContent>
    </Card>
  );
}

function SentimentCard({ sentiment, events, today, onOpenClaude }: {
  sentiment: TaifexSentiment | null;
  events: ReturnType<typeof upcomingEvents>;
  today: string;
  onOpenClaude: () => void;
}) {
  const fresh = sentiment && sentiment.date >= today;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Newspaper className="size-4" aria-hidden /> 輿情與事件
          {sentiment ? (
            <span className="text-xs font-normal text-muted-foreground">
              {sentiment.receivedAt ? formatTW(sentiment.receivedAt, 'MM/dd HH:mm') : sentiment.date} · {sentiment.provider === 'claude' ? 'Claude 排程' : '手動貼上'}
            </span>
          ) : null}
          {sentiment && !fresh ? <Badge variant="secondary">非今日</Badge> : null}
          <Button size="sm" variant="ghost" className="ml-auto h-8" onClick={onOpenClaude}>設定 Claude 輿情</Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {sentiment ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span>整體 <span className="font-semibold tabular-nums">{formatScore(sentiment.overall.sentiment)}</span></span>
              <span className="text-xs text-muted-foreground">信心 {Math.round(sentiment.overall.confidence * 100)}%</span>
              {sentiment.overall.confidence === 0 ? <Badge variant="secondary">無來源，不計分</Badge> : null}
            </div>
            {sentiment.overall.summary ? <p className="text-xs leading-relaxed text-muted-foreground">{sentiment.overall.summary}</p> : null}
            {sentiment.drivers.length ? (
              <ul className="grid gap-1 text-xs sm:grid-cols-2">
                {sentiment.drivers.map((d, i) => (
                  <li key={`${d.type}-${i}`} className="flex gap-1.5">
                    <span className="shrink-0 font-medium">{d.direction > 0 ? '偏多' : d.direction < 0 ? '偏空' : '中性'}</span>
                    <span className="text-muted-foreground">{DRIVER_LABELS[d.type]}｜{d.note}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <IndicatorRow indicators={sentiment.indicators} />
            {sentiment.overall.sources.length ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                {sentiment.overall.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener" className="max-w-[16rem] truncate text-primary underline-offset-2 hover:underline">{s.title}</a>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">尚未收到輿情。設定 Claude 排程後，每天會在盤前與收盤後推送市場情緒與事件行事曆；沒有輿情時策略只用技術面與籌碼面。</p>
        )}
        {events.length ? (
          <div className="space-y-1">
            <p className="text-xs font-medium">未來事件</p>
            <ul className="space-y-1 text-xs">
              {events.map((e) => (
                <li key={`${e.type}-${e.date}`} className="flex items-center gap-2">
                  <span className="tabular-nums text-muted-foreground">{e.date.slice(5)}</span>
                  <Badge variant={e.importance === 'high' ? 'warning' : 'secondary'} className="px-1.5 py-0 text-[10px]">{IMPORTANCE_LABELS[e.importance]}</Badge>
                  <span>{EVENT_TYPE_LABELS[e.type]}{e.note ? `｜${e.note}` : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const INDICATOR_LABELS: Array<[keyof TaifexSentiment['indicators'], string, boolean]> = [
  ['spxChangePct', 'S&P 500', true],
  ['soxChangePct', '費半', true],
  ['tsmAdrChangePct', 'TSM ADR', true],
  ['nightSessionChangePct', '台指夜盤', true],
  ['vix', 'VIX', false],
];

function IndicatorRow({ indicators }: { indicators: TaifexSentiment['indicators'] }) {
  const items = INDICATOR_LABELS.filter(([key]) => indicators[key] !== null && indicators[key] !== undefined);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {items.map(([key, label, pct]) => {
        const value = indicators[key] ?? 0;
        return (
          <span key={key} className="rounded-md bg-muted/60 px-2 py-1">
            {label}{' '}
            <span className={cn('font-medium tabular-nums', pct ? pnlClass(value) : '')}>{pct ? formatPctValue(value, 1) : value.toFixed(1)}</span>
          </span>
        );
      })}
    </div>
  );
}
