import { Minus, ShieldAlert, TrendingDown, TrendingUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { compositeZone, gaugePercent, ZONE_LABELS } from '../dashboard';
import { SIDE_LABELS, TARGET_LABELS, formatScore } from '../options';
import { TAIFEX_RULES, type TaifexTarget } from '../types';

const TARGET_ICON = { long: TrendingUp, short: TrendingDown, flat: Minus } as const;

interface TargetBadgeProps {
  target: TaifexTarget;
  /** 'action' 顯示「做多 / 做空」，'position' 顯示「多單 / 空單」 */
  kind?: 'action' | 'position';
  contracts?: number;
  className?: string;
}

/** 多空方向一律文字 + icon，不只靠顏色 */
export function TargetBadge({ target, kind = 'action', contracts, className }: TargetBadgeProps) {
  const Icon = TARGET_ICON[target];
  const label = kind === 'action' ? TARGET_LABELS[target] : SIDE_LABELS[target];
  return (
    <Badge variant={target === 'flat' ? 'secondary' : 'outline'} className={cn('gap-1 font-medium', className)}>
      <Icon className="size-3.5" aria-hidden />
      {label}{contracts && target !== 'flat' ? ` ${contracts} 口` : ''}
    </Badge>
  );
}

interface CompositeGaugeProps {
  composite: number | null;
}

/** 合成分數量表：-1（偏空）到 +1（偏多），標出 ±0.35 進場門檻與 ±0.05 出場區 */
export function CompositeGauge({ composite }: CompositeGaugeProps) {
  const zone = compositeZone(composite);
  const pct = gaugePercent(composite);
  const entryLow = gaugePercent(-TAIFEX_RULES.entry);
  const entryHigh = gaugePercent(TAIFEX_RULES.entry);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xl font-semibold tabular-nums">{formatScore(composite)}</span>
        <span className="text-xs text-muted-foreground">{ZONE_LABELS[zone]}</span>
      </div>
      <div
        className="relative h-2.5 rounded-full bg-muted"
        role="meter"
        aria-label="合成分數"
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={composite ?? 0}
      >
        <div className="absolute inset-y-0 rounded-l-full bg-muted-foreground/20" style={{ left: 0, width: `${entryLow}%` }} />
        <div className="absolute inset-y-0 rounded-r-full bg-muted-foreground/20" style={{ left: `${entryHigh}%`, right: 0 }} />
        <div className="absolute inset-y-[-3px] w-px bg-border" style={{ left: '50%' }} />
        {composite !== null ? (
          <div
            className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow"
            style={{ left: `${pct}%` }}
          />
        ) : null}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>-1 偏空</span>
        <span>±{TAIFEX_RULES.entry} 進場門檻</span>
        <span>+1 偏多</span>
      </div>
    </div>
  );
}

/** 每頁都要看得到的虛擬交易聲明 */
export function PaperDisclaimer({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground', className)}>
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      虛擬交易模擬：不接券商、不會下真實委託，訊號僅供研究參考，不構成投資建議。期貨具槓桿，實際交易可能損失超過保證金。
    </p>
  );
}

interface FactorBarProps {
  label: string;
  score: number | null;
  weight: number;
  hint?: string;
}

/** 因子分數長條：中線為 0，往右偏多、往左偏空 */
export function FactorBar({ label, score, weight, hint }: FactorBarProps) {
  const width = score === null ? 0 : Math.min(50, Math.abs(score) * 50);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{label} <span className="font-normal text-muted-foreground">×{weight}</span></span>
        <span className="tabular-nums text-muted-foreground">{score === null ? '無資料' : formatScore(score)}</span>
      </div>
      <div className="relative h-2 rounded-full bg-muted">
        <div className="absolute inset-y-0 w-px bg-border" style={{ left: '50%' }} />
        {score !== null ? (
          <div
            className={cn('absolute inset-y-0 rounded-full', score >= 0 ? 'bg-primary' : 'bg-muted-foreground')}
            style={score >= 0 ? { left: '50%', width: `${width}%` } : { right: '50%', width: `${width}%` }}
          />
        ) : null}
      </div>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
