# 個人財務與出遊規劃系統 SPEC (Personal Hub)

> **專案代號**：`personal-hub`
> **使用者**：單人使用 (owner)
> **版本**：v1.0
> **最後更新**：2026-04-23

---

## 1. 專案概述

本系統是一套**單人使用的個人管理中樞**，整合以下六大模組：

| 模組 | 目的 |
|---|---|
| **Investment** 投資追蹤 | 台股/美股 watchlist、即時報價、歷史紀錄、分析 |
| **FX Alert** 匯率提醒 | 即時匯率查詢、到價 Telegram 通知 |
| **Bookkeeping** 記帳 | 快速記帳、分類分析、趨勢儀表板 |
| **Travel Expense** 出遊收支 | 與記帳連動、多幣別即時換算、分次旅遊統計 |
| **Itinerary** 行程規劃 | LLM 自動生成 + 手動調整、Google Maps 整合 |
| **Dashboard** 總覽儀表板 | 跨模組的每日 / 每月總覽 |

---

## 2. 需求釐清與補充

針對原始需求，做出以下**解讀與補充**（owner 可在最後決策項目調整）：

### 2.1 原始需求解讀
| 原始描述 | 解讀 |
|---|---|
| 「之後能自己加入標的並進行分析」 | 提供 Watchlist + 個別標的詳細頁 (K 線、成交量、指標) |
| 「儲存紀錄提供分析，可刪除區間」 | 歷史價格快照按時間存 Firestore，UI 可依日期區間刪除 |
| 「匯率只需儲存最新價格」 | 只保留 latest，但保留 alert 觸發紀錄 (log) |
| 「Telegram 通知」 | 使用 Telegram Bot API，單一聊天室接收 |
| 「最簡單快速的記帳」 | FAB 一鍵開啟、常用類別 one-tap、3 秒內完成 |
| 「出遊收支與記帳連動」 | 出遊紀錄同時寫入 `transactions`，多一個 `tripId` 欄位 |
| 「LLM 自動規劃行程」 | 提供旅遊資訊 → LLM 產生 draft → 使用者手動微調 |
| 「自己控制權限」 | Firebase Auth + whitelist email + role-based (預留多人) |

### 2.2 補充的缺漏功能（建議加入）

| # | 功能 | 原因 |
|---|---|---|
| 1 | **Portfolio (實際持倉)** | 只追價格不夠，需記錄買入成本/股數才能算損益 |
| 2 | **Budget (預算管理)** | 記帳若無預算比較就只是流水帳 |
| 3 | **週期性交易 (Recurring)** | 房租、訂閱等自動產生紀錄 |
| 4 | **Alert 通知紀錄** | 匯率/股價警報歷史，避免誤判是否有發送 |
| 5 | **PWA 支援** | 手機隨身記帳是關鍵 UX，須可安裝至桌面 |
| 6 | **資料匯出 (CSV/JSON)** | 避免綁死、可做年度稅務整理 |
| 7 | **離線快取** | 出國時弱網路仍可記帳（寫入本地後同步） |
| 8 | **多幣別記帳** | 不只出遊，平常可能有 USD 訂閱 |
| 9 | **Dashboard 首頁** | 一頁掌握「總資產、月花費、最新匯率、近期行程」 |
| 10 | **股價警報** | 匯率有警報、股價也應該有 |

---

## 3. 關鍵設計決策

以下為本文件預設採用的決策（有疑慮的項目列於第 12 節）：

| 決策點 | 選擇 | 理由 |
|---|---|---|
| 前端框架 | **React 18 + Vite + TypeScript** | 生態成熟、元件化、TS 降低維護成本 |
| UI Library | **shadcn/ui + Tailwind CSS** | 現代、可客製、owner 熟悉 |
| Hosting | **Firebase Hosting** | 與 Firestore 同平台、免費額度充足 |
| DB | **Firestore** (Native mode) | 即時同步、結構彈性 |
| Auth | **Firebase Auth** (Google SSO + Email whitelist) | 單人使用最簡單 |
| 登入流程 | **`signInWithRedirect` + `getRedirectResult`** | 行動裝置 popup 易被攔截，redirect 相容性最佳 |
| 主題模式 | **跟隨系統 (`prefers-color-scheme`) + 手動覆蓋** | 與手機日夜模式同步，Settings 可鎖定 |
| Icon | **Lucide React 全系統統一** | **不使用 emoji**，category/payment/trip 皆存 icon name |
| Backend 排程 | **Google Apps Script** | 依需求、免費、Time-driven Trigger 夠用 |
| 即時資料寫入 | **前端 → Firestore 直寫** (with Security Rules) | 避免多繞一層 |
| 外部 API 調用 | **Apps Script 為主** (避免前端暴露 API key) | 安全、可排程 |
| LLM Provider | **Google Gemini**（3.8 Flash / 2.5 Flash-Lite 依工作分流） | 兼顧推理品質與成本；替代方案：Claude Sonnet |
| 台股資料源 | **TWSE MIS API** (免費官方) | `https://mis.twse.com.tw/stock/api/getStockInfo.jsp` |
| 美股資料源 | **Finnhub Free Tier** (60 calls/min) | 免費、即時報價 |
| 匯率資料源 | **open.er-api.com** (免費無金鑰) + 備援 ExchangeRate-API | 可靠且免費 |
| 地圖 | **Google Maps JS API + Places API** | 必要 |
| 通知 | **Telegram Bot API** | owner 已決定 |
| Chart Library | **Recharts** | React 原生、輕量 |
| State Management | **Zustand** + **TanStack Query** | 輕量、適合 Firestore 即時訂閱 |
| 時區 | **Asia/Taipei** 為主 | 所有時間戳以 TW 時間顯示 |
| 主幣別 | **TWD** | 所有匯總以 TWD 顯示 |

---

## 4. 技術架構

### 4.1 架構總覽

```
┌──────────────────────────────────────────────────────────────┐
│                    Client (Browser / PWA)                    │
│  React SPA — Firebase Hosting                                │
│  ├─ Auth (Firebase Auth SDK)                                 │
│  ├─ Firestore SDK (real-time listeners)                      │
│  └─ Google Maps JS SDK                                       │
└──────────────────────────────────────────────────────────────┘
          │                         │                  │
          │ Read/Write              │ Auth             │ Trigger
          ▼                         ▼                  ▼
┌──────────────────────┐   ┌───────────────┐   ┌────────────────────┐
│      Firestore       │   │ Firebase Auth │   │  Apps Script API   │
│  Collections:        │   │  Google SSO   │   │  Web App (exec URL)│
│  ─ stocks            │   │  Whitelist    │   │  ─ updatePrices    │
│  ─ fx_rates          │   │               │   │  ─ generateItinerary│
│  ─ transactions      │   └───────────────┘   │  ─ genericProxy    │
│  ─ trips             │                       └────────────────────┘
│  ─ itineraries       │                               │
│  ─ alerts            │                               │
│  ─ alert_logs        │◄──────── write ──────────────┤
│  ─ users             │                               │
└──────────────────────┘                               ▼
          ▲                                   ┌────────────────────┐
          │                                   │ Apps Script        │
          │ read/write via                    │ Time-driven Trigger│
          │ Firestore REST                    │ ─ every 15 min     │
          └───────────────────────────────────┤                    │
                                              └────────────────────┘
                                                     │
                                ┌────────────────────┼─────────────────────┐
                                ▼                    ▼                     ▼
                      ┌──────────────┐   ┌─────────────────┐   ┌─────────────────┐
                      │ TWSE MIS API │   │  Finnhub API    │   │ open.er-api.com │
                      └──────────────┘   └─────────────────┘   └─────────────────┘
                                                                        │
                                              ┌─────────────────┐       │ trigger
                                              │ Telegram Bot API│◄──────┤ alert
                                              └─────────────────┘
                                                                        │
                                              ┌─────────────────┐       │
                                              │  Gemini API     │◄──────┤ itinerary
                                              └─────────────────┘
```

