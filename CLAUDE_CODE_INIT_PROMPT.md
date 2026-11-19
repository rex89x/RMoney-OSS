# Claude Code Prompt：Personal Hub 專案初始化

> 請將本檔案完整內容貼給 Claude Code，作為專案初始化的指令。
> 完整規格書請同時附上 `docs/PERSONAL_HUB_SPEC.md`。

---

## Role & Mission

你是一位資深全端工程師，我是你的 tech lead (owner)。請依以下檔案協助我 **從零建立** 一個個人化財務與出遊規劃系統 **personal-hub**：

1. **`CLAUDE.md`** — **專案 Skill，每次 session 必讀第一份文件**，所有命名、架構、防呆規則以此為準
2. **`docs/PERSONAL_HUB_SPEC.md`** — 完整系統規格書

**優先順序**：`CLAUDE.md` > `SPEC.md` > 你自己的判斷。衝突時以 `CLAUDE.md` 為準。

**本次任務範圍 = Sprint 1：基礎架構 + 完整 CI/CD**。請**不要一口氣把所有功能做完**，先把地基打穩、GitHub 建好、CI/CD 通到 push main 自動部署為止，我會驗收後再開下一個 Sprint。

---

## Non-negotiables（必須遵守）

1. **技術棧固定**：
   - Frontend：React 18 + Vite + TypeScript + Tailwind CSS + shadcn/ui + Zustand + TanStack Query + Recharts + Lucide React
   - Backend (排程/外部 API 代理)：Google Apps Script (原生 JS, 採 `clasp` 管理)
   - DB / Auth / Hosting：Firebase (Firestore Native + Firebase Auth + Firebase Hosting)
   - 部署：Firebase Hosting + Apps Script Web App

2. **UX 強制規範**（這四條特別重要，一旦違反請 owner 直接打回票）：
   - **主題跟隨系統**：使用 Tailwind `darkMode: 'class'` + 讀取 `prefers-color-scheme`；監聽 `matchMedia change` 事件即時切換；Settings 提供 Auto/Light/Dark 手動覆蓋；選擇存 `localStorage` + Firestore `users/{uid}.preferences.theme` 跨裝置同步；`<meta name="theme-color">` 也要跟著切
   - **Google 登入必須用 `signInWithRedirect`**（**禁用 popup**）：行動裝置 popup 易被攔截；在 app 啟動時 (root `useEffect`) 呼叫 `getRedirectResult(auth)`；同時掛 `onAuthStateChanged`；redirect 期間顯示全屏 spinner 避免閃爍；記得提醒我去 Firebase Console → Authorized domains 加入 hosting 域名
   - **全系統禁止 emoji**：類別、tab、按鈕、通知文案一律用 **Lucide React icons**；Firestore 文件 (e.g. `categories`) 的 `icon` 欄位儲存 Lucide icon name string (e.g. `"Utensils"`)，前端用 mapping resolve
   - **Sidebar 必須直覺**：Desktop `≥1024px` 固定 240px 寬，**不做 icon-only 收合**，icon + 中文文字永遠都在；分組 (MAIN / MARKETS / SYSTEM)；active 狀態有左側紫色 indicator bar + 淺紫底；Mobile 用 5 格底部 TabBar，icon + 文字標籤常駐顯示；匯率併入投資 tab 避免超過 5 格

3. **程式風格**：
   - 全 TypeScript，不允許 `any` 除非有註解說明
   - 元件用 function component + hooks，**不用 class component**
   - 檔名用 kebab-case、元件 export 用 PascalCase
   - 所有外部 API 呼叫統一包成 hooks (e.g. `useStockPrice`)
   - 所有 Firestore 存取統一包進 `lib/firebase.ts` + `features/*/api.ts`
   - 錯誤處理用 `try/catch` + `toast.error` 提示
   - 所有日期時區用 **Asia/Taipei**，統一用 `date-fns-tz`

4. **安全**：
   - **絕對不要** 把任何 API key 寫進前端 source code，全數放 `.env.local`
   - **絕對不要** commit `.env*` 檔案，必須有 `.env.local.example`
   - Firestore Rules 從一開始就 deny-by-default，白名單式放行
   - Apps Script 敏感參數一律用 `PropertiesService.getScriptProperties()`

5. **文檔**：
   - 每個 feature 資料夾有 `README.md` 說明職責
   - 根目錄 `README.md` + `SETUP.md` + `RUNBOOK.md`
   - Firestore Rules 有 inline comment 說明每條 rule 的用意

