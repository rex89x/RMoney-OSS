import { registerSW } from 'virtual:pwa-register';

/** 已安裝的 PWA（尤其 iOS 主畫面）常常整天不重新載入，只靠開啟時檢查會一直停在舊版。 */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * 註冊 service worker，並在「每 30 分鐘」與「app 回到前景」時檢查新版。
 * registerType 是 autoUpdate：找到新版會自動啟用並重新整理頁面，不用另外提示。
 */
export function registerPwaUpdates(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      const check = () => {
        if (!navigator.onLine) return;
        registration.update().catch((err: unknown) => console.warn('[pwaUpdateCheck]', err));
      };
      window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
    onRegisterError(err: unknown) {
      console.error('[registerSW]', err);
    },
  });
}
