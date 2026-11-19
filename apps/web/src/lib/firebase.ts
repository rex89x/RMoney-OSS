import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';
import { env, isFirebaseConfigured } from './env';

/**
 * 本機 emulator 模式：`npm run dev:emulator`（= `vite --mode emulator`）。
 * 只在 dev build 生效，production bundle 會把整段 tree-shake 掉；資料與登入全部在本機，
 * 用來做 UI 驗證 / 手機版截圖（seed：`node scripts/seed-emulator.mjs`，見 docs/RUNBOOK.md）。
 */
export const USE_EMULATORS = import.meta.env.DEV && import.meta.env.MODE === 'emulator';

if (!USE_EMULATORS && !isFirebaseConfigured()) {
  console.warn(
    '[firebase] VITE_FIREBASE_* env vars missing — Firebase calls will fail at runtime.',
  );
}

// Eager initialization. A Proxy-based lazy wrapper breaks Firestore's internal
// runtime guards (`collection()` checks the instance via duck-typed _delegate /
// type brands that the Proxy forwards incorrectly). Build still succeeds with
// empty env strings because construction doesn't hit network; only API calls do.
export const app: FirebaseApp = initializeApp(
  USE_EMULATORS ? { apiKey: 'demo-key', authDomain: 'localhost', projectId: 'demo-rmoney', appId: 'demo-app' } : env.firebase,
);

/**
 * Firestore 離線快取版本（CLAUDE.md pitfall #15）。
 * 重大 Rules 變更後，IndexedDB 裡舊的快取文件 / 待送寫入可能被新 Rules 拒絕，造成永遠卡住的寫入或幽靈資料。
 * 遇到這種變更就把這個常數往上加：下次啟動會在 Firestore 開啟 IndexedDB 之前刪掉整個快取 DB。
 * 不要每次部署都改 —— 清快取會讓離線時看不到資料、並重新下載全部監聽中的文件。
 *
 * 歷史：
 *   2026-11-rules — PR #30 收緊 users create / config read / households / transactions tripId
 */
const FIRESTORE_CACHE_VERSION = '2026-11-rules';
const FIRESTORE_CACHE_VERSION_KEY = 'personal-hub:firestore-cache-version';

function wipeStaleFirestoreCache(projectId: string): void {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  try {
    const stored = window.localStorage.getItem(FIRESTORE_CACHE_VERSION_KEY);
    if (stored === FIRESTORE_CACHE_VERSION) return;
    // 名稱格式見 @firebase/firestore indexedDbStoragePrefix：firestore/{persistenceKey}/{projectId}/main。
    // deleteDatabase 是排隊執行的：之後 Firestore 對同名 DB 的 open 會等刪除完成才進行，不會讀到舊資料。
    // 第一次安裝（沒有舊版本紀錄）也會跑一次，對空 DB 無害。
    indexedDB.deleteDatabase(`firestore/[DEFAULT]/${projectId}/main`);
    window.localStorage.setItem(FIRESTORE_CACHE_VERSION_KEY, FIRESTORE_CACHE_VERSION);
  } catch (err) {
    console.warn('[wipeStaleFirestoreCache]', err);
  }
}

if (!USE_EMULATORS && env.firebase.projectId) wipeStaleFirestoreCache(env.firebase.projectId);

export const db: Firestore = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  // 自動丟掉 undefined 欄位（避免 setDoc 因 note/notes/optional 欄位 = undefined 而整筆失敗，
  // 例如 watchlist add、portfolio buy 等流程）
  ignoreUndefinedProperties: true,
});

export const auth = getAuth(app);

/**
 * Storage SDK 約 130 KB，只有收據上傳 / 旅程文件會用到，改成第一次需要時才載入（不進首屏 bundle）。
 */
let storagePromise: Promise<FirebaseStorage> | null = null;
export function getAppStorage(): Promise<FirebaseStorage> {
  storagePromise ??= import('firebase/storage').then(({ getStorage }) => getStorage(app));
  return storagePromise;
}

if (USE_EMULATORS) {
  connectFirestoreEmulator(db, '127.0.0.1', 8085);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  // emulator 專用：用 seed 建好的測試帳號登入（帳號只存在本機 auth emulator）
  (window as unknown as { __devSignIn?: (email: string) => Promise<unknown> }).__devSignIn = (email: string) =>
    signInWithEmailAndPassword(auth, email, 'emulator-only');
}

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export { signInWithRedirect, getRedirectResult, onAuthStateChanged, fbSignOut as signOut };
export type { User };
