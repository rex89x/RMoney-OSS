import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { AuthLoading } from './auth-loading';

/** Guest 唯一允許的路徑：/trips/:id 與其下子頁（notes / itinerary 等） */
function isAllowedGuestPath(pathname: string, allowedTripIds: string[]): boolean {
  const m = /^\/trips\/([^/]+)/.exec(pathname);
  if (!m) return false;
  const id = decodeURIComponent(m[1] ?? '');
  return allowedTripIds.includes(id);
}

/** Member（共同帳本成員）允許的路徑：共同、出遊、機票雷達（只看得到自己的訂閱）、設定 */
const MEMBER_PATH_PREFIXES = ['/shared', '/trips', '/flights', '/settings'];
function isAllowedMemberPath(pathname: string): boolean {
  return MEMBER_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status, user, isViewer, isMember } = useAuth();
  const location = useLocation();
  const [guestTripIds, setGuestTripIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (!isViewer || !user?.uid) return;
    let cancelled = false;
    void (async () => {
      try {
        const snap = await getDocs(
          query(collection(db, 'trips'), where('sharedWith', 'array-contains', user.uid)),
        );
        if (cancelled) return;
        setGuestTripIds(snap.docs.map((d) => d.id));
      } catch (err) {
        console.warn('[guest-trips]', err);
        if (!cancelled) setGuestTripIds([]);
      }
    })();
    return () => { cancelled = true; };
  }, [isViewer, user?.uid]);

  const allowedRoute = useMemo(
    () => (isViewer && guestTripIds ? isAllowedGuestPath(location.pathname, guestTripIds) : true),
    [isViewer, guestTripIds, location.pathname],
  );

  if (status === 'checking') return <AuthLoading message="驗證登入中…" />;
  if (status === 'unauthed') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (isViewer) {
    if (guestTripIds === null) return <AuthLoading message="載入分享資料中…" />;
    if (guestTripIds.length === 0) return <GuestNoAccess />;
    if (!allowedRoute) {
      return <Navigate to={`/trips/${guestTripIds[0]}`} replace />;
    }
  }
  // Member：只有共同帳本 / 分享的旅程 / 機票雷達 / 設定（其餘 collection 的 rules 會擋，這裡先導走避免整頁 permission error）
  if (isMember && !isAllowedMemberPath(location.pathname)) {
    return <Navigate to="/shared" replace />;
  }
  return <>{children}</>;
}

function GuestNoAccess() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-center">
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">尚未獲得任何旅程的分享權限</h1>
        <p className="text-sm text-muted-foreground">
          請聯繫旅程主人確認他已用此 email 邀請你；若剛才才收到邀請，重新登入即可生效。
        </p>
      </div>
    </div>
  );
}
