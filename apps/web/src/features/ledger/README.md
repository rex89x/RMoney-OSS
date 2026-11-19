# Feature: ledger

記帳核心模組 — transactions / categories / budgets / recurring。

**職責邊界**：
- 本模組的 `transactions` 是系統唯一的交易 source of truth — 出遊 tx 透過 `tripId` 關聯；不要額外複製到 `trip.total`，查詢時直接 filter by tripId (避免 pitfall #6 雙重計算)。
- 記帳金額一律存雙欄位：`amount` (原幣) + `amountTWD` (換算後)，且寫入時 snapshot 當下 `fxRate` (避免 pitfall #3 歷史匯率被動搖)。
- 類別以 `key` 為 Firestore doc id，**軟刪除** (`archivedAt`)，舊 tx 顯示不受影響 (pitfall #4)。
- 所有 read 走 TanStack Query，write 走 mutation hook。
- 「理財」分頁以近 3 個完整月份的 transactions 整合儲蓄率、緊急預備金、
  `savings_goals`、`investment_plans` 與投資配置；不另建重複的財務資料。
- Apps Script 每月 15 日 09:30 發送 `financialHealthDigest`，使用相同資料口徑整理
  現金流、安全墊、退休與配置偏差；可在設定關閉或手動測試。

**主要 exports**：`useTransactions`, `useCreateTransaction`, `useCategories`, `useBudget`, `useRecurring`, `QuickEntryDialog`, `TransactionList`, `LedgerDashboard`, `FinancialPlanningPanel`.

**信用卡分期**：`QuickEntryDialog` 扣款帳戶是信用卡、一般台幣支出（非分攤 / 代墊 / 旅程）時可選「分 N 期」，存檔改建 `installment_plans`（`features/installments`），不建單筆支出；每期由 Apps Script 入帳（tx 帶 `installmentPlanId` / `installmentIndex`、標籤「分期」）。

**記帳表單的分攤**（`QuickEntryDialog` 新增 / `TransactionEditDialog` 編輯 / `HouseholdEntryDialog` 共同支出都一樣）：
- 旅程（`tripId`）與共同帳本（`householdId`）可以同時存在，共用一個 `SplitEditor`（`components/split-editor.tsx`）：
  成員 = 旅程成員 ∪ 共同帳本成員（`split-context.ts` 的 `buildSplitContext()`），寫入欄位一律經 `splitPatch()`：
  `payerId`（有旅程）/ `paidByUid`（有共同）/ `shareType` / `customShares` / `myShareTWD`（= 建立者那份）。
  兩人之間的錢在共同帳本結、旅伴的錢在旅程結，規則見 `features/household/README.md`「旅程 + 共同帳本同一筆」。
- 分攤金額以交易原幣輸入（`customShares[].amount`），台幣依該筆 `fxRate` 換算成 `amountTWD`；結算一律用 `amountTWD`。
- 公基金付款只在「純共同支出」出現；付款人不是建立者時 `fromAccountId = null`、`paymentMethod` 標 `共同帳` / `旅伴代付`，不扣建立者帳戶。
- 代墊 / 借貸（`splitMode` / `counterpartyName` / `myShareTWD` / `loanSettledAt`，`LoanSplitEditor`）只在沒有上面的多人分攤時顯示。
- 快速記帳沒帶 `tripId` 時可在表單直接挑旅程（只有支出；進行中的旅程會標示）。
- 編輯時取消分攤，`updateTransaction` 的 patch 用 `customShares: null` / `lineItems: null` 把舊欄位整個 `deleteField()`，其他分攤欄位寫 `null`。
- 編輯對方分享給我的支出（`tx.userId !== me`）時，帳戶 / 支付方式維持原樣，分攤的「我」是建立者；
  只改分攤（夥伴）走 `ShareEditDialog`，見 `features/household/README.md`「夥伴只改分攤」。
- `personalShareTWD()`：有 `householdId` / `tripId` / 代墊且 `myShareTWD` 非 null → 用 `myShareTWD`；Apps Script `personalShareTWD_()` 同口徑。

**「我花了多少」的口徑（`use-my-share.ts`）**
- 每筆支出對「我」固定三個數字：`totalTWD` 整筆、`paidTWD` 我墊付（付款人是我才有）、`shareTWD` 我負擔（分攤後我那份）；`netTWD = paid − share`，正 = 待收、負 = 待付。
  由 `useExpenseBreakdown()` 產生，`useMyExpenseShare()` 是只取 `shareTWD` 的簡化版。**所有個人統計一律用 shareTWD**，整筆只給旅程總花費 / 共同帳本總額 / 對外報帳。
- shareTWD 來源優先序：自己建立且有分攤情境（共同 / 旅程 / 代墊）→ 存好的 `myShareTWD`；其他（別人建立的、舊資料）→ `myExpenseShareTWD()` 由 customShares / lineItems / 均分推算。
- 畫面：交易列表主數字 = 我負擔，小字「整筆 · 我墊付 · 待收 / 待付」；列表上方合計看篩選區間的我負擔 / 整筆 / 待收待付；
  篩選多一個「範疇」（個人 / 共同 / 出遊 / 代墊，一筆可同時屬於共同與出遊，`txScopes()`）。
  旅程頁標題卡四格（總花費 / 我負擔 / 我墊付 / 待收待付），幣別小卡、預算 vs 實支的分類圖、報告書都有「只看我的 / 全部」切換（`ViewScopeToggle`，預設只看我的；預算進度一律用整趟總額）。
  共同帳本總覽多「本月我負擔」；首頁支出 KPI 有差額時標「整筆 X，已扣他人分攤」。

**附件（`attachments.ts` / `attachments-upload.ts` / `components/attachments-editor.tsx`，2026-11 F10）**
- `transactions.attachments: { url, path, name, contentType, size, uploadedAt }[]`，最多 5 個。圖片一律 `compressImageUnder` 成 WebP ≤ 500KB（pitfall #20），PDF < 5MB 原樣上傳；其他類型（含 SVG）前端與 Storage rules 都擋。
- Storage 路徑 `tx-receipts/{uid}/{txId}/{timestamp}-{safeName}`；快速記帳用 `clientRequestId` 當 txId（存檔時就是這筆交易的 id）。
- 舊交易只有 `photoUrl`：converter（`decodeAttachments`）映射成 attachments[0] 顯示。存檔時仍寫 `photoUrl = 第一張圖片`（`legacyPhotoUrlFor`，沒有圖片就 `deleteField()`），只認舊欄位的程式碼不受影響。
- 編輯交易只有附件真的變了才寫 `attachments` / `photoUrl`（同 tags，伴侶「只改分攤」的 rules 不允許多出欄位變動）；被移除的檔案在存檔成功後 best-effort 刪除。快速記帳還沒存檔，移除時直接刪。
- 「掃描收據」辨識完會把壓縮過的收據照片加成附件。交易列表有附件時顯示迴紋針 + 數量。

