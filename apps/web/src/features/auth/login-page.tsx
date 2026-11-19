import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth, signInWithGoogle } from '@/hooks/use-auth';
import { AuthLoading } from '@/components/layout/auth-loading';
import { captureJoinCodeFromUrl, clearDeniedEmail, getDeniedEmail } from '@/lib/join-code';
import { toast } from 'sonner';

export function LoginPage() {
  const { status } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  // ?join=CODE 先存進 sessionStorage，登入後 useInitAuth 才拿去呼叫 joinHousehold（redirect 登入會離開本頁）
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [deniedEmail, setDeniedEmail] = useState<string | null>(null);

  useEffect(() => {
    document.title = '登入 · Personal Hub';
    setJoinCode(captureJoinCodeFromUrl());
  }, []);

  // 被白名單擋下時 useInitAuth 會先記下 email 再 signOut → status 變 unauthed，這時才讀得到
  useEffect(() => {
    if (status !== 'unauthed') return;
    const denied = getDeniedEmail();
    if (denied) {
      setDeniedEmail(denied);
      clearDeniedEmail();
    }
  }, [status]);

  if (status === 'checking') return <AuthLoading />;
  if (status === 'authed') return <Navigate to="/" replace />;

  async function handleLogin() {
    setSubmitting(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error('[login]', err);
      toast.error(err instanceof Error ? err.message : '登入失敗');
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Personal Hub</CardTitle>
          <CardDescription>單一使用者個人財務 + 出遊規劃系統</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button
            className="h-11 w-full"
            onClick={handleLogin}
            disabled={submitting}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            使用 Google 登入
          </Button>
          {joinCode ? (
            <p className="text-center text-xs text-muted-foreground">
              你有一條共同帳本邀請連結（{joinCode}）。用要一起記帳的 Google 帳號登入就會自動加入。
            </p>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              僅開放白名單內 Email。登入後會使用 Google 帳號驗證身分。
            </p>
          )}
          {deniedEmail ? (
            <p className="text-center text-xs text-destructive">
              {deniedEmail} 不在白名單內。請確認用的是受邀的 Google 帳號，或請對方重新產生邀請連結。
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
