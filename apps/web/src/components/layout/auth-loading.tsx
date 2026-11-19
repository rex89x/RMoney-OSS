import { Loader2 } from 'lucide-react';

export function AuthLoading({ message = '載入中…' }: { message?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background text-muted-foreground">
      <Loader2 className="size-8 animate-spin text-primary" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
