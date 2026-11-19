# External integrations setup

Personal Hub 的第三方 credentials 全部放在 Apps Script **Script Properties**。不要放進
`apps/web/.env.local`、GitHub Secrets 或 source code。前端只呼叫 Apps Script Web App。

Apps Script editor：<https://script.google.com/d/1Ic-Z_srSgcyDOsAhnFBhpuMrqIm1Pg2ewEIRbAuSswsqvppZOb2zZ7tE/edit>

## 1. 機票掃描：Duffel、Claude API 搜尋或 Claude 排程

Google Flights 沒有提供一般開發者使用的查價 API；Google Flights Search 的官方整合只開放
航空公司與 OTA partner。Personal Hub 因此同時支援 Duffel 的結構化 flight offers，以及使用者
明確選取的 Claude API + Web Search 整理模式；兩者不會在失敗時偷偷互相 fallback。

1. 到 <https://app.duffel.com/join> 建立 Duffel 帳號。
2. 在 Duffel dashboard 建立 access token。測試可先用 test token確認授權，但 test offers 不是真實價格，
   app 不會將其存成價格快照；正式即時票價需完成 live mode onboarding 並改用 live token。
3. Apps Script Script Properties 新增：

| Key | Value |
|---|---|
| `DUFFEL_ACCESS_TOKEN` | Duffel access token |
| `FLIGHT_API_PROVIDER` | 選填；未保存 provider 的舊 watch 預設來源 |
| `FLIGHT_MONTHLY_REQUEST_LIMIT` | 選填，預設 `300`；達上限即停止 |
| `FLIGHT_ALLOW_GEMINI_FALLBACK` | 選填（名稱沿用）；僅供尚未保存 provider 的舊 watch 改用 Claude API 搜尋 |

成本保護：每次 watch 只輪替查一組出發／回程日期，每個所選艙等各 1 request。Duffel 公開牌價的
excess search fee 是 US$0.005/request（search-to-book ratio 超過 1500:1 時）；預設 300 次硬上限
即使全部計費也約 US$1.50/月。實際帳單與使用條款仍以 Duffel dashboard 為準。

機場欄位必須用三碼 IATA code（例如 `TPE`、`NRT`）。Duffel offer 約 30 分鐘內有效；本 app
只做價格雷達，不執行訂票或付款。

每條航線可在「機票雷達 → 新增／編輯航線 → 票價資料來源」選擇 Claude 排程、Claude API 搜尋或 Duffel。
選擇 Claude API 搜尋（`scanProvider: 'claude_api'`）即為該航線的明確 opt-in：後端用「設定 → AI 額度」的一般模型
加上 `web_search` 工具（每次掃描最多 5 次搜尋，US$0.01/次），只保存附有搜尋來源的結果；每次約 US$0.05–0.30，
依掃描頻率自動執行並扣 Claude API 額度。舊資料的 `scanProvider: 'gemini'` 自動視為 `claude_api`。

若所選 provider 缺少對應的 token/key，該 watch 會安全停止並在卡片顯示錯誤，不會自動改用另一個
可能產生費用的 provider。

Provider 已集中由 `flightProvider_(watch)` 分流，排程會按 provider 分組執行；後續可加入其他
供應商而不改票價結果格式。備選方案：

- Skyscanner Flights Live/Indicative Prices 最適合彈性日期與 booking deep link，但 API key 必須送
  Partnerships team 審核，並非一般帳號註冊後立即可用。
- Google Flights Search 沒有 public consumer API，官方文件只提供受邀 airline/OTA partner onboarding。
- Amadeus Self-Service 過去很適合個人專案，但現階段不作為新整合首選；避免把新功能綁在生命週期
  不確定的方案上。

### 1.1 Claude 排程推送（不另付票價 API 費用）

不想為 Duffel / Claude API 搜尋付費時，航線可選「Claude 排程推送」：由 Claude 的排程任務（claude.ai
scheduled task，跑在 Claude 雲端環境）自己上網查價，整理成 JSON 後 POST 到 Apps Script
`?action=ingestFlightPrices`。Apps Script 這條路徑**不呼叫任何外部 API**。

```
Claude 排程（每天）── web search ──▶ /tmp/flight-prices.json
      │  python 讀環境變數 RMONEY_FLIGHT_INGEST_TOKEN 塞進 body
      ▼
Apps Script ingestFlightPrices ── 驗 token 雜湊 / criteriaKey / 價格與條件 ──▶ flight_watches + snapshots ──▶ Telegram
```

**設定步驟**

