# Personal Hub

個人財務 + 出遊規劃整合系統 (PWA)。

單一使用者 (owner)，整合：記帳 / 投資追蹤 / 匯率警報 / 出遊收支 / 行程規劃 / 總覽儀表板。

---

## 技術棧

- **Frontend**：React 18 + Vite + TypeScript + Tailwind CSS + shadcn/ui + Zustand + TanStack Query + Recharts + Lucide React + React Router v6 + React Hook Form + Zod
- **Backend (排程 / 外部 API)**：Google Apps Script (clasp)
- **Auth / DB / Hosting**：Firebase (Auth + Firestore Native + Hosting)
- **LLM**：Claude API（預設 Claude Opus 5.5，via Apps Script；設定 → AI 額度 可改模型）
- **Maps**：Google Maps JS API + Places API
- **Notification**：Telegram Bot API
- **CI/CD**：GitHub Actions

---

## 專案結構

```
personal-hub/
├── apps/web/           React SPA (PWA)
├── apps-script/        Google Apps Script (clasp-managed)
├── firebase/           Firestore / Storage rules、indexes（firebase.json 在 repo 根目錄）
├── .github/workflows/  CI / deploy-hosting / deploy-apps-script
├── docs/               SPEC / SETUP / RUNBOOK / CICD / BOOTSTRAP / APPS_SCRIPT_SETUP
└── CLAUDE.md           Primary context for Claude Code sessions
```

---

## 快速啟動

```bash
# 1. Install deps
npm install

# 2. Env setup
cp apps/web/.env.local.example apps/web/.env.local
# edit apps/web/.env.local with your Firebase config

# 3. Dev server
npm run dev

# 4. Typecheck / lint / build
npm run typecheck
npm run lint
npm run build
```

詳細設置流程：見 [`docs/SETUP.md`](./docs/SETUP.md)。

---

## CI/CD

- **PR → main**：`ci.yml` 跑 typecheck / lint / build / rules dry-run；PR 自動部署到 Firebase Hosting preview channel
- **push main**：`deploy-hosting.yml` 部署前端到 live + Firestore Rules；若 `apps-script/**` 有變，`deploy-apps-script.yml` 走 clasp push + deploy

見 [`docs/CICD_SETUP.md`](./docs/CICD_SETUP.md)。

---

## 文件入口

- [`CLAUDE.md`](./CLAUDE.md) — 專案 skill (命名、防坑、規範)
- [`docs/PERSONAL_HUB_SPEC.md`](./docs/PERSONAL_HUB_SPEC.md) — 完整規格書
- [`docs/SETUP.md`](./docs/SETUP.md) — Firebase / GCP / Telegram / Finnhub / Claude API 申請流程
- [`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md) — RMoney 操作說明（使用者手冊，目前含機票雷達與 Claude 排程設定）
- [`docs/INTEGRATIONS_SETUP.md`](./docs/INTEGRATIONS_SETUP.md) — 機票、財政部電子發票與 Claude API credentials / 成本控制
- [`docs/BOOTSTRAP.md`](./docs/BOOTSTRAP.md) — 首次登入白名單設定
- [`docs/APPS_SCRIPT_SETUP.md`](./docs/APPS_SCRIPT_SETUP.md) — Apps Script 部署
- [`docs/CICD_SETUP.md`](./docs/CICD_SETUP.md) — GitHub Actions secrets 清單
- [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) — 常見錯誤處置