### 4.2 資料流場景

**場景 A：定時更新股價**
1. Apps Script 每 15 分鐘 (TW 交易時間) 觸發
2. 讀取 Firestore `watchlist` 取得所有追蹤代號
3. 分別打 TWSE / Finnhub API 取得最新價
4. 更新 `stocks/{symbol}` (latest) + append 到 `stocks/{symbol}/history/{timestamp}`
5. 檢查 `alerts` 中 type=stock 的條件，命中則寫 `alert_logs` + Telegram 通知

**場景 B：使用者記一筆帳**
1. 使用者在 PWA 點 FAB → 輸入金額/類別
2. 前端直接寫入 Firestore `transactions/{txId}`
3. Firestore 即時同步到 Dashboard 元件

**場景 C：LLM 規劃行程**
1. 使用者在 UI 填入「目的地 / 日期 / 偏好」
2. 前端 POST 到 Apps Script Web App
3. Apps Script 組 prompt → 呼叫 Gemini API
4. 解析 JSON 回應 → 寫入 Firestore `itineraries/{tripId}` → 回傳給前端
5. 使用者在 UI 拖拉調整，寫回 Firestore

---

## 5. 模組詳細設計

### 5.1 Auth 身分驗證與權限

**需求**：owner 單人使用，但預留未來多人 (家人) 擴充。

**設計**：
- Firebase Auth：**Google SSO only** (不開放 Email 註冊)
- **登入流程必須使用 `signInWithRedirect` + `getRedirectResult`**（不可用 popup）：
  - 原因：行動裝置 (iOS Safari / Chrome / in-app browser) 常因彈窗攔截而失敗；redirect 在所有瀏覽器穩定
  - 流程：
    1. 使用者在 `/login` 點「使用 Google 登入」
    2. 前端呼叫 `signInWithRedirect(auth, new GoogleAuthProvider())`
    3. 跳轉至 Google 授權頁
    4. 授權完成後自動導回 app
    5. app 於 `main.tsx` (root) `useEffect` 內呼叫 `getRedirectResult(auth)` 接收結果
    6. 同時掛 `onAuthStateChanged` listener 處理後續狀態
  - **必須在 Firebase Console → Authentication → Settings → Authorized domains** 加入：
    - `localhost`（開發用）
    - `<your-project-id>.web.app` 與 `.firebaseapp.com`（Hosting 預設域名）
    - 任何自訂域名
  - **Loading 狀態處理**：redirect 回來到 `getRedirectResult` 完成這段需要顯示全屏 spinner，避免閃爍到 `/login` 再跳 `/`
- **Email Whitelist**：於 Firestore `config/allowedEmails` 維護白名單
  - 登入成功後前端立即檢查：不在名單 → `signOut()` + toast 顯示「無權限」
  - 同時 Security Rules 再把一次關（雙層防線）
- **Role-based**：`users/{uid}.role = 'owner' | 'viewer'`
  - `owner`：全部權限（owner）
  - `viewer`：僅可讀（未來擴充）
- **Security Rules**：所有 collection 僅允許 whitelist 內的 uid 讀寫
- **登出**：`signOut()` + 清除 IndexedDB 的 Firestore offline cache + redirect 到 `/login`

**Firestore Security Rules 範例（片段）**：
```javascript
match /{document=**} {
  allow read, write: if request.auth != null
    && exists(/databases/$(database)/documents/users/$(request.auth.uid))
    && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'owner';
}
```

---

### 5.2 Investment 投資追蹤

#### 5.2.1 預設標的

**台股** (11 檔)：`0050, 2646, 2330, 2881, 2884, 2887, 2892, 2897, 4904, 6757, 8215`
**美股** (9 檔)：`DIS, GOOGL, JPM, MA, META, MRVL, NVDA, TSLA, TSM`

系統 seed data 於初始化時寫入。

#### 5.2.2 核心功能

| 功能 | 說明 |
|---|---|
| Watchlist | 顯示所有追蹤標的的最新價/漲跌 |
| 標的詳細頁 | 歷史價格圖 (日/週/月)、高低價、成交量 |
| 新增/刪除標的 | 支援代號搜尋後加入 |
| 手動更新 | 除排程外，UI 可觸發 refresh |
| 歷史紀錄區間刪除 | 依日期範圍刪除 `history` 子集合 |
| 股價警報 | 到價 Telegram 通知 (同匯率) |
| **Portfolio (補強)** | 紀錄買入日期/股數/成本，自動算已實現/未實現損益 |
| 資產總覽 | 總市值 (TWD) / 總報酬 / 報酬率 |

#### 5.2.3 資料模型

```
stocks/{symbol}
  ├─ symbol: "2330"
  ├─ market: "TW" | "US"
  ├─ name: "台積電"
  ├─ currency: "TWD" | "USD"
  ├─ currentPrice: 850.0
  ├─ change: 5.0
  ├─ changePercent: 0.59
  ├─ volume: 12345678
  ├─ high: 855.0
  ├─ low: 848.0
  ├─ open: 849.0
  ├─ prevClose: 845.0
  ├─ updatedAt: Timestamp
  └─ history (sub-collection)
       └─ {timestamp}
            ├─ price: 850.0
            ├─ volume: 12345
            └─ timestamp: Timestamp

watchlist/{uid}_{symbol}
  ├─ userId
  ├─ symbol
  ├─ addedAt
  └─ note: "長期持有"

portfolio/{positionId}
  ├─ userId
  ├─ symbol
  ├─ shares: 1000
  ├─ avgCost: 820.0
  ├─ currency: "TWD"
  ├─ lots: [ {date, shares, price, fee} ]  // 分批買入
  └─ notes
```

#### 5.2.4 API 調用策略

**TWSE MIS API**：
```
GET https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw|tse_0050.tw|...
```
- 可一次查多檔 (pipe 分隔)
- 盤中即時、收盤後最後成交
- 注意加上 Header `Referer: https://mis.twse.com.tw/stock/`

**Finnhub Free Tier**：
```
GET https://finnhub.io/api/v1/quote?symbol=TSLA&token={API_KEY}
```
- 60 calls/min
- 需迴圈呼叫每一檔 (無批次)
- 回傳：`c` (current), `d` (change), `dp` (changePercent), `h/l/o/pc`

**呼叫頻率**：
- TW 盤中 (週一~五 09:00–13:30 Asia/Taipei)：每 15 分鐘
- US 盤中 (夏令 21:30–04:00 / 冬令 22:30–05:00)：每 15 分鐘
- 非盤中：每小時一次（只為更新收盤價）

---

