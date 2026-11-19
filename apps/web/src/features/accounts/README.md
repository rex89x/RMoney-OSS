# Accounts

`accounts` is the first-class source for cash, bank, credit card, e-wallet, investment cash, and loan accounts.

Responsibilities:

- CRUD and archive for `accounts/{accountId}`.
- Typed Firestore converter with Timestamp to Date conversion.
- Account selectors for ledger flows.
- Legacy bridge fields (`legacyPaymentMethod`, `legacySource`) during the 8-month migration window.

Non-goals for Phase 1:

- Do not mutate historical `transactions`.
- Do not delete `payment_methods`, `cash_accounts`, or `liabilities`.
- Do not auto-create transfer transactions except through explicit future flows.

## Reconciliation (對帳)

- `reconcile.ts`: 輸入實際餘額 → 差額建一筆 `adjustment` / `adjustment_income` 交易（`createTransaction`，帳戶餘額隨之同步），並寫 `accounts.lastReconciledAt`。
- 負債帳戶（信用卡 / 貸款）以「欠款變多 = 支出」解讀。
- `adjustment` 類別若不存在會從 `DEFAULT_CATEGORIES` 自動補上；月底預測與異常偵測排除此類別。

## 貸款攤還表（F3）

- `amortization.ts`（純函式，`apps/web/tests/amortization.test.cjs`）：
  - `buildAmortizationSchedule`：本息平均攤還（annuity）/ 本金平均攤還（equal_principal）；期數與月付擇一（本息平均可只給月付反推期數）；0% 利率；金額算到 0.01，最後一期付清剩餘本金吸收尾差。
  - 第 k 期日期 = `addTWCalendarMonths(第 1 期日, k − 1)`，一律從第 1 期推算（1/31 → 2/28 → 3/31，pitfall #23）。
  - `simulateEarlyRepayment`：第 k 期繳完後多還一筆本金，「縮短期數（月付不變）」或「降低月付（期數不變）」，回傳省下利息 / 提早期數 / 新月付。
  - `remainingPrincipalAt`、`downsampleRows`（圖表 ≤ 500 點，pitfall #13）。
- UI：帳戶列表的貸款列「攤還表」按鈕 → `AmortizationDialog`。預設以目前欠款為本金、`loan.nextDueDate` 為第 1 期、有 `monthlyPayment` 就用月付反推剩餘期數；欄位可改來試算。摘要（月付、總利息、還清日、今日剩餘本金）+ 剩餘本金折線 + 分頁表格（60 期 / 頁）+ 提前還款試算。
- 純試算，不寫 Firestore；淨值負債端仍用貸款帳戶餘額（沒有改成攤還表推算的剩餘本金）。

## 保險 / 退休帳戶（2026-11 F9）

| type | details | 淨值 |
|---|---|---|
| `insurance` | `insurance: { insurer, policyNo?, kind, premiumTWD, premiumFrequency, nextPremiumDate, maturityDate?, coverageTWD?, cashValueTWD? }` | 只計 `cashValueTWD`（解約金 / 保單價值）；純保障型 = 0；`balance` 固定 0、不計 |
| `pension` | `pension: { provider, employerContributionPct?, selfContributionPct?, monthlySalaryTWD?, expectedReturnPct?, retirementAge?, birthYear? }` | 以 `balance` 現值計 |

- 淨值口徑在 `valuation.ts longTermAccountValueTWD`，與 `apps-script/src/NetWorth.gs`（`insuranceCashValueTWD_` + pension 分支）必須同步；快照欄位 `insurancePensionTWD`。
- `insurance.ts`：`advancePremiumDate`（依頻率 `addTWCalendarMonths`，月底 clamp）、`insuranceReminders`（保費 14 天內 / 逾期、滿期 30 天內）—— Inbox 與 GAS `notifyInsuranceDue`（`insuranceDueItems_`）同規則。
- `insurance-pay.ts`：「已繳保費」→ 確保 `insurance` 類別存在 → `createTransaction` 建 expense（扣款帳戶餘額同步）→ `nextPremiumDate` 推一期。交易 id = `insurance-{accountId}-{本期 yyyyMMdd}`，重按不會重複扣款。
- `pension.ts`：`projectPension`（目前餘額 + 月提繳工資 × 提繳率，月複利到「出生年 + 退休年齡」那年 1 月）顯示在帳戶列。
- 理財健檢的「有沒有退休規劃」= 有啟用中的 `pension` 帳戶，或投資計畫勾選 `isRetirement`（舊計畫退回名稱比對），見 `features/investments/retirement.ts`。
- 保險 / 退休帳戶不出現在記帳的付款帳戶選單（各處 `allowedAccountTypes` 都是白名單）。
