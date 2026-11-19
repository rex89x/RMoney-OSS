# 台指期虛擬交易（TAIFEX Paper Trading）規劃

> 狀態：P1（資料 + 策略 + 虛擬帳戶 + 回測 + 輿情 + UI）已實作（2026-11-09）；P2（每日自動化、盤中模擬、績效評估、下單建議、策略競賽與 walk-forward）見 §11（2026-11-10）；
> P3（日盤 + 夜盤的盤中技術模擬、監控頻率比較、休市判斷）見 §12（2026-11-12）。
> 定位：**日線波段策略的虛擬單模擬**。不接券商、不下真單、不碰 `portfolio`。
> 目標：先用虛擬帳戶跑出至少 3 個月的「實盤前紀錄」，策略穩定後再依 §9 接券商 API。

---

## 1. 為什麼是「日線波段」而不是當沖

| 考量 | 日線波段（本版） | 當沖 / 分鐘線 |
|---|---|---|
| 資料來源 | 期交所每日公開 CSV（免費、權威） | 需要券商即時報價 API（Shioaji / 富邦 Neo 等） |
| 執行環境 | Apps Script 排程即可 | 需要常駐程式（GAS 6 分鐘逾時、不能常駐連線） |
| 文獻支持 | 趨勢追蹤在期貨上有百年證據（§3） | 扣掉手續費 + 滑價後多數策略的期望值為負 |
| 個人可維護性 | 每天收盤後算一次、隔天開盤成交 | 需要盯盤、斷線處理、風控即時性 |

結論：先把日線波段做到「規則固定、可回測、可追蹤」，接券商時再評估是否加入盤中停損單。

---

## 2. 資料來源（全部公開、免金鑰，GAS 端抓）

| 資料 | 來源 | 用途 |
|---|---|---|
| 台指期日行情（所有月份、一般 / 盤後） | 期交所 `futDataDown`（CSV，Big5），`commodity_id=TX` | 價格、成交量、未平倉；近月連續序列 |
| 三大法人台指期未平倉 | 期交所 `futContractsDateDown`（CSV） | 外資 / 投信 / 自營商淨未平倉口數 |
| 選擇權 Put/Call Ratio | 期交所 `pcRatioDown`（CSV） | 未平倉 PCR、成交量 PCR |
| 輿情 / 事件 | Claude 排程上網整理 → `ingestTaifexSentiment` | 市場情緒分數、重大事件（FOMC、CPI、央行、結算、地緣政治） |

- 解析器以「欄位名稱關鍵字」對應欄位，不依賴欄位順序；欄位改名時 `diagTaifex`（owner 限定）會回傳原始回應前幾行方便排查。
- 期交所資料通常 15:00 前後更新；排程在 18:00 抓取當天資料。

### 2.1 近月連續序列

- 每天只保留**月契約**（排除週契約 `W`、價差 `/`），交易時段取「一般」。
- 近月 = 到期日（每月第三個週三）**晚於當天**的最近月份 → 結算日當天已換到次月。
- 換月：前一天同時記下次月收盤價 `nextClose`，換月價差 `rollGap = 次月收盤 − 近月收盤`。
  - 指標計算用「往回調整」(back-adjusted) 序列，最新一段等於真實價格。
  - 持倉跨換月：等同在前一天收盤平舊倉、開新倉；停損價、進場價一起平移 `rollGap`，並扣一次雙邊成本。

---

## 3. 策略（模型版本 `tx-v1`，參數凍結）

原則（沿用股市雷達）：**只用跨市場被反覆驗證的因子、參數採文獻預設值、不在自己的少量資料上調參**；
要改公式就升版本，新舊版本績效分開看。

### 3.1 因子（每個轉成 [-1, 1]）

| 因子 | 權重 | 定義 | 依據 |
|---|---|---|---|
| `trend` 趨勢 | 0.30 | ½·clip((EMA20−EMA60)/(2·ATR20)) + ½·clip((收盤−EMA60)/(3·ATR20)) | Hurst, Ooi & Pedersen (2017) *A Century of Evidence on Trend-Following Investing*；Brock, Lakonishok & LeBaron (1992) |
| `breakout` 通道突破 | 0.20 | 55 日唐奇安通道位置 ×2−1 | Donchian 通道 / Turtle 系統；Faith (2007) *Way of the Turtle* |
| `tsmom` 時間序列動能 | 0.20 | 60 日報酬 ÷ (日波動 × √60)，÷2 後 clip | Moskowitz, Ooi & Pedersen (2012) *Time Series Momentum*, JFE |
| `foreignFlow` 外資籌碼 | 0.20 | 外資台指期淨未平倉：½·z(水位,120d) + ½·z(5 日變化,120d)，÷2 後 clip | Lai & Wang (2015) *J. Behavioral Finance*：外資淨部位對台指期報酬有顯著正向效果；多篇台灣碩論同向 |
| `pcr` 選擇權 PCR | 0.10 | 未平倉 PCR 的 120 日 z-score ÷2（台灣賣方結構：PCR 高＝下檔支撐強） | Pan & Poteshman (2006) RFS（選擇權部位含資訊）；權重刻意偏低，文獻結論分歧 |

