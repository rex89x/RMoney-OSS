# Feature: einvoice

台灣電子發票匯入（階段一：檔案匯入；階段二：財政部 API 自動同步 — Apps Script `EInvoice.gs`，需 `EINVOICE_APP_ID` / `EINVOICE_CARD_NO` / `EINVOICE_CARD_ENCRYPT` Script Properties）。

**職責邊界**：
- `parser.ts`：解析財政部整合平台的 `M|…` / `D|…` pipe 檔（Big5 / UTF-8 自動判斷）與含 header 的 CSV。
- `match.ts`：對既有交易去重。優先用 `transactions.invoiceNumber`；沒有的話同台北日 + 同金額視為「可能已記」，讓使用者連結而不是重複建。
- `categorize.ts`：依店名 / 品項關鍵字猜類別；猜不到給 `other`，會進「需要處理」。
- 交易建立走 `createTransaction`（逐筆），確保帳戶餘額調整與一般記帳一致；不走 `bulkCreateTransactions`。
- 「忽略」存在 `users/{uid}.preferences.einvoice.ignored[invoiceNo]`，180 天後失效；不新增 collection、不改 rules。

**Firestore 欄位**：`transactions.invoiceNumber?: string | null`（匯入或連結時寫入）。

**UI**：設定 → 發票。

**自動同步（階段二）**：
- GAS `syncEInvoices({daysBack})`：`carrierInvChk` 依月份分段查、`carrierInvDetail` 抓品項；跳過作廢 / 已有 `invoiceNumber` / 使用者忽略過的；類別用同一套關鍵字規則，猜不到給 `other`。
- 每日 01:00 由 `tick_daily_0100` 執行；面板「立即同步」可手動觸發，通知 key `einvoiceSync`。
- 自動同步的交易支付方式來自 `EINVOICE_PAYMENT_METHOD`（預設「信用卡」）。設了 `EINVOICE_ACCOUNT_ID`（accounts 的 doc id）就記 `fromAccountId` 並同步扣該帳戶餘額；沒設則 `fromAccountId = null`、不動餘額。
