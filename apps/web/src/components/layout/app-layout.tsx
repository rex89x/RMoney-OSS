import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Plane } from 'lucide-react';
import { Sidebar } from './sidebar';
import { TabBar } from './tab-bar';
import { Fab } from './fab';
import { OfflineIndicator } from './offline-indicator';
import { lazyWithRetry } from '@/lib/lazy-with-retry';
import { useAuth } from '@/hooks/use-auth';
import { useQuickEntryStore } from '@/stores/quick-entry-store';

// 全域 dialog 改 lazy：它們把 markdown / day-picker / 記帳 / 共同帳元件整包拉進首屏（index chunk 600 KB+）。
// 首屏畫完後才載入，store 狀態（quick-entry-store / ask-store）不受影響。
const QuickEntryDialog = lazyWithRetry(async () => {
  const m = await import('@/features/ledger/components/quick-entry-dialog');
  return { default: m.QuickEntryDialog };
});
const AskFinanceDialog = lazyWithRetry(async () => {
  const m = await import('@/features/ask');
  return { default: m.AskFinanceDialog };
});
const CommandPalette = lazyWithRetry(async () => {
  const m = await import('@/components/command-palette');
  return { default: m.CommandPalette };
});
const HotkeysCheatsheet = lazyWithRetry(async () => {
  const m = await import('@/components/hotkeys-cheatsheet');
  return { default: m.HotkeysCheatsheet };
});
const NotificationCenter = lazyWithRetry(async () => {
  const m = await import('@/features/notifications/components/notification-center');
  return { default: m.NotificationCenter };
});

/** PWA shortcut：`/?quickEntry=expense|income` 開啟後直接彈出快速記帳，並清掉 query */
function useQuickEntryFromUrl(enabled: boolean) {
  const [params, setParams] = useSearchParams();
  const openDialog = useQuickEntryStore((s) => s.openDialog);
  const kind = params.get('quickEntry');
  useEffect(() => {
    if (!enabled || !kind) return;
    if (kind === 'expense' || kind === 'income') openDialog(kind);
    const next = new URLSearchParams(params);
    next.delete('quickEntry');
    setParams(next, { replace: true });
  }, [enabled, kind, openDialog, params, setParams]);
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const hideFab = pathname.startsWith('/login');
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const { isViewer, isMember } = useAuth();
  useQuickEntryFromUrl(!isViewer && !isMember);

  if (isViewer) {
    // Viewer 模式：拿掉 Sidebar / TabBar / FAB / QuickEntry / 全域 CommandPalette。
    // 只留純內容 + 登出按鈕。
    return (
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/90 px-4 py-2 backdrop-blur safe-top">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Plane className="size-4" /> 旅程分享
          </div>
          <GuestSignOutButton />
        </header>
        <main className="flex flex-1 flex-col overflow-x-clip">
          <div className="mx-auto w-full max-w-3xl flex-1 px-4 pb-8 pt-4 lg:px-8 lg:pt-6">
            {children}
          </div>
        </main>
        <OfflineIndicator />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <Sidebar />
      <main className="flex min-h-dvh min-w-0 flex-1 flex-col overflow-x-clip pb-[calc(env(safe-area-inset-bottom)+60px)] lg:pb-0">
        {/* 手機底部多留 ~80px 給右下角 FAB，最後一列的金額 / 分頁按鈕才不會被蓋住 */}
        <div className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-[calc(env(safe-area-inset-top)+1.25rem)] lg:px-8 lg:pb-6 lg:pt-6">
          {children}
        </div>
      </main>
      <TabBar />
      {!hideFab ? <Fab /> : null}
      <Suspense fallback={null}>
        {/* 快速記帳對 member 也掛上（旅程頁「新增花費」、共同支出都走它；帳戶欄位在元件內只給 owner） */}
        <QuickEntryDialog />
        {!isMember ? (
          <>
            <AskFinanceDialog />
            <CommandPalette onOpenCheatsheet={() => setCheatsheetOpen(true)} />
            <HotkeysCheatsheet open={cheatsheetOpen} onOpenChange={setCheatsheetOpen} />
            {/* 通知中心面板（owner-only，元件內判斷）；鈴鐺在側欄 / 首頁 / 「更多」面板 */}
            <NotificationCenter />
          </>
        ) : null}
      </Suspense>
      <OfflineIndicator />
    </div>
  );
}

function GuestSignOutButton() {
  return (
    <button
      type="button"
      onClick={async () => {
        const { signOutAndClear } = await import('@/hooks/use-auth');
        void signOutAndClear();
      }}
      className="rounded-md border px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      登出
    </button>
  );
}