- 每個因子缺資料就不計入分母（`coverage` 顯示涵蓋率）；coverage < 0.5 不產生新進場。
- 外資 / PCR 用單一市場自身的時間序列 z-score（不是寫死的口數門檻），法規或市場規模改變時會自動適應。

### 3.2 合成與濾網

```
quant      = Σ wᵢ·sᵢ / Σ wᵢ(有資料)
sentiment  = clip(輿情分數 × 信心 × 0.2, ±0.2)        沒有 https 來源 → 0
composite  = clip(quant + sentiment, ±1)
ADX14 < 18 （無趨勢盤整）→ composite × 0.6           Wilder (1978) ADX；降低盤整期來回停損
```

輿情只作**輔助與否決**：Antweiler & Frank (2004)、Tetlock (2007) 的結論是新聞 / 社群情緒對方向預測力弱、對波動與風險較有用，
所以輿情最多推 ±0.2，且主要用在「事件風險 → 暫停新進場」。

### 3.3 進出場（含遲滯，避免來回洗）

| 目前部位 | 條件 | 動作 |
|---|---|---|
| 空手 | composite ≥ +0.35 且 trend ≥ 0 | 做多 |
| 空手 | composite ≤ −0.35 且 trend ≤ 0（且允許放空） | 做空 |
| 多單 | composite ≤ −0.35 | 反手做空（不允許放空則平倉） |
| 多單 | composite ≤ +0.05 | 平倉 |
| 空單 | 對稱 | — |
| 任何 | 下一個交易日有高重要性事件（FOMC / CPI / 央行 / 地緣政治，由輿情回報）| **不新開倉**，既有部位照停損管理；結算日只提示不擋 |
| 任何 | 帳戶回撤 ≥ 上限（預設 20%） | 熔斷：平倉並停止新進場，需在 UI 手動解除 |

### 3.4 停損與部位大小

- 初始停損：進場價 ∓ 2×ATR20；移動停損（Chandelier）：持倉期間最高收盤 − 3×ATR20（空單對稱），只往有利方向移動。
- 日線模擬：隔天開盤成交；停損用當天高低價檢查，跳空穿越則以開盤價成交（不美化成停損價）。
- 口數 = floor(權益 × 每筆風險% ÷ (停損點數 × 每點價值))，再受以下上限：
  - 保證金使用率 ≤ 40%（口數 × 原始保證金 ≤ 權益 × 40%）
  - 最大口數（設定）
  - 算出 0 口 → 不進場並提示「資金不足以符合風險預算，改用較小契約」
- 波動越大停損越遠 → 口數自動變少，等同波動目標（Moreira & Muir 2017；Turtle N 值部位法）。

### 3.5 成本模型（設定可調）

| 項目 | 預設 |
|---|---|
| 契約 | 微台 TMF（10 元/點）；可選小台 MTX（50）、大台 TX（200） |
| 手續費 | 每口單邊 TX 60 / MTX 30 / TMF 15 元 |
| 期交稅 | 契約價值 × 十萬分之二（單邊） |
| 滑價 | 每口單邊 1 點 |
| 原始保證金 | TX 350,000 / MTX 87,500 / TMF 17,500（**估計值，請依期交所公告調整**） |

---

## 4. 每日流程

```
08:00 TPE  tick_daily_0800 → taifexPreOpenReview()
           讀昨晚~今早收到的 Claude 輿情：
           - 今天有高重要性事件，或輿情強烈反向（分數×信心 ≤ −0.5）
             → 取消「新開倉 / 反手」的待成交單（只會否決，不會新增）

18:00 TPE  tick_daily_1800 → runTaifexDaily()
           1. 抓期交所當天日行情 + 三大法人 + PCR → taifex_daily/{yyyyMMdd}
           2. 對每根尚未處理的 K 棒：
              a. 換月平移（rollGap）
              b. 開盤成交待成交單（自動 / 手動）
              c. 用當天高低檢查停損
              d. 以收盤價結算權益、更新回撤、熔斷檢查
              e. 計算訊號 → taifex_signals/{yyyy-MM-dd}；自動模式下產生明天的待成交單
           3. Telegram 推播（key: taifex）

週日 20:00  runTaifexBacktest() → taifex_backtests/latest
```

