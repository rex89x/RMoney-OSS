import { daysBetweenTWDates, formatTW } from '@/lib/tz';

/** 列表一次最多拿幾筆（CLAUDE.md §5.6：列表強制 limit） */
export const NOTIFICATIONS_LIMIT = 50;

export function countUnread(items: ReadonlyArray<{ readAt: Date | null }>): number {
  return items.reduce((n, item) => (item.readAt ? n : n + 1), 0);
}

/** 徽章文字：超過 99 顯示 99+ */
export function formatUnreadBadge(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

/**
 * 只接受站內絕對路徑（`/xxx`），擋掉 `//evil.com`、`https://…`、`javascript:` 等，
 * doc 內容由 GAS 寫入，但前端仍當作不可信輸入（CLAUDE.md §5.8）。
 */
export function safeNotificationLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string') return null;
  const trimmed = link.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) return null;
  // 空白與控制字元（code < 0x20）都不該出現在站內路徑
  if (/\s/.test(trimmed) || [...trimmed].some((ch) => ch.charCodeAt(0) < 0x20)) return null;
  return trimmed;
}

/**
 * 相對時間（台北時區）：剛剛 / N 分鐘前 / N 小時前（同一天）/ 昨天 HH:mm / 今年 MM/dd HH:mm / yyyy/MM/dd。
 */
export function formatNotificationTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const days = daysBetweenTWDates(date, now);
  if (diffMs >= 0 && diffMs < 60_000) return '剛剛';
  if (diffMs >= 0 && diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分鐘前`;
  if (days === 0 && diffMs >= 0) return `${Math.floor(diffMs / 3_600_000)} 小時前`;
  if (days === 1) return `昨天 ${formatTW(date, 'HH:mm')}`;
  if (formatTW(date, 'yyyy') === formatTW(now, 'yyyy')) return formatTW(date, 'MM/dd HH:mm');
  return formatTW(date, 'yyyy/MM/dd');
}
