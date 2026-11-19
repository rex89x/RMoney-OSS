import { create } from 'zustand';
import type { ThemeMode } from '@/types/global';

interface ThemeState {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
  setResolved: (r: 'light' | 'dark') => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: 'auto',
  resolved: 'light',
  setMode: (mode) => set({ mode }),
  setResolved: (resolved) => set({ resolved }),
}));
