# Feature: taifex

台指期（TX 近月連續）日線波段策略的**虛擬交易**：每天收盤後算訊號，隔天開盤以虛擬單成交，追蹤權益與交易紀錄。
不接券商、不下真實委託、不碰 `portfolio`。完整規劃（策略、文獻、資料流、Rust 引擎評估、接券商路線）見
`docs/TAIFEX_PAPER_TRADING_PLAN.md`；使用說明見 `docs/USER_GUIDE.md`「台指期模擬」。

另有**盤中技術模擬**（§12）：日盤 + 夜盤每 5 分鐘取樣，四個監控頻率（5 / 15 / 30 / 60 分）的虛擬機器人用同一套技術指標進出場，
比較監控頻率、時段與進場時間；週末、國定假日、臨時休市不模擬。與日線波段帳戶完全獨立。

獨立 route `/taifex`，側欄 MARKETS 群組「台指期模擬」。Telegram key `taifex`。

## 資料（前端除 config 外全部唯讀，Rules `write: false`）

| Collection | 寫入者 | 內容 |
|---|---|---|
| `taifex_daily/{yyyyMMdd}` | GAS `runTaifexDaily` | 近月 OHLC、量、未平倉、次月收盤、三大法人淨未平倉、PCR |
| `taifex_signals/{yyyy-MM-dd}` | GAS | 指標、因子、合成分數、事件風險、建議部位、部位快照 |
| `taifex_sentiment/{yyyy-MM-dd}` | GAS（Claude 推送 / 手動貼上） | 整體情緒、驅動因素、事件、隔夜指標 |
| `taifex_paper_accounts/default` | GAS | 權益、部位、待成交單、熔斷、權益曲線（≤ 750 點） |
| `taifex_paper_trades/{id}` | GAS | 已平倉交易（含 `epoch`，重置後新一輪） |
| `taifex_backtests/latest` | GAS 週日 / 手動 | 完整策略 / 純趨勢 / 大盤持有 |
| `taifex_paper_accounts/v_{variant}` | GAS | 策略競賽：基準 / 保守 / 積極 / 最佳化 各一個虛擬帳戶 |
| `taifex_live/current` | GAS 盤中每 5 分鐘 / 18:00 | 即時報價（Fugle → 期交所 MIS → ^TWII + 基差推估）與盤中用的日 K 快取 |
| `taifex_live/tech` | GAS 日盤 + 夜盤每 5 分鐘 | 盤中技術模擬：狀態（交易中 / 休市原因 / 下次開盤）、四個監控頻率的機器人、時段摘要 |
| `taifex_live/tech_bars` | GAS | 5 分 K（≤ 960 根） |
| `taifex_live/tech_trades` | GAS | 技術模擬最近 400 筆交易 |
| `taifex_live/calendar` | GAS 每週 | 證交所休市表快取 |
| `taifex_optimizations/latest` | GAS 週日 / 手動 | walk-forward 參數網格、樣本內 / 外績效、穩定度、風險建議 |
| `taifex_reviews/{週日日期}` | GAS（MCP `commit_taifex_review`；套用 / 退回 / 還原走 action） | 每週檢討：摘要、發現、演算法想法、PR 連結、調整提案（diff、回測對照）、狀態 |
| `taifex_tuning/current` | GAS `applyTaifexReview` / `revertTaifexTuning` | 目前生效的調校值：日線門檻、因子權重、盤中規則（某一區為 null = 用內建預設）、版本、變更紀錄 |
| `taifex_configs/default` | 前端 | 模式、契約、資金、風險、成本、熔斷、通知、主帳戶策略變體、盤中模擬開關、`tech`（技術模擬開關 / 日夜盤 / 口數 / 推播 / 自訂休市日） |

查詢都是單欄位 `orderBy`（`date` / `closeDate`），不需要 composite index。交易分頁、回測分頁打開才讀。

## 操作（全部走 Apps Script，Firebase idToken + owner 角色）

`runTaifexDaily`、`backfillTaifex`、`runTaifexBacktest`、`placeTaifexOrder`、`cancelTaifexOrder`、`resetTaifexPaper`、
`resumeTaifexPaper`、`importTaifexSentiment`、`get/set/revokeTaifexIngestToken`、`diagTaifex`（期交所欄位排查）、
`runTaifexIntraday`（盤中手動模擬一次）、`runTaifexOptimization`、`diagTaifexQuote`（時段 / 休市表 / 即時報價排查）、
`runTaifexTech`（技術模擬手動跑一輪）、`resetTaifexTech`、`refreshTaifexCalendar`（改自訂休市日後重抓休市表）、
`applyTaifexReview` / `rejectTaifexReview` / `revertTaifexTuning`（週檢討提案的套用 / 退回 / 還原最近一次）。
Claude 排程推送走 `ingestTaifexSentiment`（ingest token，只寫不讀）。