Claude 排程（claude.ai scheduled task，建議 07:30 與 17:00 各一次）上網整理：美股 / 費半 / 台積電 ADR 隔夜表現、
Fed / 央行 / 經濟數據行事曆、外資動向新聞、地緣政治、PTT 股板與鉅亨等情緒 → POST `ingestTaifexSentiment`。

---

## 5. Firestore Schema（前端除設定外全部唯讀）

| Collection | 寫入者 | 內容 |
|---|---|---|
| `taifex_daily/{yyyyMMdd}` | GAS | 近月 OHLC、結算價、量、未平倉、次月收盤、三大法人淨未平倉、PCR |
| `taifex_signals/{yyyy-MM-dd}` | GAS | 指標、因子、composite、事件風險、建議部位、原因 |
| `taifex_sentiment/{yyyy-MM-dd}` | GAS（Claude 推送 / 手動貼上） | 市場情緒、驅動因素、事件行事曆、來源 |
| `taifex_paper_accounts/default` | GAS | 權益、部位、待成交單、熔斷狀態、權益曲線（最多 750 點） |
| `taifex_paper_trades/{id}` | GAS | 已平倉交易（進出場、損益、成本、原因、來源 auto/manual） |
| `taifex_backtests/latest` | GAS | 回測：完整策略 / 純趨勢 / 買進持有三組對照 |
| `taifex_configs/default` | 前端（owner） | 模式、契約、資金、風險%、口數上限、成本、熔斷門檻、通知 |

Rules：前五個 `write: false`（帳戶與成績只能由確定性程式產生，避免手動改出好看的績效）；`taifex_configs` owner 讀寫。
手動下單 / 取消 / 重置帳戶 / 解除熔斷都走 Apps Script action（Firebase idToken + owner 角色），不直接寫 Firestore。

---

## 6. UI / UX（`/taifex`，側欄 MARKETS「台指期模擬」）

設計原則：**一眼看懂今天該做什麼 → 為什麼 → 風險在哪**；手機優先、所有數字附單位、虛擬交易標示不可省略。

| 分頁 | 內容 |
|---|---|
| 總覽 | 訊號卡（做多 / 做空 / 空手、composite 量表、主要原因）、部位卡（方向、口數、成本、未實現損益、停損距離）、帳戶卡（權益、報酬、最大回撤）、待成交單橫幅（可取消）、事件風險提示、資料更新時間 |
| 訊號 | 價格 + EMA20/60 + 停損線走勢圖、因子拆解長條、ADX / ATR / 外資 / PCR 數值、近 20 日訊號表 |
| 交易 | 權益曲線、交易紀錄（勝率、獲利因子、平均持有天數）、手動下單 |
| 回測 | 三組對照的績效表與權益曲線、說明樣本期與限制 |
| 設定 | 模式（自動跟單 / 只給建議）、契約、資金、風險、成本、熔斷、重置帳戶 |
| 說明 | 策略邏輯、因子文獻、限制、Claude 排程設定步驟 |

- 空狀態：沒有資料時給「回補歷史資料（約 2 年）」按鈕。
- 危險操作（重置帳戶、反手）用 shadcn Dialog 二次確認，不用 `window.confirm`。
- 顏色：沿用 app 既有慣例（獲利 = 綠、虧損 = 紅）；多空方向一律用文字 + icon（TrendingUp / TrendingDown）表示，不只靠顏色。

---

## 7. 防過擬合與驗證

- 策略參數凍結在 `TAIFEX_MODEL_VERSION`；使用者能調的只有資金管理（風險%、口數、成本），不能調因子權重或門檻。
- 回測同時跑「完整策略」「純趨勢（只用 trend/breakout/tsmom）」「買進持有」，看籌碼因子是否真的有增量貢獻。
- 回測與虛擬帳戶共用同一個 `stepTaifexAccount_` 純函式 → 回測結果與實際模擬不會因為程式分岔而對不起來。
- 指標：總報酬、CAGR、年化 Sharpe、最大回撤、勝率、獲利因子、交易次數、平均持有天數、曝險比例。
- 已知限制：期交所 CSV 回補上限約 3 年；三大法人資料需另抓；輿情沒有歷史，回測不含輿情。

---

## 8. 實作對照

