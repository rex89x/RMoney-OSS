import { Activity, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import { isTaifexSessionNow, useRunTaifexIntraday } from '../hooks';
import { formatPoints, formatTWD, pnlClass } from '../options';
import type { TaifexAccount, TaifexConfig, TaifexLiveDoc } from '../types';

interface TaifexLiveCardProps {
  live: TaifexLiveDoc | null;
  account: TaifexAccount;
  config: TaifexConfig;
  today: string;
}

type SessionState = 'pre' | 'open' | 'closed' | 'weekend';

function sessionState(now: Date): SessionState {
  const day = Number(formatTW(now, 'i'));
  if (day > 5) return 'weekend';
  const hhmm = formatTW(now, 'HH:mm');
  if (hhmm < '08:45') return 'pre';
  return isTaifexSessionNow(now) ? 'open' : 'closed';
}

const SESSION_LABELS: Record<SessionState, string> = {
  pre: '盤前（08:45 開盤）',
  open: '日盤交易中',
  closed: '已收盤（18:00 結算）',
  weekend: '休市',
};

/** 盤中即時：報價、漲跌、主帳戶即時損益與距停損；資料每 5 分鐘由 Apps Script 更新 */
export function TaifexLiveCard({ live, account, config, today }: TaifexLiveCardProps) {
  const run = useRunTaifexIntraday();
  const state = sessionState(new Date());
  const quote = live?.quote && live.quote.date === today ? live.quote : null;
  const mark = account.live && account.live.date === today ? account.live : null;
  const change = quote && quote.prevClose ? quote.last - quote.prevClose : null;
  const changePct = change !== null && quote?.prevClose ? (change / quote.prevClose) * 100 : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Activity className="size-4" aria-hidden /> 盤中即時
          <Badge variant={state === 'open' ? 'success' : 'secondary'}>{SESSION_LABELS[state]}</Badge>
          {quote?.estimated ? <Badge variant="warning">推估價</Badge> : null}
          {state === 'open' ? (
            <Button size="sm" variant="ghost" className="ml-auto h-8" disabled={run.isPending} onClick={() => run.mutate()}>
              <RefreshCw className={cn('size-3.5', run.isPending && 'animate-spin')} /> 立即模擬一次
            </Button>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {quote ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-2xl font-semibold tabular-nums">{formatPoints(quote.last)}</span>
              <span className={cn('tabular-nums', pnlClass(change))}>
                {formatPoints(change, true)}（{changePct === null ? '—' : `${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%`}）
              </span>
              <span className="text-xs text-muted-foreground">{quote.contract ?? ''} · {quote.time} 更新</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <Cell label="開盤" value={formatPoints(quote.open)} />
              <Cell label="最高" value={formatPoints(quote.high)} />
              <Cell label="最低" value={formatPoints(quote.low)} />
            </div>
            {mark && account.position ? (
              <p className="text-sm">
                主帳戶即時損益 <span className={cn('font-semibold tabular-nums', pnlClass(mark.unrealized))}>{formatTWD(mark.unrealized, true)}</span>
                <span className="text-xs text-muted-foreground"> · 距停損 {formatPoints(mark.stopDistance)} 點</span>
              </p>
            ) : null}
            {quote.estimated ? (
              <p className="text-[11px] text-muted-foreground">
                目前用加權指數即時價 + 基差（{formatPoints(quote.basis, true)} 點）推估期貨價格；在 Apps Script 設定 FUGLE_API_KEY 後改用期貨實際報價。
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {state === 'open'
              ? config.intradayEnabled ? '等待第一筆報價（每 5 分鐘更新）。' : '盤中模擬已在設定中關閉。'
              : '開盤時間（平日 08:45–13:45）每 5 分鐘用即時報價模擬：開盤成交待成交單、盤中停損、接近停損提醒。'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums">{value}</p>
    </div>
  );
}