### 5.3 FX Alert 匯率提醒

#### 5.3.1 功能
- 預設追蹤：`USD/TWD, JPY/TWD, EUR/TWD, IDR/TWD`
- 顯示即時匯率 (所有追蹤幣對)
- **只儲存最新** (依需求)
- 新增警報：`currency pair`, `direction (above/below)`, `threshold`, `active`
- 觸發即發 Telegram，並寫入 `alert_logs`
- 警報可暫停 / 一次性 / 重複 (cooldown)

#### 5.3.2 資料模型

```
fx_rates/{pair}        // e.g. pair = "USD_TWD"
  ├─ base: "USD"
  ├─ quote: "TWD"
  ├─ rate: 31.5
  ├─ source: "open.er-api"
  └─ updatedAt

alerts/{alertId}
  ├─ userId
  ├─ type: "fx" | "stock"
  ├─ target: "USD_TWD" | "2330"
  ├─ direction: "above" | "below"
  ├─ threshold: 32.0
  ├─ active: true
  ├─ cooldownMinutes: 60  // 觸發後多久內不再發
  ├─ lastTriggeredAt
  ├─ createdAt
  └─ notes: "換美金 budget"

alert_logs/{logId}
  ├─ alertId
  ├─ triggeredAt
  ├─ triggerValue: 32.1
  ├─ notificationSent: true
  └─ channel: "telegram"
```

#### 5.3.3 API
```
GET https://open.er-api.com/v6/latest/USD
```
- 回傳 USD 對所有貨幣的匯率
- 備援：`https://api.exchangerate-api.com/v4/latest/USD`

#### 5.3.4 Telegram 通知格式

> 為維持全系統無 emoji 的一致性，通知文字僅使用標點與中文字元。若之後你覺得 Telegram 裡加少量 emoji 可讀性較高，可個別開例外。

```
[FX Alert] USD/TWD
--------------------
Rate     : 32.15 (above)
Threshold: 32.00
Time     : 2026-04-23 14:30:05
--------------------
```

---

### 5.4 Bookkeeping 記帳

#### 5.4.1 UX 設計原則（重要）
> 3 秒內完成一筆記帳 是首要目標。

**快速記帳流程**：
1. PWA 底部 **浮動 FAB** (+) 永遠可見
2. 點擊彈出 Bottom Sheet
3. 預設狀態：
   - 類別：**最近常用的 3 個** 作為快捷按鈕 (one-tap)
   - 日期：今天
   - 類型：支出
   - 支付方式：上次使用的
4. 輸入金額 → 選類別 (或打字其他) → 存檔
5. **可選**：備註、照片、改日期
6. 按 Save 立即寫入 Firestore，Dashboard 即時更新

#### 5.4.2 預設類別

> **重要**：系統全面使用 Lucide React icons，**不使用 emoji**。Firestore 的 `categories.icon` 欄位儲存 Lucide icon name (PascalCase string)，前端動態 resolve。

**支出**：

| key | 名稱 | icon (Lucide) | color |
|---|---|---|---|
| food | 餐飲 | `Utensils` | `#F59E0B` |
| transport | 交通 | `Car` | `#3B82F6` |
| home | 居家 | `Home` | `#10B981` |
| shopping | 購物 | `ShoppingBag` | `#EC4899` |
| medical | 醫療 | `Stethoscope` | `#EF4444` |
| entertainment | 娛樂 | `Gamepad2` | `#8B5CF6` |
| education | 學習 | `BookOpen` | `#06B6D4` |
| investment | 投資 | `TrendingUp` | `#059669` |
| gift | 禮物 | `Gift` | `#F97316` |
| other | 其他 | `MoreHorizontal` | `#6B7280` |

**收入**：

| key | 名稱 | icon (Lucide) | color |
|---|---|---|---|
| salary | 薪資 | `Briefcase` | `#0EA5E9` |
| bonus | 獎金 | `Award` | `#EAB308` |
| invest_return | 投資收益 | `LineChart` | `#10B981` |
| gift_income | 禮金 | `Gift` | `#F97316` |
| other_income | 其他 | `MoreHorizontal` | `#6B7280` |

使用者可自訂（新增 / 改 icon / 刪除 / 排序）。

#### 5.4.3 支付方式
預設：`現金, 信用卡-X, 銀行轉帳, LINE Pay, 街口, 悠遊卡, 其他` → 使用者可編輯

#### 5.4.4 Dashboard 元件

| 卡片 | 內容 |
|---|---|
| 本月總結 | 總收入、總支出、淨額 |
| 類別圓餅圖 | 本月支出依類別百分比 |
| 趨勢折線圖 | 過去 12 個月收支趨勢 |
| 週花費長條圖 | 最近 7/30 天每日花費 |
| Top 5 支出 | 本月單筆前 5 大 |
| 預算進度條 | 若設定預算，各類別用量 |
| 最近 10 筆交易 | 可點擊編輯 |

**篩選器**：日期範圍、類別、支付方式、類型 (收入/支出)、關鍵字、trip

#### 5.4.5 資料模型

```
transactions/{txId}
  ├─ userId
  ├─ type: "expense" | "income"
  ├─ amount: 120
  ├─ currency: "TWD"
  ├─ amountTWD: 120        // 換算後的主幣別金額
  ├─ fxRate: 1             // 記帳當下的匯率
  ├─ category: "food"
  ├─ subCategory: "午餐"   // optional
  ├─ paymentMethod: "信用卡-CUBE"
  ├─ note: "麥當勞"
  ├─ photoUrl: "gs://..."  // optional
  ├─ date: Timestamp       // 交易日期 (可自訂，非 createdAt)
  ├─ createdAt
  ├─ updatedAt
  ├─ tripId: null | "bali-2026-05"   // 出遊關聯
  ├─ tags: ["商務", "請客"]
  └─ recurringId: null     // 若為週期性交易

categories/{categoryId}
  ├─ userId
  ├─ name: "餐飲"
  ├─ type: "expense"
  ├─ icon: "Utensils"      // Lucide React icon name (PascalCase)
  ├─ color: "#F59E0B"
  ├─ order: 1
  └─ budget: 10000         // optional 月預算

budgets/{budgetId}
  ├─ userId
  ├─ month: "2026-04"
  ├─ total: 50000
  └─ byCategory: { food: 10000, transport: 3000, ... }

recurring/{recurringId}
  ├─ userId
  ├─ template: { type, amount, category, ... }
  ├─ frequency: "monthly" | "weekly"
  ├─ nextDue: Timestamp
  ├─ active: true
  └─ lastGeneratedAt
```

---

### 5.5 Travel Expense 出遊收支

#### 5.5.1 核心理念
> 出遊收支 = **Trip** (出遊實例) + **transactions (tripId != null)**
> 記帳與出遊共用同一 collection，tripId 區分屬於哪一趟。

這樣做的好處：
- Dashboard 看總花費時自動包含出遊
- 單獨看某趟出遊也可以 filter by tripId
- 匯入/匯出 一致

#### 5.5.2 Trip 功能

