import { RouterProvider } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider, removeOldestQuery } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import superjson from 'superjson';
import { Toaster } from 'sonner';
import { router } from './router';
import { useInitAuth } from './hooks/use-auth';
import { useInitTheme } from './hooks/use-theme';
import { useThemeStore } from './stores/theme-store';
import { ErrorBoundary } from './components/error-boundary';
import { ConfirmProvider } from './components/ui/confirm';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30 * 1000,
      // 給 persist 用：長 gcTime 才不會離線時被清掉
      gcTime: 24 * 60 * 60 * 1000,
    },
  },
});

// 用 superjson 才能正確序列化/反序列化 Date / Map / Set 等型別。
// JSON.stringify 預設會把 Date 變成 ISO 字串、rehydrate 後就不再是 Date。
// 改 cache key 強制清掉舊的壞掉 cache。
const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: 'personal-hub:query-cache:v2',
  throttleTime: 1000,
  serialize: (v) => superjson.stringify(v),
  deserialize: (v) => superjson.parse(v),
  // localStorage 約 5 MB：寫滿時丟掉最舊的 query 再試，而不是整份 cache 靜默寫入失敗（稽核 O5）
  retry: removeOldestQuery,
});

/**
 * 不落 localStorage 的 query 家族：
 * - 高頻變動（transactions / portfolio）：避免離線時顯示陳舊「0 筆」
 * - 大量時序資料（K 線、歷史快照、雷達、回測）：一個就可能上百 KB，會把 5 MB 擠爆、
 *   而且離線時看舊的走勢圖意義不大
 */
const NON_PERSISTED_QUERY_PREFIXES = [
  'transactions', 'transactions-deleted', 'portfolio',
  'stock-candles', 'stock-history', 'fx-candles', 'flight-watch-snapshots',
  'portfolio-snapshots', 'net-worth-snapshots',
  'stock-radar', 'swing-', 'taifex',
  'error-logs', 'audit-logs', 'alert-logs', 'ai-usage-summary',
];

function shouldPersistQueryKey(key: unknown): boolean {
  if (typeof key !== 'string') return true;
  return !NON_PERSISTED_QUERY_PREFIXES.some((p) => key === p || key.startsWith(p));
}

// 一次性清舊 v1 cache，避免殘留壞掉資料
if (typeof window !== 'undefined') {
  try { window.localStorage.removeItem('personal-hub:query-cache'); } catch { /* ignore */ }
  // 清掉舊離線 queue：之前的設計會把線上交易也誤塞進來（因 navigator.onLine 不可靠），
  // 改用 Firestore 原生離線之後這個 queue 已棄用。把殘留資料丟掉。
  try { window.localStorage.removeItem('personal-hub:offline-queue:v1'); } catch { /* ignore */ }
}

function AppShell() {
  useInitAuth();
  useInitTheme();
  const resolved = useThemeStore((s) => s.resolved);
  return (
    <>
      <RouterProvider router={router} />
      <Toaster
        richColors
        position="top-center"
        theme={resolved}
        closeButton
        // PWA standalone 模式下 top-center 會被瀏海 / 動態島蓋住，往下讓出 safe area
        offset="calc(env(safe-area-inset-top) + 12px)"
        toastOptions={{ duration: 3500 }}
      />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary scope="App">
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: 24 * 60 * 60 * 1000,
          // 只 persist 成功、且不在 NON_PERSISTED_QUERY_PREFIXES 的 query
          dehydrateOptions: {
            shouldDehydrateQuery: (q) => q.state.status === 'success' && shouldPersistQueryKey(q.queryKey[0]),
          },
        }}
      >
        <ConfirmProvider>
          <AppShell />
        </ConfirmProvider>
      </PersistQueryClientProvider>
    </ErrorBoundary>
  );
}