## 演算法

- **計算只在 GAS**：純函式 `apps-script/src/TaifexStrategy.gs`（測試 `apps-script/tests/taifex.test.cjs`、
  黃金資料 `apps-script/tests/taifex-golden.test.cjs` + `fixtures/taifex-golden.json`）。
- 前端 `types.ts` 的 `TAIFEX_FACTOR_WEIGHTS` / `TAIFEX_RULES` 只是顯示用，要與 GAS 一致；改公式要升 `TAIFEX_MODEL_VERSION`
  並重新產生黃金資料（`UPDATE_GOLDEN=1`）。
- 回測與虛擬帳戶共用 `stepTaifexAccount_`，結果不會因程式分岔而不一致。
- 盤中技術模擬：純函式 `apps-script/src/TaifexTech.gs`（測試 `apps-script/tests/taifex-tech.test.cjs`），模型版本 `TAIFEX_TECH_VERSION`；
  前端 `tech.ts` 的 `TAIFEX_TECH_RULES` / `TECH_BUCKETS` 只是顯示用，要與 GAS 一致。改公式升版本並重置技術模擬。
- 交易時段與休市一律用 `tfSessionAt_` + `loadTaifexHolidays_()`；前端 `sessionByClock` 只看時鐘（決定要不要輪詢），休市以 `status.state` 為準。
- 設定頁只能調資金管理。門檻、因子權重、盤中規則只能經「每週檢討」調整（見下節），不提供自由輸入（防過擬合）。

## 每週檢討與調校

- 流程：Claude 排程（週日 21:30）→ MCP `taifex_weekly_review`（唯讀）→ `preview_taifex_review` → `commit_taifex_review`
  存成 `taifex_reviews/{週日}`（**不改任何參數**，推播 Telegram）→ owner 在「週檢討」分頁套用 / 退回 → 可還原最近一次。
- 可調範圍與上下限寫死在 `apps-script/src/TaifexTuning.gs` 的 `TAIFEX_TUNING_BOUNDS`（純函式，測試 `apps-script/tests/taifex-tuning.test.cjs`）；
  IO 在 `TaifexReview.gs`。讀取調校值一律經 `loadTaifexTuning_()`（會重驗範圍，壞掉的區塊退回預設）。
- 日線門檻 / 權重套用後寫進 `taifex_tuning/current`，主帳戶切到策略變體 `tuned`（「Claude 調校」）；`v_tuned` 也是策略競賽的一員。
  資金管理直接改 `taifex_configs/default`；盤中規則由 `tfTechRules_()` 覆寫 `TAIFEX_TECH_RULES`。
- 調參數不升 `TAIFEX_MODEL_VERSION`（公式沒變、黃金資料不變）；改公式才升版，由 Claude 開 PR、owner 合併。
- 前端 `review.ts`（型別、解析、標籤、排程提示詞）+ `components/taifex-review.tsx`；`TUNING_LABELS` 要與 GAS `TAIFEX_TUNING_LABELS` 一致。

## 前端

- `dashboard.ts`、`perf.ts`（績效評估、策略競賽排行）、`claude-schedule.ts`、`types.ts` 解析：純函式，測試 `apps/web/tests/taifex.test.cjs`。
- 交易紀錄 collection 混有策略變體（`accountId`），主帳戶畫面一律以 `accountId === account.id` 過濾。
- 盤中（08:45–13:45）帳戶與即時報價每 60 秒重抓（`refetchInterval`），盤外不輪詢。
- `tech.ts`（解析、頻率排名、進場時間分段、累計損益曲線）+ `components/taifex-tech.tsx`（「盤中技術」分頁）：分頁打開才讀，日盤 / 夜盤時間每 60 秒重抓。
- `components/taifex-sim.tsx`：分頁容器、資料更新、空狀態（回補歷史資料）、下單與 Claude 對話框。
- 顏色沿用 app 慣例（獲利綠、虧損紅）；多空方向一律文字 + icon（`TargetBadge`）。
- App 內說明 `taifex-guide.tsx` 與 `docs/USER_GUIDE.md` 要一起更新。

## 與其他 feature 的關係

- 與 `stock-radar` 共用設計模式（Claude 輿情 token、確定性公式、成績可信），資料完全獨立。
- 與 `investments` 無資料關聯；虛擬帳戶不計入淨值。
