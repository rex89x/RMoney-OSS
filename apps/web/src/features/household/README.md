# household — 共同帳本（情侶 / 家庭分帳）

## 職責
- `households/{id}`：一個共同帳本 = 成員（`memberIds` / `members`）、預設分攤比例（`splitRatio`，%）、共同月預算（`monthlyBudgetTWD`）、待接受的邀請（`pendingInvites`）。
- 共同支出仍存在 `transactions`（建立者的 `userId`），多帶：
  - `householdId`、`paidByUid`（誰付）、`scope: 'household'`
  - `shareType: 'custom'` + `customShares[{ memberId: uid, amountTWD }]`（各成員應負擔）
  - `myShareTWD` = 建立者那份（讓建立者自己的 ledger / dashboard 只算自己那份）
- `households/{id}/settlements`：實際轉帳紀錄（from → to）。餘額 = Σ(付款人 +total、各成員 −share) + Σ(結算 from +amt、to −amt)，見 `balance.ts`。
- 結算時 owner 可勾「同時記到我的帳本」→ 建一筆 `household_settlement(_income)` 交易（會動帳戶餘額；forecast / 異常偵測排除）。

## 角色
- **owner**（owner）：全功能；FAB 先選個人支出／收入、共同支出或公基金；`/shared` 頁可邀請、改比例、改預算。
- **member**（伴侶）：`config/allowedEmails` 內、role `member`。只看得到 `/shared`、分享給他的 `/trips`、`/flights`（機票雷達：看得到 owner 建的、也能自己建）、`/settings` 一般頁；FAB 可新增共同支出或存入公基金；旅程頁「新增花費」走 `QuickEntryDialog`（對 member 也掛載，帳戶欄位只給 owner）。Rules 只放行 `households`（成員）、`transactions`（同 householdId 可讀；只能寫自己 `userId` 的）、`categories`（唯讀）。

## 邀請流程
1. owner 在 `/shared?tab=settings` 輸入 email → Apps Script `inviteHouseholdMember`：加 `config/allowedEmails` + `household.pendingInvites`
2. 對方首次登入 → `ensureUserDoc` 建 `users/{uid}`（role `member`）→ `acceptPendingInvites` 把 uid 加進 `memberIds` / `members`，並在第一次補齊 `splitRatio`（均分）

## 與其他 feature 的關係
- `ledger`：`personalShareTWD` / `myExpenseShareTWD` 對 `householdId` tx 回傳自己那份；`LoansPanel` 與 inbox「未結清代墊」排除 household tx（結算在 `/shared`）。
- Apps Script：`queryTxsBetween_` 只算 owner 的 tx（`ownerTxsOnly_`）；每週回顧多一行「共同帳：X 還要付你 NT$…」。

## 共同目標與預算（C2）
- `savings_goals.householdId`：共同目標，rules 讓成員讀寫（含 `contributions`，多存 `byUid` 顯示各自貢獻）。owner 的目標面板有「共同目標」開關；`/shared?tab=goals` 用 `GoalsPanel householdId=…` 只列共同目標（member 不能 list 全部 goals）。
- `household.monthlyBudgetTWD`：總覽進度條、首頁「共同帳」卡、Inbox（≥80% 警示、未結算 ≥ NT$1,000）、每週回顧多一行預算用量。

## 公基金
- `households/{id}/fund_entries`：兩位成員各自存入公基金的紀錄；本人只能替自己新增正數存入，建立者或 household owner 可刪除。
- `transactions.paidByUid === '__household_fund__'`：共同支出由公基金支付。基金餘額 = 累計存入 − 這類共同支出。
- 公基金付款仍列入共同支出與共同月預算，但不形成成員彼此的應收／應付。
- 共同交易、結算與公基金入金都使用 Firestore `onSnapshot` 同步到 TanStack Query cache；任一成員新增、編輯或刪除後，已開啟的共同帳本與首頁卡會即時計算新餘額。
- owner 自己付款的共同支出若選擇個人帳戶，ledger 的 Firestore transaction 會同步扣除／回補該帳戶餘額；公基金付款則只扣共同基金，不重複扣個人帳戶。

### 修改公基金（2026-11）
- 公基金分頁的流水帳每一列都能點：**公基金支出** → `HouseholdTxDetailDialog` → `HouseholdEntryDialog` 修改金額 / 類別 / 日期 / 付款人（可改回個人付款），
  或沒有完整編輯權時「修改分攤」；刪除是軟刪，金額回到公基金。**公基金存入** → `HouseholdFundEntryDialog entry=` 修改金額 / 日期 / 備註。
