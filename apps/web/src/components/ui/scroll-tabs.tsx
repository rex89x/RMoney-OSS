import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { TabsList, TabsTrigger } from './tabs';
import { cn } from '@/lib/utils';

export interface ScrollTabItem {
  value: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** 右上角小紅點 / 數字（例：待結算） */
  badge?: ReactNode;
}

interface ScrollTabsListProps {
  items: ScrollTabItem[];
  /** 目前選中的 value（用來把選中的分頁捲進畫面） */
  value: string;
  className?: string;
  'aria-label'?: string;
}

/**
 * 手機友善的分頁列：分頁多時橫向捲動（不壓縮、不換行、不需要轉橫向），
 * 選中的分頁自動捲到中間，兩側有漸層提示「還有更多」。桌面上分頁夠放時就是一般的 segmented tabs。
 * 必須放在 Radix `<Tabs>` 裡。
 */
export function ScrollTabsList({ items, value, className, ...rest }: ScrollTabsListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const update = () => setEdges({
      left: list.scrollLeft > 4,
      right: list.scrollLeft + list.clientWidth < list.scrollWidth - 4,
    });
    update();
    list.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      list.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [items.length]);

  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[data-state="active"]');
    if (!list || !active) return;
    const target = active.offsetLeft - (list.clientWidth - active.offsetWidth) / 2;
    list.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }, [value]);

  return (
    <div className={cn('relative', className)}>
      <TabsList
        ref={listRef}
        aria-label={rest['aria-label']}
        className="scrollbar-none flex h-auto w-full snap-x justify-start gap-1 overflow-x-auto overscroll-x-contain p-1"
      >
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className="relative h-9 shrink-0 snap-start gap-1.5 px-3 sm:flex-1"
          >
            {item.icon ? <item.icon className="size-4" aria-hidden /> : null}
            {item.label}
            {item.badge != null ? (
              <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 text-destructive-foreground">
                {item.badge}
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-6 rounded-l-md bg-gradient-to-r from-muted to-transparent transition-opacity',
          edges.left ? 'opacity-100' : 'opacity-0',
        )}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-md bg-gradient-to-l from-muted to-transparent transition-opacity',
          edges.right ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}
