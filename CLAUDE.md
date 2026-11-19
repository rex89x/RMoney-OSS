# Personal Hub — Project Skill

> **此檔為 Claude Code 的 primary context**，每次 session 必讀。
> 所有程式碼決策、命名、架構、防呆規則都以本檔為準。
> 細部功能設計請參考 `docs/PERSONAL_HUB_SPEC.md`。
> 遇到衝突：本檔的規範 > SPEC > Claude Code 自己的判斷。

---

## 1. 專案身份

| 項目 | 值 |
|---|---|
| 代號 | `personal-hub` |
| 類型 | Single-user personal finance + travel planning web app (PWA) |
| Owner | owner (single `owner` user, 保留多人擴充) |
| 主幣別 | TWD |
| 主時區 | Asia/Taipei (UTC+8) |
| 語系 | 介面繁中為主、code 全英 |

---

## 2. 技術棧 (pinned versions)

| 層 | 技術 |
|---|---|
| Frontend | React 18 + Vite 5 + TypeScript 5 (strict) |
| Styling | Tailwind CSS 3.x (`darkMode: 'class'`) + shadcn/ui |
| UI State | Zustand (ephemeral UI) |
| Data State | TanStack Query v5 |
| Router | React Router v6 |
| Forms | React Hook Form + Zod |
| Icons | **Lucide React 專用，禁用 emoji** |
| Charts | Recharts |
| Date/Time | date-fns + date-fns-tz (**固定 Asia/Taipei**) |
| Toast | sonner |
| Auth / DB / Hosting | Firebase (Auth + Firestore Native + Hosting) |
| Backend (排程/外部 API) | Google Apps Script + clasp |
| LLM | Claude API (Anthropic Messages API via Apps Script, `apps-script/src/Claude.gs`) |
| Maps | Google Maps JS API + Places API |
| Notification | Telegram Bot API (via Apps Script) |
| CI/CD | GitHub Actions |
| Node | 20 LTS |
| Package manager | npm (workspaces) |

**禁止引入**：`create-react-app`、Material UI、Ant Design、moment.js、axios (用 fetch)、enzyme、emotion (已有 Tailwind + shadcn 就夠)。

---

## 3. 資料夾結構

```
personal-hub/                       # monorepo root
├── apps/
│   └── web/                        # React SPA
│       └── src/
│           ├── components/
│           │   ├── ui/             # shadcn generated
│           │   └── layout/         # Sidebar, TabBar, FAB, AppLayout
│           ├── features/           # 每個模組一個資料夾
│           │   └── <feature>/
│           │       ├── index.ts           # barrel export
│           │       ├── api.ts             # Firestore CRUD
│           │       ├── hooks.ts           # TanStack Query hooks
│           │       ├── types.ts
│           │       ├── schema.ts          # Zod
│           │       ├── components/
│           │       └── README.md
│           ├── pages/              # Route-level components
│           ├── hooks/              # Global hooks (useTheme, useAuth)
│           ├── lib/                # firebase.ts, appsScript.ts, maps.ts, utils.ts
│           ├── stores/             # Zustand stores
│           ├── types/              # Global TS types
│           ├── App.tsx
│           └── main.tsx
├── apps-script/                    # clasp-managed GAS project
│   └── src/*.gs
├── functions/                      # Cloud Functions：MCP 閘道（OAuth + 轉送到 Apps Script）
├── firebase/
│   ├── firestore.rules
│   ├── firestore.indexes.json
│   └── storage.rules
├── .github/workflows/              # CI/CD
├── docs/                           # SPEC, SETUP, RUNBOOK, CICD, BOOTSTRAP
├── CLAUDE.md                       # 本檔
├── README.md
├── firebase.json                   # Firebase CLI 設定（hosting / rules / indexes 路徑）
└── package.json                    # workspace root
```

---

## 4. 命名與風格

