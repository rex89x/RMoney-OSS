# Accounts / Transfer / Billing Refactor Plan

> Status: **Phase 1 implementation started — accounts foundation shipped via Codex**
> Owner: owner
> Last updated: 2026-05-05
> Related: `CLAUDE.md` §13, `docs/PERSONAL_HUB_SPEC.md`

本文件落地一波「收支與資產管理完整化」的重構，把原本以 `paymentMethod` 字串為核心的 ledger 升級為以 `accounts` 為 first-class 資料的模型，並補上 transfer、信用卡帳單完整流程、信貸繳款、訂閱自動入帳、投資與帳戶連動、悠遊卡 / 街口 / LINE Pay 鍊式支付、旅遊預算編輯。

---

## 0. 設計原則

1. **不破壞既有功能與資料**：所有改動以「擴充」為主，舊欄位保留 8 個月，舊 UI 在新功能 ship 後逐步退場。
2. **一個 commit 一件事**（CLAUDE.md §15）：每個 Phase 拆成多個獨立可 ship 的 PR。
3. **Migration 一律 dry-run + 報告 + commit 兩階段**，不直接覆寫現有 TX。
4. **彙總邏輯永遠過濾 `type === 'transfer'`**，避免重複計算月支出。
5. **資料源真相**：accounts 是 cash / bank / credit / e-wallet / investment-cash / loan 的單一表；舊 `cash_accounts` / `payment_methods` / `liabilities` 三條線收斂到 `accounts`。

---

## 1. 需求總表（已 confirmed）

| # | 需求 | Phase |
|---|---|---|
| 1 | 信貸繳款扣待繳 | Phase 3 |
| 2 | 信用卡費繳款選扣款帳戶（避免重複記帳） | Phase 2 |
| 3 | 買賣股票連動帳戶餘額（台股/美股，含股息） | Phase 4 |
| 4 | 訂閱算進當月支出 + 指定支付方式 | Phase 3 |
| 5 | 特定信用卡累積消費 / 帳單 / 繳款（現金不歸戶） | Phase 2 |
| 6 | 悠遊卡自動加值；街口 / LINE Pay 綁卡或綁戶 | Phase 4 |
| 7 | 編輯旅遊預算 | Phase 3 |

### 補充項（已 confirmed 全收）

- **A**：`Transaction.type` 新增 `'transfer'`（基礎，先做）
- **B**：`accounts` 升級為 first-class collection
- **C**：TX 改用 `fromAccountId` / `toAccountId`
- **D**：自動加值語意（消費 from 悠遊卡 + transfer 信用卡 → 悠遊卡）
- **E**：投資交割帳戶用單一 `investment_cash` type 但允許多幣別（TWD / USD / JPY 起步，可彈性擴充）
- **F**：信用卡 `closingDay`（結帳日）+ `dueDay`
- **G**：歷史資料 dry-run + commit 兩階段 migration
- **H**：`subscriptions` 與 `recurring` 合併為單一 engine
- **I**：`liabilities` 上長出 `monthlyPayment` / `nextDueDate`（廢除另開的 scheduled_payments 重複部分）

### 已 confirmed 的關鍵決策

| 決策點 | 結論 |
|---|---|
| Transfer 重構 | 同意，但**不影響既有功能與資料** → 舊 TX 保留 `paymentMethod` 字串、新增欄位皆 optional、UI 灰度切換 |
| Subscriptions ↔ Recurring | **合併** 成一個 engine |
| 多幣別交割帳戶 | **單一 investment_cash account type，currency 欄位彈性**（TWD / USD / JPY 起步，後續可加） |
| 歷史 paymentMethod 字串 | 保留 **8 個月**（截至 2027-01-05 移除） |
| 本計畫 | commit 為 `docs/REFACTOR_ACCOUNTS_PLAN.md` |

---

## 2. Schema Diff

### 2.1 新增 collection：`accounts`