- 交易分頁的公基金存入列多一顆「修改」。
- rules `fund_entries` 的 update 與 delete 同一批人（建立者或 household owner），只能改 `amountTWD / note / date`（`affectedKeys().hasOnly`）。

### 每月計畫：固定存入 + 固定扣款（2026-11）
- `households/{id}.fundPlan`（`HouseholdFundPlan`）：`dayOfMonth`、`startMonth`、`contributions{uid: TWD}`、`autoRecord`、`fixedExpenses[]`。
  有 `canAddExpense` 的成員可以改（rules 只放行 `fundPlan` + `updatedAt`）。設定 UI：`HouseholdFundPlanDialog`（RHF + `HouseholdFundPlanSchema`）。
- 狀態卡 `HouseholdFundPlanCard`（公基金分頁 KPI 下方）：本月每人存了沒（`fund_entries.planMonth`）、固定扣款扣了沒、每月淨流入
  （計畫存入 − 固定扣款 − 近 3 個月其他公基金支出平均）、淨流入為負時可撐幾個月。純函式在 `fund-plan.ts`（`buildFundPlanStatus`）。
- 本人按「記錄存入」→ 存入對話框帶入本月剩餘金額與 `planMonth`；一般存入也可以切「算進每月固定存入」。
- 自動化：Apps Script `HouseholdFundPlan.gs` `runHouseholdFundPlans()`，每天 01:00（`tick_daily_0100`）：
  - 固定扣款：到日建立公基金付款的共同支出，交易 id = `fundplan_{hid}_{itemId}_{yyyyMM}`，`userId` = household owner、`myShareTWD = 0`、
    `customShares` 依 `splitRatio`。已存在（含軟刪）就跳過 → 刪掉某月扣款不會被補回來。前端「立即扣款」（`useChargeFundPlanExpense`）用同一個 id。
  - 自動存入（`autoRecord`）：本月沒有該成員的 `planMonth` 紀錄才建立，`createdBy` = 該成員（本人之後可改 / 刪）；
    另寫 `fundPlanRuns['c:{uid}'] = 'yyyy-MM'`，刪掉自動存入那筆也不會隔天又長回來。
  - 只處理 `startMonth` 之後、已到日的月份，不回補；日期超過當月天數用月底；Timestamp 寫台北中午避免跨日。
- 公基金存入仍**不扣個人帳戶**（維持 2026-09-21 決議）；自動存入只記共同餘額。

## 記帳方式預設「帳本負擔」（2026-11）
- 共同支出不用再先選誰付、誰負擔：`SplitEditor` 在 `allowFund`（純共同帳本、沒歸入旅程）時最上方是「記帳方式」四選一，
  底層仍是 `payerId + mode`（`presetOfSplit()`）：
  | 記帳方式 | payerId | mode | 結果 |
  |---|---|---|---|
  | 帳本負擔（公基金，**預設**） | `__household_fund__` | — | 從公基金扣，不形成誰欠誰 |
  | 各付一半 | 先付的人 | `equal` | 對方欠一半 |
  | 代墊：另一人全額負擔 | 先付的人 | `others`（存檔寫成 custom） | 對方欠全額 |
  | 其他分法 | 任選 | ratio / payer / custom | 原本的完整編輯器 |
- 新增共同支出（`HouseholdEntryDialog`、快速記帳勾「共同分攤」）預設公基金；歸入旅程時不能用公基金，`reconcileSplitState(..., allowFund=false)` 會改回自己付。
- 編輯舊交易時 `initialSplitState()` 會把剛好等於平分 / 代墊的分攤還原成對應選項。
- 公基金餘額不足**只警示、不擋存檔**（餘額可以晚點補存，公基金分頁會顯示負數）。

## 公基金代墊與撥還（2026-11）
- 「帳本負擔（公基金）」下面多一列「實際由誰付出去」：公基金直接付 / 某成員先墊 → `tx.fundAdvancedBy = uid`（`splitPatch()` 只在公基金負擔時保留）。
  仍然 `paidByUid = __household_fund__`、`myShareTWD = 0`，不形成成員間的誰欠誰；欠的是**公基金 → 先墊的人**。