6. **Git**：
   - 從第一個 commit 開始用 conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`)
   - 每完成一個小段落就 commit，不要一個 commit 塞所有東西

---

## Sprint 1 交付清單

請依序完成以下項目，**每完成一項就停下來告訴我，不要默默往下做**。

### 階段 1：GitHub Repo + 專案結構 + CLAUDE.md

1. 請我先到 GitHub 建好空 private repo `personal-hub`，然後告訴你 repo URL
2. 本機建立 monorepo 結構：

```
personal-hub/
├── apps/web/                  # React SPA
├── apps-script/               # Google Apps Script (clasp-managed)
├── firebase/                  # Firestore rules + indexes + firebase.json
├── .github/workflows/         # CI/CD
├── docs/                      # SPEC.md, SETUP.md, RUNBOOK.md, CICD_SETUP.md, BOOTSTRAP.md
├── .gitignore
├── .editorconfig
├── CLAUDE.md                  # ← 把我提供的這份放進來
├── README.md
└── package.json               # npm workspaces root
```

3. `CLAUDE.md`：使用我提供的內容（完整版）
4. `docs/PERSONAL_HUB_SPEC.md`：使用我提供的 SPEC 內容
5. `.gitignore` 覆蓋 `.env*`, `node_modules/`, `dist/`, `.clasprc.json`, `apps-script/.clasp.json`, `firebase-debug.log`, `.firebase/`, `.DS_Store`
6. `git init` → 第一個 commit：`chore: initial project skeleton`
7. `git remote add origin <repo-url>` → `git push -u origin main`

完成後向我確認 tree 結構與 GitHub 已連上。

### 階段 2：Firebase & 外部服務 Onboarding 文件 (`docs/SETUP.md`)

產出讓我照著做的清楚步驟：

1. Firebase Console 建立專案（推薦 project id: `personal-hub-prod`，region: `asia-east1`）
2. 啟用 Authentication (Google Provider)
3. 啟用 Firestore (Native mode, asia-east1)
4. 啟用 Hosting
5. Authorized domains 加入 `localhost`, `<project>.web.app`, `<project>.firebaseapp.com`
6. 取得 Firebase Config → 對應到 `.env.local.example` 每個欄位
7. Google Cloud Console 建立 Maps API key，開啟：Maps JavaScript API、Places API (New)、Directions API、Geocoding API；限制 HTTP Referer
8. 建立 Telegram bot (`@BotFather`) → 取 `BOT_TOKEN`；私訊 bot 後用 `getUpdates` 取 `chat_id`
9. 申請 Finnhub 免費帳號取 API key
10. 申請 Google AI Studio 取 Gemini API key
11. 建立 Service Account：Firebase Console → Project Settings → Service Accounts → Generate new private key（整份 JSON 用於 GitHub secret）
12. 本機執行 `firebase login:ci` 取得 `FIREBASE_TOKEN`（用於 Rules deploy）

**不要自己登入 Firebase Console 操作**，只產文件給我。

### 階段 3：React + Vite + TS 初始化

在 `apps/web`：

- `npm create vite@latest` 建立 `react-ts` 專案
- 加入 Tailwind CSS (設定 `darkMode: 'class'`)、shadcn/ui (`npx shadcn@latest init`)
- 設定絕對路徑 `@/`
- 建立 **ThemeProvider**：
  - 讀取 `localStorage.theme` (`auto` / `light` / `dark`)，預設 `auto`
  - `auto` 模式：讀 `window.matchMedia('(prefers-color-scheme: dark)').matches` 決定；並掛 `change` listener 即時同步手機系統切換
  - 切換時在 `<html>` 加/移除 `class="dark"`
  - 同步更新 `<meta name="theme-color">` (light: `#ffffff` / dark: `#0a0a0a`)
  - 用 Context 暴露 `{ mode, resolved, setMode }` 給全 app
  - **`index.html` 必須插入 CLAUDE.md §8 的 anti-FOUC inline script**
- 建立基礎 layout（依 `CLAUDE.md` §3 folder 結構 + SPEC §8.2 細節）：
  - `AppLayout`：
    - `≥1024px`：左側固定 Sidebar (240px) + 主內容
    - `<1024px`：主內容 + 底部 TabBar
  - **Sidebar 元件**（SPEC §8.2.1 所有規格）
  - **TabBar 元件**（SPEC §8.2.2 所有規格）
  - **FAB 元件**（SPEC §8.2.3 所有規格）
- React Router v6 + SPEC §8.1 routes
- Inter + Noto Sans TC 字型
- `src/lib/firebase.ts` 初始化 Firebase SDK（讀 env）
- 加入 sonner toast
- 建 `.env.local.example` + 讓 `.env.local` 空字串也能 `npm run build` 不炸（CI 測試用）

