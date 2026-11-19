# goals — 目標儲蓄

## 職責
- 個人 / 共同儲蓄目標的 CRUD、封存、存入紀錄與 ETA 估算。
- UI：`GoalsPanel`（設定 → 目標；`/shared?tab=goals` 以 `householdId` 只列共同目標）、`SavingsGoalsDashboardCard`（首頁）。

## 資料模型
`savings_goals/{id}`（`goalConverter`）
- `name`、`targetTWD`、`currentTWD`（存入加總的快取）、`targetDate?`、`icon?`、`color?`、`monthlyPlanTWD?`
- `householdId?`：有值 = 共同目標（成員可存入）；null = 個人目標
- `archivedAt?`（封存，列表會過濾）、`createdAt` / `updatedAt`

`savings_goals/{id}/contributions/{id}`（`goalContributionConverter`）
- `date`、`amountTWD`、`note?`、`byUid?`（共同目標記誰存的）

## 主要邏輯
- `addContribution` / `deleteContribution` 用 `runTransaction` 同步更新 `currentTWD`，確保與子集合一致。
- `useGoalEta`：近 90 天存入合計 ÷ 3 當月速度；沒有紀錄時改用 `monthlyPlanTWD`。日期推算用 `addTWCalendarMonths`。
- `requiredMonthlyTWD`：依 `targetDate` 倒推每月需存多少。

## 與其他 feature 的依賴
- `features/household`：共同目標的成員權限 `canManageGoals`（rules 以 `householdPerm()` 擋寫入，前端以 `memberCan()` 擋 UI）。
- `features/ledger`：`financial-planning-panel` 引用本 feature。

## Apps Script 端
- `notifySavingsGoalProgress`（`tick_daily_0930`，每月 1 號）推送各目標進度。
- `notifyFinancialHealthDigest`（每月 15 號）把目標進度納入理財健檢。
- Telegram `/goals` 指令（`tgGoalsReply_`）。
- `savings_goals` 在 `Backup.gs` 的每日備份清單內。

## 注意事項
- 存入紀錄**不會**建立 `transactions`，也不動帳戶餘額；它只是「這筆錢被指定給目標」的追蹤，不影響淨值計算。
- member 不能 list 全部 goals，只能用 `where('householdId', '==', …)` 查共同目標（`useHouseholdGoals`）。
- `deleteGoal` 是硬刪；平常建議用 `archiveGoal`。