- 建立者自己先墊時，扣款帳戶照常選、照常扣（錢真的從他帳戶出去）；撥還時可勾「同時記到我的帳本」記一筆
  `household_settlement_income` 收入入帳抵銷（統計排除）。
- 撥還 = `fund_entries` `type: 'reimbursement'`、`contributorUid` = 收款人（`reimburseFromFund()`，在 `settle.ts`）。rules 要 `canSettle`、收款人須是成員。
- `summarizeHouseholdFund()`：
  - `balanceTWD`（帳上可用）= 存入 − 公基金負擔的支出，**撥還不影響**
  - `owedToMember` = 先墊 − 已撥還（負數 = 撥多了）、`outstandingTWD` = 正數加總
  - `cashTWD`（實際現金）= 帳上可用 + 淨待撥還
- 所有「存入」統計（月報、分析、每月計畫、Telegram 報告 `HouseholdTelegram.gs`）都排除 reimbursement；時間軸多一種 `reimbursement`（公基金 → 成員）。
- UI：公基金分頁「公基金待撥還」卡（先墊 / 已撥還 / 還欠、撥還按鈕）、KPI「帳上可用」附實際現金；流水帳顯示「X 先墊」與撥還列。
- 測試：`apps/web/tests/household-fund-reimburse.test.cjs`。

### 先墊 → 公基金補錢：記成「撥還」，不是「存入」（2026-11-05）
- 正確流程：共同支出選「帳本負擔（公基金）」＋「X 先墊」→ 公基金欠 X；公基金轉帳還 X 時記**撥還**（公基金 −）。
  帳上可用在記支出時就扣了，撥還只讓「實際現金」減少、待撥還歸零。
- 常見誤記：把「公基金補錢給 X」記成「X 存入公基金」（＋）→ 帳上可用與實際現金都**多算一次**（支出被存入抵銷，好像公基金沒花錢）。
- 修正入口：
  - FAB 多一個「公基金補錢給先墊的人」（`canManageFund`），開 `HouseholdFundReimburseDialog`（不指定收款人時可選人，預設公基金欠最多的人）；
    「存入公基金」的說明改成「成員把自己的錢放進公基金（＋）」。
  - 修改既有的存入（`HouseholdFundEntryDialog entry=`）多一個開關「這筆其實是公基金補錢給 X」：
    `convertFundEntryToReimbursement()`（api.ts）用 `writeBatch` 刪原存入 → 建撥還（收款人 = 原存入者）→ 把勾選的公基金支出標 `fundAdvancedBy = X`。
    候選支出 = 近 90 天公基金負擔、尚未標先墊（`reimbursementCandidateTxs()`），金額剛好相加相等的組合會預先勾（`findExactExpenseMatch()`）。
    rules 不用改：刪除（建立者 / owner）、建撥還（`canManageFund`）、tx 只動 `fundAdvancedBy + updatedAt`（`splitOnlyPatch()`）都是既有放行範圍。
- 撥還對話框在公基金沒欠收款人時會警示「先把支出標成 X 先墊，否則會記成對方欠公基金」。
- 測試：`apps/web/tests/household-fund-reimburse.test.cjs`。

### 公基金管理權限與保管人（2026-11）
- 成員權限多一個 `canManageFund`（公基金管理，預設開）：記錄撥還、調整每月計畫、指定保管人。owner 在「設定 → 成員與權限」可以關。
  rules：`fund_entries` reimbursement 改看 `canManageFund`（原本是 `canSettle`）；household 的 `fundPlan` / `fundKeeperUid` 更新改看 `canManageFund`（原本 `canAddExpense`），保管人只能是成員或 null。
- `household.fundKeeperUid`：公基金帳戶在誰手上。`HouseholdFundTransfersCard`（公基金分頁完整版、總覽 compact 版只在有待撥還時出現）
  依「我」的角色顯示：保管人「請從公基金帳戶轉 X 給 Y」、收款人「公基金還要轉給你 X」、其他人「保管人要從公基金轉 X 給 Y」。
- 首頁共同帳卡多一行待撥還；Telegram 共同帳本報告多「公基金待撥還：保管人從公基金轉 NT$X 給 Y」（`HouseholdTelegram.gs`）。

## 分析與預算（2026-11）
- 純函式在 `analytics.ts`，口徑與總覽／月報相同：共同支出 = `householdPortionTWD()`、公基金支出 = `paidByUid === __household_fund__`、
  月份以台北切。全部吃 `useHouseholdLedger` 已訂閱的近 24 個月資料，切期間不會多讀 Firestore（所以期間最多 12 個月，才有等長前期可比）。
