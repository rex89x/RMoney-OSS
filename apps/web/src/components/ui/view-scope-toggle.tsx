import { cn } from '@/lib/utils';

export type ViewScope = 'mine' | 'all';

interface ViewScopeToggleProps {
  value: ViewScope;
  onChange: (next: ViewScope) => void;
  className?: string;
  /** 「只看我的」的說明（例：只算我負擔的那份） */
  mineLabel?: string;
  allLabel?: string;
}

/** 「只看我的 / 全部」切換：旅程花費、分類圖、報告書共用，預設只看我的（我負擔的那份） */
export function ViewScopeToggle({ value, onChange, className, mineLabel = '只看我的', allLabel = '全部' }: ViewScopeToggleProps) {
  return (
    <div className={cn('inline-flex rounded-full border bg-muted p-0.5 text-xs', className)} role="radiogroup" aria-label="花費口徑">
      {([['mine', mineLabel], ['all', allLabel]] as const).map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'rounded-full px-3 py-1 transition-colors',
            value === v ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
