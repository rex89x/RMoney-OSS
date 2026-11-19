# Sprint 1 Acceptance Checklist

> 逐項跑過確認本專案可 push-to-deploy。

## 設置
- [ ] GitHub repo 建好，本機 push 成功
- [ ] Firebase project 建好，Auth + Firestore + Hosting 啟用
- [ ] Firebase Authorized domains 加入 `localhost` / `.web.app` / `.firebaseapp.com`
- [ ] `apps/web/.env.local` 填齊 (依 `SETUP.md`)
- [ ] Firestore rules 已部署 (`firebase deploy --only firestore:rules`)
- [ ] `config/allowedEmails` 文件已手動建立，email 在 array 內

## 本機
- [ ] `npm install` 成功
- [ ] `npm run typecheck` 綠
- [ ] `npm run lint` 綠
- [ ] `npm run build` 成功
- [ ] `npm run dev` 可開
- [ ] 瀏覽器 `/login` 點登入 → Google 授權 → 回到 `/` 首頁
- [ ] 手機瀏覽器 (iOS Safari / Android Chrome) 同樣可登入
- [ ] 切換手機系統日夜模式 → app 即時跟著變

## UI 驗收
- [ ] Desktop ≥1024px：左側 240px 固定 Sidebar，分組顯示 MAIN/MARKETS/SYSTEM
- [ ] Sidebar active 項目有紫色左側 indicator + 淺紫底
- [ ] Mobile <1024px：底部 5 格 TabBar，active 項目文字 + icon 顏色加深
- [ ] 右下角 FAB 常駐，點擊彈出快速記帳 Dialog
- [ ] 全系統無 emoji

## Firestore Rules
- [ ] 用非白名單 Google 帳號登入 → app 自動 signOut + toast 提示
- [ ] 以 `owner` 帳號可讀寫所有 collection

## Apps Script
- [ ] clasp push 成功
- [ ] `seedAll()` 執行後 `stocks/*` 和 `categories/*` 各有 seed 資料
- [ ] `setupTriggers()` 執行後 4 個 trigger 存在
  - 註：此為 Sprint 1 當時的驗收條件；trigger 已擴充為 12 個，清單見 `docs/PERSONAL_HUB_SPEC.md` §7.2（以 `apps-script/src/Triggers.gs` `setupTriggers()` 為準）。
- [ ] `?action=ping` 回 200
- [ ] `updateFxRates` 跑完 `fx_rates/USD_TWD` 有資料
- [ ] `updateStockPrices` 盤中跑完有最新價
- [ ] `sendTelegramTest` 手機收到訊息

## CI/CD
- [ ] PR 觸發 `CI` workflow → 綠
- [ ] PR 觸發 `Deploy Hosting & Rules` → 留 preview URL 在 PR 留言
- [ ] merge main 觸發 live deploy → 2-3 分鐘內 `https://<project>.web.app` 更新
- [ ] 改 `apps-script/**` push main → `Deploy Apps Script` 跑完 → Apps Script 編輯器看到新版

---

全部打勾 → Sprint 1 完成。
