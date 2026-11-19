# BOOTSTRAP — 首次登入與白名單設定

> owner 第一次登入時，Firestore 是空的 — 白名單不存在，所以會被踢出。這份文件告訴你如何「破蛋」。

---

## 1. 先手動建立白名單

Firebase Console → Firestore → **Start collection**:

- Collection id: `config`
- 下一步：
  - Document id: `allowedEmails`
  - Field: `emails`  · Type: `array`  · 加入一個字串元素：`owner@example.com`（你的 email）
- Save

---

## 2. 登入

重新整理 `localhost:5173` → 點「使用 Google 登入」→ 選擇你的 Google 帳號。

正常的話會進入 `/` 首頁，Dashboard 卡片會顯示但都是空資料。

---

## 3. 確認 `users/{uid}` 已建立、role = 'owner'

Firebase Console → Firestore → `users/{uid}` 應該存在。預設 `role: 'owner'`。

若沒建：
- 回到 app 重新整理，`ensureUserDoc` 會自動建
- 若 Rules 擋住，檢查 rules 是否已部署 (see `docs/SETUP.md` step 1.8)

---

## 4. Seed 初始股票 / 類別

### Option A：Apps Script (推薦，一次就位)

完成 `docs/APPS_SCRIPT_SETUP.md` 後，到 Apps Script 編輯器 → 執行 `seedAll()` 函式一次。

### Option B：手動建立

若還沒部署 Apps Script，可在 Firestore Console 手動建幾筆 `categories/*` 文件 (ref `apps/web/src/lib/seed-data.ts` 的 `DEFAULT_CATEGORIES`)。

---

## 5. 驗收

- [ ] 首頁 Dashboard 顯示
- [ ] `/ledger` 可以新增一筆測試交易
- [ ] `/investments` 在 Apps Script 跑一次 `updateStockPrices` 後有資料
- [ ] 手機打開 `https://<project>.web.app` 可登入
- [ ] 切換手機系統日夜模式，app 即時跟著變

完成 → Sprint 1 OK，可以開始用。
