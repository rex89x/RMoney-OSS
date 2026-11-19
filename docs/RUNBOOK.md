# RUNBOOK — 常見問題處置

> 按症狀查 → 對應處置。

---

## CI/CD

### CI 紅燈 (PR)
1. 點進去看哪個 step 失敗
2. 最常見：typecheck → 本機 `cd apps/web && npm run typecheck` 復現
3. lint → `npm run lint:fix`
4. build → 缺 env var → 確認 secrets 填齊

### Hosting deploy 失敗
- 401 / 403 → service account 權限不夠 (Firebase Hosting Admin + Rules Admin)
- `No such project` → `FIREBASE_PROJECT_ID` 打錯

### Apps Script deploy 失敗
- `invalid_grant` → `CLASPRC_JSON` 過期 → 本機 `clasp login` → 更新 secret
- `deploymentId not found` → 首次部署還沒建 → 本機 `clasp deploy` 一次拿到 id → 更新 secret

---

## Firebase 自鎖 / 無法登入

### 伴侶用邀請連結登入後顯示「不在白名單」
- 邀請連結（設定 → 共同帳本 → 邀請連結）**24 小時有效、用過一次就失效**；過期 / 已用會回 `code-expired`，請 owner 重新產生。
- 登入檢查讀的是 `config/allowedEmailHashes`（SHA-256），不是明文名單。admin 登入一次會自動補齊；Apps Script 每日 01:00 也會 `syncWhitelistHashes_()`。若剛部署完伴侶就被擋，owner 先登入一次即可。
- 首次登入建立的 `users/{uid}` 只能是 `member` / `viewer`（rules 強制）；要升 owner / admin 到設定 → 權限（admin）。

### Telegram 群組裡其他人也能記帳
- `TG_CHAT_ID` 是群組時，設 Script Property `TG_ALLOWED_USER_IDS`（逗號分隔 Telegram user id）只放行名單內的人；沒設會維持舊行為並在 log 留 warning。

### 白名單登入無限 loop
- `config/allowedEmails` 文件不存在或 email 沒進 array → see `docs/BOOTSTRAP.md`

### `permission-denied` on Firestore read
- `users/{uid}` 不存在 → 檢查 Rules 是否允許 user 寫自己的 doc (應該允許)
- role 還是 `viewer`？ → Console 手動改 `role: 'owner'`

### IndexedDB 寫入卡住 (rules 剛改)
- 在 devtools console 跑 `clearIndexedDbPersistence(db)` (或重裝 PWA)

---

## Apps Script

### Finnhub 429 rate limit
- 改慢一點：`Stocks.gs` 的 `Utilities.sleep(1100)` 調到 `2000`

### TWSE 回 500 / 空
- 盤後 (13:30 後) 常常會延遲 → 正常、忽略

### `LockService tryLock failed`
- 同一個 script 同時跑兩次 → 減少觸發頻率，或避免重疊

### Telegram `Bad Request: chat not found`
- `TG_CHAT_ID` 錯 (或忘了加 `-` 前綴的群組 id)

### Claude API `429` / 額度用完
- 速率限制 → 稍後重試；本期額度用完 → 設定 → AI 額度 看用量，必要時關掉硬停止或等重置日（預設每月 23 號）
- `401 API key 無效` → 檢查 Script Property `ANTHROPIC_API_KEY`

### MCP 連不上 / `unauthorized`
- 先跑 `HUB_MCP_URL=... HUB_MCP_TOKEN=... node scripts/hub-mcp.mjs --check`：`unauthorized` → token 錯或已被撤銷 / 重新產生，到 AI 分析頁「MCP 連線」再產生一次
- `endpoint did not return JSON` → `HUB_MCP_URL` 不是 `/exec` 結尾的 Web App URL，或 Apps Script 尚未部署到含 `Mcp.gs` 的版本
- `daily MCP call limit reached` → 當日 1,500 次上限（`MCP_DAILY_LIMIT_`），隔天自動恢復
- AI 說「this connection is read-only」或看不到 `preview_entries` → 該連線沒開寫入：「AI 分析 → MCP 連線」對那個 client
  （或 bridge token）打開「允許寫入」；Claude.ai 要到 connector 設定重新整理工具清單
- `preview not found or expired` → 預覽 30 分鐘過期或已確認過一次，請 AI 重新 `preview_*`
- `daily MCP write limit reached` → 當日 200 次寫入上限（`HUB_WRITE_DAILY_LIMIT_`）
- 懷疑 AI 記錯帳 → 設定 → 資料 → 稽核紀錄找「MCP（…）·」開頭的紀錄；記帳到回收筒 / 交易列表刪除，
  股票到投資頁調整；要立刻停止寫入就把該連線的「允許寫入」關掉（下一次呼叫生效）
- Bridge token 疑似外流 → AI 分析頁「撤銷」，bridge 立即失效

