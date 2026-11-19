import { useEffect } from 'react';
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  clearIndexedDbPersistence,
  terminate,
} from 'firebase/firestore';
import { toast } from 'sonner';
import {
  auth,
  db,
  getRedirectResult,
  googleProvider,
  onAuthStateChanged,
  signInWithRedirect,
  signOut,
  type User,
} from '@/lib/firebase';
import { useAuthStore } from '@/stores/auth-store';
import type { UserDoc, UserRole } from '@/types/global';
import { tsToDate } from '@/lib/converters';
import { WHITELIST_HASH_DOCS, emailHash } from '@/lib/email-hash';
import { clearJoinCode, getPendingJoinCode, rememberDeniedEmail } from '@/lib/join-code';

export function useInitAuth() {
  const { setChecking, setAuthed, setUnauthed } = useAuthStore();

  useEffect(() => {
    // 1. Pick up redirect result first (may be null on cold load — OK)
    getRedirectResult(auth).catch((err) => {
      console.error('[getRedirectResult]', err);
      toast.error(err instanceof Error ? err.message : '登入失敗');
    });

    // 2. Watch auth state
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setUnauthed();
        return;
      }
      setChecking();
      try {
        // Whitelist check（full / guest / denied）
        let access = await checkEmailAccess(user.email ?? '');
        if (access === 'denied') {
          // 邀請連結（/login?join=CODE）：還不在白名單但手上有碼 → 請 Apps Script 驗碼、加白名單 + 共同帳本
          const code = getPendingJoinCode();
          if (code) {
            try {
              const { callAppsScript } = await import('@/lib/apps-script');
              await callAppsScript('joinHousehold', undefined, { code });
              clearJoinCode();
              toast.success('已加入共同帳本');
              access = 'full';
            } catch (err) {
              console.error('[joinHousehold]', err);
              clearJoinCode();
              toast.error(joinErrorMessage(err));
            }
          }
        }
        if (access === 'denied') {
          rememberDeniedEmail(user.email ?? '');
          await signOut(auth);
          toast.error('此帳號無使用權限');
          setUnauthed();
          return;
        }
        const profile = await ensureUserDoc(user, access);
        setAuthed(user, profile);
        // admin 登入時補齊 / 修正白名單雜湊 doc（best-effort；非 admin 沒有 config 寫入權限所以不跑）
        if (profile.role === 'admin') {
          try {
            const { syncAllWhitelistHashes } = await import('@/features/access/whitelist-hashes');
            void syncAllWhitelistHashes().catch((err) => {
              console.warn('[syncAllWhitelistHashes]', err);
            });
          } catch (err) {
            console.warn('[syncAllWhitelistHashes import]', err);
          }
        }
        // 接受任何在 trip.pendingInvites 等待中的邀請（best-effort）
        try {
          const { callAppsScript } = await import('@/lib/apps-script');
          void callAppsScript('acceptPendingInvites').catch((err) => {
            console.warn('[acceptPendingInvites]', err);
          });
        } catch (err) {
          console.warn('[acceptPendingInvites import]', err);
        }
      } catch (err) {
        console.error('[auth init]', err);
        toast.error(err instanceof Error ? err.message : '登入流程錯誤');
        setUnauthed();
      }
    });
    return () => unsub();
  }, [setAuthed, setChecking, setUnauthed]);
}

export type EmailAccess = 'full' | 'guest' | 'denied';

function joinErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('code-expired')) return '邀請連結已過期或已被使用，請對方重新產生';
  if (raw.includes('code-not-found') || raw.includes('invalid-code')) return '邀請連結無效，請確認連結是否完整';
  return `加入共同帳本失敗：${raw}`;
}

/**
 * 白名單檢查改讀雜湊 doc（任何登入者可讀、但列不出別人的 email，見 lib/email-hash.ts）。
 * 雜湊 doc 尚未建立時（剛部署、admin 還沒登入過一次）退回讀明文 doc —— 明文 doc 只有 admin 讀得到，
 * 所以 admin 一定能進得來並觸發 syncAllWhitelistHashes 補齊；其他人會在雜湊 doc 建好後才通過。
 */
async function emailInHashDoc(hashDocId: string, plainDocId: 'allowedEmails' | 'guestEmails', hash: string, e: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'config', hashDocId));
    if (snap.exists()) {
      const data = snap.data() as { hashes?: unknown } | undefined;
      return Array.isArray(data?.hashes) && data.hashes.some((h) => h === hash);
    }
  } catch (err) {
    console.warn(`[checkEmailAccess ${hashDocId}]`, err);
  }
  try {
    const plain = await getDoc(doc(db, 'config', plainDocId));
    const plainData = plain.data() as { emails?: string[] } | undefined;
    return !!plainData?.emails?.some((x) => String(x).toLowerCase() === e);
  } catch (err) {
    console.warn(`[checkEmailAccess ${plainDocId}]`, err);
    return false;
  }
}