- `household.categoryBudgets`：類別月預算（`HouseholdBudgetDialog`，權限同「修改設定」，沿用既有 rules）。≥ 80% 警示、> 100% 超支。
- 總覽 `HouseholdMonthPulseCard`：目前已花、月底推估（目前日均 × 當月天數）、剩餘每天可花、時間進度刻度、類別預算、接下來 14 天公基金固定扣款。
- 首頁卡片多「月底推估」與超支類別數。
- 「兩人分工」的公基金支出不算任何人負擔；「多墊／少付」未扣結算，真正欠款仍以「誰欠誰」為準。
- 測試：`apps/web/tests/household-analytics.test.cjs`。

## 權限與邀請（C3）
- `members[uid].permissions`：`canAddExpense` / `canSettle` / `canManageGoals`（預設開）、`canEditSettings`（預設關）；owner 永遠全開。前端用 `memberCan()` 擋 UI，rules 用 `householdPerm()` 擋寫入。
- owner 可直接改 `memberIds`（移除成員）；加入仍走 Apps Script（`acceptPendingInvites` / `joinHousehold`）。
- 邀請連結 `/login?join=CODE`（`inviteCode`）：對方不用先進白名單，登入時 `useInitAuth` 會用 code 呼叫 `joinHousehold`。
- `autoShareTrips`：建立出遊時自動把其他成員加進 `trip.sharedWith`；旅程分享對話框也有成員快捷鍵。
- 交易：自己建立的共同支出可編輯（`HouseholdEntryDialog tx=`）；對方開放「可編輯我的個人支出」後也能改對方記的。月報分頁（`HouseholdMonthlyReport`）看每月各自付了 / 應付、類別、結算，可複製文字。
- 分攤 UI 單一來源：`features/ledger/components/split-editor.tsx` 的 `SplitEditor`（誰付 / 怎麼分 / 各人金額 / 公基金餘額），
  快速記帳、編輯交易、共同支出對話框、夥伴的「修改分攤」四處共用；金額用 `computeSplit()`、存檔前用 `splitMismatch()` 擋加總不符，
  寫入欄位一律經 `split-context.ts` 的 `splitPatch()`。
- 目標：`monthlyPlanTWD` 每月計畫 + 依目標日期倒推的每月需存金額。

## 旅程 + 共同帳本同一筆（2026-10）
- 一筆支出可以同時有 `tripId` 與 `householdId`。只有**一份**分攤明細 `customShares`（memberId = uid 或旅伴名字），
  旅程結算、共同帳本「誰欠誰」、建立者的 `myShareTWD` 全部由它衍生。`paidByUid`（共同）與 `payerId`（旅程）寫同一個 uid。
- 不重複結算的規則（web `balance.ts` / `trips/settlement.ts` 與 Apps Script `HouseholdTelegram.gs` 同一套）：
  **兩人之間的錢只在共同帳本結，跟旅伴的錢只在旅程結。**
  - 共同帳本：`sharesOfTx()` 只回傳成員的份；有 `tripId` 時付款人「墊付」= 成員那幾份的加總（`householdPortionTWD()`），
    不是整筆；付款人是外面旅伴 → 共同帳本內沒有欠款。月彙總 / 交易列表的金額也用 `householdPortionTWD()`。
  - 旅程結算：`computeSettlement(members, txs, { householdMemberIds })` 把共同帳本成員的份併到付款人（他們之間在共同帳本結），
    只留對其他旅伴的欠款；沒給名單的舊呼叫端維持「只算總額、不算欠款」。
  - 四人旅行、owner 付 4,000 均分：旅程 owner +2,000（A、B 各 −1,000）；共同帳本 owner 墊 2,000、淨 +1,000、伴侶 −1,000；
    owner 的帳本顯示 1,000。測試在 `apps/web/tests/split-rules.test.cjs`。
- 公基金付款不能同時歸入旅程（旅程結算沒有「公基金」這個角色），`buildSplitContext()` 在有 trip 時 `allowFund = false`。
- 共同支出歸入旅程時，前端會把還不在 `trip.members` 的共同帳本成員補進去（帶 uid；只有旅程擁有者能改 trip）。
- `myShareTWD` 一律 = 建立者那份（任何人改分攤都重算），`personalShareTWD()` / Apps Script `personalShareTWD_()` 有 `householdId` 或 `tripId`
  且 `myShareTWD` 非 null 就用它，所以 ledger / dashboard / 每日每週摘要 / 現金流預測看到的「我負擔多少」一致。