| 層 | 檔案 |
|---|---|
| 純函式（指標、因子、帳戶步進、回測） | `apps-script/src/TaifexStrategy.gs`，測試 `apps-script/tests/taifex.test.cjs` |
| 期交所資料抓取 / 解析 | `apps-script/src/TaifexData.gs` |
| 每日流程、虛擬帳戶、手動下單、回測、推播 | `apps-script/src/TaifexPaper.gs` |
| Claude 輿情推送 | `apps-script/src/TaifexIngest.gs` |
| 盤中步進、下單建議單、walk-forward、報價解析（純函式） | `apps-script/src/TaifexLive.gs`，測試 `apps-script/tests/taifex-live.test.cjs` |
| 盤中模擬排程、報價抓取 | `apps-script/src/TaifexIntraday.gs` |
| 前端 | `apps/web/src/features/taifex/`、`apps/web/src/pages/taifex-page.tsx` |

---

## 9. 之後串接券商 API 的路線

1. **紙上驗證期**：虛擬帳戶至少 3 個月（約 60 個交易日），且回測與虛擬帳戶績效方向一致才進下一步。
2. **下單抽象層**：GAS 不直接打券商。待成交單寫入 `taifex_orders`（status: `pending → sent → filled / rejected`），
   由一個小型常駐服務（Cloud Run + Python）讀取後呼叫券商 SDK：永豐 Shioaji、富邦 Neo API、元大等皆為 Python / C# SDK，
   需要憑證檔與長連線，不適合放在 Apps Script。
3. **安全機制（上線前必備）**：
   - 全域 kill switch（Script Property + UI 按鈕）
   - 每日最大虧損、單筆最大口數、每日最大下單次數
   - 下單前比對虛擬帳戶與真實部位，不一致就停止並推播
   - 先以微台 1 口、`dryRun` 模式（券商模擬環境）並行至少 1 個月
4. **盤中停損**：接上即時報價後改用券商端停損單（STP / MIT），不再依賴日線高低價檢查。

---

## 9.5 Rust 決策引擎（評估 → 分階段實作）

> 狀態：**已評估、尚未實作**。引進新語言 / 新服務超出 CLAUDE.md §2 的技術棧，正式開工前需 owner 確認。

### 9.5.1 現況評估：為什麼 P1 不用 Rust

| 項目 | 數字 | 結論 |
|---|---|---|
| 每日計算量 | 約 750 根日 K × 5 因子，GAS 單次 < 50ms | 運算不是瓶頸 |
| 每日排程瓶頸 | 期交所 3 個 CSV 下載（網路 I/O，約 2–5 秒） | Rust 也快不了 |
| 回測 | 3 組 × 約 500 根，GAS < 1 秒 | 夠用 |
| 部署成本 | GAS 免費、已有 CI；Rust 需 Cloud Run + 容器 + secrets | 現階段只增加維運負擔 |

### 9.5.2 什麼時候值得上 Rust（觸發條件，符合任一項就開工）

1. **接券商即時報價**：tick / 1 分 K 每天數萬到數十萬筆，需要常駐程式做即時指標與盤中停損 → GAS 6 分鐘逾時、不能常駐，必須換。
2. **參數穩健性研究**：walk-forward、Monte Carlo 重抽樣、參數高原掃描、Deflated Sharpe Ratio，動輒上萬次回測 → GAS 會逾時，Rust（rayon 平行化）可在秒級完成。
3. **下單路由**（§9 第 2 點）：需要長連線、風控檢查與 kill switch 的常駐服務 → 同一個服務一起做，避免多一個 Python 中介。

### 9.5.3 架構

```
Firestore（taifex_daily / taifex_signals / taifex_orders）
      ▲                    │
      │ 寫入結果             │ 讀取
┌─────┴────────────────────▼──────────────────────┐
│ taifex-engine（Rust，Cloud Run，最小執行個體 0→1） │
│  axum HTTP API                                   │
│  ├─ POST /v1/signal      單日訊號（與 GAS 同公式） │
│  ├─ POST /v1/backtest    單次回測                  │
│  ├─ POST /v1/robustness  walk-forward / Monte Carlo │
│  └─ （階段 3）WebSocket 券商報價 → 盤中停損 / 下單   │
│  驗證：Firebase idToken（owner 白名單），同 GAS      │
└──────────────────────────────────────────────────┘
      ▲
      │ text/plain POST（沿用 §9 前端呼叫慣例）或由 GAS 轉呼叫
```

- 建議 crate：`axum` + `tokio`（HTTP）、`serde`（JSON）、`rayon`（平行回測）、`polars`（大量 tick 聚合，階段 3 才需要）。
- 指標自己實作（EMA / Wilder ATR / ADX / Donchian 都很短），不依賴第三方 TA 套件，確保與 GAS 結果逐位一致。
- 金額一律以「整數元」或 `i64` 點數 × 10 計算，避免浮點累積誤差影響損益。

### 9.5.4 與 GAS 的一致性（最重要）

