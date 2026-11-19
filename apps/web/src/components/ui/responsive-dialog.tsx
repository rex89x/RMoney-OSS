import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from './dialog';
import { Button } from './button';
import { useIsDesktop } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  contentClassName?: string;
}

/**
 * Dialog on desktop (>=1024px); keyboard-safe full-screen panel on mobile.
 * Unifies the UX for all "action dialog" surfaces.
 */
export function ResponsiveDialog({
  open, onOpenChange, title, description, children, footer, contentClassName,
}: Props) {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    // 取代 DialogContent 預設 padding，改成 flex-col + sticky footer，避免內容超出時 footer 點不到
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={cn('flex flex-col gap-0 p-0 overflow-hidden', contentClassName)}>
          <DialogHeader className="shrink-0 border-b p-6 pb-4 text-left">
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
          {footer ? (
            <div className="shrink-0 border-t bg-background px-6 py-3">{footer}</div>
          ) : null}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <MobileDialogPanel
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={footer}
      contentClassName={contentClassName}
    >
      {children}
    </MobileDialogPanel>
  );
}

function MobileDialogPanel({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  contentClassName,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState({ height: 0, top: 0 });
  const titleId = useId();
  const descId = useId();

  // 外接鍵盤 / iPad：Esc 關閉（桌面 Radix Dialog 原本就有）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    const original = {
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };

    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.position = original.position;
      document.body.style.top = original.top;
      document.body.style.width = original.width;
      document.body.style.overflow = original.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const syncFrame = () => {
      setFrame({
        height: Math.floor(viewport?.height ?? window.innerHeight),
        top: Math.floor(viewport?.offsetTop ?? 0),
      });
    };

    syncFrame();
    viewport?.addEventListener('resize', syncFrame);
    viewport?.addEventListener('scroll', syncFrame);
    window.addEventListener('orientationchange', syncFrame);

    return () => {
      viewport?.removeEventListener('resize', syncFrame);
      viewport?.removeEventListener('scroll', syncFrame);
      window.removeEventListener('orientationchange', syncFrame);
    };
  }, [open]);

  function keepFocusedControlVisible(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    window.setTimeout(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;

      const scrollerRect = scroller.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const bottomLimit = scrollerRect.bottom - 24;
      const topLimit = scrollerRect.top + 24;

      if (targetRect.bottom > bottomLimit) {
        scroller.scrollTop += targetRect.bottom - bottomLimit;
      } else if (targetRect.top < topLimit) {
        scroller.scrollTop -= topLimit - targetRect.top;
      }
    }, 320);
  }

  if (!open) return null;

  const height = frame.height || window.innerHeight;
  const panel = (
    <div className="fixed inset-0 z-50 bg-black/60 duration-200 animate-in fade-in-0">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cn(
          'fixed inset-x-0 flex flex-col bg-background text-foreground duration-200 animate-in slide-in-from-bottom-4 motion-reduce:animate-none',
          contentClassName,
        )}
        style={{ top: frame.top, height }}
      >
        <header className="shrink-0 border-b bg-background px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold leading-tight">{title}</h2>
              {description ? <p id={descId} className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="關閉">
              <X className="size-5" />
            </Button>
          </div>
        </header>
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
          onFocusCapture={(event) => keepFocusedControlVisible(event.target)}
        >
          {children}
        </div>
        {footer ? (
          <div className="shrink-0 border-t bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
