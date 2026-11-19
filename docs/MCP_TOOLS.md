# MCP 串接規劃（Personal Hub × 外部 AI）

Personal Hub 透過 MCP（Model Context Protocol）把資料與操作開放給 Claude.ai / Claude Code / Claude Desktop。
這份文件是**總規劃**：哪些功能已經能用、這次新增了什麼、之後還能接什麼，以及寫入的安全模型。
連線設定步驟在 `docs/INTEGRATIONS_SETUP.md` 3.1 / 3.2。

## 1. 架構

```
Claude.ai ──OAuth 2.1──▶ MCP 閘道（functions/，Cloud Functions）──┐
                                                                   ├─▶ Apps Script ?action=mcp（Mcp.gs）
Claude Code / Desktop ──stdio──▶ scripts/hub-mcp.mjs（bridge token）┘        │
                                                                             ├─ HubTools.gs       唯讀工具（所有連線）
                                                                             └─ HubWriteTools.gs  寫入工具（owner 開啟寫入的連線）
```

| 檔案 | 內容 |
|---|---|
| `apps-script/src/HubTools.gs` | 唯讀工具；MCP、App 內 AI 分析、問一下、Telegram `/ask` 共用 |
| `apps-script/src/HubWriteTools.gs` | 寫入工具；**只有 MCP** 會用，App 內的 AI 拿不到 |
| `apps-script/src/Mcp.gs` | JSON-RPC 端點、驗證、依連線決定有沒有寫入工具 |
| `functions/lib/gateway.js` | OAuth 授權伺服器；每個授權（grant）記錄能不能寫入 |
| `apps/web/src/features/mcp-access/` | 同意畫面、已授權 client 清單、寫入開關 |

## 2. 寫入的安全模型

寫入財務資料的風險比讀取高，所以每一層都預設關閉：

1. **逐一授權**：每個連線預設唯讀。
   - Claude.ai：同意畫面有「同時允許寫入」開關（預設關）；之後可在「AI 分析 → MCP 連線」對每個已授權的 client 隨時開關，
     下一次工具呼叫就生效（閘道每次都重讀 grant）。client 自己要求 `hub.write` scope 沒有用，只有 owner 能決定。
   - bridge token：卡片上的「允許 bridge token 寫入」開關（Script Property `MCP_TOKEN_WRITE`）；重新產生 token 會自動回到唯讀。
2. **看不到就呼叫不到**：沒開寫入的連線 `tools/list` 不會列出寫入工具，硬呼叫會回 read-only 錯誤。
3. **兩段式（預覽 → 確認）**：`preview_*` 只驗證與正規化、不寫入，回傳每一筆會怎麼寫與 `previewId`；
   `commit_*` 只收 `previewId`、不收原始資料，所以模型無法跳過預覽。預覽 30 分鐘有效、**只能確認一次**
   （網路重試不會重複買賣股票），而且綁定建立它的使用者。Claude.ai 對非唯讀工具另外會跳出它自己的確認視窗。
4. **只新增、不破壞**：沒有任何刪除或覆寫既有帳務的工具。`undo_entry` 只能軟刪除「MCP 自己記的帳」（`source = 'mcp'`），
   7 天內可在 App 回收筒還原。行程匯入不會動到預覽以外的既有項目。
5. **上限與稽核**：每日最多 200 次寫入（`HUB_WRITE_DAILY_LIMIT_`）；每次確認寫一筆 `audit_logs`
   （設定 → 資料 → 稽核紀錄，摘要以「MCP（client 名稱）·」開頭）。
6. **同一套商業邏輯**：記帳 / 股票直接走既有的 AI 匯入（`ImportApply.gs`）——類別與付款方式比對、匯率鎖定（§12）、
   帳戶餘額調整、持倉與已實現損益、內容 hash 去重都和 web / Telegram 匯入一致，不另外發明一套。

## 3. 工具清單

### 3.1 唯讀（已上線，23 個）