| 類型 | 規則 | 範例 |
|---|---|---|
| 檔名 | kebab-case | `stock-list.tsx`, `use-stock-price.ts` |
| React 元件 | PascalCase | `StockList`, `QuickEntryFab` |
| Hook | `use` 開頭 camelCase | `useStockPrice`, `useAuth` |
| 常數 | SCREAMING_SNAKE | `DEFAULT_CATEGORIES` |
| Firestore collection | snake_case 複數 | `transactions`, `alert_logs` |
| Firestore field | camelCase | `amountTWD`, `createdAt` |
| TS type/interface | PascalCase，型別用 `type`、擴展用 `interface` | `type Transaction = {...}` |
| Zod schema | `<Name>Schema` | `TransactionSchema` |
| Env 變數 | `VITE_*` prefix for frontend | `VITE_FIREBASE_API_KEY` |

**TypeScript 規則**：
- `strict: true`, `noUncheckedIndexedAccess: true`
- 禁用 `any`，例外須加 `// @ts-expect-error` 或 `// eslint-disable-next-line` + 原因註解
- 禁用 non-null assertion (`!`) 除非有 runtime 保證 + 註解
- 一律 `import type` for type-only imports

**Component 規則**：
- 一律 function component + hooks
- Props 用 `interface XxxProps`
- 無 default export (除 pages 外) — 用 named export 方便 refactor
- 業務邏輯放 hooks (`use*`)，元件只做渲染

---

## 5. Firestore 互動守則

1. **All reads via TanStack Query** — 包成 `useXxxQuery` hook，自動 caching、revalidation、loading/error 狀態
2. **All writes via mutation hook** — `useXxxMutation`，自動 invalidate 相關 query
3. **Converter 必備** — 每個 collection 要有 `FirestoreDataConverter<T>` 做型別轉換，Timestamp ↔ Date 在這一層處理
4. **Batched writes** — 超過 1 個相關文件的寫入必用 `writeBatch` 或 `runTransaction`
5. **Listener 有節制** — real-time `onSnapshot` 只用在「需要即時同步」的地方（Dashboard 卡片、listing 頁）；單筆讀用 `getDoc`
6. **Pagination** — 列表頁強制 limit + cursor，不 fetch all
7. **Soft delete for critical data** — transactions、trips 用 `deletedAt` 欄位軟刪，不真的移除 (之後可做 undo)
8. **Security Rules 是第二道防線，不是唯一** — 前端也要做檢查（體驗）
9. **Composite index** — 任何 multi-field query 都要在 `firestore.indexes.json` 宣告
10. **Never expose Admin SDK 到前端** — 只在 Apps Script (service account) 用

---

## 6. 功能模組開發模式

新增一個 feature 時，必須建立完整資料夾結構：

```
features/<feature-name>/
├── index.ts              # export { useXxx, XxxList, XxxForm }
├── api.ts                # raw Firestore queries + converter
├── hooks.ts              # useXxxQuery, useXxxMutation (TanStack Query)
├── types.ts              # type Xxx = {...}
├── schema.ts             # Zod schemas for forms
├── components/
│   ├── xxx-list.tsx
│   ├── xxx-form.tsx
│   └── xxx-card.tsx
└── README.md             # 此 feature 的責任邊界、與其他 feature 的依賴
```

**api.ts 範本**：
```typescript
import { collection, doc, getDoc, ... } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { transactionConverter } from './types';

export const transactionsRef = () =>
  collection(db, 'transactions').withConverter(transactionConverter);

export async function getTransaction(id: string) { ... }
export async function createTransaction(data: TransactionInput) { ... }
// ...
```

**hooks.ts 範本**：
```typescript
export function useTransactions(filters: Filters) {
  return useQuery({
    queryKey: ['transactions', filters],
    queryFn: () => listTransactions(filters),
  });
}

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createTransaction,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transactions'] }),
  });
}
```

---

## 7. Auth 模式（不可偏離）

```typescript
// main.tsx root
useEffect(() => {
  // 1. 先接 redirect result（可能為 null，不代表錯）
  getRedirectResult(auth).catch((err) => toast.error(err.message));

  // 2. 掛常態 listener
  const unsub = onAuthStateChanged(auth, async (user) => {
    if (!user) return setAuthState({ status: 'unauthed' });
    setAuthState({ status: 'checking' });
    const allowed = await checkWhitelist(user.email!);
    if (!allowed) {
      await signOut(auth);
      toast.error('此帳號無使用權限');
      return setAuthState({ status: 'unauthed' });
    }
    await ensureUserDoc(user);   // 不存在就建
    setAuthState({ status: 'authed', user });
  });
  return unsub;
}, []);
```

