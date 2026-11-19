# Feature: flight-watches

管理旅遊目的地的機票價格雷達，回答「何時去比較便宜」與「經濟艙或商務艙是否值得」。

獨立 route 為 `/flights`；桌面側欄直接進入，手機可由 `/trips` 頁首的機票雷達入口進入。

- `flight_watches/{watchId}`：搜尋條件、最新公開票價估計、歷史最低價。
- `flight_watches/{watchId}/snapshots/{snapshotId}`：每次成功掃描的價格區間快照，由 Apps Script 寫入。
- 前端負責 CRUD、每筆 watch 的 provider 選擇與手動刷新；第三方 API 一律由 Apps Script 呼叫。
- 每筆 watch 可選 `claude`（Claude 排程推送，見下方，新 watch 預設）、`claude_api`（Apps Script 呼叫 Claude API + web search）或 `duffel`。舊資料未保存 provider 時才沿用 Script Properties 的全域設定。
- 2026-11 Gemini → Claude 遷移：舊的 `scanProvider: 'gemini'` 在前端 converter（`parseScanProvider`）與後端 `flightProvider_` 都視為 `claude_api`；`geminiModel` 欄位已不再讀寫。
- `claude_api` 用 設定 → AI 額度 的一般模型，每次掃描最多 5 次 web search；計入 Claude 額度與硬停止，沒有 web search 來源（citations 或 `web_search_tool_result`）的結果不得保存。
- 解析只取最後一次搜尋之後的 text block（`parseFlightWatchClaudeResponse_`），也保留舊 Gemini `candidates` 格式的解析給測試 / 舊資料。
- 每次 watch 輪替一組日期與晚數、每個艙等各 1 request；每月預設硬上限 300 requests。
- `tick_daily_0900` 依每筆訂閱的每日／平日／每週排程，輪流掃描最多 10 筆到期項目。
- 機場使用可搜尋 IATA 選單，可輸入清單外的三碼 IATA 機場代碼。
- 一個訂閱可同時比較多種艙等；結果保存 `cabinEstimates` 與最多 12 組 `travelWindows`（盡量分散在不同週與晚數，供「出發時機」與「候選日期評估」比較）。
- 航空公司條件支援不限、只看指定、排除指定，另可獨立排除廉價航空與限制直飛。
- 展開價格趨勢時才讀取最近 36 筆 snapshots，避免列表初次載入產生不必要讀取。
- `advice` 由程式以理想價、常見價與前次價格決定，不直接採用模型的購買建議。
- Telegram 可設定只在達理想價或跌幅達自訂門檻時通知，也可每次排程掃描都回報目前各艙等價格與推薦日期。

## Claude 排程推送

- `scanProvider = 'claude'`：Apps Script 每日排程與「立即更新」都跳過這類航線，改由使用者的 Claude 排程查價後 POST `ingestFlightPrices`（`apps-script/src/FlightIngest.gs`）。
- `claude-schedule.ts`：產生 ingest token（前端 CSPRNG，後端只存 SHA-256）、`flightCriteriaKey`（須與 GAS `flightWatchCriteriaKey_` 一致）、排程提示詞、貼上結果解析（走 `features/import/json-repair.ts`）。
- `components/claude-schedule-dialog.tsx`：token 產生／撤銷、複製提示詞、手動貼上結果（`importFlightPrices`，Firebase 驗證）。
- 推送結果與 Claude API 搜尋共用 `buildFlightEstimateFromRaw_` 驗證；estimate 帶 `provider: 'claude'`。異常低價只保存快照、不更新 `bestPriceTWD`、不發低價通知。
- 卡片在 3 天以上沒收到推送時顯示提醒。設定步驟與安全設計見 `docs/INTEGRATIONS_SETUP.md` §1.1。
- `claudePromptKey`：複製提示詞時記下每條航線當下的 criteriaKey（`markClaudePromptKeys`，writeBatch）。與目前條件比較得出 `synced / stale / new / excluded`（`claudeWatchStatuses`），對話框可勾選部分航線分成多個 Claude 排程；推送指令每 10 條自動分批。

## 日期區段、總覽與說明