**ESLint + Prettier 設定**：
- 採 typescript-eslint 推薦設定
- 禁 `any` 規則打開（除非有 `// eslint-disable` + reason）
- production build 禁 `console.log` (allow `console.warn/error`)

**package.json scripts**：`dev`、`build`、`preview`、`typecheck` (`tsc --noEmit`)、`lint`、`lint:fix`、`format`、`test`

### 階段 4：Firebase Auth + 白名單

- **登入頁 `/login`**：
  - 正中置一顆「使用 Google 登入」按鈕
  - 點擊呼叫 `signInWithRedirect(auth, new GoogleAuthProvider())`
  - **禁止使用 `signInWithPopup`**
- **Root (`App.tsx` 或 `main.tsx`) 的 auth 初始化**：
  - `useEffect` 第一個執行 `getRedirectResult(auth).catch(handleError)` 接住 redirect 回來的 user
  - 同時掛 `onAuthStateChanged` 監聽
  - auth state 用 3 態：`unauthed | checking | authed`（見 CLAUDE.md §7）
  - redirect 處理期間 UI 顯示全屏 spinner (`<AuthLoading />`)，**不要**閃爍到 `/login` 又跳 `/`
- **白名單檢查**（登入成功後）：
  - 讀 `config/allowedEmails` 文件，檢查 `user.email` 是否在 `emails` 陣列中
  - 不在名單：`signOut()` → toast `"此帳號無使用權限"` → 停留在 `/login`
  - 在名單：檢查 `users/{uid}` 是否存在，不存在就建立 `{ email, displayName, photoURL, role: 'owner', preferences: { theme: 'auto' }, createdAt: serverTimestamp() }`
- **Protected Route wrapper**：未登入/未通過白名單 → redirect `/login`
- **Header / Sidebar 底部**：顯示 avatar + displayName + Logout icon button
- **登出流程**：`signOut(auth)` → 清 IndexedDB (`clearIndexedDbPersistence`) → redirect `/login`
- **首次登入 bootstrap**：產出 `docs/BOOTSTRAP.md` 教我怎麼用 Firebase Console 手動在 Firestore 建立：
  1. `config/allowedEmails` → `{ emails: ["<我的 email>"] }`
  2. 登入後 Console 看 `users/{uid}` → 確認 `role: "owner"`

**完成驗收**：手機瀏覽器開 dev server，點登入 → 跳轉 Google → 授權後回到 `/` 首頁、無 popup 被攔截問題。不在白名單的帳號登入會被擋下並登出。

### 階段 5：Firestore Rules v1

在 `firebase/firestore.rules` 寫出 deny-by-default 的 rules（參考 CLAUDE.md §13 防坑 #9 避免自鎖）：

- 所有路徑預設禁止
- `config/allowedEmails`：auth user 可讀（供白名單檢查用），無人可寫
- `users/{uid}`：auth user 可讀寫自己的文件
- 其他所有 collection：auth user 且 `users/{uid}.role == 'owner'` 才能讀寫
- 每條 rule 上方有中文註解解釋用意

附上 `firebase/firestore.indexes.json`（可先空陣列）和 `firebase/firebase.json`。

### 階段 6：Apps Script Skeleton

在 `apps-script/`：

- `.clasp.json.example`（scriptId 留空，告知我怎麼填）
- `appsscript.json` (runtime V8)
- `src/Main.gs`：
  - `doGet(e)` / `doPost(e)` router，依 `e.parameter.action` 分派
  - **身分驗證 middleware**：從 header 取 `Authorization: Bearer <id-token>` → 打 Google `tokeninfo` 驗證 → 比對 whitelist，失敗回 401
  - 支援 `action=ping` 回 `{ok: true, ts: ...}` 做健康檢查
- `src/Telegram.gs`：`sendTelegram(msg)` 函式
- `src/Firestore.gs`：空殼（下 Sprint 再實作）
- `src/Triggers.gs`：註解說明未來會建的 triggers
- `docs/APPS_SCRIPT_SETUP.md`：裝 clasp、push、部署 Web App、設 Script Properties 流程

### 階段 7：Home Dashboard Placeholder

`/` 首頁先畫出 SPEC §5.8 Dashboard 卡片骨架（用假資料 + skeleton loaders），確認整個 UI 框架 + Sidebar + TabBar + FAB 都正常。

### 階段 8：CI/CD Pipelines (本 Sprint 重點，必做)

**目標：push 到 main 後 3 分鐘內自動 deploy 完成，無人工介入**。

依 SPEC §11.4 建立 3 個 workflow：

