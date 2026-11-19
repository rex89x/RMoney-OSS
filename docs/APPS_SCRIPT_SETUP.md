# APPS_SCRIPT_SETUP

> Personal Hub 的後端邏輯（定時抓股價、匯率、LLM 行程、Telegram）都在 Google Apps Script。
> 目標是把 `apps-script/src/` 同步到一份 clasp-managed 的 Apps Script 專案。

---

## 1. 建立 Apps Script 專案

```bash
cd apps-script

# 第一次
clasp login                # 會開瀏覽器授權
clasp create --type webapp --title "personal-hub" --rootDir ./src
```

會產生 `apps-script/.clasp.json` — 裡面有 `scriptId`。**不要 commit 這檔**（`.gitignore` 已擋）。
同時 `~/.clasprc.json` 會記著你的 OAuth token。

複製 `.clasp.json.example` 當參考，填入 scriptId 即可：
```json
{ "scriptId": "xxxxxxxxxx", "rootDir": "src" }
```

---

## 2. Push 程式碼

```bash
clasp push --force
```

現在到 Apps Script 編輯器 (`clasp open`) 應該可以看到：
- `Main.gs`, `Firestore.gs`, `Telegram.gs`, `Stocks.gs`, `Fx.gs`, `Alerts.gs`, `Itinerary.gs`, `Recurring.gs`, `Summary.gs`, `Triggers.gs`, `Seed.gs`

---

## 3. 設定 Script Properties

編輯器 → Project Settings (⚙) → Script properties → **Add script property**：

| Key | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | 你的 Firebase project id (e.g. `personal-hub-prod`) |
| `FIREBASE_API_KEY` | 前端用的 Web API key（同 `VITE_FIREBASE_API_KEY`）— 用來驗證 Firebase ID Token |
| `TG_BOT_TOKEN` | 從 BotFather 取得 |
| `TG_CHAT_ID` | 你的 chat id (字串) |
| `FINNHUB_API_KEY` | Finnhub key |
| `ANTHROPIC_API_KEY` | Claude API key（Anthropic Console → API Keys）；所有 AI 功能共用 |
| `DUFFEL_ACCESS_TOKEN` | （機票掃描）Duffel token；設定後該航線不使用 Claude API |
| `FLIGHT_API_PROVIDER` | （選填）未保存 provider 的舊機票雷達預設來源 |
| `FLIGHT_MONTHLY_REQUEST_LIMIT` | （選填）機票 API 每月 request 硬上限，預設 `300` |
| `FLIGHT_ALLOW_GEMINI_FALLBACK` | （選填，名稱沿用）僅供未保存 provider 的舊機票雷達改用 Claude API 搜尋；新資料直接在 UI 選擇 |
| `FLIGHT_INGEST_*` | **不要手動填**；由機票雷達「Claude 排程」產生／撤銷 token 時自動寫入（只存 SHA-256） |
| `GOOGLE_MAPS_API_KEY` | 給 Places/Geocoding 的 server-side key |
| `EINVOICE_APP_ID` | （選填）財政部電子發票整合服務平台 App ID，設了才會每日自動同步載具發票 |
| `EINVOICE_CARD_NO` | （選填）手機條碼，例 `/ABC+123` |
| `EINVOICE_CARD_ENCRYPT` | （選填）手機條碼驗證碼 |
| `EINVOICE_PAYMENT_METHOD` | （選填）匯入發票的支付方式名稱，預設「信用卡」 |
| `APP_URL` | （選填）推播裡的 app 連結（例 `https://<your-project-id>.web.app`）；沒設就不帶網域 |

機票、電子發票與 Claude API 的申請及成本控制細節見 [`INTEGRATIONS_SETUP.md`](./INTEGRATIONS_SETUP.md)。

> 注意：`FIREBASE_API_KEY` 是前端公開的 Web API key（非密鑰），Apps Script 用它呼叫
> `identitytoolkit.googleapis.com/v1/accounts:lookup` 驗證前端送來的 Firebase ID Token。
> 此 endpoint 是驗 Firebase JWT 的唯一正確方式 — `oauth2/tokeninfo` 只能驗 Google OIDC token。

---

## 4. 部署為 Web App

Deploy → **New deployment**：
- Type: Web app
- Description: `v1`
- Execute as: **Me**
- Who has access: **Only myself** (或 Anyone with Google account — 若要讓前端跨帳號驗證 token)

取得 Web App URL → 貼到 `apps/web/.env.local`:
```
VITE_APPS_SCRIPT_URL=https://script.google.com/macros/s/xxxxx/exec
```

測試：在瀏覽器打 `<URL>?action=ping`，應回 `{"ok":true,"ts":...}`。

---

## 5. Seed 初始資料

到編輯器 → 選 `Seed.gs` → `seedAll` → 點執行。
會建立所有預設 `stocks/*` 和 `categories/*` 文件。

---

## 6. 啟用定時觸發器

執行 `Triggers.gs` → `setupTriggers()` 一次。

查看 Triggers 頁面 → 應該看到：
- `tick_15min` 每 15 分
- `tick_hourly` 每小時
- `tick_daily_0100` 每日 01:00
- `tick_daily_0800` 每日 08:00

---

## 7. 首次跑看看

到編輯器執行：
- `updateFxRates` → 應在 `fx_rates/*` 看到 4 個 pair
- `updateStockPrices` → 應在 `stocks/{symbol}` 看到盤中價
- `sendTelegramTest` → 手機 Telegram 應收到訊息

---

## 8. CI/CD

完成以上後，把下列值記錄起來：

- `~/.clasprc.json` 全部內容 → GitHub Secrets 的 `CLASPRC_JSON`
- `apps-script/.clasp.json` 全部內容 → GitHub Secrets 的 `CLASP_JSON`
- Apps Script → Deploy 的 `deploymentId` → GitHub Secrets 的 `CLASP_DEPLOYMENT_ID`

見 `docs/CICD_SETUP.md`。