export async function checkEmailAccess(email: string): Promise<EmailAccess> {
  if (!email) return 'denied';
  const e = email.trim().toLowerCase();
  let hash: string;
  try {
    hash = await emailHash(e);
  } catch (err) {
    console.error('[checkEmailAccess hash]', err);
    return 'denied';
  }
  if (await emailInHashDoc(WHITELIST_HASH_DOCS.allowedEmails, 'allowedEmails', hash, e)) return 'full';
  if (await emailInHashDoc(WHITELIST_HASH_DOCS.guestEmails, 'guestEmails', hash, e)) return 'guest';
  // 雜湊 doc 還沒建（剛部署）或剛被加進名單還沒同步：問 Apps Script（以 owner 身分讀明文名單，
  // 任何已登入帳號都能查「自己」），它會順便把雜湊 doc 補齊。這一步只在前面都比不到時才發生。
  try {
    const { callAppsScript } = await import('@/lib/apps-script');
    const res = await callAppsScript<never>('checkAccess');
    const access = res.access;
    if (access === 'full' || access === 'guest') return access;
  } catch (err) {
    console.warn('[checkEmailAccess appsScript]', err);
  }
  return 'denied';
}

export async function isEmailAllowed(email: string): Promise<boolean> {
  return (await checkEmailAccess(email)) !== 'denied';
}

export async function ensureUserDoc(user: User, access: EmailAccess = 'full'): Promise<UserDoc> {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    // 首次登入：viewer 來源 → viewer；其他預設 member。
    // 不再由前端寫 'admin' / 'owner' —— rules 的 users create 只接受 member / viewer（2026-11 稽核 S1），
    // 升級一律在設定 → 權限（admin）或 Firebase console 操作。owner 既有的 admin doc 不受影響。
    const initialRole: UserRole = access === 'guest' ? 'viewer' : 'member';
    const payload = {
      email: user.email ?? '',
      displayName: user.displayName ?? null,
      photoURL: user.photoURL ?? null,
      role: initialRole,
      ledgerSharedWith: [] as string[],
      ledgerEditors: [] as string[],
      preferences: { theme: 'auto' as const, mainCurrency: 'TWD' as const },
      createdAt: serverTimestamp(),
    };
    await setDoc(ref, payload);
    return {
      id: user.uid,
      ...payload,
      createdAt: new Date(),
    };
  }
  const data = snap.data();
  // 讀取 role；前端不再自我升降級（Rules 已禁止使用者自改 role 欄位）。
  // - admin 自我修正：之前的 setDoc(role: 'admin') 已停用；owner 的 doc 在首次建立時就是 admin。
  // - guest 自我降級：改由 Apps Script acceptPendingInvites（admin SDK）處理。
  const role = (data.role as UserRole) ?? 'member';
  void access;
  return {
    id: user.uid,
    email: data.email ?? user.email ?? '',
    displayName: data.displayName ?? user.displayName ?? null,
    photoURL: data.photoURL ?? user.photoURL ?? null,
    role,
    ledgerSharedWith: Array.isArray(data.ledgerSharedWith) ? (data.ledgerSharedWith as string[]) : [],
    ledgerEditors: Array.isArray(data.ledgerEditors) ? (data.ledgerEditors as string[]) : [],
    preferences: data.preferences ?? { theme: 'auto', mainCurrency: 'TWD' },
    createdAt: tsToDate(data.createdAt),
  };
}

export async function signInWithGoogle() {
  await signInWithRedirect(auth, googleProvider);
}

export async function signOutAndClear() {
  try {
    await signOut(auth);
  } catch (err) {
    console.error('[signOut]', err);
  }
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (err) {
    console.error('[clearIndexedDbPersistence]', err);
  }
  window.location.assign('/login');
}

// 額外視為 admin 的 email（逗號分隔，選填）；正式的 admin 判斷以 users/{uid}.role 為準。
const ADMIN_EMAILS = new Set<string>(
  String(import.meta.env.VITE_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}

export function useAuth() {
  const { status, user, profile } = useAuthStore();
  const isAdmin = profile?.role === 'admin' || isAdminEmail(profile?.email);
  // Viewer = 只能看分享給他的旅程；舊稱 'guest' 仍視為 viewer
  const isViewer = profile?.role === 'viewer' || profile?.role === 'guest';
  // Owner = 持有完整帳本 / 投資資料的人（admin 也算）
  const isOwner = isAdmin || profile?.role === 'owner';
  // Member = 被邀請進共同帳本的人（伴侶）：只看得到 /shared、分享的 trips、設定
  const isMember = !isOwner && !isViewer && status === 'authed';
  return { status, user, profile, isAdmin, isViewer, isOwner, isMember };
}
