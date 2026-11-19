import { useEffect, useState } from 'react';
import { collection, doc, getDocs, updateDoc } from 'firebase/firestore';
import { UserCog } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { useHousehold } from '@/features/household/hooks';
import type { UserDoc, UserRole } from '@/types/global';

export const ROLE_LABEL: Record<UserRole, string> = {
  admin: '管理員',
  owner: '主帳本（全功能）',
  member: '共同帳本成員',
  viewer: '只看分享旅程',
  guest: '只看分享旅程（舊）',
};

export const ROLE_HINT: Record<UserRole, string> = {
  admin: '全部權限 + 管理使用者 / 白名單',
  owner: '看得到投資、帳戶、個人記帳；等同你自己',
  member: '只看得到共同帳本、分享的旅程、設定',
  viewer: '只看得到被分享的旅程（唯讀）',
  guest: '同 viewer',
};

/** users/{uid} 清單 + 角色切換（admin 才能寫 role） */
export function UsersPanel() {
  const [users, setUsers] = useState<UserDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const { user: me } = useAuth();
  const { household } = useHousehold();

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'users'));
      setUsers(snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          email: (data.email as string) ?? '',
          displayName: (data.displayName as string | null) ?? null,
          photoURL: (data.photoURL as string | null) ?? null,
          role: (data.role as UserRole) ?? 'member',
          ledgerSharedWith: Array.isArray(data.ledgerSharedWith) ? (data.ledgerSharedWith as string[]) : [],
          ledgerEditors: Array.isArray(data.ledgerEditors) ? (data.ledgerEditors as string[]) : [],
          preferences: (data.preferences as UserDoc['preferences']) ?? {},
          createdAt: null,
        };
      }));
    } catch (err) {
      console.error('[users load]', err);
      toast.error(err instanceof Error ? err.message : '讀取失敗');
    } finally {
      setLoading(false);
    }
  }

  async function changeRole(uid: string, role: UserRole) {
    try {
      await updateDoc(doc(db, 'users', uid), { role });
      setUsers((prev) => prev.map((u) => (u.id === uid ? { ...u, role } : u)));
      toast.success('角色已更新，對方重新整理後生效');
    } catch (err) {
      console.error('[changeRole]', err);
      toast.error(err instanceof Error ? err.message : '更新失敗');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><UserCog className="size-4" /> 使用者與角色</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          只有登入過一次的帳號才會出現在這裡。伴侶登入後把角色留在「共同帳本成員」即可；不要給 owner，否則對方會看到你的投資與個人記帳。
        </p>
        {loading ? <p className="text-sm text-muted-foreground">載入中…</p> : users.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚無使用者</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {users.map((u) => {
              const inHousehold = household?.memberIds.includes(u.id) ?? false;
              return (
                <li key={u.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{u.displayName ?? u.email}</span>
                      {inHousehold ? <Badge variant="secondary" className="text-[10px]">共同帳本</Badge> : null}
                      {u.id === me?.uid ? <Badge variant="outline" className="text-[10px]">我</Badge> : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{u.email} · {ROLE_HINT[u.role]}</div>
                  </div>
                  <Select value={u.role} onValueChange={(v) => void changeRole(u.id, v as UserRole)}>
                    <SelectTrigger className="h-9 w-[168px] text-xs" disabled={u.id === me?.uid}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(['admin', 'owner', 'member', 'viewer'] as UserRole[]).map((r) => (
                        <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">無法修改自己的角色（避免誤鎖）。</p>
      </CardContent>
    </Card>
  );
}
