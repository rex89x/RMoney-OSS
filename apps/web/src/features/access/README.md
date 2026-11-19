# access — 權限管理

## 職責
admin（owner）用的權限總面板，掛在 `/admin` 與 設定 → 權限：
- `AccessDiagnostics`：輸入 email 檢查 白名單 / users doc / 共同帳本成員狀態，並列出 app 以外的常見登入失敗原因（OAuth 測試模式、選錯 Google 帳號）。
- `WhitelistPanel`：`config/allowedEmails`（完整登入）與 `config/guestEmails`（viewer）。
- `UsersPanel`：`users/*` 角色切換（admin / owner / member / viewer），標示誰在共同帳本。
- 共同帳本成員的細部權限（`households.members[uid].permissions`）在 `features/household` 的設定分頁管理。

## 角色 vs 權限
| 層 | 存哪 | 誰改 |
|---|---|---|
| 能不能登入 | `config/allowedEmails` / `guestEmails` | admin（UI）或 Apps Script 邀請 |
| 登入後看得到什麼 | `users/{uid}.role` | admin（rules 禁止自改） |
| 共同帳本裡能做什麼 | `households/{id}.members[uid].permissions` | household owner |

## 邀請連結
`/login?join=CODE`（`households.inviteCode`）：對方不用先進白名單；登入後 `useInitAuth` 用 code 呼叫 Apps Script `joinHousehold`，成功後加白名單 + 成員。
