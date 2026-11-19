# analytics

記帳統計 / 分析 / 圖表的單一來源。首頁卡片、記帳 → 分析、年度回顧、月底預測、Inbox 預算警示都從這裡取數字。

## 責任邊界

| 檔案 | 內容 |
|---|---|
| `metrics.ts` | 純函式：消費支出 / 實際收入口徑、期間彙總、類別增減、商家排行、星期 / 每日加總、日/週/月 bucket、12 個月類別序列、固定 vs 變動、類別預算節奏、首頁一句話結論、記帳後預算回饋文字 |
| `periods.ts` | 純函式：期間（本月 / 上月 / 本季 / 近 30 / 90 天 / 今年）與「比較期間」（進行中的期間只比同期，月底自動 clamp） |
| `hooks.ts` | `useRangeTransactions`（固定 `RANGE_TX_LIMIT`，讓同期間的卡片共用同一個 query key）、`usePeriodComparison`、`useMonthlyForecast`、`useCategoryAnomalies`、`useCategoryLookup` |
| `drilldown.ts` | 圖表點擊 → `/ledger?tx_*` 交易列表 |
| `use-budget-impact.ts` | 快速記帳存檔後的預算 toast |
| `components/` | `AnalysisPanel`（記帳 → 分析）、`MonthStatusCard`（首頁置頂）、`CategoryBars`、`DeltaBadge`、各分析卡片 |

## 口徑（必讀）

- **消費支出** = `type === 'expense'`，排除 `rental_purchase`（資產轉換）、`adjustment`（對帳）、`household_settlement`（結算還錢）。
- **實際收入** = `type === 'income'`，排除 `adjustment_income`、`household_settlement_income`。
- 支出一律用「我負擔」（`useMyExpenseShare`）。
- Apps Script 對應 `Notifications.gs` 的 `isConsumptionExpense_` / `isEarnedIncome_`，兩邊清單要同步改。

## 規則

- 新的統計卡片請用 `useRangeTransactions(range)`。
- **交易共用視窗**（`features/ledger/tx-window.ts`）：`useTransactions` 對「近 12 個完整月份 + 本月」只讀一次 Firestore（query key `['transactions', uid, 'window', yyyy-MM]`），
  區間落在視窗內的查詢（不論 `startDate` / `endDate` / `limit` / `category` / `type` / `scope` 怎麼組合）都在前端切片，不再各讀一次。
  只有視窗答不了的才獨立查詢：起始日早於視窗（年度回顧的去年、ytd 的比較期間）、帶 `tripId`、沒有 `startDate` 又湊不滿 `limit`、或視窗被 `TX_WINDOW_LIMIT` 截斷時較舊的區間。
  → 需要更久以前的資料請明確給 `startDate` / `endDate`，不要用「不帶日期 + 大 limit」。
- 期間用 `usePeriodRange` / `useComparisonRange`（以台北日期當 memo key），不要把 `nowTW()` 直接當範圍終點：每次 render 都不同會讓 query key 一直變。
- 圖表顏色用 `lib/chart-theme.ts`（`--chart-*` token），Tooltip 套 `CHART_TOOLTIP_PROPS`，深色模式才看得清楚。
- 測試：`apps/web/tests/analytics.test.cjs`。
