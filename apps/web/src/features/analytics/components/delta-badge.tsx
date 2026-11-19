import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DeltaBadgeProps {
  /** 比例（0.12 = +12%）；null = 無法比較 */
  value: number | null;
  /** 上升是好事（收入 / 儲蓄率）還是壞事（支出） */
  goodWhen: 'up' | 'down';
  /** 顯示在數字後的說明，例如「vs 上月同期」 */
  suffix?: string;
  /** 以百分點顯示（儲蓄率差） */
  points?: boolean;
  className?: string;
}

export function DeltaBadge({ value, goodWhen, suffix, points, className }: DeltaBadgeProps) {
  if (value == null || !Number.isFinite(value)) {
    return suffix ? <span className={cn('text-[11px] text-muted-foreground', className)}>{suffix} 無資料</span> : null;
  }
  const flat = Math.abs(value) < 0.005;
  const good = flat ? null : (value > 0) === (goodWhen === 'up');
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  const text = points
    ? `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)} pp`
    : `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums',
        good == null ? 'text-muted-foreground' : good ? 'text-success' : 'text-destructive',
        className,
      )}
    >
      <Icon className="size-3" />
      {text}
      {suffix ? <span className="ml-1 font-normal text-muted-foreground">{suffix}</span> : null}
    </span>
  );
}
