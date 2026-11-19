import { create } from 'zustand';
import type { User } from 'firebase/auth';
import type { UserDoc } from '@/types/global';

export type AuthStatus = 'checking' | 'unauthed' | 'authed';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  profile: UserDoc | null;
  setChecking: () => void;
  setUnauthed: () => void;
  setAuthed: (user: User, profile: UserDoc) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'checking',
  user: null,
  profile: null,
  setChecking: () => set({ status: 'checking' }),
  setUnauthed: () => set({ status: 'unauthed', user: null, profile: null }),
  setAuthed: (user, profile) => set({ status: 'authed', user, profile }),
}));