- **同一份黃金測試資料**：把 `apps-script/tests/taifex.test.cjs` 的輸入與 `TaifexStrategy.gs` 的輸出匯出成 JSON fixtures，
  Rust 端 `cargo test` 必須逐筆比對（分數到小數 3 位、損益到整數元完全相同）。
- 模型版本 `TAIFEX_MODEL_VERSION` 共用；任一邊改公式都要兩邊同時升版，CI 同時跑兩邊測試。
- 過渡期「影子模式」：Rust 與 GAS 同時算訊號，結果寫到不同欄位，連續 20 個交易日完全一致才切換主力。

### 9.5.5 分階段

| 階段 | 內容 | 前提 |
|---|---|---|
| R0（現在） | 規劃 + 黃金測試資料格式；GAS 維持主力 | — |
| R1 | Rust 移植 `TaifexStrategy.gs` 純函式 + `/v1/backtest` + `/v1/robustness`；前端回測分頁加「穩健性」 | owner 同意新增 Cloud Run 服務 |
| R2 | 影子模式：每日訊號 Rust / GAS 並行比對 | R1 完成 |
| R3 | 券商即時報價 + 盤中停損 + 下單路由（取代 §9 的 Python 中介） | 虛擬帳戶滿 3 個月、§9 安全機制完成 |

### 9.5.6 需要 owner 決定

1. 是否接受新增 Rust 服務（Cloud Run 計費、`apps/engine` 新 workspace、新的 CI workflow 與 GCP service account）。
2. 券商選擇：Shioaji（永豐）目前只有 Python / C# SDK，Rust 端要嘛自行對接其底層協定、要嘛保留一個極薄的 Python 報價轉接層 —
   R3 前需要確認券商是否提供 REST / WebSocket 或 FIX 介面。

---

## 11. P2：每日自動化、盤中模擬、績效評估、下單建議（2026-11-10）

### 11.1 每天自動跑（不需要手動）

| 時間（台北） | 做什麼 |
|---|---|
| 08:00 | 補跑每日流程（18:00 若期交所延遲或逾時失敗）→ 盤前輿情否決 → 依夜盤更新下單建議單 → Telegram「今日下單建議」 |
| 08:45–13:45 每 5 分鐘 | 盤中模擬（§11.2），主帳戶 + 4 個策略變體；國定假日略過 |
| 08:45–13:45、15:00–05:00 每 5 分鐘 | 盤中技術模擬（§12），四個監控頻率 |
| 18:00 | 期交所日 K → 收盤結算 → 訊號 → 明日待成交單 + 下單建議單 → Telegram |
| 21:00 | 再補跑一次每日流程（已處理的 K 棒不會重複） |
| 週日 20:00 | 回測 + walk-forward 參數最佳化（§11.4） |

5 分鐘 trigger（`tick_taifex_intraday`）由 `tick_15min` 自動安裝，部署後不必手動重跑 `setupTriggers`。

### 11.2 盤中模擬

- **報價**：Fugle 期貨盤中 API（Script Property `FUGLE_API_KEY`）優先；沒設定或失敗 → Yahoo `^TWII` + 基差
  （期貨昨收 − 現貨昨收）推估，成交紀錄標示「推估價」。`diagTaifexQuote` 可檢查兩個來源。
- **成交規則**（與回測一致、不偷看未來）：
  - 每筆單有 `validFrom`：平日 08:45 前下的單 → 當天開盤；之後（含盤中、收盤後補跑）→ 下一個交易日。
  - 開盤前就有效的單以**開盤價**成交；盤中下的手動單（`liveOnly`）以**即時價**成交，盤中沒來得及就以當天收盤價。
  - 停損：已持有的部位用當日最高 / 最低檢查（跳空以開盤價），當天以即時價進場的部位只看最新價。
  - 換月在盤中處理一次，收盤結算時 `skipGap` 不再重複。
- **快取**：18:00 寫 `taifex_live/current.context`（最後一根 K、ATR、近月 / 次月），盤中只讀這份，每次約 6 讀 6 寫。
- **推播**：開盤成交（附實單要掛的停損單價格）、停損出場、接近停損（距離 ≤ 0.5 ATR，每天一次）。

### 11.3 下單建議單（`tfBuildOrderTicket_`）

| 情境 | 建議委託 |
|---|---|
| 新倉 / 反手的新倉腿 | 限價（參考價 ± max(10, 0.25×ATR) 點緩衝）、ROD，08:45 前送出；09:00 未成交改範圍市價（MWP）；09:15 仍未成交放棄、不追價 |
| 平倉 / 減碼 | 範圍市價（MWP）、IOC |
| 反手 | 先平倉、確認成交後再送新倉，避免保證金不足 |
| 成交後 | 立刻掛停損單（STP），停損價 = 成交價 ∓ 停損點數；每天收盤依移動停損改單 |

