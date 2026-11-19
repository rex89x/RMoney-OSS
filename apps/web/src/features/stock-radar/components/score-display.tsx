import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ACTION_META, formatScore, type ActionTone } from '../options';
import type { StockRadarAction } from '../types';

const TONE_BADGE: Record<ActionTone, string> = {
  good: 'border-transparent bg-success/15 text-success',
  plain: 'border-transparent bg-muted text-foreground',
  warn: 'border-transparent bg-warning/15 text-warning',
  bad: 'border-transparent bg-destructive/15 text-destructive',
  muted: 'border-dashed text-muted-foreground',
};

export const TONE_TEXT: Record<ActionTone, string> = {
  good: 'text-success',
  plain: '',
  warn: 'text-warning',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
};

interface ActionBadgeProps {
  action: StockRadarAction;
  className?: string;
}

export function ActionBadge({ action, className }: ActionBadgeProps) {
  const meta = ACTION_META[action];
  return <Badge variant="outline" className={cn('shrink-0', TONE_BADGE[meta.tone], className)}>{meta.label}</Badge>;
}

interface ScoreBarProps {
  score: number | null;
  className?: string;
}

/** [-1, 1] 分數：中線為 0，往右綠、往左紅 */
export function ScoreBar({ score, className }: ScoreBarProps) {
  const value = score === null ? 0 : Math.max(-1, Math.min(1, score));
  const width = `${Math.abs(value) * 50}%`;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
        {score !== null ? (
          <div
            className={cn('absolute inset-y-0', value >= 0 ? 'left-1/2 bg-success' : 'right-1/2 bg-destructive')}
            style={{ width }}
          />
        ) : null}
      </div>
      <span className={cn('w-11 text-right text-xs tabular-nums', score === null ? 'text-muted-foreground' : value >= 0 ? 'text-success' : 'text-destructive')}>
        {formatScore(score)}
      </span>
    </div>
  );
}
