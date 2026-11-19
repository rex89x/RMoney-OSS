# itinerary — 行程規劃

> 旅程（`trips`）與行程的整體說明、巧明日常匯入 / 匯出、AI 文字匯入流程見 `features/trips/README.md`。本檔只寫 itinerary 資料夾本身的責任邊界。

## 職責
- `/trips/:id/itinerary` 的 `ItineraryEditor`（Timeline / Map / List）、項目編輯（`item-dialog`）、地點搜尋（`place-search`）、地圖（`map-view`）。
- 行程 / 天 / 項目的 CRUD、排序、整天搬移（`moveDay`）、整天刪除（`deleteDay`）。
- AI：Claude 生成整份 draft、單日建議、旅遊筆記、文字 → 行程（`ai-import.ts` 純函式 + `apply-ai-import.ts` 寫入）。
- 背景定位（`locate.ts`）：Google Maps 連結解析 / geocode 補座標。

## 資料模型
- `itineraries/{tripId}`（`itineraryConverter`）：`tripId`、`title`、`summary?`、`tips?`、`notes?`（markdown）、`notesUpdatedAt?`、`generatedByLLM?`、`llmModel?`、`destination?`、`startDate?` / `endDate?`（date-only string）。doc id 一般等於 tripId。
- `itineraries/{tripId}/days/{YYYY-MM-DD}`：`date`、`theme?`。
- `.../days/{dayId}/items/{itemId}`：`order`、`startTime?` / `endTime?`、`type`（transport / meal / activity / accommodation / shopping）、`title`、地點欄位（`placeId` / `placeName` / `address` / `lat` / `lng` / `mapsUrl`）、`estimatedCost?` / `actualCost?` / `currency?`、`linkedTxId?`、`status`（planned / done / skipped）、匯入用 `sourceId?` / `sourcePlaceQuery?`、營業時間 `openingHours?`（見下）。

## 與其他 feature 的依賴
- `features/trips`：旅程 metadata、權限（rules 以對應 trip 的 `canReadTrip` / `canWriteTrip` 判斷；share user 只能讀）、巧明日常匯入共用的 `guessItemType`。
- `features/import/json-repair`：AI 回傳 JSON 修復（pitfall #25）。

## Apps Script 端（`Itinerary.gs`，皆為前端觸發的 action，無排程）
- `generateItinerary`：Claude 生成並寫入 `itineraries/{tripId}` 與 days / items。
- `parseItineraryText`：文字 → JSON（只回傳、不寫 Firestore）。
- `suggestDayItems`、`generateTripNotes`：單日建議、旅遊筆記。
- `placesSearch`、`geocode`、`resolveGoogleMapsUrl`：地點搜尋與定位，Places API key 留在 GAS。
- `placeDetails`：營業時間（Place Details，fields 只要 `place_id,opening_hours,utc_offset_minutes,business_status,url`，`language=zh-TW`），結果放 Script Cache 6 小時。和其他 itinerary action 一樣不在 `MEMBER_ALLOWED_ACTIONS_`，只有 owner / admin 能呼叫。測試 `apps-script/tests/itinerary-place-details.test.cjs`。

## 營業時間（2026-11）
- 項目有 `placeId` 時，Timeline 檢視在卡片上顯示「那天」的營業時間（Google `weekday_text`，index 0 = 星期一），排定時間不在營業時間、可能在結束前打烊、當天公休、暫停營業 / 永久歇業會出警示。
- `useItemOpeningHours`：item 上的 `openingHours` 沒過期就直接用；沒抓過、`placeId` 換了、或超過 14 天，且使用者是 owner / admin 角色時才呼叫 Apps Script；trip writer 會把結果存回 item（`saveItemOpeningHours`），共享成員只看已存的。交通 / 住宿類型不抓（省 Places 費用）。
- `openingHours`：`placeId`、`weekdayText[]`、`periods[]`（`{ open: { day, time: 'HHmm' }, close? }`，沒有 close = 24 小時）、`utcOffsetMinutes`、`businessStatus`、`url`、`noHours`、`fetchedAt`（Timestamp ↔ Date 在 converter）。
- 純函式 `opening-hours.ts`（測試 `apps/web/tests/itinerary-hours.test.cjs`）：`isOpenAt(periods, date, utcOffsetMinutes)` 用**地點的** utc offset 換回當地牆上時間再比對（不是台北、不是主機時區），處理跨夜、跨週（週六 → 週日）、24 小時；`evaluateItemHours` 把 day id（`yyyy-MM-dd`，當地日期）+ startTime / endTime 當作地點當地時間。

## 路線（2026-11）
- Timeline 工具列「路線」：用 Google Maps URLs（`https://www.google.com/maps/dir/?api=1&origin=…&destination=…&waypoints=a|b&travelmode=…`）依序開當天路線，**不用 Directions API、不計費**。有 `placeId` 帶 `origin_place_id` / `destination_place_id`；`waypoint_place_ids` 只有每個 waypoint 都有 place_id 才帶（必須一一對應）。
- 純函式 `directions.ts`：`itemsToRouteStops`（沒有地點的項目略過、連續同一點合併）、`buildDirectionsLinks`（一個連結最多 9 個 waypoints，觸控裝置用 3 個；超過就切段，下一段從上一段終點出發；`transit` 不支援 waypoints → 每段只有起訖）。
- 地圖（`map-view.tsx` `MapView`）用虛線直線依序連起當天的點，只示意順序，不是實際路線。

## 注意事項
- 大量寫入用 `chunked-batch.ts`（每個 batch ≤ 450 筆，Firestore 上限 500）。
- 地點搜尋走 Apps Script `placesSearch`，輸入 debounce 400ms；地圖顯示才在前端載入 Maps JS API（`VITE_GOOGLE_MAPS_API_KEY`，以 HTTP Referer 限制）。
- `days` / `items` 子集合的 rules 以 `trips/{itineraryId}` 判斷權限，所以 itinerary doc id 必須等於 tripId。