**絕對規則**：
- 永遠 `signInWithRedirect`，永遠不用 `signInWithPopup`
- auth 狀態 3 態：`unauthed | checking | authed`，不是 boolean
- `checking` 階段 UI 顯示 `<AuthLoading />` 全屏 spinner，不閃到 `/login`

---

## 8. 主題模式（不可偏離）

**Source of truth**：`users/{uid}.preferences.theme` (`auto | light | dark`)
**Fallback**：`localStorage.theme`（尚未登入時）

**實作骨架**：
```typescript
function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(loadThemeFromLocalStorage() ?? 'auto');

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = mode === 'auto' ? (media.matches ? 'dark' : 'light') : mode;
      document.documentElement.classList.toggle('dark', resolved === 'dark');
      document.querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', resolved === 'dark' ? '#0a0a0a' : '#ffffff');
    };
    apply();
    // 系統切換時跟著走
    if (mode === 'auto') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
  }, [mode]);

  return { mode, setMode };
}
```

**防 FOUC (Flash of Unstyled Content)** — 在 `index.html` `<head>` 插入 inline script，早於 React 掛載：
```html
<script>
  (function () {
    var saved = localStorage.getItem('theme') || 'auto';
    var isDark = saved === 'dark' ||
      (saved === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) document.documentElement.classList.add('dark');
  })();
</script>
```

---

## 9. 外部 API 調用守則

**鐵律：前端不持有任何第三方 API key**

| 需求 | 前端做法 |
|---|---|
| 更新股價 | POST `{APPS_SCRIPT_URL}?action=updateStockPrices` |
| 更新匯率 | POST `{APPS_SCRIPT_URL}?action=updateFxRates` |
| LLM 生行程 | POST `{APPS_SCRIPT_URL}?action=generateItinerary` |
| Places 搜尋 | **例外**：Maps JS API 可在前端，因為 key 用 HTTP Referer 限制 |

**Apps Script 端驗證**：前端用 `text/plain` simple POST，把 Firebase `idToken` 放在 JSON body，GAS 用 `parseBody_(e).idToken` 驗證 → 比對 email 是否在白名單。不要把 idToken 放 URL query；也不要改用 `Authorization` header，Apps Script Web App 會遇到 CORS preflight。

---

## 10. 錯誤處理

```typescript
try {
  await createTransaction(input);
  toast.success('已新增');
} catch (err) {
  console.error('[createTransaction]', err);
  toast.error(err instanceof Error ? err.message : '發生未知錯誤');
  // 嚴重錯誤可另寫 errorLogs collection
}
```

- Async 一律 `try/catch`
- 使用者可見錯誤 → `toast.error`
- 技術錯誤 → `console.error('[functionName]', err)` + 可選寫 Firestore errorLogs
- 禁止 `.catch(() => {})` 吞錯誤
- 禁止直接 `alert()` / `window.confirm()`，用 shadcn Dialog

---

## 11. 日期與時間

- Firestore Timestamp 永遠是 **UTC**
- UI 顯示一律經 `date-fns-tz` 轉 `Asia/Taipei`
- 「今天」的定義：台北時間的 00:00–23:59:59
- 列表預設 group by TW 日期
- DatePicker / date-only string 一律用 `lib/tz.ts` 的 `formatDateInput` / `parseDateInput` / `dateInputToTWDate` / `dateInputToTWBoundary` / `formatTWDateInput`
- 「今天 / 天數差 / 週期加月份或年份」用 `startOfTWDay` / `daysBetweenTWDates` / `addTWCalendarMonths` / `addTWCalendarYears`，避免本機 timezone 與月底 rollover
- 禁止用 `toISOString().slice(0, 10)` 產生 UI 日期或 query 日期，會在 Asia/Taipei 往前一天

```typescript
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
const TW = 'Asia/Taipei';
formatInTimeZone(date, TW, 'yyyy-MM-dd HH:mm');
```

**市場時間表** (寫死在 `lib/market-hours.ts`)：
- TW：週一~五 09:00–13:30 Asia/Taipei
- US：週一~五 `09:30–16:00 America/New_York` (自動處理 DST)