```typescript
type AccountType =
  | 'cash'                 // 實體現金（皮夾、抽屜）
  | 'bank'                 // 銀行存款（活/儲/定）
  | 'credit_card'          // 信用卡（負債帳戶）
  | 'e_wallet_balance'     // 餘額制：街口錢包、LINE Pay 一卡通、悠遊卡
  | 'investment_cash'      // 券商交割帳戶（多幣別）
  | 'loan';                // 信貸 / 車貸 / 房貸（負債帳戶）

type Account = {
  id: string;
  ownerId: string;
  name: string;                          // 「台新 CUBE」「玉山交割戶」「悠遊卡」
  type: AccountType;
  currency: 'TWD' | 'USD' | 'JPY' | string;  // 開放擴充，預設 TWD
  active: boolean;
  archivedAt: Timestamp | null;
  iconKey?: string;                      // 對應 Lucide icon name
  colorKey?: string;
  note?: string;

  // 餘額（手動或自動推導，見 §4）
  balance: number;                       // 原幣
  balanceTWD: number;                    // 換算
  balanceUpdatedAt: Timestamp;

  // 信用卡專屬
  creditCard?: {
    closingDay: number;                  // 結帳日 1~31
    dueDay: number;                      // 繳款日 1~31
    cardLast4?: string;
    creditLimit?: number;
    linkedSettlementAccountId?: string;  // 預設繳卡費的扣款帳戶
  };

  // 貸款專屬
  loan?: {
    principalTWD: number;                // 初始本金
    interestRate?: number;               // 年利率
    monthlyPayment: number;              // 每期應繳
    nextDueDate: Timestamp;              // 下期繳款日
    termMonths?: number;
    linkedSettlementAccountId?: string;
  };

  // e-wallet 補充
  eWallet?: {
    provider: 'jko' | 'linepay' | 'easycard' | 'other';
    autoTopUp?: {
      enabled: boolean;
      sourceAccountId: string;           // 通常是信用卡 account
      thresholdTWD: number;              // 餘額低於 X 自動加值
      topUpAmountTWD: number;            // 加值金額
    };
  };

  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

**Firestore path**：`accounts/{accountId}`

### 2.2 修改 `transactions`

```typescript
// 既有欄位全部保留（不破壞）
type TransactionType = 'expense' | 'income' | 'transfer';   // ← 新增 transfer