| 功能 | 說明 |
|---|---|
| 建立 Trip | 名稱、起訖日期、目的地、base/foreign currency、budget |
| 多幣別即時換算 | 輸入 IDR 金額時，自動用最新匯率換 TWD 存檔 |
| Trip 儀表板 | 總花費 (TWD + 原幣)、每日花費、類別佔比 |
| 與記帳連動 | 一筆 tx 同時屬於總帳 & trip |
| Trip 關聯行程 | Trip 可選關聯到 Itinerary (5.6) |
| 旅伴分攤 (可選補強) | 記錄代墊/結算 (v2 再做) |

#### 5.5.3 Trip 類別
在一般類別外，出遊情境加上（同樣用 Lucide icon name，**不使用 emoji**）：

| key | 名稱 | icon |
|---|---|---|
| trip_ticket | 門票 | `Ticket` |
| trip_hotel | 住宿 | `Hotel` |
| trip_flight | 機票 | `Plane` |
| trip_local_transport | 當地交通 | `Bus` |
| trip_souvenir | 伴手禮 | `Gift` |
| trip_food | 旅遊餐飲 | `Utensils` |

#### 5.5.4 資料模型

```
trips/{tripId}
  ├─ userId
  ├─ name: "Bali 2026/05"
  ├─ destination: ["Bali, Indonesia"]
  ├─ startDate: 2026-05-07
  ├─ endDate: 2026-05-10
  ├─ baseCurrency: "TWD"
  ├─ foreignCurrencies: ["IDR", "USD"]
  ├─ budget: 50000          // TWD
  ├─ coverImage: "..."
  ├─ itineraryId: "..."     // optional link
  ├─ status: "planning" | "active" | "done"
  ├─ createdAt
  └─ notes
```

交易直接用 `transactions` + `tripId`，另外提供 `/trips/{tripId}/summary` API 計算彙總。

#### 5.5.5 機票價格雷達

- 使用獨立 `/flights` 頁面呈現排程、最新查詢結果、來源與歷史價格趨勢；出遊頁保留入口。
- 使用者選擇出發／抵達機場、彈性出發日期、住宿晚數與成人數。
- 同一筆訂閱可比較經濟艙、豪華經濟艙、商務艙與頭等艙，結果須分艙等保存，禁止混用價格。
- 航空公司可設為不限、只看指定或排除指定，並可獨立開啟「排除廉價航空」與「只看直飛」。
- 每條航線可獨立選擇 Duffel Flights API 或 Gemini Google Search；Duffel 每次輪替一組日期與晚數，不消耗 Gemini tokens。
- Gemini provider 可選受控白名單內的模型；選擇 provider 即為明確 opt-in，沒有 grounding source 的結果不得保存，tokens 與 Search grounding 用量須納入 AI Budget。
- 所選 provider 缺少 token/key 時安全停止，不得自動切換到另一個可能產生費用的 provider。
- Flight API 每月 request 硬上限預設 300，達上限後停止掃描並回報，不得自動超額。
- 每條航線可排程為每日、平日或每週指定星期（Asia/Taipei 09:00），停用後不再自動掃描。
- Telegram 可選擇只在達理想價／跌幅達門檻時提醒，或每次排程掃描都回報目前各艙等票價與推薦日期。
- 每次結果保存各艙等價格區間、最多 12 組分散在可出發範圍的候選日期、價格建議與來源，並寫入 snapshots 供歷史趨勢圖使用。
- 購買建議由程式依理想價、常見價與前次掃描變化決定；模型只提供有來源的價格摘要，不作為建議的唯一依據。
- 所有金額為全體旅客來回含稅 TWD 估價，UI 必須提醒使用者實際庫存、行李與付款條件可能不同。

---

### 5.6 Itinerary 行程規劃

#### 5.6.1 功能流程

```
  建立 Trip
    ↓
  提供偏好（天數、興趣、步調、預算、必去）
    ↓
  LLM 產生 draft 行程 (JSON)
    ↓
  自動抓 Google Places 座標/照片
    ↓
  使用者在 UI 手動調整
    ↓
  儲存 / 分享 / 匯出 PDF
    ↓
  出遊中：打卡、筆記、花費連動到記帳
```

#### 5.6.2 LLM Prompt 範例（儲存於 Apps Script）

```
你是一位資深旅遊規劃師。依以下條件產出行程，**只回傳合法 JSON**，不要任何其他文字。

使用者偏好：
- 目的地：{destination}
- 日期：{startDate} ~ {endDate}
- 預算：{budget} TWD
- 興趣：{interests}
- 步調：{pace: relaxed | balanced | packed}
- 必去：{musts}
- 忌口/不想去：{avoid}

輸出格式：
{
  "summary": "...",
  "days": [
    {
      "date": "2026-05-07",
      "theme": "抵達日 + 海邊放鬆",
      "items": [
        {
          "order": 1,
          "startTime": "10:00",
          "endTime": "11:30",
          "type": "transport|meal|activity|accommodation|shopping",
          "title": "抵達 Denpasar 機場",
          "placeName": "Ngurah Rai International Airport",
          "address": "Bali, Indonesia",
          "estimatedCost": 0,
          "currency": "TWD",
          "notes": "接機由飯店安排"
        }
      ]
    }
  ],
  "tips": ["...", "..."]
}
```

後處理：
- 逐一用 Google Places API `findPlaceFromText` 取 `place_id` + coordinates + photos
- 寫入 Firestore

#### 5.6.3 手動編輯 UI
- **時間軸 (Timeline)** 模式：拖曳排序、改時間、改內容
- **地圖 (Map)** 模式：marker 顯示、路線、切換 driving/walking/transit
- **清單 (List)** 模式：表格式編輯
- **切換模式** 頂部 tab

#### 5.6.4 資料模型

```
itineraries/{itineraryId}
  ├─ userId
  ├─ tripId           // optional
  ├─ title: "Bali 4D3N"
  ├─ destination
  ├─ startDate / endDate
  ├─ generatedByLLM: true
  ├─ llmModel: "gemini-3.8-flash"
  ├─ summary
  ├─ tips: [...]
  └─ days (sub-collection)
       └─ {dayId: "day-1"}
            ├─ date
            ├─ theme
            └─ items (sub-collection)
                 └─ {itemId}
                      ├─ order
                      ├─ startTime / endTime
                      ├─ type
                      ├─ title
                      ├─ placeId          // Google Place ID
                      ├─ placeName
                      ├─ address
                      ├─ lat / lng
                      ├─ photoUrl
                      ├─ estimatedCost
                      ├─ actualCost       // 實際花費（可連動 tx）
                      ├─ linkedTxId       // 若已記帳
                      ├─ notes
                      └─ status: "planned" | "done" | "skipped"
```

#### 5.6.5 Google Maps 整合

- **Places Autocomplete**：地點搜尋
- **Place Details**：名稱、地址、照片、評分、營業時間
- **Directions API**：行程間路線 / 時間估計
- **Static Maps**：PDF 匯出時用
- **Embed**：單點顯示

**API 需開通**：
- Maps JavaScript API
- Places API (New)
- Directions API
- Geocoding API

---

### 5.7 Notification 通知系統

#### 5.7.1 Telegram 設定

**一次性設定**：
1. 與 `@BotFather` 對話建立 bot → 取得 `BOT_TOKEN`
2. 找自己 bot 私訊一次 → 用 `getUpdates` 取得 `chat_id`
3. Token / chat_id 儲存於 Apps Script 的 `PropertiesService.getScriptProperties()`

