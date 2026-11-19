# rentals — 租賃 / 出租資產

## 職責
- 先有一筆大額購入、之後每月收租回本的資產（設備、車輛、不動產等）。
- `RentalsPanel`（新增 / 編輯 / 結案 / 封存、記錄收款）、`RentalsDashboardCard`（首頁「更多」區）。
- 回本試算：`totalReceivedTWD`、`netPnLTWD`、`paybackProgressPct`、`estimateMonthsToPayback`、`projectedPaybackDate`、`unrecoveredCostTWD` 等純函式（`types.ts`）。

## 資料模型
`rentals/{id}`（`rentalConverter`）
- `ownerId`、`name`、`assetType`（equipment / vehicle / real_estate / other）、`startDate`
- `purchaseAmountTWD`（取得成本）、`expectedMonthlyIncome`、`expectedMonths?`、`defaultIncomeAccountId?`
- `status`（active / closed）、`closedAt?`、`archivedAt?`、`note?`
- `incomes[]`（embedded array，每月約一筆不會爆量）：`id`、`monthKey`、`date`、`amountTWD`、`txId?`（對應的 income 交易）、`payerName?`、`note?`、`createdAt`
- 查詢 `where ownerId == uid` + `orderBy startDate desc`，composite index 已宣告；index 未就緒時 fallback 為前端排序。

## 與 ledger 的連動
- 建立時可勾「同時記一筆購入支出」→ `createTransaction`（`type: 'expense'`、`category: 'rental_purchase'`、`fromAccountId`）。
- 記錄收款 → `createTransaction`（`type: 'income'`、`category: 'rental_income'`、`toAccountId`），把 tx id 存回 `incomes[].txId`。
- 刪除收款 → 對應交易 `softDeleteTransaction`。
- `rental_purchase` 不算消費支出、`rental_income` 屬被動收入（`features/analytics/metrics.ts`，GAS 端 `NON_CONSUMPTION_EXPENSE_CATEGORIES_` 同步）。

## 與其他 feature 的依賴
- `features/ledger`（`createTransaction` / `softDeleteTransaction`）、`features/accounts`（收款 / 扣款帳戶）。
- `features/net-worth`：`totalUnrecoveredCostTWD` 當虛擬資產（pitfall #24）。

## Apps Script 端
- 無專屬 action / 排程。`NetWorth.gs` 的 `snapshotNetWorthMonthly` 直接讀 `rentals` 計算 `rentalUnrecoveredTWD`（只算 `status` 為 active 且未封存者）。

## 注意事項
- 購入支出會讓來源帳戶變負，淨值靠 `rentalUnrecoveredTWD` 抵銷；收租累積到超過成本後，未回收成本為 0，之後收入直接以現金計入，不會重複計算。
- 交易與 rental doc 是兩次獨立寫入，不是 batch：交易寫失敗只 `console.warn`，收款紀錄仍會寫入但 `txId` 為 null。
- `rentals` 目前**不在** `Backup.gs` 的每日備份清單內。
