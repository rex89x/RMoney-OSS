import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { useSwipeToDelete } from '@/hooks/use-swipe-to-delete';
import { cn } from '@/lib/utils';

interface Props {
  children: ReactNode;
  onDelete: () => void;
  className?: string;
  /** 拖到多左才觸發刪除（px），預設 -80（再小容易誤觸） */
  threshold?: number;
}

/**
 * 通用 swipe-to-delete 列容器。手機上向左滑即觸發 delete callback。
 * 手勢邏輯（方向鎖定、拖曳中不套 transition）在 `useSwipeToDelete`。
 */
export function SwipeRow({ children, onDelete, className, threshold = -80 }: Props) {
  const { offset, handlers } = useSwipeToDelete({ onDelete, threshold });

  return (
    <div className={cn('relative overflow-hidden rounded-xl', className)}>
      <div
        className={cn(
          'absolute inset-0 flex items-center justify-end bg-destructive px-4 transition-opacity',
          offset < -10 ? 'opacity-100' : 'opacity-0',
        )}
      >
        <Trash2 className="size-5 text-destructive-foreground" />
      </div>
      <div
        {...handlers}
        style={{ transform: `translateX(${offset}px)` }}
        className={cn('relative touch-pan-y', offset === 0 && 'transition-transform')}
      >
        {children}
      </div>
    </div>
  );
}
