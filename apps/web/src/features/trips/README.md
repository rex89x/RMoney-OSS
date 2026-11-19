# Feature: trips + itinerary

## trips
- `trips/{tripId}` — 每趟出遊的 metadata (名稱、日期、幣別、預算)
- 花費**不**存在 trip 內部 — 只是 `transactions` 帶 `tripId` (pitfall #6)
- `/trips/:id` summary：多幣別彙總 + 原幣 + TWD 換算 + 預算進度

## itinerary
- `itineraries/{itineraryId}` — 通常 itineraryId = tripId (簡化關聯)
- `itineraries/{id}/days/{dayId}/items/{itemId}` — 三層 subcollection
- Editor 有 Timeline / Map / List 三種模式
- LLM 透過 Apps Script 產生 draft；前端**不**直接呼叫 Claude API
- Map 用 `Google Maps JS API`，API key 前端可用 (綁 HTTP Referer)
- 營業時間（Apps Script `placeDetails`）與每日「路線」（Google Maps URLs，不用 Directions API）見 `features/itinerary/README.md`

**防坑**：地點搜尋走 Apps Script `placesSearch`（Places API key 不在前端），輸入有 debounce（`place-search.tsx`），不是前端 Autocomplete 逐鍵計費。

## flight-watches

想去但尚未建立正式 trip 的目的地放在 `flight_watches` feature。出遊列表頁會顯示公開機票價格區間與來源；每日搜尋、歷史快照和 Telegram 價格提醒都由 Apps Script 負責。

## 從巧明日常匯入行程

出遊頁「從巧明日常匯入」（或巧明日常帶 `/trips?import=chiauming` 開過來）貼上巧明日常旅程「行程 → 複製到 RMoney」的 JSON（`chiauming-trip` v1）。

- `import-chiauming.ts`：strict Zod 解析 + 純規劃（依日期分組、時間排序、依關鍵字猜 `type`、旅程日期往外擴到涵蓋所有停留點）。測試在 `apps/web/tests/trip-import.test.cjs`。
- `apply-chiauming-import.ts`：寫 Firestore。新建或更新既有旅程（只有 owner 能寫行程表，所以只列自己的旅程）；項目 ID = `cm100_` + sha256(sourceId) 前 40 碼，**重新匯入是更新不是重複**。巧明日常刪掉或改日期的停留點會移除舊位置的項目；使用者在 RMoney 自己加的項目（沒有 `sourceId`）一律不碰。地點字串沒變時保留已 geocode 的座標，變了才在背景重新補（共用 `apply-template.ts` 的 `backgroundGeocode`）。
- 匯入後把「巧明日常旅程 key → RMoney trip id」寫進貼上匯入的設定（`ledger/paste-import-settings.ts`），之後貼同一趟旅程的費用會預選這趟。
- 格式改動要同步巧明日常 `src/lib/rmoney-trip-transfer.ts`。

## 旅伴與共同帳本成員（2026-10）
- `companions.ts` / `known-companions.ts`：常用旅伴 = 共同帳本成員（帶 uid）+ 之前任何旅程加過的人；成員面板「新增成員」可一鍵加入，缺共同帳本成員時面板上方會提示一鍵補齊。
- 分享給共同帳本成員（share-dialog）= 他就是旅伴：會一併補進 `trip.members`（帶 uid）。建立旅程時若開了「自動分享」，共同帳本成員（含自己）直接成為成員。
- 分攤名單（`ledger/split-context.ts` `buildSplitContext`）把 `trip.sharedWith` 裡的共同帳本成員也當旅伴，建立者一定在名單內；成員是否為共同帳本成員一律標示。

## AI 文字匯入行程（2026-11）
旅程列表「AI 匯入行程」（建新旅程）或行程規劃頁「貼文字 AI 匯入」（加進這趟）。貼攻略、訂房信等文字 → 整理成每天的停留點 → 預覽勾選 → 寫入並在地圖定位。

- 純邏輯 `itinerary/ai-import.ts`（測試 `apps/web/tests/itinerary-ai-import.test.cjs`），寫入 `itinerary/apply-ai-import.ts`，背景定位 `itinerary/locate.ts`。
- 與巧明日常 `src/lib/trip-ai-import.ts` **同一份契約與規則**（`{ trip?, stops[], warnings[] }`，RMoney 多了 type / endTime / address / estimatedCost / currency / mapsUrl 選填欄位），改一邊要改另一邊。
- 兩條路：站內 Claude（Apps Script `parseItineraryText`，只回 JSON、不寫 Firestore、計入 Claude 額度 `itineraryImport`）；外部 AI（複製提示詞給 Claude / ChatGPT，要求附查證過的 Google Maps 連結、查不到省略）。
- 定位優先序：連結內含座標直接寫入 → 短網址交給 `resolveGoogleMapsUrl` → 沒連結用 Places 搜尋「mapQuery 或地名＋目的地」；交通類沒連結不定位。只接受 Google Maps 網域的連結。
- 項目 ID `ai_` + sha256(日期|時間|正規化標題)：重貼同一份是更新；只覆蓋 AI 管的欄位，實際花費、狀態、連結的交易保留。
- 全程地圖顯示「N 個項目還沒定位」，旅程擁有者可一鍵「重新定位」。

## 複製到巧明日常（2026-11）
旅程頁「匯出 → 複製到巧明日常」：`export-chiauming.ts` 產生 `rmoney-trip` v1（行程＋花費），巧明日常 `src/lib/rmoney-trip-import.ts` 接收。方向是 RMoney → 巧明日常，改格式兩邊一起改。

- 行程帶地圖連結與座標；原本從巧明日常匯入的項目帶 `originId`，回去時更新原停留點。
- 花費用 `computeSettlement(..., { householdMemberIds: [] })` 的分攤明細，只匯巧明兩人負擔的份（台幣）；朋友先付、兩人沒分擔、`importSourceId` 是 `chiauming-100:` 的交易略過並列出原因。測試 `apps/web/tests/chiauming-export.test.cjs`。
- 人員對應預設：自己 = 明、共同帳本另一位 = 巧，可在對話框改。JSON 不帶帳戶、餘額、uid、email。

## 行李清單（2026-11）
旅程頁「行李」分頁（`components/trip-packing-panel.tsx`）：依分類分組的勾選清單、打包進度條（x / y 已打包）、新增 / 編輯 / 刪除、「從範本產生」、「全部取消勾選」、只印清單的「列印」（`body.print-packing` + `index.css` print 規則）。

- 資料：子集合 `trips/{tripId}/packing/{itemId}`（`packingItemConverter`）：`name`、`category`（documents / clothes / toiletries / electronics / health / other）、`packed`、`quantity`、`assignee`（旅伴 uid 或 null）、`order`、`createdAt`、`updatedAt`。選子集合而不是 trip 欄位，是為了旅伴同時勾選不會互相蓋掉整份清單。
- 權限（`firestore.rules` `match /packing/{itemId}`）：讀 = `canReadTrip`；新增 / 刪除 / 改名稱分類數量 = `canWriteTrip`（owner / admin）；被分享的旅伴只能改 `packed` / `assignee`（加 `updatedAt`）。測試在 `tests/rules/firestore.rules.test.mjs`。
- 範本（`packing-template.ts`，純函式，測試 `apps/web/tests/trips-packing.test.cjs`）：天數用台北日曆日（`daysBetweenTWDates`），衣物最多帶一週份、5 天以上加洗衣袋；季節看出發月份（台北時間，南半球目的地反轉）；目的地認得熱帶 / 寒冷地名時覆蓋季節，認不得只看季節；國外（目的地非台灣地名或有外幣）加護照、簽證、旅平險、外幣、轉接頭、網卡 / eSIM。對話框可手動改國內外與氣候。名稱已存在的項目不重複加入。
- 勾選、指派、刪除、全部取消勾選用 TanStack `onMutate` 樂觀更新，失敗還原並 toast。範本與全部取消勾選用 batch 寫入。
