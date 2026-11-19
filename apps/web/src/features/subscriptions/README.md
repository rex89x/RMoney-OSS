# subscriptions — 訂閱費追蹤

## 職責
- 追蹤 Netflix / Spotify 等規律扣款，換算「平均每月」合計（`monthlyAmountTWD`）。
- 兩種建立方式：手動新增；或從交易**自動偵測**（`detector.ts`，前端執行）後一鍵加入。
- `SubscriptionsPanel`（設定 → 訂閱）、`SubscriptionsDashboardCard`（首頁現金流區）。

## 資料模型
`subscriptions/{id}`（`subscriptionConverter`）
- `name`、`amountTWD`（每期金額）、`billingCycle`（weekly / biweekly / monthly / yearly）
- `nextChargeDate?`、`lastChargedAt?`、`paymentMethod?`、`category?`、`vendor?`
- `active`（停用而非刪除）、`note?`、`createdAt` / `updatedAt`

## 自動偵測（`detectSubscriptions`）
- 讀近 6 個月交易（`useTransactions({ startDate, limit: 5000 })`），以清理後的 note / merchant 為 key。
- 金額 ±15%、至少 3 次、間隔符合週期、近 90 天仍出現 → 視為候選。
- 候選也會出現在 `features/inbox` 的 `subscription-candidate`。

## 與其他 feature 的依賴
- `features/ledger`（交易來源、`effectiveAmountTWD`）、`features/inbox`（候選待辦，用 `useUpsertSubscription` 加入）。

## Apps Script 端
- `notifySubscriptionsDigest`（`tick_daily_0930`，每月 1 號）：月平均合計 + Top 5。
- `notifyFixedExpensesMonthly`（每月 1 號）：訂閱 + 週期 + 排程攤平合計。
- Telegram `/subs` 指令（`tgSubsReply_`）。
- 在 `Backup.gs` 每日備份清單內。

## 注意事項
- 訂閱**只做追蹤，不會自動產生交易**；自動入帳是 `features/ledger` 的 recurring（`recurring` collection + GAS `runRecurringTransactions`，每日 01:00）。
- 訂閱與 recurring 目前仍是兩條線。`docs/REFACTOR_ACCOUNTS_PLAN.md` Phase 3 規劃讓 `subscriptions` 加 `paymentAccountId` / `autoCreateTx` 並併入 recurring engine，尚未實作；同一筆扣款若兩邊都建，固定支出健檢會各算一次。

## 自動入帳（2026-11，與 recurring 合併）

- 入帳主體是 `recurring`（Apps Script `runRecurringTransactions` 每日 01:00 依 `nextDue` 記帳、調整帳戶餘額、冪等）。
- 訂閱負責「追蹤 + 偵測」；在訂閱清單按「自動入帳」會建立 recurring，訂閱記 `recurringId`、recurring 記 `subscriptionId`（`linkSubscriptionAutoPost`，同一個 batch）。
- 之後改訂閱的名稱 / 金額 / 週期 / 啟用，會同步到 recurring；刪訂閱會一起刪 recurring；「取消自動」只刪 recurring、保留訂閱。
- `notifyFixedExpensesMonthly` 會跳過已自動入帳的訂閱，避免和「週期記帳」重複計算。