**通知類別**：
| 類別 | 情境 | 頻率上限 |
|---|---|---|
| 匯率警報 | Alert 觸發 | cooldown 可設 (預設 60 min) |
| 股價警報 | Alert 觸發 | 同上 |
| 預算警報 | 某類別本月 >80% 時 | 每日一次 |
| 每日摘要 (選) | 昨日花費、今日重要事項 | 每日 1 次 |
| 系統錯誤 | API 調用失敗連 3 次 | 即時 |

#### 5.7.2 Apps Script 工具函式

```javascript
function sendTelegram(message, parseMode = 'Markdown') {
  const token = PropertiesService.getScriptProperties().getProperty('TG_BOT_TOKEN');
  const chatId = PropertiesService.getScriptProperties().getProperty('TG_CHAT_ID');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    payload: { chat_id: chatId, text: message, parse_mode: parseMode }
  });
}
```

---

### 5.8 Dashboard 首頁

**Home Dashboard** 一頁呈現：

```
┌─────────────────────────────────────────────┐
│ Good morning, owner           [今天 4/23 週四] │
├─────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│ │總資產     │ │本月花費   │ │本月預算   │    │
│ │NT$2.1M   │ │NT$18,500 │ │64% 用掉  │    │
│ └──────────┘ └──────────┘ └──────────┘    │
├─────────────────────────────────────────────┤
│ [DollarSign]  匯率 (updated 14:25)          │
│ USD: 31.52 (+0.12)  JPY: 0.21  IDR: 0.00192│
├─────────────────────────────────────────────┤
│ [TrendingUp]  Watchlist Top movers          │
│ 2330 +2.1%   NVDA +1.8%   0050 +0.5%       │
├─────────────────────────────────────────────┤
│ [Plane]  接下來的行程：Bali (14 天後)       │
│ [查看行程]                                  │
├─────────────────────────────────────────────┤
│ [BarChart3]  本月花費趨勢                   │
│ [sparkline]                                 │
└─────────────────────────────────────────────┘
                             [+ 快速記帳 FAB]
```

> 方括號內為 Lucide icon name；實際渲染時用 `<Icon />` component。全系統無 emoji。

---

## 6. Firestore 完整資料模型總覽

```
users/{uid}
  ├─ email, displayName, photoURL
  ├─ role: "owner" | "viewer"
  ├─ preferences: { theme, mainCurrency, ... }
  └─ createdAt

config/
  ├─ allowedEmails: ["rex@..."]
  └─ systemFlags: {...}

stocks/{symbol}
  └─ history/{timestamp}

watchlist/{uid}_{symbol}

portfolio/{positionId}

fx_rates/{pair}

alerts/{alertId}
alert_logs/{logId}

transactions/{txId}
categories/{categoryId}
budgets/{budgetId}
recurring/{recurringId}

trips/{tripId}

itineraries/{itineraryId}
  └─ days/{dayId}
        └─ items/{itemId}

notifications/{notifId}         # App 內通知中心（GAS sendNotification_ 寫入、保留 60 天；見 features/notifications/README.md）
```

---

## 7. API 設計

### 7.1 Apps Script Web App Endpoints

部署為 Web App (Execute as me, Access: Only me)

| Endpoint | Method | 功能 |
|---|---|---|
| `?action=updateStockPrices` | GET | 手動觸發更新所有股價 |
| `?action=updateFxRates` | GET | 手動觸發更新匯率 |
| `?action=checkAlerts` | GET | 手動檢查所有警報 |
| `?action=generateItinerary` | POST | 生成 LLM 行程 (body: {tripId, preferences}) |
| `?action=exportData` | GET | 備份全部資料 (下載 JSON) |
| `?action=geocode` | GET | Places API 代理 (避免金鑰外洩) |

### 7.2 Apps Script 定時觸發器

以 `apps-script/src/Triggers.gs` 的 `setupTriggers()` 為準（設定 → 資料 →「重新註冊排程」或 editor 手動執行；會先 `deleteAllTriggers()` 再全部重建），目前共 **12 個**。時間皆為 Asia/Taipei。

> Apps Script 的 `atHour(n)` 只保證在 n 點那一小時內觸發（分鐘不固定），所以 `tick_daily_0930` / `tick_daily_1230` 實際是 09 點 / 12 點時段執行，名稱只是辨識用。

| 觸發器 | 時間 | 功能 |
|---|---|---|
| `tick_15min` | 每 15 分鐘 | 盤中（TW 或 US 開盤）更新股價；每次都更新 FX；兩者更新後都會跑 `checkAllAlerts` |
| `tick_hourly` | 每小時 | 非盤中更新收盤價；盤中寫 `stocks/{symbol}/history` 快照 |
| `tick_daily_0100` | 每日 01:00 | recurring 入帳、公基金每月計畫、清理 30 天前股價 history 與 7 天前 trash 交易、白名單雜湊同步、每日備份（§11.9）、股市雷達台股籌碼、電子發票同步 |
| `tick_daily_0700` | 每日 07:00 | 美股收盤後：股價 / FX / 日 K、投資組合每日快照、淨值月快照、共同投資帳快照 |
| `tick_daily_0800` | 每日 08:00 | 每日摘要、錯誤彙整、股市雷達盤前評估、台指期盤前輿情否決 |
| `tick_daily_0900` | 每日 09:00 | 市場日報、信用卡帳單到期、貸款繳款提醒、機票雷達掃描 |
| `tick_daily_0930` | 每日 09 點時段 | 每月 1 號：月度記帳 / 訂閱 / 固定支出 / 出遊回顧 / 儲蓄目標 / 投資計畫報告（4/1、5/1 加報稅季整理）；每月 15 號：理財健檢；其他日子不做事 |
| `tick_daily_1230` | 每日 12 點時段 | 月底結餘預測、類別花費異常、排程支出到期提醒 |
| `tick_daily_1800` | 每日 18:00 | 台股收盤後：股價 / FX / 日 K、除權息日曆、短波段掃描與紙上交易、投資組合 / 淨值 / 共同投資帳快照、台指期每日訊號與虛擬交易 |
| `tick_daily_2100` | 每日 21:00 | 記帳日報、預算警告、代墊 / 墊付團提醒、共同帳本報告、股市雷達美股 fallback 推播、最終匯率 + 匯率日報 |
| `tick_weekly_sun` | 週日 03:00 | 已停用（備份移到 `tick_daily_0100`），trigger 保留以免重跑 `setupTriggers`，函式直接 return |
| `tick_weekly_sun_2000` | 週日 20:00 | 每週回顧、股市雷達回測、台指期回測 |

---

## 8. 前端 UI/UX

### 8.1 頁面結構

```
/                        Dashboard (首頁)
/investments             投資 Watchlist + Portfolio
/investments/:symbol     單檔標的詳細
/fx                      匯率即時 & 警報管理
/ledger                  記帳主頁 (含新增 + 列表)
/ledger/dashboard        記帳儀表板
/ledger/categories       類別管理
/ledger/budget           預算設定
/trips                   Trip 列表
/trips/:id               Trip 總覽 (花費 + 行程)
/trips/:id/itinerary     行程規劃編輯
/settings                設定 (Telegram, 類別, 匯出, 主題)
/login
```

### 8.2 Navigation