| 領域 | 工具 |
|---|---|
| 目錄 | `hub_catalog` |
| 記帳 / 收支 | `sum_by_month`、`sum_by_category`、`sum_by_payment_method`、`spend_by_merchant`、`list_transactions`、`budget_status` |
| 資產 / 淨值 | `accounts_balance`、`net_worth_latest`、`net_worth_history` |
| 投資 | `portfolio_latest`、`portfolio_positions`、`portfolio_history`、`stock_quotes` |
| 旅遊 | `list_trips`、`trip_detail`、`trip_itinerary`、`trip_expenses` |
| 機票雷達 | `flight_watches`、`flight_price_history`、`flight_date_prices` |
| 台指期模擬 | `taifex_weekly_review`（一週的帳戶、交易、訊號、策略變體、最佳化、盤中技術模擬、目前參數與可調範圍） |
| 其他資料集 | `list_records`（週期交易、訂閱、預定付款、分期、儲蓄目標、投資規劃、負債、手動資產、租賃、預算、類別、信用卡帳單、股利、已實現損益、觀察名單、機票追蹤、匯率） |

### 3.2 寫入（8 個）

| 工具 | 會不會寫入 | 做什麼 |
|---|---|---|
| `entry_options` | 否 | 可用的類別、帳戶、支付方式、預設交割帳戶、今天日期 |
| `preview_entries` | 否 | 驗證記帳（支出 / 收入）與股票成交（買 / 賣），回每一筆的解析結果與 `previewId`；一次最多 40 筆 |
| `commit_entries` | **是** | 寫入預覽的內容：新增交易、調整帳戶餘額；股票更新持倉、已實現損益、交割帳戶 |
| `undo_entry` | **是** | 復原一筆 MCP 記的帳（軟刪除 + 還原餘額）；股票成交不能由 MCP 復原 |
| `preview_itinerary` | 否 | 驗證行程項目（加到現有旅程或新建旅程），回新增 / 更新明細與 `previewId`；一次最多 120 項 |
| `commit_itinerary` | **是** | 建立旅程（如需要）、寫入行程表的天與項目 |
| `preview_taifex_review` | 否 | 驗證台指期每週檢討 + 參數調整提案（範圍、權重總和），跑「目前 vs 提案」回測對照，回 `previewId` |
| `commit_taifex_review` | **是** | 存成 `taifex_reviews/{週日}` 並推播；**不改任何參數**，owner 在 App 核准才生效 |

項目格式與 `docs/AI_IMPORT_FORMAT.md` 相同（多一個選填的 `tripId`，把記帳歸到旅程）。行程項目 id 與 web 的
AI 匯入相同（日期 + 時間 + 標題），所以從 MCP 與 web 匯入同一份行程不會重複，重複匯入是更新。

### 3.3 台指期每週檢討（排程，無人值守）

排程執行時沒有人可以逐次確認，所以這組工具把「確認」移到 App 裡：

```
Claude 排程（週日 21:30）
  └─ taifex_weekly_review          讀這一週的狀態
  └─ preview_taifex_review         驗證 + 回測對照（不寫入）
  └─ commit_taifex_review          存提案、推播（不改參數）
owner 在 App「台指期模擬 → 週檢討」
  └─ 套用 applyTaifexReview        重驗範圍 → 寫 taifex_tuning/current、設定、audit_logs
  └─ 退回 rejectTaifexReview / 還原最近一次 revertTaifexTuning
```

- `commit` 寫入的只有檢討文件本身；同一週可以覆蓋還沒核准的那一份，已核准的不能覆蓋。
- 可調的 key 與上下限寫死在 `apps-script/src/TaifexTuning.gs`（`TAIFEX_TUNING_BOUNDS`）；超出範圍、未知的 key、權重總和不是 1 都在 preview 就回錯誤。
- 套用 / 退回 / 還原只有 Firebase 登入的 owner 能做（`Main.gs` action），MCP 沒有對應的工具。
- 改公式（演算法）不走 MCP：排程的 Claude 在 repo 開 PR，網址放進檢討的 `prUrl`，owner 合併後才部署。
- 排程提示詞在 App「週檢討 → Claude 排程設定」可以複製（`apps/web/src/features/taifex/review.ts`）。

### 3.4 可以怎麼說