### Claude.ai connector 連不上 / 授權失敗（MCP 閘道）
- 先看 Actions「Deploy Functions (MCP gateway)」是否綠燈；紅燈多半是 Blaze / API 未啟用 / SA 缺角色，見 `docs/INTEGRATIONS_SETUP.md` 3.2
- `curl -i -X POST https://asia-east1-<your-project-id>.cloudfunctions.net/mcp` 應回 `401` 與 `WWW-Authenticate: Bearer resource_metadata=...`；回 404 = function 沒部署，回 403 = invoker 不是 public
- `curl https://<your-project-id>.web.app/.well-known/oauth-authorization-server` 應回 JSON；回 HTML = Hosting 尚未部署到含 rewrite 的版本
- 授權頁顯示「無法驗證這個授權請求」→ client 註冊的 redirect_uri 不在白名單（`functions/lib/gateway.js` `REDIRECT_HOSTS`），看 function log
- 已授權但工具呼叫回 `Personal Hub backend unavailable`（502）→ Apps Script 還沒部署到含 `mcpGatewayAuthorized_` 的版本，或 `functions/.env` 的 `APPS_SCRIPT_URL` 錯（secret `VITE_APPS_SCRIPT_URL`）
- 懷疑閘道密鑰外流 → 刪掉 Firestore `mcp_gateway/secret`，重新部署 function（會產生新的；Apps Script 快取最多 10 分鐘）
- 要全部撤銷 → 「AI 分析 → MCP 連線」逐一撤銷，或直接刪 `mcp_oauth_grants` collection

### AI 分析結果說「已達查詢上限」或資料不完整
- Claude 自己查資料有 6 輪 / 15 萬 input tokens / 200 秒的護欄（`CLAUDE_ANALYSIS_LIMITS_`）；把範圍縮小（指定月份、旅程、在「想特別關注的重點」寫清楚）再跑一次

---

## Data

### 某筆 tx 顯示時間差 8 小時
- 代表 UI 沒走 `date-fns-tz` → 檢查 component 是否用 `formatTW()`

### DatePicker 選到的日期少一天
- 不要用 `toISOString().slice(0, 10)` 做 date-only string。
- UI 選到的日期用 `formatDateInput(d)`；從 date-only string 寫入 Firestore/TW 查詢邊界用 `dateInputToTWDate()` 或 `dateInputToTWBoundary()`。
- 常見位置：trip 建立、recurring next due、DataTable date range、dashboard → ledger links、stock history date range。

### 排程日期月底跳錯月份
- 不要用 `Date#setMonth()` / `Date#setFullYear()` 直接推 date-only 週期。
- 月繳、季繳、年繳請用 `addTWCalendarMonths()` / `addTWCalendarYears()`，會把 1/31 + 1 month clamp 成 2 月最後一天。
- UI 顯示、天數差、逾期判斷請用 `startOfTWDay()` / `daysBetweenTWDates()`。

### Watchlist 更新完但 UI 沒動
- TanStack Query cache → 手動 `refresh mutation.mutateAsync()` 或 invalidate

### history 子集合爆炸
- 跑 `Triggers.gs` 的 `cleanupOldHistory_()` (已掛在每日 01:00 trigger)

---

## Mobile UX

### 新增記帳時鍵盤收合後畫面被擠壓
- 先確認 `components/ui/drawer.tsx` 是否仍用 `visualViewport` 同步 `--drawer-available-height`。
- `ResponsiveDialog` 內容區要保留 `min-h-0 flex-1 overflow-y-auto`，footer 才不會被鍵盤或 safe area 擠掉。
- 不要在單一表單內硬寫 `height: 100vh` 或額外 fixed container；修 shared drawer 層。

### 手機版要不需要轉橫向（直式 375px 可操作）
- 規則：
  - grid 的子元素一律可以縮（`[&>*]:min-w-0` 或子元素自己 `min-w-0`），否則長網址 / email 會把整張卡撐寬
  - 日期欄（DatePicker）手機上獨佔一行：`grid-cols-1 sm:grid-cols-2` 或 `col-span-2 sm:col-span-1`
  - 分頁多的頁面用 `ScrollTabsList`（`components/ui/scroll-tabs.tsx`）：橫向捲動 + 自動捲到選中分頁
  - KPI 數字卡用 `StatTile` / `StatGrid`（`components/ui/stat-tile.tsx`）：手機 2 欄、桌面 4 欄
  - `<main>` 用 `overflow-x-clip` 而不是 `overflow-x-hidden`：hidden 會讓 `position: sticky` 失效
  - 不要自己寫 `<TabsList className="flex w-full overflow-x-auto">`：TabsList 預設 `justify-center`，溢出時最左邊的分頁會被切掉、捲不到 → 一律用 `ScrollTabsList`
  - iOS focus 自動放大：`index.css` 在手機寬度把「小字（text-xs / text-sm / text-[≤15px]）或沒設字級」的 input / textarea / select 強制 16px；刻意放大的金額欄不受影響，新元件不需要另外處理
  - 數字欄位用 `<Input type="number">` 會自動帶 `inputMode="decimal"`（叫出數字鍵盤）
  - 觸控尺寸：`Button size="icon-sm"` 手機 36px / 桌面 32px；Select / Dropdown / Command 選項、日曆日期格在手機上自動放大
  - 只有 hover 才看得到的按鈕（`opacity-0 group-hover:opacity-100`）在手機上會變成「看不到但點得到」→ 加 `[@media(hover:none)]:opacity-…` 或 `lg:` 限定
  - Tailwind 開了 `hoverOnlyWhenSupported`：觸控裝置不會有 hover 樣式，點按回饋用 `active:`
  - 左滑刪除用 `hooks/use-swipe-to-delete.ts`（有方向鎖定，上下捲動不會誤觸）；dnd-kit 把手要加 `touch-none`
  - 是 / 否確認一律 `useConfirm()`（置中精簡對話框）；表單類才用 `ResponsiveDialog`（手機全螢幕）
  - 頁面最底部要留給 FAB：AppLayout 手機版已加 `pb-24`；sticky 底部操作列要避開 TabBar（`bottom-[calc(env(safe-area-inset-bottom)+68px)]`）和 FAB（`pr-20`）