參考價：最新收盤 × (1 + Claude 回報的夜盤漲跌%)，沒有夜盤資料就用收盤。顯示停損風險（元、% 權益）與估計保證金。

### 11.4 報酬最大化測試

- **策略競賽**：四組參數各一個虛擬帳戶（`taifex_paper_accounts/v_*`），同資金、同成本、同盤中模擬，績效分頁依總報酬排名
  （回撤超過熔斷上限的排在後面）。主帳戶可在設定選要跟哪一組。

  | 變體 | 進場 | 停損 | 移動停損 |
  |---|---|---|---|
  | 基準 | ±0.35 | 2×ATR | 3×ATR |
  | 保守 | ±0.45 | 2.5×ATR | 3.5×ATR |
  | 積極 | ±0.25（出場 0） | 1.5×ATR | 2.5×ATR |
  | 最佳化 | 每週 walk-forward 結果 | | |

- **Walk-forward**（`tfOptimizeTaifex_`）：36 組參數；前 60% 歷史以「回撤 ≤ 上限、交易 ≥ 5 筆」下**年化報酬最高**選參數，
  再看它在後 40%（沒看過的資料）的表現。只有樣本外也勝過基準才標示「有效」；同時報告樣本內 / 外報酬的排名相關係數
  （< 0 表示樣本內最佳多半是運氣）。因子權重仍凍結，只調進出場與停損。
- **風險建議**：回撤大致與每筆風險成正比，建議把回測最大回撤拉到熔斷上限的 80%：`建議風險% = 目前風險% × 0.8 × 上限 ÷ 回測回撤`（限制在 0.25–3%）。
  這是「報酬最大化」最直接的槓桿，但也等比例放大虧損，建議先看策略競賽的實際表現。

### 11.5 績效評估（前端 `perf.ts`）

總報酬、年化（滿 20 個交易日才算）、Sharpe、Sortino、最大回撤、Calmar、同期大盤（近月連續、不含槓桿）、曝險、每月報酬。
結論分四級：**樣本不足**（< 60 個交易日且 < 10 筆交易，先參考回測）、良好、普通、不佳；並比對實際 Sharpe 與回測是否落差過大。

---

## 12. P3：盤中技術模擬（日盤 + 夜盤）、監控頻率比較、休市判斷（2026-11-12）

§1 說明過日線波段是主策略；這一節是**獨立的實驗帳**，不影響主帳戶與策略競賽。目的是先累積資料回答三個問題，
之後才有依據調整盤中演算法：

1. **多久看一次盤**（監控頻率）比較好：每 5 / 15 / 30 / 60 分鐘。
2. **日盤還是夜盤**的技術訊號比較可靠。
3. **開盤後多久進場**比較好（依進場時間分段）。

程式：純函式 `apps-script/src/TaifexTech.gs`（測試 `apps-script/tests/taifex-tech.test.cjs`）、排程與資料存取
`apps-script/src/TaifexTechRun.gs`、前端 `features/taifex/tech.ts` + `components/taifex-tech.tsx`（「盤中技術」分頁）。

### 12.1 交易時段與休市

| 時段 | 時間（台北） | 備註 |
|---|---|---|
| 日盤 | 交易日 08:45–13:45 | 同時跑 §11.2 的日線波段盤中處理 |
| 夜盤 | 交易日 15:00–隔日 05:00 | 00:00–05:00 屬於「前一天」開始的夜盤（週六凌晨是週五夜盤；週一凌晨沒有） |

休市判斷（任何一項成立就不模擬、不動部位，只把狀態寫成休市）：

1. **週末**。
2. **國定假日**：證交所 OpenAPI `holidaySchedule`（期交所休市日相同），每週更新一次存 `taifex_live/calendar`；
   表內的「開始交易日 / 最後交易日」是有開盤的日子，會排除。抓不到時用固定日期的國定假日當後備。
3. **自訂休市日**（設定頁，颱風假等臨時休市）。
4. **報價沒在更新**：報價時間戳距今超過 45 分鐘視為臨時休市（最後一道防線；春節前封關日沒有夜盤也靠這條）。

§11.2 的日線波段盤中處理同樣套用 2–4（以前國定假日的平日會拿到前一天的價格）。
`diagTaifexQuote` 會回傳目前時段、下次開盤、休市表與三個報價來源的解析結果。

### 12.2 報價來源

