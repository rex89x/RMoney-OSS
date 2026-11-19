# SETUP — Personal Hub 首次建置

> 這是 owner 第一次上線 / 換機時要做的步驟。依順序完成，每步都會產生 `.env.local` 和 GitHub Secrets 需要的值。

---

## 0. 本機需求

- Node 20+ (建議 `nvm install 20 && nvm use 20`)
- npm 10+ (隨 Node 附)
- `firebase-tools` 全域：`npm install -g firebase-tools`
- `@google/clasp` 全域：`npm install -g @google/clasp`
- Git

---

## 1. Firebase 專案

1. 到 https://console.firebase.google.com 建立新 project — 建議 id `personal-hub-prod`
2. Google Analytics **可停用**（單人不需要）
3. 設定 → 新增 Web App：
   - 名稱：`personal-hub-web`
   - **勾 Firebase Hosting**
   - 記下 Firebase config 的 6 個欄位 → 填入 `apps/web/.env.local`:
     ```
     VITE_FIREBASE_API_KEY=
     VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com
     VITE_FIREBASE_PROJECT_ID=<project>
     VITE_FIREBASE_STORAGE_BUCKET=<project>.appspot.com
     VITE_FIREBASE_MESSAGING_SENDER_ID=
     VITE_FIREBASE_APP_ID=
     ```
4. 左側選單 **Authentication** → 開始使用 → Providers → **Google**：
   - Enable
   - Support email 填你自己
   - Save
5. **Settings → Authorized domains** 加入：
   - `localhost`
   - `<project>.web.app`
   - `<project>.firebaseapp.com`
   - （未來如果接自訂域名也要加）
6. 左側 **Firestore Database** → 建立資料庫 → **Native mode** → Location `asia-east1` → 開始以 **production mode** (rules 後續部署會覆寫)
7. 左側 **Hosting** → 開始使用（照精靈走到尾即可）
8. 本機 `firebase login` 登入後：
   ```bash
   cd firebase
   # 已有 firebase.json / firestore.rules / firestore.indexes.json
   firebase use --add   # 選 personal-hub-prod
   firebase deploy --only firestore:rules
   ```

---

## 2. Google Cloud / Maps

1. 到 https://console.cloud.google.com 選擇 Firebase 建立的專案 (同一個)
2. APIs & Services → Library → **啟用以下**：
   - Maps JavaScript API
   - Places API (New)
   - Directions API
   - Geocoding API
3. APIs & Services → Credentials → Create credentials → **API key**
   - 名稱：`personal-hub-maps-browser`
   - Application restrictions: **HTTP referrers**:
     - `https://<project>.web.app/*`
     - `https://<project>.firebaseapp.com/*`
     - `http://localhost:5173/*`
   - API restrictions: 勾剛剛啟用的 4 個
4. 填入 `apps/web/.env.local`: `VITE_GOOGLE_MAPS_API_KEY=<key>`
5. 再建一支 **Places / Geocoding 專用、server-side key** (給 Apps Script 用)：
   - Application restrictions: **None**（Apps Script 的 egress IP 不固定）
   - API restrictions: 只勾 Places + Geocoding
   - 這個 key 稍後填到 Apps Script Script Properties

---

## 3. Telegram Bot

1. 與 [@BotFather](https://t.me/BotFather) 對話 → `/newbot` → 命名 → 取得 `BOT_TOKEN`
2. 傳一則訊息給你的 bot (隨意)
3. 瀏覽器打開 `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` → 找 `chat.id` (通常是正數；群組則為負數)
4. 記下 `BOT_TOKEN` 和 `CHAT_ID`

---

## 4. Finnhub

1. https://finnhub.io → Sign Up (Free tier)
2. Dashboard → 取得 API Key
3. 記下

---

## 5. Claude API (Anthropic Console)

1. https://platform.claude.com → 登入有 API 額度的組織 → Settings → API Keys → Create Key
2. 將 key 放到 Apps Script Script Property `ANTHROPIC_API_KEY`，不要放前端或 repository
3. 到 app「設定 → AI 額度」確認每期額度（預設 US$100）與重置日（預設每月 23 號）
4. 完整模型 / 成本控制見 [`INTEGRATIONS_SETUP.md`](./INTEGRATIONS_SETUP.md)

---

## 6. Service Account for CI/CD

Firebase Console → Project Settings → Service accounts → **Generate new private key**

下載 JSON 檔，保管好。待會要以「整份 JSON 字串」貼到 GitHub Secrets 的 `FIREBASE_SERVICE_ACCOUNT`。

建議縮小權限：到 GCP Console → IAM → 找到 `firebase-adminsdk-*` 這個 SA → 移除 `Editor` → 只給：
- Firebase Hosting Admin
- Firebase Rules Admin
- Cloud Datastore User (供寫入 Firestore)

---

## 7. firebase login:ci

本機：
```bash
firebase login:ci
```

會跳開瀏覽器，授權後回 terminal，印出一串 token → 複製，待會貼到 GitHub Secrets 的 `FIREBASE_TOKEN`。

---

## 8. 本機第一次跑起來

```bash
# root
npm install

# web
cd apps/web
npm run dev
```

瀏覽器開 http://localhost:5173 → 應該能看到登入頁 → 登入後會卡在白名單檢查（因為你還沒建 `config/allowedEmails`）。

請繼續看 `docs/BOOTSTRAP.md`。