- 本機檢查（不需要登入 production，資料全在本機 emulator）：
  ```bash
  npx firebase-tools emulators:start --only firestore,auth --project demo-rmoney   # 終端 1
  node scripts/seed-emulator.mjs                                                  # 種子資料
  npm run dev:emulator --workspace apps/web -- --port 5174                        # 終端 2
  npx -y -p playwright@1.56 node scripts/mobile-audit.mjs rex@example.com         # owner 視角：全部頁面 + 逐一點過分頁（360px）
  WIDTH=320 npx -y -p playwright@1.56 node scripts/mobile-audit.mjs rex@example.com  # 最窄的手機再跑一次
  npx -y -p playwright@1.56 node scripts/mobile-audit.mjs partner@example.com /shared  # 伴侶視角
  ```
  有「超出畫面又不在可捲動容器裡」的元素會列出來並 exit 1；截圖在 `mobile-audit/`（已 gitignore）。
  seed 會幫 owner 的每一頁塞「偏長、偏大」的資料（8 位數金額、超長名稱、13 個月交易）—— 空狀態測不出溢出。
  登入失敗（seed 沒跑、白名單 seed 跟 rules 不一致）會直接 exit 2，不會把登入頁當成各頁面測過。
  瀏覽器手動測：開 `http://localhost:5174/login`，DevTools console 執行 `await __devSignIn('rex@example.com')`。

### 導覽
- 手機底部分頁（owner）：首頁 / 記帳 / 共同 / 投資 / 更多。「更多」面板自動列出 `NAV_ITEMS` 裡不在底部分頁的項目，
  新增頁面只要加進 `components/layout/nav-items.ts` 的 `NAV_ITEMS`。
- 其他進入共同帳本的方式：側欄「共同」、PWA 圖示長按捷徑「共同帳本」、Command palette / 快捷鍵 `G H`。

---

## 共同投資帳 / 共同帳本 Telegram

- **伴侶加入 Telegram**：`/shared?tab=settings` → Telegram 卡 →「產生加入連結」→ 傳給對方 → 對方點開在 Telegram 按 Start。
  連結 24h、單次使用；綁錯人就在同一張卡「解除」再重產。不用改任何 Script Property。
- **伴侶收不到報告**：(1) 卡片上是否顯示「已連結」（`households.telegramLinked`）(2) 報告開關與頻率（每天 21:00 判斷；weekly = 週日、monthly = 每月 1 號）
  (3) Apps Script 執行紀錄搜尋 `runHouseholdReports`。手動補發：設定頁「立即傳一份給我」，或 owner 呼叫 `?action=notify&kind=householdReport`（會發給全部成員）。
- **共同投資沒有報價**：按「更新報價」（`refreshHouseholdQuotes`，一分鐘冷卻、最多 20 檔台股 + 10 檔美股）；仍失敗看 Apps Script log 的 `refreshHouseholdQuotes`。
- **走勢圖沒資料**：快照在每天 07:00 / 18:00 跟 portfolio snapshot 一起跑（`snapshotHouseholdInvestments`），新功能上線後隔天才有兩個點。
- **連結部位股數不對**：owner 在共同投資頁按「連結我的持股」會立即同步；自動同步同樣在 07:00 / 18:00。
- 選填 Script Property `APP_URL`（例 `https://<your-project-id>.web.app`）：報告尾端會附共同帳本連結。
- 權限邊界：role `member` 只能呼叫 `Main.gs` 的 `MEMBER_ALLOWED_ACTIONS_`；綁定的非 owner Telegram chat 只能用 `/report /invest /unlink /help`。

## Rollback

### Hosting 回滾
- Firebase Console → Hosting → Release history → 選前一版 → Rollback

### Firestore Rules 回滾
- `git revert` 把 `firebase/firestore.rules` 改回 → push → CI 會重新部署

### Apps Script 回滾
- Apps Script → Deployments → 選舊 version → 覆寫為 live

---

## Monthly Maintenance

- [ ] 檢查 Firebase 用量儀表 (免費額度)
- [ ] 檢查 Finnhub quota 與 Claude API 額度（設定 → AI 額度 / Anthropic Console）
- [ ] 如果 CI 開始 fail → 檢查 `CLASPRC_JSON` 是否過期
- [ ] 備份 `.env.local` 到密碼管理器 (1Password)