type Transaction = {
  // ... 既有欄位 ...
  type: TransactionType;

  // 新增（皆 optional，舊資料 null）
  fromAccountId?: string;     // expense / transfer 必填
  toAccountId?: string;       // income / transfer 必填

  // 既有 paymentMethod 字串保留 8 個月（至 2027-01-05）
  paymentMethod?: string;     // legacy，逐步以 fromAccountId 取代

  // transfer 專屬
  transferGroup?: {
    role: 'leg';              // 多腳轉帳預留
    pairedTxId?: string;      // 自動加值等鍊式 TX 的關聯
  };
};
```

**約束（前端 + Zod）**：
- `type === 'expense'` → `fromAccountId` required, `toAccountId` must be null
- `type === 'income'` → `toAccountId` required, `fromAccountId` must be null
- `type === 'transfer'` → 兩者都 required，且不可相同
- 月支出彙總：`type === 'expense'`（**不含 transfer**）

### 2.3 修改 `credit_card_bills`

```typescript
type CreditCardBill = {
  // ... 既有 ...
  accountId: string;            // ← 新增，取代 paymentMethodId
  paymentMethodId?: string;     // legacy 保留 8 個月
  closingDate: Timestamp;       // ← 新增（從 account.creditCard.closingDay 推算）

  paidFromAccountId?: string;   // ← 新增：繳款是從哪個 cash/bank 出
  paidViaTransferId?: string;   // ← 新增：對應的 transfer TX id
};
```

「繳卡費」流程：
1. 使用者選來源帳戶（bank）+ 金額
2. 寫一筆 `type='transfer'` from bank → to credit_card account
3. CC bill 標記 paidAt + paidFromAccountId + paidViaTransferId
4. **不產生 expense TX**（消費當下已記）

### 2.4 修改 `subscriptions`（與 recurring 合併）

```typescript
type Subscription = {
  // ... 既有 ...
  paymentAccountId: string;     // ← 新增：哪個 account 扣款
  autoCreateTx: boolean;        // ← 新增：到期自動寫 TX？
  category: string;
  // 與 recurring 共用 engine
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly';
  nextDue: Timestamp;
  active: boolean;
  lastGeneratedAt?: Timestamp;
};
```

`recurring` collection 廢除 → migration 一次性轉成 subscriptions（保留原 doc 在 `recurring_legacy` 8 個月）。

### 2.5 修改 `liabilities`（信貸繳款）

```typescript
type Liability = {
  // ... 既有 balanceTWD / interestRate ...
  accountId?: string;           // ← 連結到 accounts/{type:'loan'}（新建立的會自動建 account）
  monthlyPayment?: number;      // ← 新增
  nextDueDate?: Timestamp;      // ← 新增
  linkedSettlementAccountId?: string;
};
```

「繳信貸」= transfer from bank → to loan account；balance 自動 ↓。

### 2.6 廢除 / 收斂

| 舊 | 新 | 何時移除 |
|---|---|---|
| `payment_methods` 字串集合 | `accounts` collection | 2027-01-05 |
| `cash_accounts` 獨立 collection | 併入 `accounts` (type='cash'/'bank') | 2027-01-05 |
| `recurring` collection | 併入 `subscriptions` | 2027-01-05 |
| TX 上的 `paymentMethod` 字串 | `fromAccountId` | 2027-01-05 |

### 2.7 Trip 預算

```typescript
type Trip = {
  // ... 既有 ...
  budget?: number;              // 既有
  budgetTWD?: number;           // ← 新增（多幣別 trip 用）
  budgetUpdatedAt?: Timestamp;  // ← 新增
};
```

UI 在 Trip 詳情頁加編輯按鈕 + 預算 vs 實支進度條。

---

## 3. Phase 拆分（每個 Phase 獨立可 ship）

### Phase 0 — 設計確認（不動 code）✅ 本文件
- [x] 寫 `docs/REFACTOR_ACCOUNTS_PLAN.md`（本檔）
- [ ] owner review + sign-off
- [ ] commit 本檔（`docs(refactor): accounts/transfer/billing plan`）

### Phase 1 — Accounts first-class + Transfer type（基礎）

Codex implementation note (2026-05-05):
- [x] 新增 `features/accounts`（types / api / hooks / schema / components / README）
- [x] `Transaction.type` 支援 `transfer`，並新增 optional `fromAccountId` / `toAccountId` / `transferGroup`
- [x] Quick Entry / Transaction Edit 可在 accounts 已建立時雙寫 accountId + legacy `paymentMethod`
- [x] Firestore Rules / Indexes 加入 `accounts`
- [x] Settings 加入「帳戶」管理 tab
- [x] Apps Script 加入 `dryRunAccountsMigration()` 與 `dryRunAccountsMigration` action
- [x] Backup 匯出納入 `accounts`
- [x] 淨值頁現金/貸款新增入口收斂到同一個 `AccountsPanel`
- [x] 新增/編輯/軟刪/復原交易時，以 Firestore transaction 同步調整 account balance
- [x] 信用卡繳費建立 `transfer` from 扣款帳戶 → credit_card account，bill 記錄 paid linkage
- [x] loan account 繳款建立 `transfer` from 扣款帳戶 → loan account
- [x] 淨值 snapshot 改以 `accounts` 作為 liquid / loan / credit card debt source
- [x] 支付方式統計改優先以 `fromAccountId` 顯示帳戶支出
- [ ] commit migration 寫回歷史 TX（需 owner review dry-run mapping 後才做）

**目標**：底層資料模型升級，**舊 UI 完全不變、舊資料完全不動**。

**改動範圍**：
- 新增 `apps/web/src/features/accounts/`（types / api / hooks / schema / components / README）
- `Transaction.type` 加入 `'transfer'`，`fromAccountId` / `toAccountId` 為 optional
- Zod schema 加入 cross-field validation
- 月支出彙總（dashboard / budgets / monthly summary）過濾 `type !== 'transfer'`
- Firestore Rules + indexes 加 `accounts` collection
- Settings 頁加「帳戶管理」（CRUD + archive）
- Migration script（**dry-run only，不寫入**）：
  - seed 預設 accounts（從 `DEFAULT_PAYMENT_METHODS` + `cash_accounts` + `liabilities` 合成）
  - 對既有 TX 提供 `paymentMethod → accountId` mapping 報告
  - 產出 `migration-report.json` 列 mismatch
- 第二步（**owner 確認 mapping 後**）：commit migration 把 `fromAccountId` 寫回 TX

**驗收**：
- 既有 TX 完全不變（只多了 `fromAccountId` 欄位）
- 既有 dashboard 月支出數字一致
- 帳戶管理 UI 可建立 / 編輯 / 封存帳戶
- Quick Entry FAB 可選 `fromAccountId`（**舊欄位 paymentMethod 同步保留以利切換**）

### Phase 2 — 信用卡完整化（#2, #5）

**改動範圍**：
- `accounts.creditCard.closingDay` / `dueDay` / `linkedSettlementAccountId`
- `credit_card_bills` 加 `accountId` / `closingDate` / `paidFromAccountId` / `paidViaTransferId`
- 當期帳單 query 改成 `fromAccountId === cardId && txDate ∈ [closingPrev, closingCurr]`
- 「繳卡費」UI：選來源 + 金額 → 寫 transfer + 標記帳單 paid（**不寫 expense**）
- Dashboard 加「信用卡卡片」：每張卡當期應繳 / 已繳 / 下期截止日
- 自動偵測：消費 TX 寫入時，若 `from` 是 `credit_card` 帳戶 → 自動歸戶到該卡當期帳單
- 現金消費（`from` 是 `cash` 或 `bank`）→ **不入任何帳單**

**驗收**：
- 一張新卡：建立 → 設 closingDay/dueDay → 消費 3 筆 → 自動算出當期帳單金額
- 「繳卡費」流程跑通：transfer 寫入 + 帳單 paid + dashboard 立即更新
- 現金 TX 不會被誤算進任何信用卡帳單

### Phase 3 — 信貸 / 訂閱合併 / 旅遊預算（#1, #4, #7）

**改動範圍**：
- `liabilities.monthlyPayment` / `nextDueDate` / `accountId`（自動建立對應 loan account）
- 「繳信貸」UI：選來源 + 金額 → transfer + balance ↓ + advance nextDueDate
- `subscriptions` 加 `paymentAccountId` / `autoCreateTx`，併入 `recurring` engine
- `recurring` 廢除：migration 一次性轉換、原 collection rename 為 `recurring_legacy`
- Apps Script `runRecurringTransactions` 改為掃 `subscriptions`：到期 → 產 TX（含 `fromAccountId`）→ advance `nextDue`
- Trip 詳情頁加「編輯預算」表單（budget / budgetTWD / currency）+ 預算 vs 實支進度條
- 月支出 dashboard 加入「訂閱本月應扣」區塊

**驗收**：
- 信貸：建立 loan account → 設 monthlyPayment + nextDueDate → 模擬繳一期 → balance 正確 ↓ + nextDueDate +1 月
- 訂閱：建立 Netflix subscription → 設 paymentAccountId = CUBE 卡 + autoCreateTx → 到期日跑 Apps Script → 自動產 TX → 出現在當月支出
- Trip 預算：編輯後立刻反映在進度條

### Phase 4 — 投資連動 + e-wallet 鍊（#3, #6）

**改動範圍**：
- `accounts.type === 'investment_cash'`（單一 type、currency 欄位彈性 TWD/USD/JPY/...）
- 買進 form 加「扣款帳戶」選單（filter type='investment_cash' && currency 對應）→ 寫 transfer (cash → investment_cash) + 建 portfolio lot
- 賣出：transfer (investment_cash → cash) + 寫 realized_lots
- 股息：income to investment_cash（或設定提領到一般 cash）
- 悠遊卡 `eWallet.autoTopUp` 設定 UI；觸發時：
  - 寫 transfer from 信用卡 → to 悠遊卡（`transferGroup.pairedTxId` 標記與消費 TX 關聯）
  - 該 transfer 自動進信用卡當期帳單（Phase 2 已支援）
- 街口 / LINE Pay：兩種 account 並存
  - 餘額制 (`e_wallet_balance`)：先 transfer (bank → e-wallet) 儲值；消費 from e-wallet
  - 綁卡制：消費 from 信用卡（與一般刷卡無異，無需另建 account）

**驗收**：
- 買台積電 100 股：扣台幣交割戶 → 部位增加，台幣戶 balance ↓
- 賣 AAPL 10 股：美元交割戶 ↑，realized PnL 正確
- 悠遊卡自動加值：消費 70 元 → 餘額觸發 → 自動寫 transfer 500 from 信用卡 → 信用卡當期帳單 +500（**不是 +570**）
- 街口餘額制：儲值 1000 → 消費 200 → 街口 balance = 800、信用卡帳單不動

### Phase 5 — Polish

- Dashboard / budgets / monthly summary 全面過濾 transfer
- Migration 報告：跑出 N 筆 TX 已關聯 accountId、M 筆 mismatch（讓 owner 手動補）
- `firestore.indexes.json` 新增：
  - `transactions: fromAccountId + date DESC`
  - `transactions: toAccountId + date DESC`
  - `transactions: fromAccountId + closingPeriod`
  - `accounts: ownerId + type + active`
- 更新 `docs/PERSONAL_HUB_SPEC.md` 對應段落
- 8 個月後（2027-01-05）移除 legacy 欄位的 cleanup PR（先排進 backlog）

---

## 4. Migration 計畫

### 4.1 Dry-run（Phase 1 前期）
1. Apps Script 寫 `dryRunAccountsMigration()`：
   - 建立 candidate `accounts`（從 `DEFAULT_PAYMENT_METHODS` + `cash_accounts` + `liabilities`）
   - 對所有 TX 跑 `paymentMethod → accountId` mapping
   - 產 `migration-report.json`：
     - matched: N 筆
     - ambiguous: M 筆（如 "LINE Pay" 同時對應綁卡 / 綁戶兩種帳戶）
     - unmatched: K 筆
2. 報告下載到本機，**owner 手動 review 並修正 ambiguous mapping**

### 4.2 Commit 階段（Phase 1 末期）
1. seed `accounts` collection（owner = owner）
2. batch update TX：`fromAccountId` / `toAccountId` 寫回（仍保留 `paymentMethod` 字串）
3. 產 `migration-commit-report.json` 比對
4. **Apps Script 加保險**：每日 00:00 跑 reconcile job，若發現 TX 有 `paymentMethod` 但無 `fromAccountId` → 補（持續 8 個月）

### 4.3 Rollback
- 不刪 `paymentMethod` 字串、不刪舊 collection（直到 2027-01-05）
- 若 Phase 1 出問題：UI 切回讀 `paymentMethod`、停用 transfer 入口、Apps Script reconcile job 暫停
- Rules 保持向下相容：新欄位皆 optional

---

## 5. 風險與回滾

| 風險 | 機率 | 緩解 |
|---|---|---|
| Migration mapping 錯誤導致月支出失準 | 中 | dry-run + 兩階段 + 8 個月雙寫；reconcile job 持續比對 |
| Transfer 漏過濾導致月支出重複 | 中 | 所有彙總點集中到單一 helper `sumExpenseTWD()`，內部硬性過濾 |
| 信用卡帳單歸戶錯期（closingDay 邊界） | 中 | 用 `lib/tz.ts` 的 `startOfTWDay`；單元測試覆蓋月底邊界 |
| 自動加值 + 消費 TX 雙重計算 | 高 | `transferGroup.pairedTxId` 雙向引用，dashboard 過濾 type=transfer |
| Recurring → Subscriptions 合併資料遺失 | 低 | recurring 改名為 recurring_legacy 保留 8 個月 |
| Firestore Rules 鎖死 | 低 | 每個 Phase 都跑 `firebase deploy --only firestore:rules --dry-run` |

---

## 6. 時間預估（粗估，可調）

| Phase | 預估 | 備註 |
|---|---|---|
| Phase 0 | 0.5 day | 本文件 + sign-off |
| Phase 1 | 3~4 days | 最大塊，含 migration script |
| Phase 2 | 2~3 days | 信用卡 UI + 帳單邏輯 |
| Phase 3 | 2~3 days | 三個小 feature 一起 |
| Phase 4 | 3~4 days | 投資連動 + e-wallet 鍊 |
| Phase 5 | 1 day | polish + indexes + docs |
| **總計** | **~12~16 days** | 中間視 review 節奏 |

---

## 7. 待 confirm 後啟動

下次回應：
- [ ] owner sign off 本文件 → commit
- [ ] 開 Phase 1 工作（先做 `accounts` collection + types + Settings UI，不動既有 ledger 流程）

---

**EOF**
