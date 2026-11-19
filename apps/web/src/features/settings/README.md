# settings — 設定頁

## 職責
- `/settings` 的 `SettingsPage`（由 `pages/settings-page.tsx` 掛載），以 `?tab=` 切換分頁；大部分分頁只是把其他 feature 的 Panel 組起來。
- 本資料夾自有的 Panel（`components/`）：

| Panel | 分頁 | 內容 |
|---|---|---|
| `PaymentMethodsPanel` | 支付 | `payment_methods`（`features/ledger/payment-methods` 的 hooks） |
| `NotificationsPanel` | 通知 | `users/{uid}.preferences.notifications` 開關 + Apps Script `notify` 測試推播；同一組開關也決定是否寫入 App 內通知中心（`features/notifications`） |
| `FxPairsPanel` | 匯率 | 追蹤的幣別對（`features/fx/hooks`） |
| `BootstrapPanel` | 資料 | 初始化 `categories`（`DEFAULT_CATEGORIES` + `TRIP_CATEGORIES`）/ 範例 `stocks`；手動觸發 `updateStockPrices`、`updateFxRates`、`backfillCandles`、`sendTest`、`setupTriggers` |
| `DataTransferPanel` | 資料 | 交易 CSV 匯出（近一年）/ 匯入（`bulkCreateTransactions`） |
| `ErrorLogsPanel` | 資料 | `error_logs` 最近錯誤（`lib/error-log.ts`） |

- 「一般」分頁：主題（`useTheme`，寫回 `users/{uid}.preferences.theme`，CLAUDE.md §8）、帳號資訊、登出。

## 其他分頁的來源
類別 / 預算 / 週期（`features/ledger`）、帳戶（`accounts`）、帳單（`billing`）、淨值（`net-worth`）、訂閱（`subscriptions`）、排程（`scheduled-payments`）、目標（`goals`）、AI 預算（`ai-budget`）、發票（`einvoice`）、Audit log（`audit`）、權限（`access`，僅 admin）。

## 角色
- member 只看得到「一般」分頁（`tab` 強制為 `general`）。
- 權限分頁只對 `isAdmin` 顯示。

## Apps Script 端
- 無專屬排程；`BootstrapPanel` / `NotificationsPanel` 呼叫的 action 見上表。`setupTriggers` 會重建所有 time-driven trigger（清單見 SPEC §7.2）。

## 注意事項
- 資料夾結構不符 CLAUDE.md §6：沒有 `index.ts` / `api.ts` / `hooks.ts`；`NotificationsPanel` 的偏好儲存直接在元件內 `updateDoc`。
- `NotificationsPanel` 的 key 清單要與 GAS `sendNotification_(key, …)` 的 key 同步（`types/global.ts` 的 `NotificationKey`）；2026-11 補上原本漏掉、關不掉的 `fxDaily`（21:00 匯率日報）。
- `NotificationsPanel` 各通知的時間說明是寫死的文字，排程改動時要同步更新（例如 2026-11 備份由每週改每日 01:00 時，`weeklyBackup` 的說明一併改過；key 名稱沿用）。
