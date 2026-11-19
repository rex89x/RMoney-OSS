import type { ReactNode } from 'react';
import { Card, CardContent } from './card';
import { Skeleton } from './skeleton';
import { cn } from '@/lib/utils';

export type StatTone = 'plain' | 'good' | 'warn' | 'bad';

const TONE_CLASS: Record<StatTone, string> = {
  plain: '',
  good: 'text-success',
  warn: 'text-warning',
  bad: 'text-destructive',
};

interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  /** 直接指定數值顏色（例：損益依正負決定），優先於 tone */
  valueClassName?: string;
  loading?: boolean;
  onClick?: (() => void) | undefined;
}

/**
 * KPI 數字卡。手機上兩張一排（見 StatGrid），數字字級自動縮小、不換行不溢出。
 * 顏色只用在數值本身；標籤與說明一律 muted（dataviz：文字不穿 series 顏色）。
 */
export function StatTile({ label, value, hint, tone = 'plain', valueClassName, loading, onClick }: StatTileProps) {
  const body = (
    <CardContent className="p-3 text-left sm:p-4">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      {loading ? <Skeleton className="mt-1 h-7 w-24" /> : (
        <p className={cn('truncate text-lg font-semibold tabular-nums sm:text-2xl', valueClassName ?? TONE_CLASS[tone])}>{value}</p>
      )}
      {hint ? <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{hint}</p> : null}
    </CardContent>
  );
  if (!onClick) return <Card className="min-w-0">{body}</Card>;
  return (
    <Card className="min-w-0 transition-colors hover:bg-muted/40">
      <button type="button" className="block w-full rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onClick}>
        {body}
      </button>
    </Card>
  );
}

/** StatTile 的排版：手機 2 欄、桌面 4 欄 */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4', className)}>{children}</div>;
}
