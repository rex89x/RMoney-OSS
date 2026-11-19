# MCP Access（MCP 連線）

讓外部 AI client 透過 MCP 自己查 Personal Hub 的資料（預設唯讀），owner 另外開啟後還能幫忙記帳、記股票成交、
匯入旅程行程。這個 feature 負責**授權 UI**：OAuth 同意畫面、已授權 client 的清單 / 撤銷 / 寫入開關、
bridge token 管理。MCP server 本體不在前端（總規劃見 `docs/MCP_TOOLS.md`）：

| 位置 | 內容 |
|---|---|
| `apps-script/src/HubTools.gs` | 唯讀資料工具（定義 + handler），MCP、App 內 AI 分析、問一下共用 |
| `apps-script/src/HubWriteTools.gs` | 寫入工具（預覽 → 確認），只有開了寫入的 MCP 連線拿得到 |
| `apps-script/src/Mcp.gs` | `?action=mcp` JSON-RPC 端點；只接受 body 裡的 bridge token 或閘道密鑰 |
| `functions/` | MCP 閘道（Cloud Functions）：OAuth 2.1 授權伺服器 + 轉送到 Apps Script，給 Claude.ai 用 |
| `scripts/hub-mcp.mjs` | stdio bridge，給 Claude Code / Desktop 用 |

## 兩種連線

1. **Claude.ai 網頁版 / 手機 App（OAuth）**
   - 使用者在 Claude.ai 貼 `mcpGatewayUrl()`（不含密鑰）。Claude 走 OAuth，把瀏覽器導到
     `/oauth/authorize`（`pages/oauth-authorize-page.tsx` → `OAuthConsent`）。
   - `useOAuthConsent`：解析參數（`OAuthAuthorizeParamsSchema`）→ 等登入（未登入就 `signInWithGoogle`，
     redirect 登入完會回到同一個網址）→ 請閘道驗證 client / redirect_uri → owner 按允許 →
     `approveOAuth` 帶 Firebase ID token 給閘道 → 導回 Claude。
   - 這一頁刻意不放在 `ProtectedShell`：要保留 query string，而且未授權的人不該看到 App 版面。
   - 同意畫面的「同時允許寫入」開關（`useOAuthConsent().allowWrite`，預設關）隨 `approveOAuth` 送給閘道。
   - `McpAccessCard` 用 `useMcpGrants` / `useRevokeMcpGrant` 列出與撤銷授權，`useSetMcpGrantWrite` 切換單一授權的寫入。
2. **Claude Code / Desktop（bridge token）**
   - `rotateMcpToken`：前端 `crypto.getRandomValues` 產生 `rmcp_…`，只把 SHA-256 送到 `setMcpToken`；明文留在元件 state 顯示一次。
   - `useSetMcpWriteAccess`：bridge token 的寫入開關（`setMcpWriteAccess`）；換 token 會回到唯讀。

## 安全

- 前端對角色的判斷（`isOwner`）只是體驗；閘道會用 Admin SDK 再驗一次 ID token 與 `users/{uid}.role`。
- 驗證失敗時**不會**導回 `redirect_uri`（避免變成 open redirect）；「拒絕」只在閘道確認過 redirect_uri 之後才導回。
- 核准請求帶的是 ID token（不是 cookie），沒有 CSRF 面；Hosting 已設 `X-Frame-Options: DENY`。
- 閘道的 `/oauth/approve`、`/oauth/grants*` 只允許 Personal Hub 網域跨域呼叫。
- 寫入一律預設關閉，開啟前有確認對話框；開關只是把意圖送給閘道 / Apps Script，真正的把關在後端
  （沒開寫入的連線列不出也呼叫不了寫入工具）。

依賴：`lib/apps-script`、`lib/env`、`lib/firebase`、`hooks/use-auth`。閘道的 region 寫在 `api.ts` 的
`GATEWAY_REGION`，要與 `functions/index.js`、`apps/web/vite.config.ts` 一致。