**設計原則**：直覺、分組清楚、永遠看得到標籤文字（不做 icon-only 模式）、active 狀態明顯。

#### 8.2.1 Desktop Sidebar (≥ 1024px)

- **固定寬度 240px**，不可收合（犧牲一點空間換取零學習曲線）
- **垂直分組**，每組上方有淺灰 section label
- **每項 = Lucide icon (20px) + 中文名稱 + (選擇性) 右側小徽章 (e.g. 未讀通知數)**
- icon 與文字間距 `12px`，每項高度 `40px`，整項可點
- **active 狀態**：
  - 左側 `3px` 紫色 indicator bar
  - 項目背景淺紫 `bg-primary/10`
  - icon 與文字 color 加深
- **hover**：淺灰底 `bg-muted`
- **底部固定區**：user avatar + displayName + 登出 icon button

結構示意：

```
┌────────────────────────┐
│  Personal Hub          │   ← 品牌區 (48px)
├────────────────────────┤
│  MAIN                  │
│  [Home]       首頁     │
│  [Wallet]     記帳     │
│  [Plane]      出遊     │
│                        │
│  MARKETS               │
│  [TrendingUp] 投資     │
│  [DollarSign] 匯率     │
│                        │
│  SYSTEM                │
│  [Settings]   設定     │
├────────────────────────┤
│  [avatar] owner          │
│  [LogOut]              │
└────────────────────────┘
```

#### 8.2.2 Mobile Bottom TabBar (< 1024px)

- **固定 5 個 tab**：`首頁 / 記帳 / 投資 / 出遊 / 設定`
  - 匯率併入「投資」頁（以 sub-tab 呈現），避免 TabBar 超過 5 項增加認知負擔
- **icon 24px + 文字 10-11pt 標籤常駐顯示**（不靠 icon-only 猜意思）
- **active**：icon 使用 filled variant + 紫色、文字粗體
- **safe-area-inset-bottom** padding 避免覆蓋 home indicator
- 切換 tab 有 `haptic` 震動回饋 (若支援)

#### 8.2.3 FAB (全裝置共用)

- 右下角圓形按鈕，`Plus` icon (28px)
- 除 `/login` 外所有頁面皆顯示
- 點擊彈出「快速記帳」：
  - Mobile：Bottom Sheet
  - Desktop：Dialog
- **長按** (mobile) / **右鍵** (desktop) 切換：`新增支出 / 新增收入 / 新增出遊紀錄`
- 位置避開 TabBar：`bottom: calc(env(safe-area-inset-bottom) + 72px)`

#### 8.2.4 響應式斷點

| 斷點 | Layout |
|---|---|
| `< 768px` | Mobile: Bottom TabBar + FAB |
| `768–1023px` | Tablet: 可開關的 drawer sidebar + FAB |
| `≥ 1024px` | Desktop: 固定 Sidebar 240px + FAB |

### 8.3 設計風格

- **主題 (Light/Dark)**：
  - **預設跟隨系統**：讀取 `window.matchMedia('(prefers-color-scheme: dark)')`
  - 監聽 `matchMedia` 的 `change` 事件 → 使用者切換手機 OS 日夜模式時**即時切換**，無需重新整理
  - Settings 提供 3 選項：`Auto (跟隨系統)` / `Light` / `Dark`
  - 使用者選擇存於 `localStorage.theme` + `users/{uid}.preferences.theme`（跨裝置同步）
  - 實作建議：用 `class="dark"` 掛在 `<html>` 上 (Tailwind `darkMode: 'class'` 模式，才能手動覆蓋)
  - Meta theme-color 也要跟著切（影響手機瀏覽器 URL bar 顏色）
- **配色**：主色紫 `#7C3AED`，中性灰依 Tailwind `neutral` 色階，風格類 Linear / Raycast
- **圖表**：Recharts，色盤隨 theme 動態切換（`useTheme()` hook）
- **字型**：Inter (英文) + Noto Sans TC (中文)，用 `next/font` 等效方案預載
- **Icon**：**Lucide React**，全系統禁止 emoji
  - 類別、支付方式、Trip 類別等在 Firestore 皆存 Lucide icon name (PascalCase string)，例如 `"Utensils"`、`"Plane"`
  - 前端用 dynamic import / mapping 解析：`const Icon = LucideIcons[iconName]`
- **間距**：採 4px grid (Tailwind 預設)
- **圓角**：`rounded-xl` 為主、`rounded-2xl` for cards

### 8.4 PWA 設定
- `manifest.json`：安裝 icon、主題色、啟動畫面
- Service Worker：快取 static assets、offline fallback
- IndexedDB：記帳草稿 (離線時)

---

## 9. 安全與權限

| 項目 | 作法 |
|---|---|
| Firestore Rules | Whitelist UID + Role Check |
| API Key 管理 | 全部存於 Apps Script `PropertiesService`，前端不持有 |
| Google Maps API Key | 限制 HTTP Referer + API 限制 |
| Firebase Config | 可暴露於前端 (Firebase 設計如此)，靠 Rules 保護 |
| Apps Script Web App | `Access: Only me` + 使用者登入後呼叫時帶 Firebase ID Token 驗證 |
| Env 變數 | `.env.local` + Firebase Hosting 時用 build-time inject，**不進 git** |
| CORS | Apps Script 預設僅允許 Google 來源，需自行處理 (doGet/doPost + setHeader) |
| 敏感資料 | 不記信用卡號、不記密碼；若需備註用 tag |

### 必備 .gitignore
```
.env.local
.env*
*.apikey
.firebaserc (視情況)
firebase-debug.log
node_modules/
dist/
.vscode/
```

---

## 10. 開發階段規劃

建議分 5 個 Sprint 完成：

### Sprint 1：基礎架構 (1 週)
- [x] Firebase 專案建立 (Auth + Firestore + Hosting)
- [x] React + Vite + TS scaffold
- [x] Tailwind + shadcn/ui 整合
- [x] Firebase Auth (Google SSO + email whitelist)
- [x] Routing + Layout (Sidebar / TabBar)
- [x] Firestore Rules 初版
- [x] Apps Script 專案建立 + 基本 Web App 框架
- [x] Telegram bot 設定 + 測試訊息

### Sprint 2：記帳核心 (1 週)
- [x] Transactions CRUD
- [x] Categories 管理 (含 seed)
- [x] 快速記帳 FAB
- [x] Ledger 列表 + 篩選
- [x] Dashboard 基本卡片
- [x] 圖表 (類別、趨勢)
- [x] Budget 設定

### Sprint 3：投資 + 匯率 (1 週)
- [x] Watchlist (seed 預設標的)
- [x] Apps Script: TWSE API 串接
- [x] Apps Script: Finnhub API 串接
- [x] Apps Script: FX API 串接
- [x] 定時觸發器設定
- [x] 個股詳細頁 + 歷史圖
- [x] Alerts CRUD + 觸發邏輯
- [x] Telegram 通知整合

### Sprint 4：出遊與行程 (1.5 週)
- [x] Trip CRUD
- [x] Trip Dashboard (多幣別彙總)
- [x] Google Maps 整合
- [x] Itinerary 編輯器 (Timeline / Map / List)
- [x] LLM 行程生成 (Gemini API)
- [x] 匯出 PDF

