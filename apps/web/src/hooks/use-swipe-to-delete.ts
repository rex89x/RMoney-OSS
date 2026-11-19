import { useRef, useState, type TouchEvent } from 'react';

interface Options {
  onDelete: () => void;
  /** 拖到多左才觸發刪除（px，負數），預設 -80 */
  threshold?: number;
  /** 最多可以拖多遠（px，負數），預設 -100 */
  maxOffset?: number;
}

/** 手指移動超過這個距離才判斷是「橫滑」還是「直捲」 */
const DIRECTION_LOCK_PX = 8;

/**
 * 手機 swipe-to-delete 共用邏輯。
 * - 方向鎖定：一開始偏垂直就當作捲動頁面，整個手勢都不會位移 / 觸發刪除
 *   （避免上下捲列表時手指稍微往左偏就跳出刪除確認）
 * - 有橫滑過的手勢會吞掉接下來的 click，不會滑完又打開編輯
 */
export function useSwipeToDelete({ onDelete, threshold = -80, maxOffset = -100 }: Options) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const mode = useRef<'pending' | 'swipe' | 'scroll'>('pending');
  const swiped = useRef(false);

  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    start.current = { x: t.clientX, y: t.clientY };
    mode.current = 'pending';
    swiped.current = false;
  }

  function onTouchMove(e: TouchEvent) {
    const t = e.touches[0];
    if (!start.current || !t) return;
    const dx = t.clientX - start.current.x;
    const dy = t.clientY - start.current.y;
    if (mode.current === 'pending') {
      if (Math.abs(dx) < DIRECTION_LOCK_PX && Math.abs(dy) < DIRECTION_LOCK_PX) return;
      mode.current = Math.abs(dx) > Math.abs(dy) * 1.2 && dx < 0 ? 'swipe' : 'scroll';
    }
    if (mode.current !== 'swipe') return;
    swiped.current = true;
    setOffset(Math.max(Math.min(dx, 0), maxOffset));
  }

  function onTouchEnd() {
    if (mode.current === 'swipe' && offset <= threshold) {
      if ('vibrate' in navigator) navigator.vibrate?.([20, 15, 20]);
      onDelete();
    }
    setOffset(0);
    start.current = null;
    mode.current = 'pending';
  }

  /** 包在 onClick 外層：剛剛是橫滑手勢就不要觸發 click */
  function guardClick(handler: () => void) {
    return () => {
      if (swiped.current) {
        swiped.current = false;
        return;
      }
      handler();
    };
  }

  return {
    offset,
    guardClick,
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd },
  };
}
