# dashboard — 首頁儀表板

## 職責
- `HomeDashboard`（`home-dashboard.tsx`）：首頁 `/`，由 `pages/dashboard-page.tsx` 掛載。
  - 期間切換：`thisMonth` / `lastMonth` / `thisQuarter` / `ytd`（`DashboardScope`）。
  - 卡片分段：今日焦點 / 現金流 / 投資 / 更多（預設折疊「更多」）；`monthStatus` 固定置頂。
  - 卡片可隱藏、拖曳排序（`@dnd-kit`），新版本加入的卡片 key 自動補到順序尾端。
- `analytics-cards.tsx`：類別分布、近 6 個月收支、本月累積、支付方式、預算達成、快速統計、結算狀態等統計卡片。
- `daily-budget-remaining-card.tsx`：今日剩餘額度。

## 資料模型
- 不擁有 collection。偏好存在 `users/{uid}.preferences.dashboard`：`scope`、`hiddenCards`、`order`、`collapsedSections`。
- 卡片 key / scope / section 的型別在 `types/global.ts`（`DashboardCardKey`、`DashboardScope`、`DashboardSectionKey`）。

## 與其他 feature 的依賴
- 統計口徑全部走 `features/analytics`：`useRangeTransactions` + `usePeriodRange` / `useComparisonRange`，消費支出用 `isConsumptionExpense`（CLAUDE.md pitfall #26）。
- 「我負擔的金額」用 `features/ledger/use-my-share`（共同帳只算自己那份）；預算用 `features/ledger` 的 `useBudget`。
- 其餘卡片來自各 feature 的 `*DashboardCard`：net-worth、accounts、rentals、subscriptions、scheduled-payments、goals、investments、fx、trips、flight-watches、stock-radar、inbox、household。
- Dashboard 只查 `transactions`，出遊花費以 `tripId` 為 filter，不另外加 `trip.total`（pitfall #6）。

## Apps Script 端
- 無專屬 action。卡片顯示的股價、匯率、淨值快照等由各 feature 的 GAS 排程寫入（見 SPEC §7.2）。

## 注意事項
- 資料夾結構不符 CLAUDE.md §6：沒有 `index.ts` / `hooks.ts` / `components/`，元件直接放在根目錄。
- 偏好儲存（`savePrefs`）目前直接在元件內 `updateDoc(users/{uid})`，不是 mutation hook；之後重構時應移到 hook。
- 「投資組合總覽」KPI 的美股換算用 `useFxRate('USD')`，讀不到時預設 31。
