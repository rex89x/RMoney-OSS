# billing — 信用卡帳單提醒

## 責任

- 對 `payment_methods` 中已啟用 `billingEnabled` 的信用卡，計算「最近一個 ≤ 今天的繳款截止日」當作本期 cycle。
- 提供 UI 讓使用者標記某期「已繳費」（寫入 `credit_card_bills/${pmId}__${YYYY-MM}.paidAt`）。
- Telegram 推播由 Apps Script `notifyCreditCardDues()` 負責，從繳款日當天起，未繳就每天提醒。

## Firestore

- `payment_methods/{pmId}` 加 3 個欄位：`billingEnabled`、`statementDay`、`dueDay`
- `credit_card_bills/{billId}`：id 用 `${pmId}__${YYYY-MM}` 確保 idempotent；
  `cycleMonth` 以 dueDate 月份為準。

## 與其他 feature 的依賴

- `@/features/installments`：每張卡列出「分期未到期」金額（`useInstallmentRemainingByCard`，以 `findCardAccount` 對到的信用卡帳戶加總）。

- 讀取 `@/features/ledger/payment-methods`：取得 `PaymentMethod` 設定。
- UI 嵌在 Settings page 的 `帳單` tab。

## Pitfalls

- dueDay = 31 在 30 天的月份：用 `clampDayToMonth` clamp 至月底。
- 若使用者的 statementDay > dueDay（例：25 結 / 15 繳）→ statementDate 推到上個月（見 `deriveStatementDate`）。
- Apps Script 端與前端共用同套 dueDate 計算邏輯（GAS 端是 JS 重寫一份，無法 import 前端 TS）。
