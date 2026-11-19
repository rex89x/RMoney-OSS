# AI Budget（Claude API 額度）

追蹤 Claude API 用量、估算本期花費，並提供額度 / 模型設定與試算器。

- **資料來源**：Apps Script 每次呼叫 Claude 後，把 `response.usage`（input / cache / output tokens、web search 次數）
  依官方牌價換算成 USD，寫進 `ai_usage_events`（`provider: 'anthropic'`）。前端只讀，不可偽造（Rules：write false）。
- **計費週期**：預設每月 23 號（台北 00:00）重置、每期 US$100；`ai_budget_configs/{uid}` 的 `cycleResetDay` /
  `monthlyCreditUSD` 可調。週期邊界由後端 `aiCycleBounds_()` 計算後以 ISO 字串回傳，前端只做線性外推（`forecast.ts`）。
- **模型**：`defaultModel`（行程 / 問答 / AI 分析 / 機票搜尋）與 `fastModel`（收據 / 匯入 / Telegram）都預設
  `claude-opus-5-5`；後端以白名單 `CLAUDE_SELECTABLE_MODELS_` 驗證。
- **硬停止**：`hardStopEnabled` 開啟後，本期估算達額度時 `assertClaudeBudgetAvailable_()` 會拒絕新的請求。
- **警示**：達 `warningPercent` / 100% 各發一次 `aiBudget` 通知（以週期起日 `lastAlertCycle` 去重）。

顯示金額是估算，最終以 Anthropic Console 為準。2026-11 以前的 Gemini 事件（沒有 `provider`）不計入。

價格表有兩份要同步：`apps-script/src/Claude.gs` 的 `CLAUDE_MODEL_PRICES_` 與 `forecast.ts` 的 `CLAUDE_PRICES`。

被 `claude-analysis` 使用（共用 `AI_FEATURE_LABELS` / `formatUSD` / 本期用量）。