- `segmentLabel`：同一條航線可以有多個日期區段（各自一筆 watch），列表依 `flightRouteKey` 分組；卡片「同航線新增日期區段」沿用條件、日期往後接續。
- `/flights` 分成「總覽 / 航線 / 使用說明」三個分頁（`components/flight-radar.tsx`），Claude 排程對話框由頁面統一持有。
- `dashboard.ts`：總覽的純函式（KPI、需要處理、價格尺、跨區段最划算日期、走勢寬表）。走勢每個區段每天一點、最多 8 條，顏色依建立順序固定（`stableSeriesIndex`），不跟排名變。
- 首頁 Dashboard 卡片 `flightRadar`（`flight-radar-card.tsx`）：最便宜 3 個區段 + 待處理數量。
- App 內使用說明 `flight-radar-guide.tsx` 與 `docs/USER_GUIDE.md`「機票雷達」章節內容要一起更新。

Duffel 的可售 offer 通常約 30 分鐘後到期；Claude API 搜尋則是整理有 web search 來源佐證的公開價格，並非可直接購買的報價。兩條路徑都會再次檢查艙等、日期、晚數、直飛與已知廉航條件，UI 必須持續顯示限制與來源。

## 單程／來回、航班細節、排程群組、總覽分析

- `tripType`（`roundtrip` | `oneway`，舊資料視為來回）：單程不檢查晚數、`returnDate` 為空字串；Duffel 單程只送一個 slice；Claude API／Claude 排程提示詞都會標明。criteriaKey 只有單程才多加 `oneway` 一段，來回指紋與舊版相同（既有提示詞不失效）。
- `FlightTravelWindow` 選填細節：`departureTime`、`arrivalTime`、`returnDepartureTime`、`returnArrivalTime`（HH:mm 當地時間）、`durationMinutes`、`flightNumber`。Apps Script `flightWindowDetails_` 驗格式，不合法就捨棄欄位；Duffel 從 segments 自動帶入。
- `claudeGroup`：Claude 排程群組（空字串 = 預設群組），一個群組一個 Claude 排程任務。同步標記 `claudePromptKey` = criteriaKey（預設群組）或 `criteriaKey@群組`，移動群組會顯示需重新複製。
- 篩選（行程／艙等／航線）在 `flight-radar.tsx`，同時套用總覽與列表；KPI 與需要處理看全部區段。
- 總覽區塊：目前最低價機票（`flight-ticket.tsx`）、需要處理、出發時機（週熱度＋推薦週、週幾、晚數）、候選日期評估、價格尺、艙等價差、出發日散點、航班細節（直飛／時段／航空公司）、走勢。分析類區塊有「分析區段」選單，預設最便宜區段；週幾／時段／航空公司在同一艙等內比較。
- 版面（區塊顯示與順序）存 `users/{uid}.preferences.flightRadar`。


## 多點進出（open-jaw，2026-11）

- `tripType = 'openjaw'`：去程 `origin → destination`（A 進），回程 `returnOrigin → returnDestination`（B 出）。只有 openjaw 保存這兩個欄位，其他行程寫空字串。
- 回程航段一律經 `flightReturnLeg()`（前端 `types.ts`）／`flightReturnLeg_()`（GAS）；晚數、日期輪替、`returnDate` 驗證與來回相同（`hasReturnLeg()`）。
- Duffel：第二個 slice 改成 `returnOrigin → returnDestination`，就是 multi-city 報價。Claude API／Claude 排程提示詞明寫「同一張多城市機票合計，不可用兩張單程相加」。
- criteriaKey：openjaw 才多加 `openjaw|returnOrigin|returnDestination`，來回／單程的指紋不變（既有 Claude 提示詞不失效）。前後端要一起改。
- `flightRouteKey()` / `flightRouteText()` 把回程兩端納入，所以「TPE→NRT 來回」與「TPE→NRT／KIX→TPE」是不同航線組；圖表短名稱為「NRT/KIX 寒假」。
- 總覽版面：長名稱一律換行（不 `truncate`）、艙等價差 Y 軸寬度依名稱估算、走勢與散點 X 軸加 padding，避免多點進出名稱或邊緣點被切掉。

## 拼單程（separate one-way tickets，2026-11）

