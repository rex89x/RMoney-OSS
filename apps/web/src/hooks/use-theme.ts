import { useEffect } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { useThemeStore } from '@/stores/theme-store';
import { useAuthStore } from '@/stores/auth-store';
import { db } from '@/lib/firebase';
import type { ThemeMode } from '@/types/global';

const LS_KEY = 'theme';
const META_SELECTOR = 'meta[name="theme-color"]';

function applyResolved(resolved: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  const meta = document.querySelector(META_SELECTOR);
  if (meta) {
    meta.setAttribute('content', resolved === 'dark' ? '#0a0a0a' : '#ffffff');
  }
}

export function useInitTheme() {
  const { mode, setMode, setResolved } = useThemeStore();
  const user = useAuthStore((s) => s.user);
  const profile = useAuthStore((s) => s.profile);

  // Hydrate from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(LS_KEY) as ThemeMode | null;
    if (stored === 'auto' || stored === 'light' || stored === 'dark') {
      setMode(stored);
    } else {
      setMode('auto');
    }
  }, [setMode]);

  // When profile loads with a theme preference, sync it down (profile wins)
  useEffect(() => {
    if (profile?.preferences?.theme) {
      const t = profile.preferences.theme;
      localStorage.setItem(LS_KEY, t);
      setMode(t);
    }
  }, [profile, setMode]);

  // Apply mode + watch system changes when auto
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const compute = (): 'light' | 'dark' => {
      if (mode === 'auto') return media.matches ? 'dark' : 'light';
      return mode;
    };
    const resolved = compute();
    setResolved(resolved);
    applyResolved(resolved);
    localStorage.setItem(LS_KEY, mode);

    if (mode === 'auto') {
      const handler = () => {
        const r = media.matches ? 'dark' : 'light';
        setResolved(r);
        applyResolved(r);
      };
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    }
    return undefined;
  }, [mode, setResolved]);

  // Persist to Firestore when user + mode changes
  useEffect(() => {
    if (!user) return;
    if (!profile) return;
    if (profile.preferences?.theme === mode) return;
    // 只寫 theme：以前把登入時讀到的整份 preferences 一起寫回，同一個 session 裡後來改過的其他設定
    //（成本法、Inbox 略過、首頁卡片順序…）會被舊值蓋回去。setDoc merge 對巢狀 map 是深層合併，只給 theme 就只動 theme。
    void setDoc(
      doc(db, 'users', user.uid),
      { preferences: { theme: mode } },
      { merge: true },
    ).catch((err) => {
      console.error('[useInitTheme] persist failed', err);
    });
  }, [mode, user, profile]);
}

export function useTheme() {
  const { mode, resolved } = useThemeStore();
  const setMode = useThemeStore((s) => s.setMode);
  return { mode, resolved, setMode };
}
