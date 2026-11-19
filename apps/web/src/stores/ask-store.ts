import { create } from 'zustand';

interface AskState {
  open: boolean;
  initialQuestion: string;
  openAsk: (question?: string) => void;
  closeAsk: () => void;
}

export const useAskStore = create<AskState>((set) => ({
  open: false,
  initialQuestion: '',
  openAsk: (question = '') => set({ open: true, initialQuestion: question }),
  closeAsk: () => set({ open: false }),
}));