- 原幣分攤：`customShares[].amount` 是原幣金額（非台幣交易才寫），`amountTWD` 仍是結算依據；`SplitEditor` 用交易原幣輸入，台幣依該筆 `fxRate` 換算。

## 夥伴只改分攤
- 共同帳本成員（有 `canAddExpense`）對同一個共同帳本的支出、被分享旅程（`trip.sharedWith`）的 member 對該旅程的支出，
  可以只改分攤欄位：`customShares / shareType / payerId / paidByUid / myShareTWD / lineItems`。rules `txSplitEditableByPartner()` 用
  `affectedKeys().hasOnly()` 鎖死，viewer 不行。
- `updateTransaction()` 對沒碰到金額 / 帳戶 / 類型 / 刪除的 patch 不會讀 `accounts`（夥伴沒有對方帳戶的權限），見 `MONEY_FIELDS`。
- UI：`ShareEditDialog`（`features/ledger/components/share-edit-dialog.tsx`）。`TransactionList`（含旅程花費頁）點到不能完整編輯的別人支出會開它；
  `HouseholdTxDetailDialog` 對方記的共同支出多一顆「修改分攤」。能不能開由 `canEditSplitOnly()` 判斷，與 rules 同條件。

## 單一資料來源：`useHouseholdLedger`
- 誰欠誰 / 本月彙總 / 公基金 / 交易列表全部由 `useHouseholdLedger(household)` 衍生：一次訂閱近 `HOUSEHOLD_LEDGER_MONTHS`（24）個月的共同支出 + 全部結算 + 全部公基金入金。
- `useSharedSnapshot`（hooks.ts）用 refcount 讓同一個 query key 只保留一個 `onSnapshot`，同一頁多個元件不會重複訂閱。
- 之前各元件各自訂閱不同時間範圍（列表 6 個月 / 餘額 2 年 / 公基金全部），會出現「列表加總 ≠ 誰欠誰」；現在都以同一份資料計算。
- `useHouseholdMonthSummary` 的月份區間以台北月份當 `useMemo` key，跨月會自動換區間。
- 月報（`HouseholdMonthlyReport`）仍用自己的單月 query，才能往回翻超過 24 個月。

## 個人支出分享（owner → 伴侶）
- 目的：讓伴侶看得到「我的個人支出」明細，不是只有共同支出；再進一步可以開放「可編輯」。
- **Rules 的唯一授權依據：`users/{分享者 uid}.ledgerSharedWith: string[]`**。只有本人（或 admin）寫得進 `users/{uid}`，所以一定是本人主動開放自己的資料。
  `transactions` 的 read 多一條（放在最後一個 `||`，自己讀自己不用多付 `get()`）：
  `type == 'expense' && isMember() && uid() in ledgerViewersOf(userId)`。
  **只放行 `type == 'expense'`** — 收入、轉帳、帳戶、投資、淨值一律看不到。
- `households/{hid}.ledgerSharing[分享者 uid] = [看得到的 uid]` 是**純 UI 鏡像**（對方讀不到別人的 `users/{uid}`，要靠這裡才知道分頁該不該出現）。rules 不採信它。
  兩份由 `setLedgerSharing()` 用 `writeBatch` 一起寫。
- household rules 額外放行「任何成員都能改 `ledgerSharing` 裡自己那把 key」，不需要 `canEditSettings` — 那是他自己的資料。
- UI：
  - 分享者：`/shared?tab=settings` → 成員與權限 → 每位成員一個「可以看我的個人支出明細」開關（打開前有 confirm 說明會看到什麼）。
  - 觀看者：`/shared` 多一個「{對方名字}的支出」分頁（`SharedLedgerPanel`），月曆切換、類別分布、逐筆明細，唯讀。
- 查詢：`where userId == X, type == 'expense', date 區間, orderBy date desc`。**`type == 'expense'` 是 rules 要求，少了整個 query 會被拒**（index `userId + type + date` 已存在）。共同支出（有 `householdId`）client 端濾掉，避免跟「交易」分頁重複。
- 取消分享後對方的 `onSnapshot` 會收到 `permission-denied`：`useSharedLedgerMonth` 把它收進 `error`，UI 顯示「對方可能已經取消分享」而不是整頁壞掉。