### Sprint 5：完善 (0.5 週)
- [x] PWA manifest + SW
- [x] Dark mode
- [x] 資料匯出/匯入
- [x] Portfolio 功能
- [x] Recurring 交易
- [x] 每日摘要通知

---

## 11. 部署與維運

### 11.1 Repository 與分支策略

- **GitHub repo**：`personal-hub` (private)
- **分支**：
  - `main` — 永遠可部署狀態，push 即觸發 auto-deploy
  - `dev/<feature>` — 功能分支，PR 回 main
  - 不使用 `develop` / `staging` (單人專案多此一舉)
- **PR 規則**：
  - 必通過 CI (typecheck / lint / build / rules dry-run)
  - PR 會自動 deploy 到 Firebase Hosting **preview channel**，URL 會留言到 PR
  - Review：可自行 merge（單人），但鼓勵至少 24hr cooling 再 merge 重大改動
- **Tag**：每個 release 打 `v{semver}` tag

### 11.2 Firebase 專案

| 環境 | Firebase Project | 用途 |
|---|---|---|
| Production | `personal-hub-prod` | 真實使用 |
| Preview (Hosting) | 同 prod，但 preview channel | PR 測試，7 天後過期 |

> 單人專案不需要 staging，PR preview channel 已夠。

### 11.3 部署步驟（首次 onboarding）

1. 到 Firebase Console 建立 project `personal-hub-prod`
2. 啟用 Authentication (Google Provider)、Firestore (Native, `asia-east1`)、Hosting
3. Authorized domains 加入 `localhost`, `<project>.web.app`, `<project>.firebaseapp.com`
4. `firebase init` (Hosting + Firestore) 在 `firebase/` 目錄
5. 首次手動：`firebase deploy --only firestore:rules`
6. 首次手動：`cd apps/web && npm run build && firebase deploy --only hosting`
7. `cd apps-script && clasp login && clasp create --type webapp --title "personal-hub"`
8. 部署 Apps Script 為 Web App：`Execute as: me`, `Access: Only me`
9. 設定 Apps Script Script Properties（見 Appendix A）
10. 手動在 Firestore 建 `config/allowedEmails` 文件 + 首次登入 → 把 `users/{uid}.role` 改為 `owner`
11. 設定 GitHub Actions secrets（見 §11.5）
12. 之後一切交給 CI/CD，本機只留 dev 環境

### 11.4 CI/CD Pipeline (GitHub Actions)

**三個 workflow**：

#### A. `.github/workflows/ci.yml` — PR 與 push 到 main 都會跑

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  web:
    name: Web (typecheck / lint / build)
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: apps/web } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: apps/web/package-lock.json
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test --if-present
      - name: Build
        run: npm run build
        env:
          VITE_FIREBASE_API_KEY: ${{ secrets.VITE_FIREBASE_API_KEY }}
          VITE_FIREBASE_AUTH_DOMAIN: ${{ secrets.VITE_FIREBASE_AUTH_DOMAIN }}
          VITE_FIREBASE_PROJECT_ID: ${{ secrets.VITE_FIREBASE_PROJECT_ID }}
          VITE_FIREBASE_STORAGE_BUCKET: ${{ secrets.VITE_FIREBASE_STORAGE_BUCKET }}
          VITE_FIREBASE_MESSAGING_SENDER_ID: ${{ secrets.VITE_FIREBASE_MESSAGING_SENDER_ID }}
          VITE_FIREBASE_APP_ID: ${{ secrets.VITE_FIREBASE_APP_ID }}
          VITE_GOOGLE_MAPS_API_KEY: ${{ secrets.VITE_GOOGLE_MAPS_API_KEY }}
          VITE_APPS_SCRIPT_URL: ${{ secrets.VITE_APPS_SCRIPT_URL }}

  rules:
    name: Firestore Rules lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install -g firebase-tools
      - name: Dry-run deploy rules
        run: firebase deploy --only firestore:rules --dry-run --project ${{ secrets.FIREBASE_PROJECT_ID }}
        env:
          FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN }}
```

#### B. `.github/workflows/deploy-hosting.yml` — push main 自動部署前端 + Rules

```yaml
name: Deploy Hosting & Rules
on:
  push:
    branches: [main]
    paths:
      - 'apps/web/**'
      - 'firebase/**'
      - '.github/workflows/deploy-hosting.yml'
  pull_request:
    branches: [main]
    paths:
      - 'apps/web/**'
      - 'firebase/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # for PR preview comment
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm, cache-dependency-path: apps/web/package-lock.json }
      - run: cd apps/web && npm ci && npm run build
        env:
          VITE_FIREBASE_API_KEY: ${{ secrets.VITE_FIREBASE_API_KEY }}
          # ... (所有 VITE_* 同上)
          VITE_APPS_SCRIPT_URL: ${{ secrets.VITE_APPS_SCRIPT_URL }}
      - name: Deploy to Firebase Hosting (Production or Preview)
        uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: ${{ secrets.GITHUB_TOKEN }}
          firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
          channelId: ${{ github.event_name == 'push' && 'live' || '' }}   # live for main push, preview channel for PR
          projectId: ${{ secrets.FIREBASE_PROJECT_ID }}
      - name: Deploy Firestore Rules (main only)
        if: github.event_name == 'push'
        run: |
          npm install -g firebase-tools
          firebase deploy --only firestore:rules,firestore:indexes --project ${{ secrets.FIREBASE_PROJECT_ID }} --non-interactive
        env:
          GOOGLE_APPLICATION_CREDENTIALS: /tmp/sa.json
      # 注意：FirebaseExtended action 已處理 SA 認證；Rules deploy 需另外方式
      # 替代方案：把 Rules deploy 寫進 Hosting action 前置步驟，或用 FIREBASE_TOKEN
```

> **注意**：Rules deploy 與 Hosting deploy 的認證方式略有不同。建議用 `FIREBASE_TOKEN`（`firebase login:ci`）取代 Service Account 做 Rules deploy，或把 Rules deploy 拆成獨立 job 用 `google-github-actions/auth` 認證。

#### C. `.github/workflows/deploy-apps-script.yml` — push main 且 apps-script/ 有變才跑

```yaml
name: Deploy Apps Script
on:
  push:
    branches: [main]
    paths:
      - 'apps-script/**'
      - '.github/workflows/deploy-apps-script.yml'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Install clasp
        run: npm install -g @google/clasp
      - name: Write clasp credentials
        run: |
          echo '${{ secrets.CLASPRC_JSON }}' > ~/.clasprc.json
          echo '${{ secrets.CLASP_JSON }}' > apps-script/.clasp.json
      - name: Push code
        working-directory: apps-script
        run: clasp push --force
      - name: Deploy new version
        working-directory: apps-script
        run: |
          clasp deploy \
            --deploymentId ${{ secrets.CLASP_DEPLOYMENT_ID }} \
            --description "auto: $(git rev-parse --short HEAD)"
