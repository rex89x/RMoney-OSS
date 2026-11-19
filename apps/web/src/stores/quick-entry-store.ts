import { create } from 'zustand';

type QuickEntryKind = 'expense' | 'income' | 'trip';

interface QuickEntryState {
  open: boolean;
  kind: QuickEntryKind;
  tripId: string | null;
  openDialog: (kind?: QuickEntryKind, tripId?: string | null) => void;
  closeDialog: () => void;
}

export const useQuickEntryStore = create<QuickEntryState>((set) => ({
  open: false,
  kind: 'expense',
  tripId: null,
  openDialog: (kind = 'expense', tripId = null) => set({ open: true, kind, tripId }),
  closeDialog: () => set({ open: false }),
}));