| 順序 | 來源 | 日盤 | 夜盤 |
|---|---|---|---|
| 1 | Fugle 期貨盤中 API（`FUGLE_API_KEY`，夜盤帶 `session=afterhours`） | ✓ | ✓ |
| 2 | 期交所行情資訊網 `mis.taifex.com.tw`（公開、免金鑰、非正式 API） | ✓ | ✓ |
| 3 | Yahoo `^TWII` + 基差推估（標示推估價） | ✓ | ✗（現貨夜間不交易） |

與昨收差距超過 15% 的報價視為解析錯誤直接丟棄。兩個期貨來源都取不到時，該時段不模擬，畫面顯示「取不到夜盤報價」。

### 12.3 模擬方式（模型版本 `txi-v1`）

- 每 5 分鐘取一筆報價 → 累積 **5 分 K**（高低點取樣；若報價的時段最高 / 最低創新，代表這 5 分鐘內到過，一併計入）。
  最多保留 960 根（約 4 個交易日）。
- 四個機器人各自把 5 分 K 合併成自己頻率的 K 棒（以各時段開盤為起點），**只在自己的監控時間**算指標、做進出場決策。
- **停損每 5 分鐘都檢查**（等同掛在交易所的停損單），不受監控頻率影響；成交在停損價。
- 需要 35 根該頻率的 K 棒才開始決策：5 分約 3 小時，60 分約 2 個交易日。

| 因子（各 [-1, 1]） | 權重 | 定義 |
|---|---|---|
| 均線趨勢 | 0.35 | (EMA9 − EMA21) ÷ ATR14 |
| MACD 柱狀體 | 0.25 | MACD(12,26,9) 柱狀體 ÷ (0.25 × ATR14) |
| RSI 動能 | 0.20 | (RSI14 − 50) ÷ 20 |
| 通道位置 | 0.20 | 收盤在前 20 根高低通道中的位置 |

| 規則 | 值 |
|---|---|
| 進場 | 分數 ≥ +0.4 且收盤 > EMA21 做多；≤ −0.4 且收盤 < EMA21 做空（設定不允許放空時只做多） |
| 出場 | 分數回到 0.1 以下（多單）/ −0.1 以上（空單）；強烈反向則反手 |
| 停損 | 進場價 ∓ 2×ATR；移動停損 = 持倉期間最佳收盤 ∓ 3×ATR，只往有利方向移動 |
| 時段結束 | 收盤前 30 分鐘不開新倉、前 10 分鐘一律平倉，不留倉到下一個時段；排程漏跑留下的倉在下個時段第一筆報價時以原時段最後價平倉 |
| 口數 / 成本 | 固定口數（設定，預設 1 口）；契約、手續費、滑價、期交稅沿用主設定，進出各算一次 |

### 12.4 資料（全部在既有的 `taifex_live`，Rules 不變：owner 唯讀、只有 Apps Script 能寫）

| 文件 | 內容 |
|---|---|
| `taifex_live/tech` | `status`（交易中 / 休市原因 / 下次開盤）、四個機器人（部位、累計統計、依時段與進場時間分段的統計、最近一次判斷的指標）、最近 90 個時段摘要 |
| `taifex_live/tech_bars` | 5 分 K |
| `taifex_live/tech_trades` | 最近 400 筆模擬交易 |
| `taifex_live/calendar` | 證交所休市表快取 |
| `taifex_configs/default.tech` | `enabled` / `day` / `night` / `notify` / `contracts` / `extraHolidays` |

配額：每輪約 3 讀 2 寫；一個交易日約 230 輪（日盤 61 + 夜盤 169），遠低於 Firestore 免費額度。休市與時段外只讀 CacheService。

### 12.5 怎麼解讀

- 至少 **30 筆交易**再比較頻率（畫面會標「樣本不足」）；頻率越高交易越多、成本越重，淨損益已扣成本。
- 「每次查看平均損益」= 累計淨損益 ÷ 查看次數，用來公平比較不同頻率花的「盯盤成本」。
- 這是技術指標的實驗帳，規則刻意簡單、參數取常見預設值；要改公式就升 `TAIFEX_TECH_VERSION` 並在分頁按「重置技術模擬」，
  新舊規則的成績才不會混在一起。

---

## 13. P4：每週檢討 → 調校提案 → 核准（2026-11-16）

目的：每週日回頭看這一週的表現，讓 Claude 透過 MCP 取得狀態、提出參數調整；公式層級的調整走 PR。
原本「只開放資金管理、其餘凍結」的設計改成「可以調，但只能經過檢討流程，而且每一項有寫死的上下限」。

### 13.1 流程