1. **`.github/workflows/ci.yml`** — PR + push main 跑
   - jobs: `web` (typecheck, lint, test, build), `rules` (Firestore Rules dry-run)
   - 先不做 emulator 測試（下 Sprint 補）

2. **`.github/workflows/deploy-hosting.yml`** — push main 自動部署前端 + Rules；PR 自動部署 preview channel
   - 用 `FirebaseExtended/action-hosting-deploy@v0`
   - main push → channelId: `live`
   - PR → auto preview channel，URL 回貼 PR comment
   - Rules deploy 用 `FIREBASE_TOKEN` 方式較簡單

3. **`.github/workflows/deploy-apps-script.yml`** — push main 且 `apps-script/**` 有變才跑
   - `npm install -g @google/clasp`
   - 從 secrets 還原 `~/.clasprc.json` 和 `apps-script/.clasp.json`
   - `clasp push --force` + `clasp deploy --deploymentId <id>`

**同時產出 `docs/CICD_SETUP.md`**：
- 列出所有需要的 GitHub Secrets（見 SPEC §11.5）及取得方式
- 每個 secret 的**具體指令/連結**（讓我不用想）
- 常見失敗排查（Token 過期、SA 權限不足、build env 缺漏）

**驗收方式（end-to-end test）**：
1. 在本機改個字 (e.g. Dashboard 標題)
2. 開 PR → CI 應自動跑通
3. 應看到 Firebase Hosting preview 連結自動留言到 PR
4. merge 到 main → `deploy-hosting` workflow 自動跑
5. 2-3 分鐘內 Firebase Hosting 更新
6. 點 `.web.app` URL 看到改動

**這整套驗證跑通才算 Sprint 1 完成。**

### 階段 9：README + 驗收清單

根目錄 `README.md` 包含：
- 專案簡介
- 快速啟動步驟（clone → install → env → run）
- 架構簡介（含 `CLAUDE.md`、`docs/PERSONAL_HUB_SPEC.md` 連結）
- CI/CD badge (可選)
- 開發 workflow

產出 **Sprint 1 驗收清單** (`docs/SPRINT1_ACCEPTANCE.md`)，逐項列出：
- [ ] GitHub repo 建立並 push 第一版
- [ ] Firebase 專案設定完成（依 SETUP.md 步驟）
- [ ] 本機 `npm run dev` 可開 app
- [ ] 手機瀏覽器可登入 Google 並進入首頁（驗證 redirect 流程）
- [ ] 切換手機系統日夜模式，app 即時跟著變
- [ ] Sidebar 顯示分組、TabBar 5 格正常切換
- [ ] Firestore Rules 已部署，非白名單帳號無法讀寫
- [ ] Apps Script Web App 部署，`?action=ping` 回 200
- [ ] 三個 GitHub Actions workflow 都是綠燈
- [ ] 實測 push main 觸發自動 deploy 成功
- [ ] 實測 PR 觸發 preview channel 成功

---

## 回答與互動準則

1. **不要一次吐很多程式碼**，每個階段做完跟我 check in
2. 有歧義時 **問我**，不要自己假設
3. 寫程式前 **先說打算怎麼做、為什麼**，我認可後再動手
4. 有依賴要安裝時 **列清楚 package name + 版本**（用最新 stable）
5. 若發現 SPEC 有缺漏或矛盾，**標記出來** 並提修正建議
6. 所有技術解釋用 **繁體中文**，但 code / commit message / 英文專有名詞保持英文
7. 我的開發機是 **Mac (Apple Silicon)**，指令請以此為準

---

## 禁止事項

- ❌ 不准用 `deprecated` / 已停更的套件 (如 `create-react-app`)
- ❌ 不准把 API key / secret hardcode
- ❌ 不准直接在前端呼叫股價/匯率 API（會暴露 key），一律走 Apps Script
- ❌ 不准跳過 TypeScript 型別，全部要補齊
- ❌ 不准一次做完所有 Sprint，只做 Sprint 1

---

## 起手式

請先讀完 `CLAUDE.md` 與 `docs/PERSONAL_HUB_SPEC.md` 全部內容，然後：

1. 跟我確認你理解了需求 (條列 5 條 key points)
2. **特別確認你理解 CLAUDE.md §13 的 20 條 data traps**，並在整個 Sprint 1 過程保持警覺
3. 列出你對 CLAUDE.md / SPEC 的任何疑問 (若無可跳過)
4. 提出 Sprint 1 的 **實作順序與依賴關係**（階段 1 → 9）
5. 等我回 "GO" 後再開始階段 1

準備好了嗎？

---

**EOF**