### 可編輯（2026-10）
- 第二層開關「可以編輯我的個人支出」，只有「可看」打開時才出現。**Rules 依據：`users/{分享者 uid}.ledgerEditors: string[]`**（⊆ `ledgerSharedWith`）；UI 鏡像 `households.ledgerEditing[分享者 uid]`。
  兩層由同一個 `setLedgerSharing({ scope: 'view' | 'edit' })` 維護：關「可看」會連「可編輯」一起收回；開「可編輯」會順便補上「可看」。`nextLedgerShareState()` 是純函式，不變式寫在那裡。
- Rules 放行的範圍（`txEditableByLedgerEditor()`）：只有 `update`，原本與改完都要 `type == 'expense'`、`userId` 不能變。
  **不能** create（替對方新增）、不能硬刪；軟刪 / 復原是 update 所以可以。
- 編輯者改金額或把付款人改成自己時，`updateTransaction()` 會在同一個 `runTransaction` 回補對方 `accounts` 的餘額，
  所以 `accounts/{id}` 多開：`get` 單一帳戶 + `update` 只限 `balance / balanceTWD / balanceUpdatedAt / updatedAt`
  （條件同樣是 `uid() in ledgerEditorsOf(account.ownerId)`；不開 list，看不到對方的帳戶清單）。
- 前端閘門 `canEditLedgerOf(household, editorUid, ownerUid)`：自己的永遠 true；別人的要鏡像同時有可看 + 可編輯。
  - `SharedLedgerPanel`：可編輯時每筆變成按鈕 → `TransactionEditDialog`。
  - `HouseholdTxDetailDialog` / `HouseholdEntryDialog`：對方記的共同支出，有開放就能編輯 / 刪除（取代以前「只有記錄的人能改」）。
- `TransactionEditDialog` 編別人的交易時（`tx.userId !== me`）：帳戶 / 支付方式維持原樣（`accounts` / `payment_methods` 的 rules 限 owner，
  子元件 `OwnerPaymentSection` 只在 owner 編自己的時候掛上）；「複製」按鈕隱藏（會複製到自己名下）。
  共同分攤的「我」一律是**建立者**（`creatorUid = tx.userId`）：`myShareTWD = shares[creatorUid]`、付款人 = 建立者才保留扣款帳戶。
- 已知限制：編輯者改到**外幣帳戶**的交易時，`applyAccountAdjustments` 需要 `listFxRates()`（rules 限 owner list）會被拒，
  整筆 update 會失敗並 toast；目前 owner 的扣款帳戶都是 TWD，先不處理。

## 分頁結構（`/shared`）
分頁設定集中在 `pages/shared-page.tsx` 的 `SECTIONS`（id = `?tab=`、icon、顯示條件、render），新增分頁加一筆即可；
分頁列用 `ScrollTabsList`，手機上黏在頂端、可橫向捲動。手機底部分頁有「共同」直達。

| tab | 元件 | 內容 |
|---|---|---|
| 總覽 | `HouseholdOverview` | 4 張 KPI（本月支出 / 預算剩餘 / 誰欠誰 / 公基金餘額）、誰欠誰＋算式、近 6 個月堆疊長條、本月類別分布 |
| 交易 | `HouseholdEntriesList` | **共同支出 + 公基金存入 + 結算轉帳**的統一時間軸 |
| 分析 | `HouseholdInsights` | 期間（3/6/12 月）vs 前期：KPI、每月趨勢＋移動平均＋預算線、類別趨勢、類別變化、兩人分工、星期幾、公基金走勢、大筆支出 |
| 投資 | `JointInvestmentPanel`（`features/joint-investments`） | 共同持有 + 兩人各自的持股、損益、各自擁有多少、走勢、共同目標試算 |
| 公基金 | `HouseholdFundPanel` | 獨立功能：KPI、誰存了多少、存入↔支出流水帳（含每筆後的累計餘額） |
| 月報 | `HouseholdMonthlyReport` | 某月各自付了 / 應付、類別、結算，**外加本月公基金存入與支出** |
| 結算 | `SettlementsList` | 結算紀錄 |
| {對方}的帳 | `SharedLedgerPanel` | 對方分享的個人支出（唯讀），見上一節 |
| 目標 / 設定 | `GoalsPanel` / `HouseholdSettingsPanel` + `HouseholdTelegramCard` | 設定頁多一張 Telegram 卡：連結 / 替伴侶產生加入連結 / 共同帳本報告頻率 |

