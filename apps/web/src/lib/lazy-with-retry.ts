import { lazy, type ComponentType } from 'react';

/**
 * 部署後的 stale-chunk 自癒包裝。
 *
 * 場景：使用者在某次部署前就把 app 開著（PWA `registerType: 'autoUpdate'`，
 * Workbox 會清掉 outdated precache）。新版部署後，舊分頁仍持有舊的 index.html
 * 與舊 chunk hash；當使用者 lazy 導航到某頁時，動態 import 舊 chunk 會丟出
 * "Importing a module script failed" / "Failed to fetch dynamically imported module"，
 * 被 ErrorBoundary 接住變成整頁錯誤。
 *
 * 修法：偵測到 chunk 載入錯誤時，做「一次性」整頁 reload。index.html 是
 * `no-cache`（見 firebase.json），reload 會抓到新版 index + 新 chunk hash，
 * 載入即恢復。用 sessionStorage 旗標避免無限 reload；任何一次成功載入即清旗標，
 * 讓未來真正的新部署仍能再觸發一次自癒。
 */

const RELOAD_FLAG = 'ph:chunk-reloaded';

function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|dynamically imported module/i.test(
    message,
  );
}

// 以 props 型別 P 為泛型（而不是 ComponentType<unknown>），有 props 的元件也能 lazy
export function lazyWithRetry<P extends object>(
  factory: () => Promise<{ default: ComponentType<P> }>,
) {
  type T = ComponentType<P>;
  return lazy(async () => {
    try {
      const module = await factory();
      window.sessionStorage.removeItem(RELOAD_FLAG);
      return module;
    } catch (error) {
      if (isChunkLoadError(error) && !window.sessionStorage.getItem(RELOAD_FLAG)) {
        window.sessionStorage.setItem(RELOAD_FLAG, '1');
        window.location.reload();
        // reload 進行中，回傳永不 resolve 的 promise，避免閃一下錯誤畫面
        return new Promise<{ default: T }>(() => {});
      }
      throw error;
    }
  });
}
