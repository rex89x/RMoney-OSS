# installments — 信用卡分期付款（F2）

## 職責
- 刷卡分期（3 / 6 / 12 / 24 期…，0 利率或含手續費）的計畫：建立、列出進度、取消。
- `InstallmentsPanel`（記帳 → 分期，owner-only）：進度 x/N、未入帳金額、下期日期、每期明細。
- 快速記帳（`ledger/components/quick-entry-dialog.tsx`）：扣款帳戶是信用卡時可選「分 N 期」（0 利率），
  存檔改建計畫、不建單筆支出。含手續費的分期請從分頁建立。
- `useInstallmentRemainingByCard`：信用卡帳單面板 / 帳戶列表顯示每張卡「分期未到期」。
- `useInstallmentRemainingTWD` / `totalInstallmentRemainingTWD`：淨值負債端（見 `features/net-worth/README.md`）。

## 資料模型
`installment_plans/{id}`（`installmentPlanConverter`，rules：`isOwner()` 讀寫）
- `ownerId`、`title`、`totalAmountTWD`（不含手續費）、`feeTWD`（手續費 / 利息總額，平均攤入各期）
- `periods`、`perPeriodTWD = floor((total + fee) / periods)`，**最後一期吸收尾差**
- `cardAccountId`（`accounts` type = `credit_card`）、`category`
- `startDate`：第 1 期入帳日；第 i 期 = `addTWCalendarMonths(startDate, i − 1)`（一律從首期日推算、月底 clamp，pitfall #23）
- `paidPeriods`（Apps Script 推進）、`status`：`active` / `completed` / `cancelled`
- `lastPostedAt`、`cancelledAt`、`note`、`createdAt` / `updatedAt`
- index：`(ownerId ASC, startDate DESC)`；列表 `limit(200)`

## 消費認列方式
每期在入帳日記一筆 `expense`（`perPeriodTWD`），`fromAccountId = cardAccountId` → 卡片欠款增加。
月支出反映的是「本月分期金額」，與信用卡帳單一致；不會在購買當月一次認列全額。
交易欄位：`tags: ['分期']`、`note: '{title} {i}/{N}'`、`installmentPlanId`、`installmentIndex`（1 起算）。

## Apps Script 端（`Installments.gs`）
- `runInstallmentPlans()`：`tick_daily_0100`（台北 01:00，pitfall #19）＋ action `runInstallments`（建立計畫後前端立即呼叫，失敗不影響建立）。
- `LockService` 上鎖；tx id `inst_{planId}_{i}` 冪等：已存在（含軟刪）就不再建立、不再動餘額，只補推進 `paidPeriods`。
- 第一次跑會補齊所有已到期的期數（catch up）；最後一期入帳後 `status = 'completed'`。
- 餘額用 `importAdjustAccount_`（與 web / 匯入 / recurring 同一套）。
- 入帳後沿用 `notifyRecurringRun` 推播。`installment_plans` 在每日備份清單內。
- 測試：`apps-script/tests/installments.test.cjs`（冪等、catch up、取消、與前端金額 / 日期 parity）。

## 取消
`status = 'cancelled'`：之後不再入帳；已入帳的交易保留（退款請另外記收入 / 調整）。不提供刪除，保留歷史。

## 與其他 feature 的依賴
- `features/accounts`：信用卡帳戶、`AccountSelect`。
- `features/ledger`：類別（`useCategories`）；入帳的 tx 走一般 `transactions` 口徑（`isConsumptionExpense` 會算進消費）。
- `features/billing`、`features/net-worth`：讀 `useInstallmentRemainingByCard` / `useInstallmentPlans`。

## 注意事項
- 金額 / 日期公式改動時，`schedule.ts` 與 `Installments.gs` 必須一起改（parity 測試會擋）。
- 不支援外幣分期（台灣信用卡分期以台幣計）。
