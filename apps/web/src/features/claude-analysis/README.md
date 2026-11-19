# Claude Analysis（AI 分析）

使用者**手動觸發**的 Claude 分析報告。每次都是兩段式，沒有排程、沒有自動執行：

1. `estimateClaudeAnalysis` — 用免費的 `count_tokens` 算基礎 prompt（system + 工具定義 + 任務），
   再依預期的查詢輪數估出費用區間與本期額度。
2. 使用者在 `AnalysisConfirmDialog` 看過費用與「Claude 會查哪些範圍」後按「確認執行」，才呼叫
   `runClaudeAnalysis`（body 必須帶 `confirmed: true`，後端缺少就拒絕）。

## Claude 自己查資料（2026-11）

後端不再預先聚合整包資料塞進 prompt。`runClaudeAnalysis` 只送任務說明與一組**唯讀工具**
（`apps-script/src/HubTools.gs`），Claude 依任務決定要查哪些彙總 / 明細，查完才寫報告
（`claudeAgentLoop_`，`apps-script/src/Claude.gs`）。同一組工具也給「問一下」與 MCP（`features/mcp-access`）用。

| kind | 內容 | Claude 通常會查 |
|---|---|---|
| `monthlyReview` | 月度財務回顧 | 逐月 / 類別彙總、預算、需要追查的明細 |
| `subscriptionAudit` | 固定支出 / 訂閱健檢 | 週期範本、訂閱、依店家彙總的重複支出 |
| `portfolioReview` | 投資組合健檢 | 持股明細、市值走勢、淨值、投資規劃 |
| `transactionCleanup` | 記帳品質檢查 | 近 60 天交易明細（翻頁）、類別清單 |
| `tripReview` | 旅遊計畫檢視 | 旅程資料、行程表、旅程花費；可指定旅程或讓 Claude 自己挑 |

- 每張卡片有選填的「想特別關注的重點」（`focus`，最多 300 字），會附在任務後面。
- 費用護欄（`CLAUDE_ANALYSIS_LIMITS_`）：最多 6 輪工具查詢、累計 input 15 萬 tokens、200 秒；
  到上限就用 `tool_choice: none` 要求 Claude 以手上的資料完成報告。多輪請求開自動 prompt caching。
- 結果只回傳 Markdown 與 `toolCalls`（工具名稱 + 參數，顯示「Claude 查了什麼」），不回傳工具結果、不寫 Firestore；
  上次結果存在這台裝置的 localStorage（`claude-analysis:last:<kind>`）。
- 用量以 `analysis:<kind>` 記在 `ai_usage_events`（每一輪一筆），顯示於 設定 → AI 額度。
- 支出 / 收入口徑同 `isConsumptionExpense_` / `isEarnedIncome_`（工具內部統一處理）。

依賴：`ai-budget`（本期用量、`formatUSD`、模型名稱）、`trips`（旅程下拉選單）。

新增 kind 時前後端都要加：`CLAUDE_ANALYSIS_KINDS_` + `claudeAnalysisTask_`（GAS）、`definitions.ts` + `schema.ts` + `types.ts`、
`ai-budget/labels.ts`。新增工具只改 `HubTools.gs`，並在 `definitions.ts` 的 `TOOL_LABELS` 補顯示名稱。
機票雷達的 `flight_*` 工具說明見 `features/flight-watches/README.md`。
