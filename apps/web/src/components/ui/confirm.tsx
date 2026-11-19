import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogTitle,
} from '@/components/ui/dialog';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  /** 'danger' 用紅色 destructive 按鈕；'default' 用主色 */
  variant?: 'danger' | 'default';
}

interface ConfirmCtx {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<ConfirmCtx | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [resolver, setResolver] = useState<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      setResolver(() => resolve);
    });
  }, []);

  function handle(v: boolean) {
    setOpen(false);
    resolver?.(v);
    setResolver(null);
  }

  const variant = opts?.variant ?? 'danger';

  return (
    <Ctx.Provider value={{ confirm }}>
      {children}
      {/* 是 / 否確認用精簡的置中對話框：手機上不要整頁蓋掉、按鈕放在拇指好按的位置 */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) handle(false); }}>
        <DialogContent className="max-w-sm gap-5 p-5 sm:p-6">
          <div className="flex items-start gap-3 pr-6">
            <div className={
              variant === 'danger'
                ? 'flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive'
                : 'flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary'
            }>
              <AlertTriangle className="size-5" />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
              <DialogTitle className="text-base leading-snug">{opts?.title ?? ''}</DialogTitle>
              {opts?.description ? (
                <DialogDescription className="break-words">{opts.description}</DialogDescription>
              ) : (
                <DialogDescription className="sr-only">請確認是否繼續</DialogDescription>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 flex-1 sm:h-10" onClick={() => handle(false)}>
              {opts?.cancelText ?? '取消'}
            </Button>
            <Button
              variant={variant === 'danger' ? 'destructive' : 'default'}
              className="h-11 flex-1 sm:h-10"
              onClick={() => handle(true)}
              autoFocus
            >
              {opts?.confirmText ?? '確認'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx.confirm;
}
