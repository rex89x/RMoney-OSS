import { useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { CheckCircle2, CircleAlert, Loader2, Stethoscope, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { db } from '@/lib/firebase';
import { useHousehold } from '@/features/household/hooks';
import type { UserRole } from '@/types/global';
import { ROLE_LABEL } from './users-panel';

interface Check {
  ok: boolean | null;
  label: string;
  detail: string;
}

/**
 * 「為什麼她登入說沒權限？」— 輸入 email，逐項檢查白名單 / users / 共同帳本狀態，
 * 並列出 app 以外的常見原因（Google OAuth 測試模式、登入到別的帳號）。
 */
export function AccessDiagnostics() {
  const { household } = useHousehold();
  const [email, setEmail] = useState('');
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    const e = email.trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    setRunning(true);
    const out: Check[] = [];
    try {
      const [allowedSnap, guestSnap] = await Promise.all([
        getDoc(doc(db, 'config', 'allowedEmails')),
        getDoc(doc(db, 'config', 'guestEmails')),
      ]);
      const allowed = ((allowedSnap.data() as { emails?: string[] } | undefined)?.emails ?? []).map((x) => x.toLowerCase());
      const guests = ((guestSnap.data() as { emails?: string[] } | undefined)?.emails ?? []).map((x) => x.toLowerCase());
      const inAllowed = allowed.includes(e);
      const inGuest = guests.includes(e);
      out.push({
        ok: inAllowed,
        label: '登入白名單（config/allowedEmails）',
        detail: inAllowed ? '有，登入時會通過白名單檢查' : inGuest
          ? '不在完整白名單，但在 viewer 名單：登入後只能看分享的旅程，進不了共同帳本。用下方「邀請到共同帳本」或把 email 加進登入白名單'
          : '沒有。登入會被擋「此帳號無使用權限」。用共同帳本的邀請 email / 邀請連結，或在上方白名單手動加入',
      });

      const userSnap = await getDocs(query(collection(db, 'users'), where('email', '==', e)));
      const userDoc = userSnap.docs[0];
      const role = (userDoc?.data() as { role?: UserRole } | undefined)?.role;
      out.push({
        ok: userDoc ? true : null,
        label: '登入過（users/{uid}）',
        detail: userDoc
          ? `有，角色：${role ? ROLE_LABEL[role] : '未知'}${role === 'viewer' || role === 'guest' ? '（只看旅程；把角色改成「共同帳本成員」）' : ''}`
          : '還沒成功登入過。白名單通過後第一次登入會自動建立',
      });

      if (household) {
        const uid = userDoc?.id;
        const isMember = uid ? household.memberIds.includes(uid) : false;
        const pending = household.pendingInvites.map((x) => x.toLowerCase()).includes(e);
        out.push({
          ok: isMember ? true : pending ? null : false,
          label: `共同帳本「${household.name}」成員`,
          detail: isMember ? '已是成員' : pending
            ? '已邀請，等對方用這個 email 登入一次就會自動加入'
            : '不是成員也沒有待加入邀請。到「共同 → 設定」邀請這個 email，或給對方邀請連結',
        });
      } else {
        out.push({ ok: false, label: '共同帳本', detail: '你還沒建立共同帳本，先到「共同」頁建立' });
      }
    } catch (err) {
      console.error('[accessDiagnostics]', err);
      out.push({ ok: false, label: '檢查失敗', detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setChecks(out);
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Stethoscope className="size-4" /> 登入疑難排解</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="對方登入用的 Google email" />
          <Button type="submit" disabled={running || !email.trim()}>
            {running ? <Loader2 className="size-4 animate-spin" /> : null} 檢查
          </Button>
        </form>
        {checks ? (
          <ul className="space-y-2">
            {checks.map((c) => (
              <li key={c.label} className="flex gap-2 rounded-md border p-2 text-sm">
                {c.ok === true ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                  : c.ok === false ? <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    : <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />}
                <div>
                  <div className="font-medium">{c.label}</div>
                  <div className="text-xs text-muted-foreground">{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">app 以外的常見原因</div>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            <li>對方手機上選到另一個 Google 帳號（家人 / 工作帳號）。登入頁被擋時會顯示實際用的 email，請對照。</li>
            <li>Firebase 專案的 Google OAuth 同意畫面還在「測試」狀態：只有列在測試使用者的帳號能登入，其他人會看到 Google 的「存取遭封鎖」。到 Google Cloud Console → API 和服務 → OAuth 同意畫面，把對方加進測試使用者，或把應用程式發布為正式版。</li>
            <li>剛加進白名單 / 剛被邀請：請對方完全登出再登入一次（設定 → 登出）。</li>
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}
