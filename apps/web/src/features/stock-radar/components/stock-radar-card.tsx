import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Radar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { latestRunByMarket } from '../dashboard';
import { useStockRadarRuns } from '../hooks';
import { MARKET_LABELS, REGIME_META } from '../options';
import type { StockRadarAction, StockRadarItem, StockRadarMarket } from '../types';
import { ActionBadge, TONE_TEXT } from './score-display';

/** 首頁卡片優先順序：先持股風險，再加碼、買進 */
const PRIORITY: StockRadarAction[] = ['exit', 'trim', 'add', 'buy'];

/** 首頁 Dashboard 卡片：兩個市場的盤勢 + 最需要處理的 3 檔；沒有任何評估時不顯示 */
export function StockRadarCard() {
  const { data: runs = [] } = useStockRadarRuns();
  const latest = useMemo(() => latestRunByMarket(runs), [runs]);
  const markets = (['TW', 'US'] as StockRadarMarket[]).filter((m) => latest[m]);
  const top = useMemo(() => {
    const items: Array<StockRadarItem & { market: StockRadarMarket }> = [];
    markets.forEach((m) => (latest[m]?.items ?? []).forEach((item) => items.push({ ...item, market: m })));
    return items
      .filter((item) => PRIORITY.includes(item.action))
      .sort((a, b) => PRIORITY.indexOf(a.action) - PRIORITY.indexOf(b.action))
      .slice(0, 3);
  }, [latest, markets]);
  if (markets.length === 0) return null;
  const needsAction = markets.reduce(
    (sum, m) => sum + (latest[m]?.items ?? []).filter((item) => item.action === 'trim' || item.action === 'exit').length,
    0,
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base"><Radar className="size-4" /> 股市雷達</CardTitle>
        <Link to="/stock-radar" className="flex items-center text-xs text-muted-foreground">
          查看全部 <ChevronRight className="size-3" />
        </Link>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
          {markets.map((m) => {
            const run = latest[m];
            if (!run) return null;
            const meta = REGIME_META[run.effectiveRegime];
            return (
              <span key={m}>
                {MARKET_LABELS[m]} {run.runDate.slice(5)}｜<span className={cn('font-medium', TONE_TEXT[meta.tone])}>{meta.label}</span>
              </span>
            );
          })}
        </div>
        {top.length === 0 ? (
          <p className="text-xs text-muted-foreground">今天沒有需要動作的標的，持股續抱。</p>
        ) : top.map((item) => (
          <div key={`${item.market}-${item.symbol}`} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">
              {item.symbol} <span className="text-xs text-muted-foreground">{item.name !== item.symbol ? item.name : ''}</span>
            </span>
            <ActionBadge action={item.action} />
          </div>
        ))}
        {needsAction > 0 ? (
          <Link to="/stock-radar" className="block text-xs text-warning">{needsAction} 檔持股建議減碼或出場</Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
