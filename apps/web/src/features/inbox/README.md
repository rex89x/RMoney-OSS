# Feature: inbox

「需要處理」集中頁：把散在各 feature 的待辦聚合成一份清單，處理完就消失。

**職責邊界**：
- 純前端聚合，不建新 collection；每個 item 從既有 feature 的 query 推導（ledger / payouts / subscriptions / billing / scheduled-payments / budget / accounts（保單））。
- 「略過」寫在 `users/{uid}.preferences.inbox.dismissed[itemId] = ISO string`，每個使用者各自獨立；120 天後自動失效。
- item id 帶週期（信用卡 cycleMonth、排程 dueDate、預算 month），所以略過只影響本期。
- 本 feature **不**擁有任何資料寫入邏輯：處理動作一律呼叫該 feature 的 mutation hook（`useMarkScheduledPaid`、`useUpsertSubscription`、`TransactionEditDialog`）。

**Item 來源**：

| kind | 條件 | 動作 |
|---|---|---|
| `uncategorized-tx` | 45 天內類別為「其他」或類別已不存在 | 開 TransactionEditDialog |
| `unsettled-loan` | 代墊超過 7 天未結清（依對方彙總） | 前往 `/ledger?tab=loans` |
| `payout-unpaid` | 墊付團有人未繳 | 前往 `/ledger?tab=loans` |
| `subscription-candidate` | 偵測到規律扣款但尚未建立訂閱 | 一鍵加入訂閱 |
| `credit-card-due` | 5 天內到期 / 今天 / 逾期且未標記已繳 | 前往 `/settings?tab=bills` |
| `scheduled-payment-due` | dueDate − today ≤ remindBeforeDays | 標記已繳 |
| `insurance` | 保單保費 14 天內到期 / 已逾期（id 帶本期繳費日）、或 30 天內滿期（`accounts/insurance.ts insuranceReminders`，與 GAS `notifyInsuranceDue` 同規則） | 前往 `/settings?tab=accounts` 按「已繳保費」 |
| `budget-warn` | 本月總額或某類別 ≥ 80% | 前往 `/settings?tab=budget` |

**主要 exports**：`useInboxItems`, `useDismissInboxItem`, `InboxList`, `InboxDashboardCard`。