```

> `CLASP_DEPLOYMENT_ID` 是首次手動 `clasp deploy` 產生的 ID，之後重複用同一 ID 更新。

### 11.5 GitHub Actions Secrets 清單

請在 `Settings → Secrets and variables → Actions` 建立：

| Secret | 取得方式 | 用途 |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console → Project Settings → Service Accounts → Generate new private key (貼入整份 JSON) | Hosting deploy |
| `FIREBASE_TOKEN` | 本機 `firebase login:ci` 產生 | Rules/Indexes deploy |
| `FIREBASE_PROJECT_ID` | Firebase project ID (e.g. `personal-hub-prod`) | 通用 |
| `VITE_FIREBASE_API_KEY` etc. | Firebase Console → Web app config | Build-time inject |
| `VITE_GOOGLE_MAPS_API_KEY` | Google Cloud Console | Maps |
| `VITE_APPS_SCRIPT_URL` | Apps Script 部署後的 Web App URL | 前端呼叫 |
| `CLASPRC_JSON` | 本機 `~/.clasprc.json`（`clasp login` 後產生） | Apps Script auth |
| `CLASP_JSON` | 本機 `apps-script/.clasp.json` | Apps Script scriptId |
| `CLASP_DEPLOYMENT_ID` | `clasp deployments` 列出的 deploymentId | Apps Script 版本管理 |

**安全注意**：
- `FIREBASE_SERVICE_ACCOUNT` 的 Service Account 只給 `Firebase Hosting Admin` + `Firebase Rules Admin` role，**不給 Editor 或 Owner**
- `CLASPRC_JSON` 每 ~30 天可能需要 refresh（Google OAuth token 過期），寫進 RUNBOOK

### 11.6 Deploy 失敗處置

放進 `docs/RUNBOOK.md`：
- CI 紅燈 → 看哪個 step 失敗 → 本機復現 → 修完重推
- Hosting deploy 失敗 → 通常 build env 少帶；檢查 secrets 齊全
- Rules deploy 失敗 → rules 語法錯 → 本機 `firebase emulators:exec --only firestore "npm test"` 測試
- Apps Script deploy 失敗 → 多半是 clasp token 過期 → 本機 `clasp login` 重做、更新 secret

### 11.7 Rollback

- **Hosting**：Firebase Console → Hosting → Release history → Rollback 到前一版 (30 天內)
- **Firestore Rules**：`git revert` + push main 觸發重新 deploy
- **Apps Script**：Apps Script IDE → Deployments → Archive 當前、redeploy 舊 version

### 11.8 免費額度評估

| 服務 | 免費額度 | 本專案預估使用 |
|---|---|---|
| Firebase Hosting | 10GB 流量/月 | < 1% |
| Firestore | 50K read / 20K write / 20K delete 每日 | < 10% |
| Firebase Auth | 50K MAU | 1 user |
| Apps Script | 90 min 執行/日 | ~ 30 min |
| Finnhub | 60 calls/min | OK |
| TWSE | 未明示，合理使用 | OK |
| Gemini API | 依 model / tier 動態配額；app 另有月預算與 hard stop | 個人用量可控 |
| Duffel Flights API | Search 超過 1500:1 search-to-book ratio 後 US$0.005/次 | app 預設 300 requests/月硬上限 |
| Google Maps | $200 免費額度/月 | 個人用足夠 |
| **GitHub Actions** | **2,000 min/月 (private repo)** | **估 ~50 min/月** |

**預估月費：$0**

### 11.9 備份策略
- 每日 01:00（Asia/Taipei）由 `tick_daily_0100` 呼叫 `Backup.gs` 的 `dailyBackupRun()`，把主要 Firestore collections 匯出成單一 JSON（`personal-hub-backup-YYYY-MM-DD.json`）寫入 Google Drive
- 保留 30 天（`BACKUP_RETENTION_DAYS_`），超過的舊備份移到垃圾桶
- Drive 資料夾由 Script Property `BACKUP_FOLDER_ID` 指定（未設定時推播提示；可在 editor 跑 `setupBackupFolder()` 自動建立）
- 備份哪些 collections 以 `Backup.gs` 的 `cols` 清單為準；任一 collection 讀取失敗會另外 `notifyError`，完成通知走 Telegram key `weeklyBackup`（沿用舊名）
- 2026-11 之前為每週日 03:00、保留 56 天
- GitHub repo 本身即為 code 備份

---

## 12. 未決定項目 (待 owner 最終拍板)

| # | 項目 | 選項 | 建議 |
|---|---|---|---|
| 1 | LLM 提供商 | Gemini / Claude / GPT | **Gemini** (免費額度優) |
| 2 | 是否要 Portfolio 實際持倉 | 是/否 | **是** (否則投資分析不完整) |
| 3 | 美股 API | Finnhub / AlphaVantage / Yahoo | **Finnhub** (速率最寬鬆) |
| 4 | 前端框架 | React / Vue / Svelte | **React** (生態最完整) |
| 5 | 多人支援優先度 | v1 / v2 | **v2** (但 schema 已預留) |
| 6 | Recurring 交易是否 v1 | 是/否 | **v1** (每月固定費用多) |
| 7 | 記帳照片 OCR | 加 / 不加 | **v2** (複雜度高) |
| 8 | Trip 旅伴分攤 | 加 / 不加 | **v2** |
| 9 | Apps Script 或 Cloud Functions | AS / CF | **AS** (依 owner 指定) |
| 10 | Mobile Native App | 要 / 不要 | **不要，PWA 即可** |

---

## Appendix A：環境變數清單

**前端** (`.env.local`)：
```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_GOOGLE_MAPS_API_KEY=
VITE_APPS_SCRIPT_URL=
```

**Apps Script** (`PropertiesService`)：
```
FIREBASE_PROJECT_ID
FIREBASE_SERVICE_ACCOUNT_JSON  # base64 encoded
TG_BOT_TOKEN
TG_CHAT_ID
FINNHUB_API_KEY
GEMINI_API_KEY
GOOGLE_MAPS_API_KEY
FX_API_URL
```

## Appendix B：專案資料夾結構建議

```
personal-hub/
├── apps/
│   └── web/                    # React frontend
│       ├── src/
│       │   ├── components/
│       │   ├── features/
│       │   │   ├── auth/
│       │   │   ├── investments/
│       │   │   ├── fx/
│       │   │   ├── ledger/
│       │   │   ├── trips/
│       │   │   └── itinerary/
│       │   ├── hooks/
│       │   ├── lib/
│       │   │   ├── firebase.ts
│       │   │   ├── appsScript.ts
│       │   │   └── maps.ts
│       │   ├── pages/
│       │   ├── stores/
│       │   ├── types/
│       │   ├── App.tsx
│       │   └── main.tsx
│       ├── public/
│       │   ├── manifest.json
│       │   └── sw.js
│       ├── .env.local.example
│       ├── package.json
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       └── tsconfig.json
├── apps-script/
│   ├── src/
│   │   ├── Main.gs              # doGet / doPost router
│   │   ├── Stocks.gs
│   │   ├── Fx.gs
│   │   ├── Alerts.gs
│   │   ├── Itinerary.gs
│   │   ├── Telegram.gs
│   │   ├── Firestore.gs         # REST wrapper
│   │   └── Triggers.gs
│   ├── appsscript.json
│   └── .clasp.json              # if using clasp
├── firebase/
│   ├── firestore.rules
│   ├── firestore.indexes.json
│   └── firebase.json
├── docs/
│   ├── SPEC.md
│   ├── SETUP.md
│   └── RUNBOOK.md
├── .gitignore
├── README.md
└── package.json                 # workspace root
```

---

**EOF**
