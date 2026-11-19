# net-worth — 淨值 / 應急基金

## 職責
- `/net-worth` 頁（`NetWorthPage`）：即時淨值、月度快照走勢、手動觸發快照。
- `NetWorthPanel`（設定 → 淨值）：維護 `manual_assets`（房產、車輛、收藏品等）。
- `NetWorthDashboardCard`、`EmergencyFundCard`（首頁 / 理財規劃）。
- `useNetWorthNow`：前端即時計算；`useEmergencyFund`：應急基金水位。

## 資料模型
| collection | 用途 |
|---|---|
| `manual_assets/{id}` | `name`、`type`、`valueTWD`、`asOf`、`archivedAt?` |
| `net_worth_snapshots/{YYYY-MM}` | `liquidTWD`、`investmentTWD`、`manualAssetsTWD`、`insurancePensionTWD`、`rentalUnrecoveredTWD`、`liabilitiesTWD`、`creditCardOutstandingTWD`、`installmentRemainingTWD`、`netWorthTWD`、`createdAt`（舊 doc 沒有 `rentalUnrecoveredTWD` / `insurancePensionTWD` / `installmentRemainingTWD` 時讀 0） |
| `cash_accounts/{id}` | **legacy**。僅在沒有對應 `accounts` 時才計入流動資產（`legacy-cash.ts` 以名稱 / `legacyPaymentMethod` 比對） |
| `liabilities/{id}` | **legacy**。仍有 converter / hooks，但淨值公式已改用 `accounts` 的 `loan` |

## 淨值公式（前端 `useNetWorthNow` 與 GAS `snapshotNetWorthMonthly` 同口徑）
```
liquid       = accounts(cash / bank / e_wallet_balance / investment_cash) 現值 + 未對應的 legacy cash_accounts
investment   = 最新 portfolio_snapshots.totalValueTWD
manual       = sum(manual_assets.valueTWD)
insurancePension = sum(accounts type=insurance 的 insurance.cashValueTWD) + sum(accounts type=pension 現值)
rentalUnrecovered = sum(active rentals max(0, purchaseAmountTWD − 累積收款))   // pitfall #24
liabilities  = accounts(type = loan) 欠款
creditCard   = accounts(type = credit_card) 欠款；為 0 時退回「已到期未繳」的 credit_card_bills
installmentRemaining = sum(active installment_plans 尚未入帳的期數金額)          // F2 分期
netWorth     = liquid + investment + manual + insurancePension + rentalUnrecovered − liabilities − creditCard − installmentRemaining
```
- 分期（`features/installments`）：每期入帳時 GAS 用 `importAdjustAccount_` 把金額加到信用卡帳戶欠款，所以**已入帳**的期數已經在 `creditCard` 裡；
  `installmentRemaining` 只算**尚未入帳**（未來期數）的部分，是真實負債但還不在卡片餘額上，兩者不重疊、不會雙重計算。
  前端 `totalInstallmentRemainingTWD`（`features/installments/schedule.ts`）與 GAS `installmentRemainingTWD_`（`Installments.gs`）同口徑；
  已取消 / 已繳完的計畫為 0。
- 保險（2026-11 F9）：只有解約金 / 保單價值（`cashValueTWD`）算資產；純保障型保單沒填 → 0。保費是支出，不會讓保單「增值」。帳戶 `balance` 對保單無意義、不計。
- 退休帳戶（`pension`，勞退個人專戶 / 自提 / IRA 類）：以 `balance` 現值計入；不算流動資產，也不進應急基金。
- 前端 `accounts/valuation.ts longTermAccountValueTWD` ↔ GAS `NetWorth.gs insuranceCashValueTWD_` + pension 分支，改一邊要改另一邊（`apps-script/tests/insurance-due.test.cjs` 有對照）。
- 顯示層：`rawLiquid` 因租賃購入為負時，先用租賃未回收成本「吸收」到 0（`rentalAbsorbedTWD`），總和不變。

## 與其他 feature 的依賴
- `features/installments`（`useInstallmentPlans` / `totalInstallmentRemainingTWD`）、`features/accounts`（`currentAccountBalanceTWD` / `currentDebtBalanceTWD`）、`features/fx`（匯率）、`features/investments`（`useLatestSnapshot`）、`features/billing`（帳單）、`features/rentals`（`totalUnrecoveredCostTWD`）。

## Apps Script 端（`NetWorth.gs`）
- `snapshotNetWorthMonthly`：`tick_daily_0700` 與 `tick_daily_1800` 各跑一次，同月覆寫、過去月份凍結；有 `LockService` 鎖。
- 外幣帳戶以快照當天的 `fx_rates/{CUR}_TWD` 重估（與前端 `accounts/valuation.ts` 同口徑），讀不到匯率才退回 `balanceTWD`。pitfall #3 的匯率凍結只適用單筆交易，不是帳戶現值。
- action `snapshotNetWorth`：頁面「手動快照」呼叫；失敗時前端 fallback 用 `useNetWorthNow` 的 raw 值直寫。

## 注意事項
- 改公式時前端 `hooks.ts` 與 `NetWorth.gs` 必須一起改。
- `types.ts` 開頭註解的公式（`liabilities.balanceTWD`、`cash_accounts` 為主）是舊版，以本檔與 `hooks.ts` 為準。
- 應急基金只計 `cash` / `bank` 帳戶與標記 `countsAsEmergencyFund` 的 legacy cash，同樣套用租賃吸收邏輯。

## 共同公基金（2026-11，資訊揭露）

淨值頁有一張「共同公基金（不計入淨值）」卡：公基金帳上可用、依 `household.splitRatio` 算的你的份額、公基金欠你的代墊（`household-fund-share.ts`）。
**不加進淨值總額**：2026-09-21 owner 決議公基金存入不扣個人帳戶，若再加份額會把存進去的錢算兩次。
日後若改成「存入時從個人帳戶建 transfer」，才可以把份額正式加進 `useNetWorthNow` 與 `NetWorth.gs`。
