# scheduled-payments — 排程支出（大額 / 不定期）

## 職責
- 保險年費、稅金、學費等比訂閱更不規則、需要提前提醒的計畫性支出。
- `ScheduledPaymentsPanel`（設定 → 排程）、`ScheduledPaymentsDashboardCard`（首頁現金流區）。
- `useUpcomingScheduledPayments(daysAhead = 90)`：列出 90 天內到期（含逾期）的項目。

## 資料模型
`scheduled_payments/{id}`（`scheduledPaymentConverter`）
- `name`、`amountTWD`、`dueDate`（下次 / 唯一一次到期日）
- `recurrence`：`one-time` / `monthly` / `quarterly` / `yearly`
- `category?`、`remindBeforeDays`（預設 7）、`paidAt?`（最近一次標記已繳）、`note?`、`createdAt` / `updatedAt`

## 主要邏輯
- `markScheduledPaid`：one-time 只寫 `paidAt`；週期性寫 `paidAt` 並把 `dueDate` 推到下一期（`nextDueDate`，用 `addTWCalendarMonths` / `addTWCalendarYears`，避免月底 rollover，pitfall #23）。
- one-time 已繳的項目不再出現在即將到期清單。

## 與其他 feature 的依賴
- `features/inbox`：`scheduled-payment-due` item（`dueDate − today ≤ remindBeforeDays`），一鍵 `useMarkScheduledPaid`。
- 週期性**自動入帳**是 `features/ledger` 的 recurring（`recurring` collection + GAS `runRecurringTransactions`），本 feature 只做提醒。

## Apps Script 端
- `notifyScheduledPaymentDue`（`tick_daily_1230`）：提前 `remindBeforeDays` 天 / 當天 / 逾期都推播。
- `notifyFixedExpensesMonthly`（每月 1 號）把排程支出攤平納入固定支出健檢；每週回顧的「需要處理」計數也會讀本 collection。
- Telegram `/scheduled` 指令（`tgScheduledReply_`）。
- 在 `Backup.gs` 每日備份清單內。

## 注意事項
- 標記已繳**不會**建立 `transactions`，實際付款仍需另外記帳。
- `docs/REFACTOR_ACCOUNTS_PLAN.md` 補充項 I 規劃讓 loan 帳戶的 `monthlyPayment` / `nextDueDate` 取代與本 feature 重疊的部分，尚未實作。
