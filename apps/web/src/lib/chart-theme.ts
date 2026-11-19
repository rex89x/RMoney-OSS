/**
 * 圖表共用樣式：顏色一律走 `index.css` 的 `--chart-*` token（light / dark 各一組），
 * 不要在元件裡寫死 hex。類別自訂顏色（categories.color）仍優先使用。
 */
import type { CSSProperties } from 'react';

export const CHART_COLORS = {
  income: 'hsl(var(--chart-income))',
  expense: 'hsl(var(--chart-expense))',
  net: 'hsl(var(--chart-net))',
  muted: 'hsl(var(--chart-muted))',
  grid: 'hsl(var(--border))',
  axis: 'hsl(var(--muted-foreground))',
  primary: 'hsl(var(--primary))',
  warning: 'hsl(var(--warning))',
} as const;

export const CHART_PALETTE: ReadonlyArray<string> = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `hsl(var(--chart-${i}))`);

export function paletteColor(i: number): string {
  return CHART_PALETTE[i % CHART_PALETTE.length] ?? CHART_COLORS.primary;
}

/** Y 軸 / 標籤用的精簡金額：1,234 → 1.2K、1,250,000 → 1.3M */
export function formatAxisTWD(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}K`;
  return `${sign}${Math.round(abs)}`;
}

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
}

/** Recharts Tooltip 預設白底，深色模式看不清楚 → 統一用 popover token */
export const CHART_TOOLTIP_PROPS: {
  contentStyle: CSSProperties;
  labelStyle: CSSProperties;
  itemStyle: CSSProperties;
  cursor: { fill: string };
} = {
  contentStyle: {
    background: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 8,
    fontSize: 12,
    color: 'hsl(var(--popover-foreground))',
  },
  labelStyle: { color: 'hsl(var(--muted-foreground))', marginBottom: 2 },
  itemStyle: { color: 'hsl(var(--popover-foreground))', padding: 0 },
  cursor: { fill: 'hsl(var(--muted) / 0.5)' },
};

export const AXIS_PROPS = {
  fontSize: 10,
  stroke: CHART_COLORS.axis,
  tickLine: false,
  axisLine: false,
} as const;
