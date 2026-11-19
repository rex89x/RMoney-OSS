import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { CHART_COLORS, paletteColor } from '@/lib/chart-theme';
import { OTHER_KEY, percentChange, topWithOther } from '../metrics';
import { DeltaBadge } from './delta-badge';

export interface CategoryBarRow {
  key: string;
  name: string;
  color?: string;
  value: number;
  /** 比較期間金額（有給才顯示增減） */
  prev?: number;
}

interface CategoryBarsProps {
  rows: CategoryBarRow[];
  /** 最多顯示幾列，其餘合併成「其他」 */
  maxRows?: number;
  /** 點擊列（「其他」會帶入被合併的 key 清單） */
  onSelect?: (keys: string[]) => void;
  /** 比較基準的說明，例如「vs 上月同期」 */
  compareLabel?: string;
  /** 金額上升是好事（收入）還是壞事（支出） */
  goodWhen?: 'up' | 'down';
  emptyText?: string;
}

/**
 * 水平長條排行（取代圓餅圖）：手機上也看得清楚每一類的金額 / 佔比 / 增減，點擊可下鑽到交易列表。
 */
export function CategoryBars({
  rows, maxRows = 6, onSelect, compareLabel, goodWhen = 'down', emptyText = '尚無資料',
}: CategoryBarsProps) {
  const { display, total, max } = useMemo(() => {
    const positive = rows.filter((r) => r.value > 0);
    const ranked = topWithOther(positive, maxRows);
    const byKey = new Map(positive.map((r) => [r.key, r]));
    const shown = new Set(ranked.map((r) => r.key));
    const hidden = positive.filter((r) => !shown.has(r.key));
    const display = ranked.map((r, i) => {
      if (r.key === OTHER_KEY) {
        const prev = hidden.some((h) => h.prev != null) ? hidden.reduce((s, h) => s + (h.prev ?? 0), 0) : undefined;
        return {
          key: OTHER_KEY, name: `其他 ${hidden.length} 類`, color: CHART_COLORS.muted, value: r.value, prev,
          keys: hidden.map((h) => h.key),
        };
      }
      const row = byKey.get(r.key)!; // ranked 的非 other 列一定來自 positive
      return { ...row, color: row.color ?? paletteColor(i), keys: [row.key] };
    });
    const total = positive.reduce((s, r) => s + r.value, 0);
    const max = display.reduce((m, r) => Math.max(m, r.value), 0);
    return { display, total, max };
  }, [rows, maxRows]);

  if (display.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  }

  return (
    <ul className="space-y-2">
      {display.map((r) => {
        const pct = total > 0 ? r.value / total : 0;
        const width = max > 0 ? Math.max(2, (r.value / max) * 100) : 0;
        const content = (
          <>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
                <span className="truncate">{r.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{Math.round(pct * 100)}%</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {r.prev != null ? (
                  <DeltaBadge value={percentChange(r.value, r.prev)} goodWhen={goodWhen} />
                ) : null}
                <span className="font-medium tabular-nums">{formatCurrency(r.value)}</span>
                {onSelect ? <ChevronRight className="size-3.5 text-muted-foreground" /> : null}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${width}%`, background: r.color }} />
            </div>
          </>
        );
        return (
          <li key={r.key}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(r.keys)}
                className={cn('-mx-1 block w-[calc(100%+0.5rem)] rounded-md px-1 py-0.5 text-left hover:bg-muted/60')}
                aria-label={`查看${r.name}交易`}
              >
                {content}
              </button>
            ) : content}
          </li>
        );
      })}
      {compareLabel ? (
        <li className="pt-1 text-[11px] text-muted-foreground">增減比較：{compareLabel}</li>
      ) : null}
    </ul>
  );
}
