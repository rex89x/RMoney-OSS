import { create } from 'zustand';

/** 通知中心面板開關：鈴鐺散在側欄 / 首頁 / 「更多」面板，面板本身只在 AppLayout 掛一份 */
interface NotificationCenterState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useNotificationCenterStore = create<NotificationCenterState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
