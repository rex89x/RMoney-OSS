import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn, formatFxRate, formatFxDelta, formatFinePercent } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useFxCandles } from '../hooks';
import type { FxRate } from '../types';

interface FxRateCardProps {
  rate: FxRate;
  /** 緊湊版（dashboard 用）— 不顯示更新時間 + 字級略小 */
  compact?: boolean;
}

/**
 * 單一匯率卡片：顯示即時匯率 + 與上一日 close 的微幅變動。
 *
 * 為什麼要 per-pair 拉 candles：candles 是 daily snapshot subcollection；
 * 一次拉 2 筆（今天剛收 + 前一天）做 diff，計算成本可忽略（pair 數量小）。
 */
export function FxRateCard({ rate, compact = false }: FxRateCardProps) {
  const { data: candles = [] } = useFxCandles(rate.id, 2);
  // candles 由 api.ts 反向後變正向（舊 → 新），所以最後一筆是最近
  const prev = candles.length >= 2 ? candles[candles.length - 2]?.rate
    : candles.length === 1 ? candles[0]?.rate
    : undefined;
  const delta = prev != null ? rate.rate - prev : null;
  const deltaPct = prev != null && prev !== 0 ? ((rate.rate - prev) / prev) * 100 : null;
  const tone = delta == null || Math.abs(delta) < 1e-9 ? 'flat'
    : delta > 0 ? 'up'
    : 'down';

  return (
    <div className={cn('rounded-xl border p-3', compact && 'p-2.5')}>
      {/* 手機兩欄的窄卡片放不下「幣別 + 漲跌 + 百分比」時，漲跌換到下一行，不要撐出卡片 */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <div className="text-xs text-muted-foreground">{rate.base} / {rate.quote}</div>
        {delta != null ? (
          <DeltaBadge tone={tone} delta={delta} pct={deltaPct} baseRate={rate.rate} />
        ) : null}
      </div>
      <div className={cn('mt-1 font-semibold tabular-nums', compact ? 'text-base' : 'text-xl')}>
        {formatFxRate(rate.rate)}
      </div>
      {!compact && rate.updatedAt ? (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {formatTW(rate.updatedAt, 'yyyy-MM-dd HH:mm')}
        </div>
      ) : null}
    </div>
  );
}

interface DeltaBadgeProps {
  tone: 'up' | 'down' | 'flat';
  delta: number;
  pct: number | null;
  baseRate: number;
}

function DeltaBadge({ tone, delta, pct, baseRate }: DeltaBadgeProps) {
  const Icon = tone === 'up' ? TrendingUp : tone === 'down' ? TrendingDown : Minus;
  const cls = tone === 'up' ? 'text-emerald-500'
    : tone === 'down' ? 'text-red-500'
    : 'text-muted-foreground';
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1 text-[10px] font-medium tabular-nums', cls)}>
      <Icon className="size-3 shrink-0" />
      <span>{formatFxDelta(delta, baseRate)}</span>
      {pct != null ? <span className="opacity-80">({formatFinePercent(pct)})</span> : null}
    </div>
  );
}
