import { Check, Loader2, LogIn, PencilLine, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { signInWithGoogle } from '@/hooks/use-auth';
import { useOAuthConsent } from '../hooks';

const WRITABLE = ['新增記帳（支出 / 收入），並同步調整帳戶餘額', '記錄股票買進 / 賣出（更新持倉、已實現損益、交割帳戶）', '建立旅程、匯入或更新行程表項目', '存台指期模擬的每週檢討與參數調整提案（提案要你在 App 核准才生效）'];
const READABLE = ['記帳明細與收支彙總、預算', '帳戶餘額與淨值', '投資持股、損益與走勢', '旅程、行程表與旅程花費', '訂閱、週期交易、投資規劃等其他資料'];

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border p-3 text-sm text-muted-foreground">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-1">{children}</p>
      </div>
    </div>
  );
}

/** OAuth 同意畫面：外部 AI client（Claude.ai）要求存取 Personal Hub 資料時顯示；寫入要另外打開 */
export function OAuthConsent() {
  const consent = useOAuthConsent();

  async function signIn() {
    try {
      // signInWithRedirect 登入完會回到這一頁（含原本的 query string）
      await signInWithGoogle();
    } catch (err) {
      console.error('[oauthConsent signIn]', err);
      toast.error(err instanceof Error ? err.message : '登入失敗');
    }
  }

  let body: React.ReactNode;
  if (!consent.paramsValid) {
    body = <Notice title="授權請求不正確">網址缺少必要的參數。請回到 Claude 重新新增 connector，不要手動修改網址。</Notice>;
  } else if (consent.authStatus === 'checking') {
    body = <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> 驗證登入中…</p>;
  } else if (consent.authStatus === 'unauthed') {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">請先登入 Personal Hub，確認是你本人之後才能授權。</p>
        <Button onClick={() => void signIn()}><LogIn className="size-4" /> 使用 Google 登入</Button>
      </div>
    );
  } else if (!consent.isOwner) {
    body = <Notice title="這個帳號不能授權">只有 Personal Hub 的擁有者可以讓外部 AI 讀取資料。</Notice>;
  } else if (consent.clientLoading) {
    body = <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> 確認授權請求…</p>;
  } else if (!consent.client) {
    body = (
      <Notice title="無法驗證這個授權請求">
        {consent.clientError ?? '未知錯誤'}。為了安全不會導回對方網站，請回到 Claude 重新新增 connector。
      </Notice>
    );
  } else {
    body = (
      <div className="space-y-4 text-sm">
        <p>
          <span className="font-medium">{consent.client.clientName}</span>
          <span className="text-muted-foreground">（授權後會導回 {consent.client.redirectHost}）</span>
          想要存取你的 Personal Hub 資料。
        </p>
        <div className="rounded-xl border p-3">
          <p className="flex items-center gap-2 font-medium"><ShieldCheck className="size-4 shrink-0" /> 允許後它可以讀取</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {READABLE.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div className="rounded-xl border p-3">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="mcp-allow-write" className="flex min-w-0 items-center gap-2 font-medium">
              <PencilLine className="size-4 shrink-0" /> 同時允許寫入
            </label>
            <Switch id="mcp-allow-write" checked={consent.allowWrite} onCheckedChange={consent.setAllowWrite} disabled={consent.approving} />
          </div>
          {consent.allowWrite ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              {WRITABLE.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            {consent.allowWrite
              ? '每次寫入前 AI 都要先產生預覽、再經你確認；它不能修改或刪除既有的資料（只能復原自己剛記的帳）。'
              : '關閉時是唯讀，AI 不能修改任何資料。之後可以在「MCP 連線」隨時開啟或關閉。'}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          之後可以隨時到「AI 分析 → MCP 連線」撤銷，撤銷後立即失效。如果你沒有在 Claude 新增 connector，請按拒絕。
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={consent.deny} disabled={consent.approving}><X className="size-4" /> 拒絕</Button>
          <Button onClick={consent.allow} disabled={consent.approving}>
            {consent.approving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 允許
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full min-w-0 max-w-md">
        <CardHeader>
          <CardTitle className="text-lg">授權存取 Personal Hub</CardTitle>
          <CardDescription>外部 AI 透過 MCP 存取你的資料前，需要你本人同意。</CardDescription>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
    </div>
  );
}