| 步驟 | 誰 | 做什麼 |
|---|---|---|
| 週日 20:00 | GAS `tick_weekly_sun_2000` | 回測 + walk-forward 最佳化（既有） |
| 週日 21:30 | Claude 排程 + MCP | `taifex_weekly_review` → `preview_taifex_review` → `commit_taifex_review`，存 `taifex_reviews/{週日}` 並推播 |
| 之後任何時間 | owner（App「週檢討」） | 看 diff 與回測對照 → `applyTaifexReview` / `rejectTaifexReview`；`revertTaifexTuning` 還原最近一次 |
| 需要改公式時 | Claude 排程 + repo | 開 PR（升模型版本、重產黃金資料、測試全過），網址寫進檢討的 `prUrl`；owner 合併才部署 |

排程無人值守，所以 MCP 的寫入只到「提案」為止；真正改參數的動作只有 Firebase 登入的 owner 能做。

### 13.2 可調範圍（`TAIFEX_TUNING_BOUNDS`）

| 區 | key 與範圍 | 生效方式 |
|---|---|---|
| params | entry 0.15–0.6、exit 0–0.3（< entry）、adxTrend 10–30、chopDamp 0.3–1、stopAtr 1–4、trailAtr 1.5–6 | `taifex_tuning/current.params` → 策略變體 `tuned` |
| weights | trend / breakout / tsmom / foreignFlow / pcr 各 0–0.5，總和 1 | `taifex_tuning/current.weights` → `params.weights` → `tfSignalAt_` |
| risk | riskPerTradePct 0.25–3、maxContracts 1–20、maxDrawdownPct 5–40、allowShort（比設定頁的範圍窄） | 直接改 `taifex_configs/default` |
| tech | entry 0.2–0.7、exit 0–0.3、stopAtr 1–4、trailAtr 1.5–6、四個指標權重各 0–0.6 總和 1 | `taifex_tuning/current.tech` → `tfTechRules_()` |

不在表上的（warmup、zLookback、輿情權重、保證金使用率、盤中指標週期…）仍然凍結，要動就是改公式 → PR。

### 13.3 防過擬合

- 提案時跑「目前 vs 提案」回測：完整期間 + 樣本外（後 40%，與每週最佳化同一個切點）；樣本外變差、回撤變大、交易太少都會標警告並顯示在核准畫面。
- 套用日線調整後主帳戶切到 `tuned` 變體，基準 / 保守 / 積極 / 最佳化照常跑 → 策略競賽可以直接看調校有沒有贏基準。
- 排程提示詞的規則：預設不調整、要多週證據、一次最多 3 個 key、每個 key 幅度不超過範圍的四分之一、剛調過的至少觀察 3 週。
- 檢討工具會回最近 6 次檢討與調整，避免來回翻。
- 調參數不升 `TAIFEX_MODEL_VERSION`；盤中技術模擬沒有歷史回測（5 分 K 只留約 4 天），調整後靠之後幾週的實際結果驗證。

### 13.4 程式

- `apps-script/src/TaifexTuning.gs`（純函式：範圍、正規化、diff、週區間與統計、回測對照）、`TaifexReview.gs`（IO：週狀態、提案、套用 / 退回 / 還原、推播）。
- `TaifexStrategy.gs`：`params.weights`（`tfParamWeights_`）；`TaifexTech.gs`：`tfTechRules_(overrides)`。沒有調校值時行為與 tx-v1 / txi-v1 完全相同（黃金資料不變）。
- MCP：`HubTools.gs` `taifex_weekly_review`、`HubWriteTools.gs` `preview_taifex_review` / `commit_taifex_review`。
- 前端：`features/taifex/review.ts`、`components/taifex-review.tsx`。Rules：`taifex_reviews`、`taifex_tuning` owner 唯讀。

## 10. 參考文獻

- Moskowitz, Ooi & Pedersen (2012), *Time Series Momentum*, Journal of Financial Economics.
- Hurst, Ooi & Pedersen (2017), *A Century of Evidence on Trend-Following Investing*, Journal of Portfolio Management.
- Brock, Lakonishok & LeBaron (1992), *Simple Technical Trading Rules and the Stochastic Properties of Stock Returns*, Journal of Finance.
- Wilder (1978), *New Concepts in Technical Trading Systems*（ATR、ADX）.
- Moreira & Muir (2017), *Volatility-Managed Portfolios*, Journal of Finance.
- Lai & Wang (2015), *Journal of Behavioral Finance* 16(4)：台灣期貨市場三大法人交易行為與台指期報酬.
- Pan & Poteshman (2006), *The Information in Option Volume for Future Stock Prices*, Review of Financial Studies.
- Antweiler & Frank (2004), *Is All That Talk Just Noise?*, Journal of Finance；Tetlock (2007), *Giving Content to Investor Sentiment*, Journal of Finance.
- Bailey & López de Prado (2014), *The Deflated Sharpe Ratio*（調參前的檢查）.