| 你說 | AI 會做 |
|---|---|
| 「午餐 150 刷玉山」 | `entry_options` → `preview_entries` → 給你看「餐飲 / 玉山銀行 / NT$150」→ 你確認 → `commit_entries` |
| 「今天買 2330 一張 1050，手續費 150」 | `preview_entries`（trade，1000 股）→ 確認 → `commit_entries` |
| 「賣掉 400 股台積電 1100」 | 預覽時檢查持倉，不夠賣會直接標錯誤、不會寫入 |
| 「東京那趟昨天晚餐 8,800 日圓」 | `list_trips` 找 tripId → 帶 `tripId` 記帳，匯率用系統當下的 JPY |
| 「把這份行程排進京都的旅程」＋貼文字 | `list_trips` → `preview_itinerary` → 確認 → `commit_itinerary` |
| 「幫我排 12/20–12/24 大阪五天四夜並建成新旅程」 | `preview_itinerary`（帶 `trip`）→ 確認 → 建旅程 + 寫行程 |
| 「剛剛那筆記錯了」 | `undo_entry` |

## 4. 其他功能的 MCP 規劃（尚未實作）

依「價值 × 風險」排序。每一項都沿用第 2 節的模型（預設關、預覽 → 確認、稽核）。

| 優先 | 功能 | 規劃的工具 | 備註 |
|---|---|---|---|
| P1 | 轉帳（帳戶間移轉、繳卡費） | `preview_entries` 加 `kind: transfer` | 要先在匯入格式（schema / ImportApply，四處一起改）加 transfer，版本號 +1 |
| P1 | 修改 MCP 記的帳（改類別 / 付款方式 / 金額） | `update_entry` | 限 `source = 'mcp'`；改付款方式要還原再套用餘額（同 Telegram `qe:pms`） |
| P1 | 旅程行程：移動 / 刪除項目、每日主題、行程筆記 | `update_itinerary_items`、`set_trip_notes` | 刪除只做 `status = skipped` 或限 AI 匯入的項目 |
| P2 | 觀察名單、到價提醒 | `watchlist_add` / `watchlist_remove`、`alert_set` | 單文件寫入、可逆，風險低 |
| P2 | 機票追蹤（新增 / 暫停 / 改理想價） | `flight_watch_upsert`、`flight_watch_pause` | 沿用 FlightWatches.gs 的驗證；新增會增加每日查價的 API 花費，要有上限 |
| P2 | 預算、儲蓄目標、預定付款、訂閱 | `budget_set`、`goal_upsert`、`scheduled_payment_add`、`subscription_upsert` | 都是 upsert；訂閱取消用 `cancelledAt` 軟刪 |
| P2 | 股利入帳、分期計畫 | `dividend_record`、`installment_plan_add` | 分期要呼叫 `runInstallmentPlans` 讓已到期期數入帳 |
| P3 | 觸發既有排程（不是寫資料） | `refresh_quotes`、`refresh_fx`、`snapshot_portfolio`、`flight_watch_refresh` | 有 API 成本與 6 分鐘逾時，需要各自的每日上限 |
| P3 | 共同帳本 / 共同投資 | `household_*` | 牽涉其他成員的資料，要先定義成員授權再做 |
| 不做 | 刪除 / 批次修改既有交易、對帳調整、帳戶餘額直接改寫、白名單與權限、備份還原、台指期下單、直接套用台指期參數（只能提案） | — | 破壞性或不可逆；留在 App 內由本人操作 |

App 內的 AI（AI 分析、問一下、Telegram `/ask`）維持唯讀：它們由排程或單一訊息觸發，沒有「使用者逐次確認」這一層。

## 5. 新增工具的步驟

唯讀工具加在 `HubTools.gs`（`hubToolDefs_` + `hubRunTool_`，同步更新 `hub_catalog`）；寫入工具加在
`HubWriteTools.gs`（`hubWriteToolDefs_` + `hubWriteRunTool_`）。寫入工具必須：

1. 分成不寫入的 `preview_*` 與只收 `previewId` 的 `commit_*`（`hubWriteSavePreview_` / `hubWriteTakePreview_`）。
2. 呼叫 `hubWriteConsumeQuota_()` 與 `hubWriteAudit_()`。
3. 重用既有的寫入函式（web `api.ts` 對應的 Apps Script 版本），不要另寫一套規則；多文件寫入用 `fsBatchWrite_`。
4. 在 `apps-script/tests/hub-write.test.cjs` 補測試：唯讀連線呼叫不到、預覽不寫入、previewId 單次使用。
5. 更新本文件 3.2 與 `apps/web/src/features/mcp-access/components/oauth-consent.tsx` 的 `WRITABLE` 說明。
