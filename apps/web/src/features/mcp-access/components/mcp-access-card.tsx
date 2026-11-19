import { Copy, Globe, KeyRound, Loader2, PencilLine, PlugZap, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Switch } from '@/components/ui/switch';
import { formatTW } from '@/lib/tz';
import { useMcpAccess } from '../hooks';

interface CopyRowProps {
  label: string;
  hint: string;
  value: string;
  onCopy: () => void;
}

function CopyRow({ label, hint, value, onCopy }: CopyRowProps) {
  return (
    <div className="min-w-0 rounded-xl border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <Button variant="outline" size="sm" onClick={onCopy}><Copy className="size-4" /> 複製</Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      <code className="mt-2 block max-h-24 overflow-y-auto break-all rounded-md bg-muted px-2 py-1.5 text-xs">{value}</code>
    </div>
  );
}

const WRITE_CONFIRM = '開啟後，這個連線上的 AI 可以新增記帳、記錄股票買賣、建立旅程與匯入行程，以及存台指期模擬的每週檢討（參數調整只是提案，要你在 App 核准）。每次寫入前它都要先產生預覽再確認，'
  + '而且不能修改或刪除既有資料（只能復原自己剛記的帳）。隨時可以關掉。';

/** MCP 連線：讓 Claude.ai / Claude Code 等外部 AI 自己來查 Personal Hub 的資料；可逐一開啟寫入 */
export function McpAccessCard() {
  const mcp = useMcpAccess();
  const confirm = useConfirm();
  const configured = mcp.status?.configured === true;

  async function rotate() {
    if (configured) {
      const ok = await confirm({
        title: '重新產生 bridge token？',
        description: '舊 token 會立即失效，已經接好的 Claude Code / Desktop 需要換成新的 token。',
        confirmText: '重新產生',
      });
      if (!ok) return;
    }
    await mcp.generate();
  }

  async function revokeGrant(grantId: string, clientName: string) {
    const ok = await confirm({
      title: `撤銷「${clientName}」的授權？`,
      description: '撤銷後這個 client 立即無法再讀取資料，要再使用必須重新授權。',
      confirmText: '撤銷',
      variant: 'danger',
    });
    if (ok) await mcp.removeGrant(grantId);
  }

  async function toggleGrantWrite(grantId: string, clientName: string, write: boolean) {
    if (write) {
      const ok = await confirm({ title: `允許「${clientName}」寫入？`, description: WRITE_CONFIRM, confirmText: '允許寫入' });
      if (!ok) return;
    }
    await mcp.setGrantWrite(grantId, write);
  }

  async function toggleBridgeWrite(enabled: boolean) {
    if (enabled) {
      const ok = await confirm({
        title: '允許 bridge token 寫入？',
        description: `${WRITE_CONFIRM} 拿到這把 token 的人也能寫入；重新產生 token 會自動回到唯讀。`,
        confirmText: '允許寫入',
      });
      if (!ok) return;
    }
    await mcp.setBridgeWrite(enabled);
  }

  async function revoke() {
    const ok = await confirm({
      title: '撤銷 bridge token？',
      description: '撤銷後本機 bridge 無法再讀取任何資料，直到你重新產生 token。Claude.ai 的授權不受影響。',
      confirmText: '撤銷',
      variant: 'danger',
    });
    if (ok) await mcp.remove();
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlugZap className="size-5 shrink-0" /> MCP 連線（讓外部 AI 查資料、幫你記帳）
        </CardTitle>
        <CardDescription>
          把 Personal Hub 當成 MCP server 接到 Claude.ai、Claude Code 或 Claude Desktop：AI 會依你的問題自己挑工具，
          只取用得到的帳務、持股、淨值與旅遊行程資料，不需要你先匯出整包。開啟「允許寫入」後，還可以直接跟它說
          「午餐 150 刷玉山」「買 2330 一張 1050」或請它把行程匯進旅程。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex items-start gap-2 rounded-xl border p-3 text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0">
            預設唯讀{mcp.status ? `（${mcp.status.toolCount} 個查詢工具，每日上限 ${mcp.status.dailyLimit} 次呼叫）` : ''}。
            沒有經過你本人授權，任何 client 都讀不到資料；授權可以隨時在這裡撤銷，撤銷後立即失效。
            寫入要對每個連線另外開啟{mcp.status?.writeToolCount ? `（${mcp.status.writeToolCount} 個寫入工具，每日上限 ${mcp.status.dailyWriteLimit} 次寫入）` : ''}：
            每次都先預覽再確認、留有稽核紀錄，而且不能修改或刪除既有資料。
          </p>
        </div>

        <section className="space-y-3">
          <h4 className="flex items-center gap-2 font-medium"><Globe className="size-4 shrink-0" /> Claude.ai 網頁版 / 手機 App</h4>
          <CopyRow
            label="Connector 網址"
            hint="到 claude.ai → Settings → Connectors → Add custom connector 貼上。網址不含任何密鑰；新增時會跳到 Personal Hub 用 Google 登入並由你按「允許」。"
            value={mcp.gatewayUrl}
            onCopy={() => void mcp.copy(mcp.gatewayUrl, ' connector 網址')}
          />
          {mcp.grantsLoading ? (
            <p className="text-muted-foreground">讀取已授權的 client…</p>
          ) : mcp.grantsError ? (
            <p className="text-muted-foreground">無法取得授權清單（MCP 閘道可能尚未部署）。</p>
          ) : mcp.grants.length === 0 ? (
            <p className="text-muted-foreground">目前沒有任何已授權的 client。</p>
          ) : (
            <ul className="space-y-2">
              {mcp.grants.map((grant) => (
                <li key={grant.grantId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
                  <div className="min-w-0">
                    <p className="font-medium">{grant.clientName}</p>
                    <p className="text-xs text-muted-foreground">
                      授權於 {formatTW(grant.createdAt, 'yyyy/MM/dd HH:mm')} ·{' '}
                      {grant.lastUsedAt ? `最近使用 ${formatTW(grant.lastUsedAt, 'yyyy/MM/dd HH:mm')}` : '尚未使用'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <PencilLine className="size-4 shrink-0" /> 允許寫入
                      <Switch
                        checked={grant.write}
                        onCheckedChange={(checked) => void toggleGrantWrite(grant.grantId, grant.clientName, checked)}
                        disabled={mcp.updatingWrite}
                        aria-label={`允許 ${grant.clientName} 寫入`}
                      />
                    </label>
                    <Button variant="outline" size="sm" onClick={() => void revokeGrant(grant.grantId, grant.clientName)} disabled={mcp.revokingGrant}>
                      <Trash2 className="size-4" /> 撤銷
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3 border-t pt-4">
          <h4 className="flex items-center gap-2 font-medium"><Terminal className="size-4 shrink-0" /> Claude Code / Claude Desktop（本機 bridge）</h4>
          <p className="text-xs text-muted-foreground">
            用 token 連線：只顯示一次、後端只存雜湊。拿到 token 的人可以讀你的財務資料（開了寫入還能記帳），外流請立刻重新產生或撤銷。
          </p>

          <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-muted-foreground">
            {mcp.statusLoading ? '讀取狀態中…'
              : mcp.statusError ? '無法取得狀態'
                : configured
                  ? `已啟用 · 建立於 ${mcp.status?.createdAt ? formatTW(mcp.status.createdAt, 'yyyy/MM/dd HH:mm') : '—'} · ${
                    mcp.status?.lastUsedAt ? `最近使用 ${formatTW(mcp.status.lastUsedAt, 'yyyy/MM/dd HH:mm')}` : '尚未使用'}`
                  : '尚未啟用'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void rotate()} disabled={mcp.busy || mcp.statusLoading}>
              {mcp.busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              {configured ? '重新產生 token' : '產生 token 並啟用'}
            </Button>
            {configured ? (
              <Button variant="outline" onClick={() => void revoke()} disabled={mcp.busy}>
                <Trash2 className="size-4" /> 撤銷
              </Button>
            ) : null}
          </div>
        </div>

        {configured ? (
          <label className="flex items-center justify-between gap-3 rounded-xl border p-3">
            <span className="min-w-0">
              <span className="flex items-center gap-2 font-medium"><PencilLine className="size-4 shrink-0" /> 允許 bridge token 寫入</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {mcp.status?.writeEnabled ? '這把 token 可以記帳、記錄股票買賣、匯入行程。' : '目前唯讀。'}重新產生 token 會自動回到唯讀。
              </span>
            </span>
            <Switch
              checked={mcp.status?.writeEnabled === true}
              onCheckedChange={(checked) => void toggleBridgeWrite(checked)}
              disabled={mcp.updatingWrite || mcp.busy}
              aria-label="允許 bridge token 寫入"
            />
          </label>
        ) : null}

        {mcp.issued ? (
          <div className="space-y-3">
            <p className="text-xs text-amber-600 dark:text-amber-400">
              請現在複製並妥善保存，離開或重新整理這一頁後就看不到了。
            </p>
            <CopyRow
              label="Claude Code 指令"
              hint="在這個 repo 的根目錄執行；token 放在環境變數與 POST body，不會出現在 URL。"
              value={mcp.issued.claudeCodeCommand}
              onCopy={() => void mcp.copy(mcp.issued?.claudeCodeCommand ?? '', '指令')}
            />
            <CopyRow
              label="Token"
              hint="需要自己組設定檔時使用（環境變數 HUB_MCP_TOKEN）。"
              value={mcp.issued.token}
              onCopy={() => void mcp.copy(mcp.issued?.token ?? '', ' token')}
            />
          </div>
        ) : null}
        </section>
      </CardContent>
    </Card>
  );
}