## 列表一律分頁
所有「呈現歷史資料」的列表都走 `@/components/data-table` 的 `useDataTable` + `DataTableToolbar` + `DataTablePagination`
（搜尋、篩選、每頁筆數 10/25/50/100，狀態同步到 URL）。每個表要給不同的 `urlKey` 才不會互相蓋掉：
`hh`（交易）、`fund`（公基金）、`st`（結算）、`pl`（對方的帳）、`tx`（出遊花費）。

## 統一時間軸 `entries.ts`
- `buildHouseholdEntries()` 把 `transactions` / `fund_entries` / `settlements` 併成 `HouseholdEntryRow[]`，
  交易分頁、公基金分頁、月報共用，才不會「支出看得到、存入看不到」。
- `memberColor()` 讓成員的識別色在 chip、進度條、圖表三處一致 —— **顏色跟著人走，不是跟著排名**，
  篩選後其他人的顏色不會被重新指派。公基金固定 `HOUSEHOLD_FUND_COLOR`（`#d97706`，通過 dataviz 的
  深淺色對比與色盲分離驗證；成員色由使用者自選，所以圖表一律附圖例＋數字，不以顏色為唯一識別）。

## 明細入口
- 交易分頁：可切近 1 / 3 / 6 / 24 個月，可依類型（支出／存入／結算）、誰、類別篩選，顯示區間合計與「我這份」；點任一筆支出開 `HouseholdTxDetailDialog`（誰付、各成員分攤金額與比例、付款方式、誰記的、建立／修改時間），自己記的才有編輯／刪除。
- 總覽「誰欠誰」可展開算式：墊付 − 應負擔 ± 已結算 = 淨額。

## 踩過的坑
- **rules 裡碰 `resource.data.*` 前要先確認 `resource` 不是 null**。`createTransaction()` 為了冪等性，
  會在 `runTransaction` 裡先 `get()` 一份**還不存在**的 doc；此時 `resource` 是 null，read rule 的每個條件
  都會丟 error。CEL 的 `||` **只有在另一個運算元為 true 時才吸收 error** —— admin 剛好有 `isAdmin()` 為 true
  所以過關，member 整條變成 error 被拒。症狀一樣是「UI 按得下去，存檔跳 Missing or insufficient permissions.」，
  而且**跟 permissions 欄位無關**，很容易誤診。
  現在 `transactions` 的 read 拆成 `get`（允許 `resource == null`）與 `list`（不放寬），
  寫入則改用 `txIsMine()` / `txHouseholdId()` 先判 null 再取 `.data`，不依賴 error 吸收行為。
- **`members[uid].permissions` 不能寫 `null`**：rules 的 `.get('permissions', {})` 只有在 key **不存在**時才回 default；
  key 在但值是 null 會回 null，接著 `.get(key, def)` 直接 runtime error → 整條 rule 拒絕，成員的
  `canAddExpense` / `canSettle` 全部失效（症狀：UI 按得下去，存檔跳 `Missing or insufficient permissions.`）。
  兩邊都修了：rules 用 `is map` 檢查（`memberPermMap()`），`updateHousehold()` 寫入前把 null 正規化成 `{}`。
  以後在 rules 裡讀任何「可能為 null 的巢狀欄位」都要比照辦理。

## 已知限制 / TODO(owner)
- 伴侶付的共同支出不會出現在 owner 的個人 ledger 統計（只在 `/shared`）；若要合併需做 mirror tx。
- 目前只支援一個 household。共同支出對話框、快速記帳、編輯交易都可以選幣別（`useCurrencyOptions`：預設五種 ∪ owner 追蹤的匯率 ∪ 旅程外幣），分攤以原幣輸入。
- 畫面上的共同支出只涵蓋近 `HOUSEHOLD_LEDGER_MONTHS` 個月；更早的要看月報往回翻。
- 公基金存入不會自動扣個人帳戶餘額（只加共同餘額），公基金也還沒計入淨值（2026-09-21 owner 確認維持現狀）。
- 預設仍是「只有記錄的人能改自己的共同支出」；要互改要靠「個人支出分享 → 可編輯」那一層（2026-10 起），不是 household 權限。
- 個人支出分享是全有全無：不能只分享部分類別或設金額門檻（rules 對 list query 無法逐類別過濾）。
