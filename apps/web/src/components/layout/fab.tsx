import { Suspense, useRef, useState, type PointerEvent } from 'react';
import { HandCoins, PiggyBank, Plus, TrendingUp, Undo2, WalletCards } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useActiveHousehold } from '@/features/household/hooks';
import { memberCan } from '@/features/household/types';
import { lazyWithRetry } from '@/lib/lazy-with-retry';
import { useAuth } from '@/hooks/use-auth';
import { useQuickEntryStore } from '@/stores/quick-entry-store';
import { cn } from '@/lib/utils';

// 共同帳三個 dialog（含 date-picker / 表單）只在第一次點開時才載入，不進首屏 bundle
const HouseholdEntryDialog = lazyWithRetry(async () => {
  const m = await import('@/features/household/components/household-entry-dialog');
  return { default: m.HouseholdEntryDialog };
});
const HouseholdFundEntryDialog = lazyWithRetry(async () => {
  const m = await import('@/features/household/components/household-fund-entry-dialog');
  return { default: m.HouseholdFundEntryDialog };
});
const HouseholdFundReimburseDialog = lazyWithRetry(async () => {
  const m = await import('@/features/household/components/household-fund-reimburse-dialog');
  return { default: m.HouseholdFundReimburseDialog };
});

interface FabProps {
  className?: string;
}

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

export function Fab({ className }: FabProps) {
  const openDialog = useQuickEntryStore((s) => s.openDialog);
  const { user, isMember } = useAuth();
  const household = useActiveHousehold();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [householdEntryOpen, setHouseholdEntryOpen] = useState(false);
  const [fundEntryOpen, setFundEntryOpen] = useState(false);
  const [reimburseOpen, setReimburseOpen] = useState(false);
  // 打開過一次就保持掛載（關閉動畫才會正常），沒打開過就不載入 chunk
  const [mounted, setMounted] = useState({ entry: false, fund: false, reimburse: false });
  if (householdEntryOpen && !mounted.entry) setMounted((m) => ({ ...m, entry: true }));
  if (fundEntryOpen && !mounted.fund) setMounted((m) => ({ ...m, fund: true }));
  if (reimburseOpen && !mounted.reimburse) setMounted((m) => ({ ...m, reimburse: true }));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const canAddShared = memberCan(household, user?.uid, 'canAddExpense');
  const canManageFund = memberCan(household, user?.uid, 'canManageFund');

  function openAfterLauncherClose(action: () => void) {
    setLauncherOpen(false);
    window.setTimeout(action, 120);
  }

  function handlePrimaryClick() {
    if (household) setLauncherOpen(true);
    else openDialog('expense');
  }

  function startLongPress(e: PointerEvent) {
    longPressed.current = false;
    pressStart.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => {
      longPressed.current = true;
      if ('vibrate' in navigator) navigator.vibrate?.(25);
      if (isMember || household) setLauncherOpen(true);
      else openDialog('income');
    }, LONG_PRESS_MS);
  }
  function cancelLongPress() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }
  /** 手指稍微抖動（< 10px）不算移動，不然長按很難成功 */
  function onPointerMove(e: PointerEvent) {
    const start = pressStart.current;
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE_PX) cancelLongPress();
  }

  // Member 沒有啟用中的 household 時，個人快速記帳沒掛載，按了沒反應 → 不顯示
  if (isMember && !household) return null;

  return (
    <>
    <Button
      aria-label={household ? '選擇新增個人、共同或公基金紀錄' : '快速記帳（長按為收入）'}
      size="icon"
      className={cn(
        'fixed right-5 z-40 size-14 touch-manipulation select-none rounded-full shadow-lg transition-transform [-webkit-touch-callout:none] active:scale-95',
        'bottom-[calc(env(safe-area-inset-bottom)+72px)] lg:bottom-8',
        className,
      )}
      onClick={() => {
        if (longPressed.current) { longPressed.current = false; return; }
        handlePrimaryClick();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (isMember || household) setLauncherOpen(true);
        else openDialog('income');
      }}
      // Pointer Events 統一處理觸控 / 滑鼠：舊版 touch + mouse 雙掛，觸控後瀏覽器補發的
      // mousedown 會把 longPressed 重設，造成長按開收入後又觸發一次 click 開支出
      onPointerDown={startLongPress}
      onPointerMove={onPointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
    >
      <Plus className="size-7" />
    </Button>
    {household ? (
      <>
        <ResponsiveDialog
          open={launcherOpen}
          onOpenChange={setLauncherOpen}
          title="新增紀錄"
          description={`選擇要記到個人帳本或「${household.name}」`}
          contentClassName="sm:max-w-sm"
        >
          <div className="grid gap-2">
            {!isMember ? (
              <>
                <button
                  type="button"
                  className="flex items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted"
                  onClick={() => openAfterLauncherClose(() => openDialog('expense'))}
                >
                  <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary"><WalletCards className="size-5" /></span>
                  <span><span className="block font-medium">個人支出</span><span className="text-xs text-muted-foreground">只記到自己的帳本</span></span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted"
                  onClick={() => openAfterLauncherClose(() => openDialog('income'))}
                >
                  <span className="flex size-10 items-center justify-center rounded-full bg-success/10 text-success"><TrendingUp className="size-5" /></span>
                  <span><span className="block font-medium">個人收入</span><span className="text-xs text-muted-foreground">薪資、退款或其他收入</span></span>
                </button>
              </>
            ) : null}
            <button
              type="button"
              disabled={!canAddShared}
              className="flex items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => openAfterLauncherClose(() => setHouseholdEntryOpen(true))}
            >
              <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary"><HandCoins className="size-5" /></span>
              <span><span className="block font-medium">共同支出</span><span className="text-xs text-muted-foreground">選擇誰付款、如何分攤或由公基金支付</span></span>
            </button>
            <button
              type="button"
              disabled={!canAddShared}
              className="flex items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => openAfterLauncherClose(() => setFundEntryOpen(true))}
            >
              <span className="flex size-10 items-center justify-center rounded-full bg-warning/15 text-warning"><PiggyBank className="size-5" /></span>
              <span><span className="block font-medium">存入公基金</span><span className="text-xs text-muted-foreground">成員把自己的錢放進公基金（公基金 ＋）</span></span>
            </button>
            {canManageFund ? (
              <button
                type="button"
                className="flex items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted"
                onClick={() => openAfterLauncherClose(() => setReimburseOpen(true))}
              >
                <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"><Undo2 className="size-5" /></span>
                <span><span className="block font-medium">公基金補錢給先墊的人</span><span className="text-xs text-muted-foreground">有人先墊、公基金轉帳還他（公基金 −）</span></span>
              </button>
            ) : null}
          </div>
        </ResponsiveDialog>
        <Suspense fallback={null}>
          {mounted.entry ? (
            <HouseholdEntryDialog household={household} open={householdEntryOpen} onOpenChange={setHouseholdEntryOpen} />
          ) : null}
          {mounted.fund ? (
            <HouseholdFundEntryDialog household={household} open={fundEntryOpen} onOpenChange={setFundEntryOpen} />
          ) : null}
          {mounted.reimburse ? (
            <HouseholdFundReimburseDialog household={household} open={reimburseOpen} toUid={null} onOpenChange={setReimburseOpen} />
          ) : null}
        </Suspense>
      </>
    ) : null}
    </>
  );
}
