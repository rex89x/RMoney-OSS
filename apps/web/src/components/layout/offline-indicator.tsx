import { WifiOff } from 'lucide-react';
import { useOnline } from '@/hooks/use-online';

export function OfflineIndicator() {
  const online = useOnline();
  if (online) return null;
  // 離線時 Firestore 內建 persistentLocalCache 會自己 queue 寫入，回到線上自動同步
  return (
    <div className="fixed left-1/2 top-[env(safe-area-inset-top,0)] z-50 flex -translate-x-1/2 translate-y-2 items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur">
      <WifiOff className="size-3" />
      <span>離線中 · 操作會在重新連線時同步</span>
    </div>
  );
}