1. 機票雷達 → 編輯航線 → 掃描方式選「Claude 排程推送」。
2. 機票雷達 → 「Claude 排程」→ 產生 token（只顯示一次）。
3. 在 Claude 雲端環境設定（session 標題列的環境選單 → Edit）：
   - 環境變數 `RMONEY_FLIGHT_INGEST_TOKEN=<剛產生的 token>`。
   - Network access 的 Allowed domains 加 `script.google.com`、`script.googleusercontent.com`
     （Apps Script Web App 會 302 轉址到後者）。說明：<https://code.claude.com/docs/en/cloud-environments#network-access>
4. 「Claude 排程」→ 複製提示詞，在 Claude 用這個環境建立每日排程任務，貼上提示詞。
5. 航線條件（日期、艙等、航空公司…）有改就重新複製提示詞並更新排程；舊提示詞推送會被拒收。

航線多時可在「Claude 排程」只勾部分航線，分成多個排程任務；推送指令會自動每 10 條分一批。
新增航線或改條件後，對話框會標示「尚未加入排程／條件已改」，總覽也會列在「需要處理」。
使用者操作步驟（含 claude.ai 介面路徑）見 [`USER_GUIDE.md`](./USER_GUIDE.md#機票雷達)。

排程無法連網時，提示詞會要求 Claude 改成在回覆輸出 JSON，可到「Claude 排程 → 貼上結果」手動匯入
（`importFlightPrices`，走 Firebase 登入驗證，規則相同）。

**安全設計**

| 風險 | 處理 |
|---|---|
| Token 外洩 | 只寫不讀：回應只有每筆成功／失敗，不回傳任何 Firestore 資料；只能寫 token 擁有者、來源為 Claude 且啟用中的航線。前端隨時可重新產生（舊的立即失效）或撤銷 |
| Token 保存 | 前端以 `crypto.getRandomValues` 產生 256-bit token，Apps Script 只存 SHA-256（`FLIGHT_INGEST_TOKEN_SHA256`），比對用 constant-time；token 放 POST body，不放 URL |
| 網頁 prompt injection 讓 Claude 回報假低價 | 後端重驗艙等／日期／晚數／直飛／廉航／航空公司條件，來源必須是 https URL；比前次常見價低 60% 以上視為可疑：降為低可信度、不更新歷史最低、不發低價通知 |
| 提示詞過期 | 每筆結果必須帶 `criteriaKey`（搜尋條件 SHA-256 前 12 碼），與目前條件不符就拒收並在卡片顯示原因 |
| 灌資料 / 重送 | 一次最多 20 筆、payload 200KB；每日總計 60 筆、每條航線每日 6 筆上限 |
| watchId 路徑注入 | watchId 只接受 `[A-Za-z0-9_-]{1,64}`，不存在與無權限回同一個錯誤 |

### 1.2 股市雷達 Claude 排程（盤前輿情）

股市雷達（`/stock-radar`）的量化因子由 Apps Script 每天 08:00 計算；網路新聞與輿情由 Claude 排程
上網整理後 POST 到 `?action=ingestStockSentiment`，Apps Script 用固定公式合成買賣建議。架構與 1.1 相同。

```
Claude 排程（台股 07:30 / 美股 20:30）── web search ──▶ /tmp/stock-sentiment.json
      │  python 讀環境變數 RMONEY_STOCK_INGEST_TOKEN 塞進 body
      ▼
Apps Script ingestStockSentiment ── 驗 token 雜湊 / 追蹤清單 / 分數範圍 / https 來源 ──▶ stock_radar_sentiment
      └─ 當天評估已存在 → 重新合成 stock_radar_runs ──▶ Telegram
```

**設定步驟**

1. 股市雷達 → 「Claude 排程」→ 產生 token（只顯示一次，與機票雷達的 token 分開）。
2. Claude 雲端環境加環境變數 `RMONEY_STOCK_INGEST_TOKEN=<token>`；Allowed domains 同 1.1
   （`script.google.com`、`script.googleusercontent.com`）。可與機票雷達共用同一個環境。
3. 對話框切到「台股」→ 複製提示詞 → 在 Claude 建立排程「週一到週五 07:30」。
4. 切到「美股」→ 複製提示詞 → 建立排程「週一到週五 20:30」。
5. 持股或自選股改了：先按「重新評估」，再重新複製該市場提示詞（對話框會標示需要重新複製）。

**安全設計**

| 風險 | 處理 |
|---|---|
| 持股資料外流 | 提示詞只有代號與名稱；Claude 拿不到股數、成本、占比。回應只有每檔成功／失敗原因 |
| Token 外洩 | 只寫不讀，只能寫目前追蹤清單內代號的輿情；Apps Script 只存 SHA-256（`STOCK_INGEST_TOKEN_SHA256`），可隨時輪替或撤銷 |
| 網頁 prompt injection 灌假輿情 | 輿情只能影響分數 ±0.3、沒有 https 來源不計分；最終動作由固定公式決定，不採用模型的買賣建議 |
| 灌資料 / 重送 | 一次最多 60 檔、payload 200KB；每個市場每天最多 6 次推送，同日多次推送以代號合併 |

台股籌碼（三大法人、融資）由 `tick_daily_0100` 從 TWSE 公開資料同步，不需要任何 key。
演算法與論文見 [`STOCK_RADAR_PLAN.md`](./STOCK_RADAR_PLAN.md)。

## 2. 財政部電子發票 API

自動同步使用財政部電子發票應用 API。`carrierInvChk` 使用現行 `0.6`（含 `page`／`996` 分頁），
`carrierInvDetail` 依官方規格使用 `0.5`。

1. 到 <https://www.einvoice.nat.gov.tw/> 登入電子發票整合服務平台。
2. 依「消費者文件下載／電子發票應用 API」流程申請 AppID。這不是一般手機條碼帳號自動附送，
   需等財政資訊中心核准。
3. 確認自己的手機條碼與驗證碼可登入平台。
4. Apps Script Script Properties 新增：

| Key | Value |
|---|---|
| `EINVOICE_APP_ID` | 財政部核發 AppID |
| `EINVOICE_CARD_NO` | 手機條碼，例如 `/ABC+123` |
| `EINVOICE_CARD_ENCRYPT` | 手機條碼驗證碼 |
| `EINVOICE_PAYMENT_METHOD` | 選填，預設「信用卡」 |
| `EINVOICE_ACCOUNT_ID` | 選填，扣款帳戶的 doc id（Firebase console → Firestore → `accounts` 集合）；設了同步扣該帳戶餘額 |

完成後到 app「設定 → 發票 → 立即同步」，先選近 3 天測試。每日 01:00 排程會同步近 7 天，
同發票號碼、作廢與已忽略資料都會跳過。尚未取得 AppID 時仍可使用 CSV 匯入，不受影響。

## 3. Claude API

所有站內 AI（行程、財務問答、Telegram 文字解析、收據辨識、AI 匯入、AI 分析、機票 Claude API 搜尋）都走
`apps-script/src/Claude.gs` 的 `callClaude_()`（Anthropic Messages API，`anthropic-version: 2026-10-21`）。

1. 到 <https://platform.claude.com> 登入有 API 額度的組織 → Settings → API Keys → Create Key。
2. Apps Script Script Properties 新增 `ANTHROPIC_API_KEY`（舊的 `GEMINI_API_KEY` 可以刪除）。
3. 到 app「設定 → AI 額度」確認每期額度（預設 US$100）、重置日（預設每月 23 號，台北 00:00）、警示門檻，
   視需要開啟「額度用完後停止 Claude」。

模型（可在 設定 → AI 額度 調整；官方牌價 / 1M tokens）：

| 用途 | 預設 | 價格 |
|---|---|---|
| 一般：行程、財務問答、AI 分析、機票搜尋 | `claude-opus-5-5` | input US$4 / output US$20 |
| 快速：收據辨識、AI 匯入、Telegram 記帳 | `claude-opus-5-5` | 同上（可改 `claude-haiku-5-5`：US$0.10 / US$0.50） |
| Web search | — | US$0.01 / 次 |

成本控制：thinking 一律開但依任務設定 `effort`（解析類 `low`、行程 / 分析 `medium`）；output（含 thinking）
是主要成本。Opus / Sonnet / Fable 請求帶 server-side refusal fallback（`fallbacks: "default"`），
被安全分類器拒絕時由 API 自動改用備援模型，費用以實際服務的模型計價。
用量計量：每次回應的 `usage` 依牌價換算寫入 `ai_usage_events`，是估算值，實際扣款以 Anthropic Console 為準。

AI 分析（側欄「AI 分析」）一律兩段式：先用免費的 `count_tokens` 估價，使用者按「確認執行」才呼叫 Claude。
2026-11 起分析改成 Claude 自己查資料：後端不再預先聚合整包資料塞進 prompt，而是給 Claude 一組唯讀工具
（`apps-script/src/HubTools.gs`），它依任務決定要查哪些彙總 / 明細。費用因此是區間（依查詢輪數），
護欄是最多 6 輪工具查詢、累計 input 15 萬 tokens、執行時間 200 秒，到上限就以手上的資料完成報告。
「問一下」與 Telegram `/ask` 也用同一組工具，所以可以問持股與旅遊行程。

### 3.1 MCP：讓外部 AI（Claude.ai / Claude Code / Claude Desktop）自己查資料、幫你記帳

同一組唯讀工具也透過 MCP 對外提供（`apps-script/src/Mcp.gs`，`?action=mcp`）。總規劃、寫入的安全模型與
之後要補的工具見 `docs/MCP_TOOLS.md`。唯讀工具清單：

| 範圍 | 工具 |
|---|---|
| 目錄 | `hub_catalog`（有哪些資料、該用哪個工具） |
| 記帳 | `sum_by_month`、`sum_by_category`、`sum_by_payment_method`、`spend_by_merchant`、`list_transactions`、`budget_status` |
| 資產 | `accounts_balance`、`net_worth_latest`、`net_worth_history` |
| 投資 | `portfolio_latest`、`portfolio_positions`、`portfolio_history`、`stock_quotes` |
| 旅遊 | `list_trips`、`trip_detail`、`trip_itinerary`、`trip_expenses` |
| 機票雷達 | `flight_watches`（航線清單 + 最新價格）、`flight_price_history`（歷史走勢與統計）、`flight_date_prices`（各出發日的最新 / 歷史最低價） |
| 其他 | `list_records`（週期範本、訂閱、分期、儲蓄目標、投資規劃、負債、股利、已實現損益、機票追蹤、匯率…） |

接法依 client 而定：

| Client | 走哪裡 | 驗證 |
|---|---|---|
| Claude.ai 網頁版 / 手機 App | MCP 閘道（Cloud Functions，見 3.2） | OAuth：跳到 Personal Hub 用 Google 登入，owner 按「允許」 |
| Claude Code / Claude Desktop | `scripts/hub-mcp.mjs` stdio bridge → Apps Script | `rmcp_…` token，放在環境變數與 POST body |

**Claude Code / Claude Desktop（bridge）**

1. App 側欄「AI 分析」最下方「MCP 連線」→「產生 token 並啟用」。Token 只顯示一次，後端只存 SHA-256。
2. 在 repo 根目錄執行畫面上的指令（零依賴、Node 18+）：
   ```bash
   claude mcp add personal-hub -e HUB_MCP_URL=<Web App URL> -e HUB_MCP_TOKEN=rmcp_... -- node scripts/hub-mcp.mjs
   # 先自我檢查連線與工具清單
   HUB_MCP_URL=<Web App URL> HUB_MCP_TOKEN=rmcp_... node scripts/hub-mcp.mjs --check
   ```
   Claude Desktop 的 `claude_desktop_config.json` 用同樣的 `command: node`、`args: [<repo>/scripts/hub-mcp.mjs]`、`env`。
3. 不用了或懷疑外流：同一張卡片「撤銷」或「重新產生 token」，舊 token 立即失效。

**寫入（選用，預設關閉）**

開啟後可以直接跟 AI 說「午餐 150 刷玉山」「買 2330 一張 1050」或請它把行程匯進旅程。多出 6 個工具
（`apps-script/src/HubWriteTools.gs`）：`entry_options`、`preview_entries` → `commit_entries`、`undo_entry`、
`preview_itinerary` → `commit_itinerary`。

- 怎麼開：Claude.ai 在同意畫面打開「同時允許寫入」，或之後到「MCP 連線」卡片對該 client 切換「允許寫入」
  （下一次呼叫就生效；Claude.ai 要重新整理 connector 才會看到新的工具清單）。bridge token 用卡片上的
  「允許 bridge token 寫入」，重新產生 token 會回到唯讀。
- 每次寫入都是「預覽 → 你確認 → 寫入」：`commit_*` 只收預覽回傳的 `previewId`（30 分鐘、單次使用）。
- 不能修改或刪除既有資料；`undo_entry` 只能軟刪除 MCP 自己記的帳。每日最多 200 次寫入，每次寫一筆稽核紀錄
  （設定 → 資料 → 稽核紀錄）。
- 記帳 / 股票走與 web、Telegram 相同的 AI 匯入邏輯（`ImportApply.gs`，格式見 `docs/AI_IMPORT_FORMAT.md`）。

安全邊界：預設唯讀、有筆數與字數上限；每日最多 1,500 次呼叫；email、uid、座標等內部欄位不會回傳。
Apps Script 端點只接受 body 裡的 token / 閘道密鑰，**不接受放在 URL 的 token**（舊的 `?key=` 直接連線模式已移除）。

### 3.2 MCP 閘道（Claude.ai 網頁版 / 手機 App）

Apps Script Web App 會 302 轉址、不能回正確的 HTTP 狀態碼、也讀不到 `Authorization` header，Claude.ai 的
connector 無法直接連。`functions/` 是放在前面的閘道（Cloud Functions 2nd gen，`asia-east1`）：

```text
Claude.ai ──(OAuth 2.1 + Bearer token)──▶ https://asia-east1-<project>.cloudfunctions.net/mcp
                                              │ 驗 token / 授權 / owner 角色
                                              ▼ body: { gatewaySecret, rpc, uid, write, client }
                                          Apps Script ?action=mcp ──▶ HubTools.gs（唯讀）
                                                                  └─▶ HubWriteTools.gs（grant 開了寫入才有）
```

- **授權**：OAuth 2.1 authorization code + PKCE（S256）、動態用戶端註冊。授權頁是 Personal Hub 的
  `/oauth/authorize`（Google 登入），只有 `users/{uid}.role` 為 owner / admin 的人能按「允許」。
- **redirect_uri 白名單**：只接受 `claude.ai` / `claude.com`（https）與本機 loopback，授權碼不會被導到其他網站。
- **Token**：授權碼 5 分鐘單次使用；access token 1 小時；refresh token 90 天、每次使用輪替。Firestore 只存 SHA-256。
- **撤銷**：「AI 分析 → MCP 連線」列出已授權的 client，撤銷後下一次呼叫就失效（每次呼叫都重新檢查授權與角色）。
- **寫入權限**：存在 grant 上（`mcp_oauth_grants/{id}.write`），預設 false；owner 在同意畫面或卡片上切換
  （`/oauth/grants/update`）。scope 相應是 `hub.read` 或 `hub.read hub.write`；client 自己要求的 scope 不影響結果。
- **閘道 → Apps Script**：閘道第一次啟動時產生密鑰存進 Firestore `mcp_gateway/secret`，Apps Script 以 script owner
  身分讀同一份來比對。`mcp_oauth_*` 與 `mcp_gateway` 都沒有對應的 Security Rule，落在預設 deny，前端讀寫不到。
- **Metadata**：authorization server metadata 由 Hosting 提供靜態 JSON（`/.well-known/oauth-authorization-server`，
  build 時由 `functions/lib/gateway.js` 產生）；protected resource metadata 由閘道自己回。

**一次性設定（owner 手動，之後都由 CI 部署）**

1. Firebase Console → 專案升級為 **Blaze**（用量計費；個人用量在免費額度內，建議順手設預算提醒）。
2. 啟用 API（Cloud Shell 或本機 gcloud）：
   ```bash
   gcloud services enable cloudfunctions.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
     run.googleapis.com eventarc.googleapis.com pubsub.googleapis.com firebaseextensions.googleapis.com --project <your-project-id>
   ```
3. 給 CI 用的 Service Account（GitHub secret `FIREBASE_SERVICE_ACCOUNT` 那一個）部署 Functions 的角色：
   ```bash
   SA=<service-account-email>
   for ROLE in roles/cloudfunctions.admin roles/run.admin roles/iam.serviceAccountUser \
               roles/artifactregistry.admin roles/cloudbuild.builds.editor roles/firebaseextensions.viewer \
               roles/serviceusage.serviceUsageConsumer; do
     gcloud projects add-iam-policy-binding <your-project-id> --member="serviceAccount:$SA" --role="$ROLE" --condition=None
   done
   ```
4. GitHub → Actions → **Deploy Functions (MCP gateway)** → Run workflow（或 push `functions/**` 的變更）。
5. claude.ai → Settings → Connectors → Add custom connector，貼「MCP 連線」卡片上的 Connector 網址
   （`https://asia-east1-<your-project-id>.cloudfunctions.net/mcp`，不含任何密鑰）→ 跳到 Personal Hub 登入並按「允許」。
   手機 App 會同步網頁版設定的 connector。

## 4. 部署後檢查

`diag` 只回傳 credential 是否存在，不回傳值；2026-11 起要帶 `secret=`（= Script Property `TG_WEBHOOK_SECRET`），
`tgDiag` / `tgInfo` / `tgFlush` 同樣規則，舊的 `tgWhPublic` / `tgFlushPublic` 已移除：

```text
https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?action=diag&secret=<TG_WEBHOOK_SECRET>
```

確認 `hasDuffelToken`、三個 `hasEinvoice*`、`hasAnthropicKey`、`claudeModels` 與 `flightProvider`。任何 token、手機條碼、
驗證碼或 API secret 都不要貼到 issue、PR、log 或對話中。