- `ticketSearch`：`single` 一張票（來回 / 多城市）、`separate` 去回各買一張單程、`both` 兩種都查取較便宜；`null` = 依行程預設（`flightTicketSearch()`：多點進出 `both`、來回 `single`、單程不適用）。表單選到預設值時存 `null`。
- `FlightTravelWindow` 多 `ticketing`（`single` / `separate`，舊資料沒有 = 一張票）、`outboundPriceTWD`、`returnPriceTWD`、`returnAirline`。拼單程的 `priceTWD` = 兩段相加。
- Duffel（`FlightWatches.gs`）：`flightDuffelRequest_(..., leg)` 的 leg 為 `full` / `outbound` / `return`；`both` 每個艙等 3 個 request、`separate` 2 個（都算進每月 request 上限）。`combineDuffelSeparateRows_` 以同艙等最便宜的去程 + 回程組一筆 `separate` 候選。
- Claude API / Claude 排程：提示詞依購票方式要求 `ticketing`，拼單程必填兩段價格。`flightWindowTicketing_` 驗證：兩段都 ≥ 500、與 `priceTWD` 差距 ≤ 5%（總價一律重算為兩段相加），回程航空公司也要符合航空公司條件；購票方式不允許的票種直接捨棄。
- criteriaKey：只有購票方式**不是行程預設值**時才多加 `ticket:<mode>`，既有提示詞不失效（前後端一致）。
- UI：表單「購票方式」三選一；票卡與候選日期標「拼單程」並列出去 / 回各段價格；航線卡顯示「一張票最低 vs 拼單程最低」；候選日期可依票種篩選。
- 測試：`apps-script/tests/flight-watches.test.cjs`、`apps/web/tests/flight-ticketing.test.cjs`。

## 共同帳本伴侶也能用（2026-11-05）

- **同一份雷達、各自建立**：伴侶（role `member`）看得到 owner 建的航線，也能自己新增；owner 也看得到伴侶建的。只有**建立者**能編輯 / 刪除 / 暫停 / 立即更新；
  別人建的卡片標「X 建立 · 唯讀」，「同航線新增日期區段」會在自己名下另建一筆（不沿用對方的 Claude 群組）。
- `flight_watches.sharedWith: string[]`：建立時 = 共同帳本其他成員；`useSyncFlightWatchSharing()`（/flights 掛載）在建立者那端依目前成員補齊 / 收回，
  舊資料第一次打開 /flights 就會補上。純函式 `flightSharingDrift()` 在 `sharing.ts`。共同帳本還在載入時不同步，避免誤清空。
- 讀取 = 兩個 query 合併：`userId == 我`（既有 index）＋ `sharedWith array-contains 我`（單欄位，不 orderBy、前端排序）。
- rules：owner 照舊全開；member 讀 `userId == 自己 || 自己 in sharedWith`（get 先判 null），寫只限自己建立的（update 不能改 `userId`），
  `snapshots` 看得到訂閱就能讀。
- member 側欄 / 底部分頁多「機票雷達」，`ProtectedRoute` 放行 `/flights`。
- Apps Script `MEMBER_ALLOWED_ACTIONS_` 多 `refreshFlightWatch`、`importFlightPrices`（都比對 `watch.userId === authResult.uid`，只能更新自己建的）。
  推送 token（`set/revokeFlightIngestToken`、`getFlightIngestStatus`）是整個 Script 共用一把，**不開放** —— Claude 排程對話框對 member 隱藏 token 區、改用「手動貼上結果」；
  Claude 排程對話框只列自己建立的航線。
- 通知分流（`notifyFlightPrices_`）：依建立者 —— owner 的照舊走 `sendNotification_('flightDeals')`；member 的發到他綁定的 `telegram_links/{uid}.chatId`，沒綁就不發。
- Claude API 掃描計入 Claude 額度（設定 → AI 額度）；Duffel request 另有每月 request 上限。

## MCP / AI 工具（2026-11-12）

`apps-script/src/HubTools.gs` 提供三個唯讀工具，MCP、App 內 AI 分析、問一下共用：

- `flight_watches`：航線清單 + 最新價格區間（拿 `watchId`）。
- `flight_price_history`：`snapshots` 每天一點（當天最後一次查價）的走勢與統計（最低 / 最高 / 平均、目前相對歷史的位置）。
- `flight_date_prices`：把歷次快照的 `travelWindows` 依「出發日 / 回程日 / 艙等 / 票種」彙總成最新價、歷史最低價與出現次數。

一次最多讀最近 300 筆快照（`HUB_FLIGHT_SNAPSHOT_LIMIT_`）；不回傳 `userId` / `sharedWith` / 來源網址。快照欄位有變動時要一起改這三個工具。
