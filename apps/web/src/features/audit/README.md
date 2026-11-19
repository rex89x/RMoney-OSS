# audit — 重大寫入稽核紀錄

## 職責
- `writeAudit(input)`：寫一筆 `audit_logs` 紀錄。**失敗不 throw**（只 `console.warn`），不影響主流程。
- `useAuditLogs(max)`：依 `timestamp desc` 讀最近 N 筆（TanStack Query，`staleTime` 60 秒）。
- `AuditLogPanel`：設定 → 資料 分頁的列表（一次讀 500 筆，前端分頁 10 / 20 / 50 筆）。

## 資料模型
`audit_logs/{autoId}`（converter：`auditLogConverter`）

| 欄位 | 說明 |
|---|---|
| `userId` | 寫入當下的 `auth.currentUser.uid`（取不到為 `'unknown'`） |
| `timestamp` | 寫入時間（Timestamp） |
| `scope` | 實體種類，例如 `'transaction'` |
| `action` | `create` / `update` / `delete` / `restore` / `archive` / `unarchive` |
| `entityId` | 被操作文件 id |
| `summary?` | 人類可讀摘要（例如 `-150 food · 早餐`） |
| `before?` / `after?` | 變更前後 JSON（選填） |

## 與其他 feature 的依賴
- 目前唯一的寫入端是 `features/ledger/hooks.ts`：新增交易（`create`，以 dynamic import 背景寫入，不阻塞表單）、軟刪除與永久刪除（`delete`）。
- 被 `features/settings` 的 資料 分頁引用（`AuditLogPanel`）。

## Apps Script 端
- 無。GAS 不寫也不讀 `audit_logs`；`Backup.gs` 的每日備份清單也**不含** `audit_logs`。

## 注意事項
- Rules：`audit_logs` 只有 owner 可讀寫（`isOwner()`）。member 的寫入會被拒，但因為 `writeAudit` 吞錯，不會影響 member 的主流程。
- 沒有清理機制，collection 會持續成長；列表只讀最近 500 筆。
- 要擴大稽核範圍（類別、旅程等）時，在對應 feature 的 mutation hook `onSuccess` / `mutationFn` 呼叫 `writeAudit`，不要在元件裡呼叫。
