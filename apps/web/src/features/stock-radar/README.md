# Feature: stock-radar

每天盤前評估「持股 + 自選股」：持有中建議加碼／續抱／減碼／出場，自選股建議買進候選／觀望／避開。
只產生建議，不碰 `portfolio`、不接券商、不下單。完整規劃見 `docs/STOCK_RADAR_PLAN.md`，
Claude 排程設定見 `docs/INTEGRATIONS_SETUP.md` §1.2，使用說明見 `docs/USER_GUIDE.md`「股市雷達」。

獨立 route `/stock-radar`，側欄 MARKETS 群組；首頁卡片 `stockRadar`（投資段）。

## 資料（前端除 config 外全部唯讀，Rules `write: false`）

| Collection | 寫入者 | 內容 |
|---|---|---|
| `stock_radar_runs/{yyyy-MM-dd}_{TW\|US}` | GAS `runStockRadar*`、輿情推送後重新合成 | regime、每檔因子、量化分數 `quantScore`、輿情加減分、最終動作與原因 |
| `stock_radar_sentiment/{同 id}` | GAS（Claude 推送 / 手動貼上） | 每檔輿情、市場整體輿情、來源 |
| `stock_radar_outcomes/{同 id}` | GAS 每天回填 | 每檔隔天開盤進場後 1/5/20 日報酬 + 大盤同期 |
| `stock_radar_backtests/{TW\|US}` | GAS 每週日 | walk-forward 回測結果 |
| `stock_radar_flows/{yyyyMMdd}` | GAS 01:00 | TWSE 三大法人淨買超、融資餘額（全市場） |
| `stock_radar_configs/default` | 前端 | 已複製到 Claude 排程的代號清單（提醒重新複製） |

前端讀最近 120 筆 runs / outcomes（約 60 個交易日 × 2 市場），單欄位 `orderBy('runDate')`，不需要 composite index。
成績單、回測分頁打開才讀。

## 演算法

- 純函式在 `apps-script/src/StockRadarFactors.gs`（`apps-script/tests/stock-radar.test.cjs`）：價格因子、籌碼因子、
  regime、輿情合成、動作判定、事後報酬、回測核心。
- 因子 key、權重、動作／原因 key 要與 `types.ts`、`options.ts` 一致；改公式就升 `STOCK_RADAR_MODEL_VERSION`，
  成績單可依版本篩選。
- 每個因子用文獻的絕對定義轉成 [-1, 1]，不做橫斷面 z-score（個人清單檔數太少）。籌碼因子只有台股，美股不計入 coverage 分母。
- 輿情：`sentiment × confidence × 0.25` ± 財報 0.05，上限 ±0.3，沒有 https 來源不計分；事件風險暫緩加碼／買進；
  市場輿情明顯偏空 → regime 降一級。最終動作由公式決定，不採用模型的買賣建議。

## Claude 排程（只寫不讀）

- `claude-schedule.ts`：token（`rmsr_`，前端 CSPRNG，GAS 只存 SHA-256）、每個市場一份提示詞（只帶代號與名稱；清單由 `buildPromptUniverse` 即時讀持股 + 自選股，規則同 GAS `stockRadarUniverse_`，不依賴當天評估是否已跑）、貼上解析（走 `features/import/json-repair.ts`）、同步狀態。
- `components/stock-claude-dialog.tsx`：token 產生／撤銷、複製提示詞、手動貼上（`importStockSentiment`，Firebase 驗證）。
- GAS 端 `apps-script/src/StockRadarIngest.gs`：只接受目前追蹤清單內代號，每市場每天 6 次。

## 前端

- `dashboard.ts`、`track-record.ts`：純函式，`apps/web/tests/stock-radar.test.cjs`。
- `components/stock-radar.tsx`：今日／個股／成績單／回測／使用說明分頁、市場切換、重新評估、Claude 排程對話框。
- App 內說明 `stock-radar-guide.tsx` 與 `docs/USER_GUIDE.md`「股市雷達」章節要一起更新。
- Telegram key `stockRadar`（設定 → 通知）。

## 與其他 feature 的關係

- `investments`：共用 `stocks/{symbol}/candles` 日 K 與 `portfolio` / `watchlist`；短波段實驗（swing）是另一套紙上交易，互不影響。
