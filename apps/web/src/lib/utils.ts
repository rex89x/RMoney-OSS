import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(
  value: number,
  currency: string = 'TWD',
  locale: string = 'zh-TW',
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'TWD' || currency === 'JPY' ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function formatNumber(value: number, digits = 2): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

/**
 * 匯率顯示精度：
 *   小幣對（JPY/TWD、CNY/TWD ≈ 0.x）肉眼看不到 0.001 級的變動，
 *   所以按 rate 大小動態決定 fraction digits，預設加 2 位緩衝。
 */
export function fxFractionDigits(rate: number): number {
  const abs = Math.abs(rate);
  if (abs === 0) return 4;
  if (abs >= 100) return 4;
  if (abs >= 10) return 4;
  if (abs >= 1) return 5;
  if (abs >= 0.1) return 6;
  if (abs >= 0.01) return 7;
  return 8;
}

/** 匯率格式化：動態 fraction digits，至少 4、最多 8，避免「USD/TWD 30.41 永遠不動」假象。 */
export function formatFxRate(rate: number): string {
  const digits = fxFractionDigits(rate);
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(rate);
}

/** 匯率變動量：以同樣的 fraction digits 顯示，符號前置。 */
export function formatFxDelta(delta: number, baseRate: number): string {
  const digits = fxFractionDigits(baseRate);
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const abs = Math.abs(delta);
  return `${sign}${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(abs)}`;
}

export function formatPercent(value: number, digits = 2): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** 細變動百分比：用 3~4 位數，呈現匯率類微幅波動（< 0.01%）。 */
export function formatFinePercent(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1 ? 2 : abs >= 0.1 ? 3 : 4;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${abs.toFixed(digits)}%`;
}

export function nonNull<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

export function groupBy<T, K extends string | number>(
  arr: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of arr) {
    const key = keyFn(item);
    if (!out[key]) out[key] = [];
    out[key].push(item);
  }
  return out;
}

export function sum<T>(arr: T[], picker: (item: T) => number): number {
  return arr.reduce((acc, it) => acc + picker(it), 0);
}

export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  wait: number,
): (...args: TArgs) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: TArgs) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