---

## 12. 幣別處理

- 主幣別 `TWD`
- 每筆 `transaction` 存：`amount`（原幣）`currency`（原幣代碼）`amountTWD`（換算值）`fxRate`（當下匯率）
- Dashboard 彙總 **一律用 `amountTWD`**
- 建立 tx 時：若 currency !== TWD → 讀 `fx_rates/{pair}` 計算 amountTWD，**同時把 fxRate 存進 tx**（之後匯率變了歷史紀錄不會被動搖）

---

## 13. Known Pitfalls / Data Traps

開發前先讀過這張表，避免踩坑：

| # | 陷阱 | 處理方式 |
|---|---|---|
| 1 | **Firestore Timestamp 是 UTC**，直接 `.toDate().toLocaleDateString()` 在某些機器顯示錯誤 | 永遠經 `date-fns-tz` 指定 Asia/Taipei |
| 2 | **US 股市 DST** 影響盤中時間（台北時間 21:30 vs 22:30 開盤） | 用 `date-fns-tz` 的 zone 計算，不要寫死偏移 |
| 3 | **FX rate 用歷史時的 rate 還是當下**：每筆 tx 存入時固定 rate，**不**隨即時匯率變動 | `transactions.fxRate` 欄位記錄當下匯率 |
| 4 | **類別刪除**：有 tx 引用的類別不能硬刪 | 軟刪 `archivedAt`；UI 預設過濾已封存類別但保留 tx 顯示 |
| 5 | **價格歷史量爆炸**：20 檔 × 每 15 分 × 一年 = 約 70 萬筆 | (a) 僅在盤中存 (b) 30 天以上改存日 K (c) subcollection 分片 |
| 6 | **出遊 tx 雙重計算**：彙總「本月總花費」時出遊 tx 已包含在 `transactions`，不能再加一次 `trip.total` | Dashboard 查詢只查 `transactions`，`tripId` 作為 filter 不是 extra source |
| 7 | **主題閃爍 (FOUC)**：React mount 前 HTML 是 light，mount 後才切 dark → 閃白 | `index.html` 插入 inline script 預先加 `class="dark"`（§8） |
| 8 | **Redirect 登入無限 loop**：`onAuthStateChanged` 比 `getRedirectResult` 早觸發，可能把使用者當未登入踢回 `/login` | auth state 用 3-state，`checking` 期間不做任何 redirect |
| 9 | **白名單 bootstrap 自鎖**：Security Rules 已啟用、但 `users/{uid}` 尚未建立 → 寫不進去 | (a) `config/allowedEmails` 允許 auth user 讀取 (b) `users/{uid}` 允許 auth user 讀寫**自己的** doc |
| 10 | **Apps Script 6 分鐘逾時**：loop 打 20 檔股價超時 | 分批處理、用 `Utilities.sleep` 控 rate、必要時用 `ScriptApp.newTrigger()` 鍊接 |
| 11 | **Apps Script 同時執行鎖**：同時間觸發兩次會 deadlock | `LockService.getScriptLock().tryLock(30000)` |
| 12 | **Firestore Rules `get()` 成本**：每次驗證讀白名單會被計費 | 白名單放 `config/allowedEmails`（單文件），用 client SDK 讀一次 cache；Rules 只驗 `users/{uid}` 存在與 role |
| 13 | **Recharts 大資料卡頓**：> 500 點會明顯掉 fps | 聚合到最小顯示粒度（一天一點），畫前用 `useMemo` |
| 14 | **Google Maps 計費**：autocomplete 每 keystroke 計費 | 用 session token；輸入 debounce 300ms |
| 15 | **Offline persistence + Rules 改動**：SDK cache 過期但 Rules 變嚴會導致寫入失敗 | 重大 Rules 變更後在 app 啟動呼叫 `clearIndexedDbPersistence()`，以 app version 為 key |
| 16 | **Clasp credentials 過期**：CI 每月會踩一次 | `CLASPRC_JSON` secret 過期要手動 refresh，加到 runbook |
| 17 | **Firebase Service Account 權限過大**：預設 Editor | CI 用的 SA 僅給 Firebase Hosting Admin + Firestore Rules Deploy roles |
| 18 | **Telegram chatId 是負數** (群組) / **正數** (私訊)：型別要 string 處理，避免 JSON parse 到 number 失精 | `PropertiesService` 存 string，API 也接受 string |
| 19 | **Recurring tx 時區錯**：UTC 00:00 生成會變 TW 早上 8:00 | 排程觸發時以台北時間 01:00 跑 |
| 20 | **照片上傳 (未來)**：直接吃 Storage 配額 | 上傳前強制壓縮 ≤ 500KB，WebP 格式 |
| 21 | **DatePicker date-only 被 UTC 轉換吃掉一天**：台北時間選 5/1，`toISOString().slice(0, 10)` 會變 4/30 | 用 `formatDateInput()` 存選到的日期；寫入 Firestore range 時用 `dateInputToTWDate()` / `dateInputToTWBoundary()` |
| 22 | **Mobile bottom sheet + keyboard 擠壓畫面**：iOS/Android 鍵盤開關會改 `visualViewport`，fixed drawer 可能殘留壓縮高度 | Drawer/ResponsiveDialog 必須用 `visualViewport` 同步可用高度，內容區加 `min-h-0 overflow-y-auto`，不要在個別表單硬寫 viewport workaround |
| 23 | **週期排程月底 rollover**：用 `Date#setMonth()` 會讓 1/31 + 1 month 變成 3 月初 | 用 `addTWCalendarMonths()` / `addTWCalendarYears()`，會 clamp 到目標月份最後一天 |
| 24 | **租賃購入會打爆現金/銀行**：購入時是真的 expense TX 從來源帳戶扣，會讓帳戶餘額變成負的，dashboard 看起來「總資產 -X」 | 淨值公式加 `rentalUnrecoveredTWD = sum(active rentals max(0, 成本 − 累積收款))` 當虛擬資產（前端 `useNetWorthNow` + Apps Script `snapshotNetWorthMonthly` 同步）。租金進來會降低未回收成本到 0，之後直接以現金形式進帳 — 不會雙重計入 |
| 25 | **LLM / 聊天軟體把 JSON 引號弄壞**：ChatGPT 網頁渲染、iOS 智慧標點、Telegram 轉貼會把 `"` 變 `“ ”`；模型也常回單引號 / Python dict、字串內未跳脫的 `"`、尾逗號、`null` 選填欄位；Telegram 4096 字會把 JSON 切成兩則 | 任何「使用者貼 JSON 進來」的入口都走 `features/import/json-repair.ts` / `apps-script/src/ImportJson.gs`（先 `JSON.parse`，失敗才修；截斷時丟最後一筆並等下一段）。提示詞要明寫「只能半形直雙引號、字串內引號改「」、不要尾逗號 / 註解 / null、包 ```json 圍欄」 |
| 26 | **「支出」口徑不一致**：對帳調整、租賃購入、共同帳結算被算成消費，首頁 / 預測 / 年度回顧數字對不起來；統計卡片各自用不同 `limit` 查同一個月，重複讀 Firestore | 一律用 `features/analytics/metrics.ts` 的 `isConsumptionExpense` / `isEarnedIncome`（GAS：`isConsumptionExpense_` / `isEarnedIncome_`）；統計查詢用 `useRangeTransactions` + `usePeriodRange`，見 `features/analytics/README.md` |
| 27 | **手機版整塊被撐出螢幕右邊**：沒寫 `grid-cols-*` 的 `grid` 只有一條 implicit `auto` 欄，欄寬下限 = 內容 min-content；裡面一個不換行的長字串 / 圖表 / `min-w-[...]` 表格就把整欄所有卡片一起撐寬（首頁曾被撐到 1100px+） | `index.css` 已把 `.grid` 預設成 `minmax(0, 1fr)`；新版面仍要注意：flex 子項放長文字要 `min-w-0`，一列按鈕要 `flex-wrap`，寬表格包 `overflow-x-auto`。改完跑 `scripts/mobile-audit.mjs`（360 與 `WIDTH=320`），見 `docs/RUNBOOK.md`「手機版檢查」 |
| 28 | **同一批交易被重複讀取**：各卡片用不同 `{ startDate, endDate, limit }` 查 `transactions`，每組條件都是一次 Firestore 讀取，記一筆帳又全部重讀 | `useTransactions` 內建「共用視窗」（近 12 個月 + 本月只讀一次、前端切片，`features/ledger/tx-window.ts`）。查詢請帶 `startDate`；不要用「不帶日期 + 大 limit」，那會退回獨立查詢 |
| 29 | **MCP 寫入繞過確認 / 被 App 內 AI 拿到**：外部 AI 一句話就能動到帳務，寫入工具若混進唯讀清單，排程觸發的 AI 分析也會拿到 | 唯讀工具放 `HubTools.gs`，寫入工具只放 `HubWriteTools.gs`（只有 MCP、且連線被 owner 開啟寫入才有）。寫入一律 `preview_*`（不寫）→ `commit_*`（只收單次使用的 `previewId`）、重用既有寫入函式、寫 `audit_logs`；不做刪除 / 覆寫既有資料的工具。見 `docs/MCP_TOOLS.md` |

---

## 14. DO ✅

- ✅ 用 Lucide icons (icon name as string) 統一風格
- ✅ 所有 async 包 try/catch + toast
- ✅ 每個 feature 有 README.md 寫清楚職責
- ✅ 每個 commit 用 conventional commits
- ✅ 改動 Firestore Rules 一律附上註解說明為什麼
- ✅ PR 描述寫清楚 What / Why / How tested
- ✅ Zod schema 作為表單驗證 single source of truth
- ✅ 新類別加入 `DEFAULT_CATEGORIES` seed + migration 說明

## 15. DON'T ❌

- ❌ **emoji** — 全系統用 Lucide icons
- ❌ `signInWithPopup` — 一律 `signInWithRedirect`
- ❌ 前端直呼第三方 API (Finnhub / Claude / ExchangeRate) — 走 Apps Script
- ❌ 把 API key 寫進 source，或 commit `.env*`
- ❌ 業務邏輯寫在 component 裡 — 移到 hooks
- ❌ `any` 型別 (除非有註解解釋)
- ❌ `console.log` 留在 production code — build 時 eslint error
- ❌ 用 `Date.now()` 比日期 — 用 date-fns compare 含時區
- ❌ 同一個 commit 塞兩個無關改動
- ❌ 不寫 converter，直接 `snap.data()` 當作 TS type 用
- ❌ Firestore 寫入不 batch 就連打多次

---

## 16. Commit Convention

格式：`<type>(<scope>): <subject>`

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | bug 修復 |
| `refactor` | 重構（不改行為） |
| `chore` | 建置、CI、依賴更新 |
| `docs` | 文件 |
| `style` | 格式化、不影響邏輯 |
| `test` | 測試 |
| `perf` | 效能 |

scope 用 kebab-case：`feat(ledger): add quick entry FAB`、`chore(ci): add firebase deploy`

---

## 17. CI/CD Contract

**PR checks (required before merge)**：
1. `npm run typecheck` (apps/web)
2. `npm run lint` (apps/web)
3. `npm run build` (apps/web)
4. `npm run test --if-present`
5. `firebase deploy --only firestore:rules --dry-run` (rules 語法檢查)

**Auto-deploy on push to `main`**：
- 若 `apps/web/**` 或 `firebase/**` 有變 → deploy Firebase Hosting (production) + Firestore Rules + Indexes
- 若 `apps-script/**` 有變 → `clasp push --force` + `clasp deploy --deploymentId $CLASP_DEPLOYMENT_ID`
  - **此命令會自動產生新 version 並把現有 deployment 指向它**，不需要手動到 editor 點「新版本」
  - `deploymentId` 不變 → Web App URL 不變 → 前端 `VITE_APPS_SCRIPT_URL` 不需更新
- PR 有變則 deploy 到 Firebase Hosting **preview channel**（自動產生 URL 貼回 PR）

**所有 secrets 存 GitHub Actions secrets**（清單見 `docs/CICD_SETUP.md`）。

---

### 17.1 Deploy SOP — Claude Code 自助部署流程

**鐵則：本專案有完整 GitHub Actions 自動部署。Claude 不要叫 owner 手動跑 `clasp push`、`firebase deploy`，也不要叫他到 Apps Script editor 點「新版本」**——這些全部 push 到 main 就會自動跑。

**標準部署流程（feature / bugfix 完成後）**：

1. 跑本機驗證（避免 CI 失敗來回）：
   ```bash
   npm run typecheck && npm run lint && npm run build
   ```
2. Conventional commit 訊息（單一 commit 不要塞無關改動，CLAUDE.md §15）
3. `git push origin main`（簡單變更）或開 PR（大改動 / 想走 preview channel）
4. **必做：監看 Actions 直到綠燈**——CI 紅了要立刻調，不要丟給 owner：
   ```bash
   gh run list --repo <owner>/<repo> --limit 5
   gh run watch <run-id> --repo <owner>/<repo>    # 串流 log
   gh run view <run-id> --log --repo <owner>/<repo>
   ```
5. 哪些檔案觸發哪個 workflow（路徑 filter）：
   - `apps/web/**` / `firebase/**` / `firebase.json` / `.firebaserc` / `package*.json` → `deploy-hosting.yml`
   - `apps-script/**` → `deploy-apps-script.yml`
   - `functions/**` → `deploy-functions.yml`（MCP 閘道）
   - 任何檔案 → `ci.yml`
6. 全綠後**回報 owner**：commit hash、deploy 連結（Hosting URL + Apps Script editor URL）、影響範圍。
7. 仍需 owner 手動的**唯二例外**：
   - 改 Apps Script **Script Properties**（Bot token / API key 等敏感值）
   - 改 Firebase **IAM/Service Account 權限**
   給他清楚步驟即可，其他東西不要要求。

**禁止行為**：
- ❌ 教 owner 手動跑 `clasp push --force`、`firebase deploy --only ...`、`Manage deployments → New version`——這些 CI 全包了
- ❌ 跳過 `gh run watch` 直接告訴 owner「應該完成了」——必須親眼看到綠燈
- ❌ 不確認 secrets 名稱就改 workflow——先 `gh secret list --repo <owner>/<repo>` 對照

**何時 commit / push（標準流程，不需要 owner 再次說「commit」）**：

完成一個 owner 交辦的有意義段落（feature / bugfix / refactor）並通過 §17.1 步驟 1 的本機驗證後，**就直接 commit + `git push origin main`**，讓 GitHub Actions 接手部署。Claude Code 與 Codex 都應該照這個流程走，不要每次都停下來問「要不要 commit」。

執行時要點：
- 一個 commit 對應一個有意義改動（CLAUDE.md §15「同一個 commit 塞兩個無關改動」是禁止行為）；同一個 session 連動的多個 feature 可拆多 commit 一次 push
- Commit message 用 §16 的 conventional commits（`<type>(<scope>): <subject>`）並加上 `Co-Authored-By` trailer
- Push 完照 §17.1 步驟 4 用 `gh run watch` 看到綠燈才算結束；CI 紅了立刻修
- **這條規則的例外（仍需先確認）**：
  1. 改動橫跨多個無關模組或可能影響其他人在用的功能 → 先講要 push 哪些，等 owner 點頭
  2. 動到 `firestore.rules` 或 IAM / Service Account / GitHub workflow / secrets 設定
  3. owner 在這次對話裡明確說「只先改不要 push」/「先給我看 diff」
  4. 處於 freeze / hotfix-only 狀態（會在對話前文或 PROJECT memory 標註）

> 早期版本的這條規則是「只在 owner 明確要求時才 commit」，已於 2026-05-06 改成預設自動 commit + push。

---

## 18. 卡住時的查詢順序

1. 本檔 (CLAUDE.md)
2. `docs/PERSONAL_HUB_SPEC.md`
3. `features/<relevant>/README.md`
4. 搜尋該 feature 現有 code pattern
5. **直接問 owner，不要猜**

---

## 19. 回答 owner 的守則

- 所有解釋用 **繁體中文**，code/commit/技術名詞保持英文
- 不確定就問，不要靜默假設
- 每完成一個有意義段落就 check in 一次
- 發現 SPEC / CLAUDE.md 有矛盾或缺漏 → 標記出來 + 提修正建議
- 有任何「暫時先這樣之後再改」→ 立刻加 `// TODO(owner): ...` 並告知 owner

---

**EOF**
