# 股市雷達（Stock Radar）規劃

> 狀態：P1–P4 已實作（2026-10-29）。§9 決策已確認，實作備註見 §11。
> 定位：**盤前決策輔助**，不是自動交易。不接券商 API、不自動下單、不寫入正式 `portfolio`。

---

## 1. 目標

每天開盤前，對「目前庫存 + 自選股」逐檔回答：

| 持有中 | 未持有（自選股） |
|---|---|
| 加碼 / 續抱 / 減碼 / 出場 | 買進候選 / 觀望 / 避開 |

每個建議都要能拆解成「哪些因子推了多少分」、「輿情說了什麼、來源在哪」、「風控規則有沒有否決」，並且**長期追蹤命中率**，讓演算法好不好用數字說話，而不是靠感覺。

---

## 2. 沿用機票雷達的架構

機票雷達驗證過的模式，股市雷達直接沿用：

| 機票雷達 | 股市雷達 |
|---|---|
| Claude 排程上網查價 → POST `ingestFlightPrices` | Claude 排程查新聞／輿情／法說／總經事件 → POST `ingestStockSentiment` |
| ingest token：前端 CSPRNG 產生、GAS 只存 SHA-256、**只寫不讀** | 同一套，獨立 token（`rmsr_` prefix、`RMONEY_STOCK_INGEST_TOKEN`） |
| `criteriaKey` 指紋：條件改了舊提示詞被拒收 | `universeKey`：追蹤清單改了舊提示詞被拒收 |
| `advice` 由程式決定，不採用模型的購買建議 | **最終動作由 GAS 確定性公式決定**，Claude 只提供輿情分數＋證據 |
| 來源必須 https、異常值降可信度 | 輿情必須附來源 URL；無來源 → 信心度歸零、不計分 |
| 總覽 / 列表 / 使用說明 三分頁 + 首頁卡片 | 同上 |

這樣做的好處：**持股數量與成本不需要送給 Claude**（token 外洩也拿不到庫存），組合層級的風控由 GAS 用即時 `portfolio` 計算。

---

## 3. 資料流（每日）

```
07:00 TPE  GAS tick（既有 updateDailyCandles 之後）
           └─ runStockRadarQuant()
              ├─ 讀 portfolio + watchlist → universe（TW / US 分開）
              ├─ 讀 stocks/{symbol}/candles（既有，TW: TWSE、US: Yahoo）
              ├─ 讀 TWSE 三大法人 T86、融資融券（TW 限定，公開資料）
              ├─ 計算因子分數 + 市場 regime
              └─ 寫 stock_radar_runs/{date}_{market}（status: quant_ready）

07:30 TPE  Claude 排程（claude.ai scheduled task）
           ├─ 提示詞內含追蹤清單 + universeKey（前端複製時產生）
           ├─ 上網：個股新聞、法說／財報日、PTT 股板、Reddit、X、鉅亨、Yahoo 財經、總經行事曆
           └─ POST ingestStockSentiment（每檔 sentiment ∈ [-1,1]、confidence、catalysts、sources）

08:15 TPE  GAS tick
           └─ synthesizeStockRadar()
              ├─ 合併 quant + sentiment（Claude 沒推送 → 只用 quant，並標示）
              ├─ 組合風控（集中度、波動目標、停損）
              ├─ 寫 stock_radar_signals/{date}_{market}
              └─ Telegram 推播「今日盤前建議」

美股：同一套流程在 20:30 TPE（夏令）/ 21:30（冬令）前再跑一次 — 依 §9 決策。

收盤後  GAS 回填 forward return（1 / 5 / 20 交易日）→ 演算法成績單
```

---

## 4. 演算法（有論文背書的因子）

原則：**只用公開文獻中跨市場、跨期間被反覆驗證的因子**，參數用文獻預設值，不在自己的少量資料上調參（避免過擬合）。

### 4.1 價格／技術因子（GAS 用既有日 K 計算）

| 因子 | 定義 | 文獻 |
|---|---|---|
| 中期動能 12-1 | 過去 12 個月報酬，扣掉最近 1 個月 | Jegadeesh & Titman (1993) *J. Finance*；Asness, Moskowitz & Pedersen (2013) *Value and Momentum Everywhere* |
| 時間序列動能 | 自身過去 12 個月報酬正負，經波動調整 | Moskowitz, Ooi & Pedersen (2012) *Time Series Momentum*, JFE |
| 52 週高點接近度 | 收盤 / 52 週最高 | George & Hwang (2004) *The 52-Week High and Momentum Investing*, J. Finance |
| 短期反轉 | 過去 1 週／1 個月報酬取負 | Lehmann (1990) QJE；Jegadeesh (1990) J. Finance |
| 趨勢濾網 | 收盤 vs 200 日（10 個月）均線 | Faber (2007) *A Quantitative Approach to Tactical Asset Allocation*；Brock, Lakonishok & LeBaron (1992) J. Finance |
| 低波動 | 60 日已實現波動率（低者加分） | Ang, Hodrick, Xing & Zhang (2006) J. Finance；Frazzini & Pedersen (2014) *Betting Against Beta* |
| 財報後漂移 PEAD | 財報 surprise 方向（Claude 提供） | Bernard & Thomas (1989) J. Accounting Research |

### 4.2 籌碼因子（台股限定，TWSE 公開資料）

| 因子 | 定義 | 依據 |
|---|---|---|
| 外資淨買超 | 近 5 / 20 日外資買賣超占成交量比 | 台灣市場外資流量對報酬的預測力：Richards (2005) JFQA；Lin & Swanson 等台股實證 |
| 融資餘額變化 | 融資增幅過大視為散戶過熱（反向） | 散戶情緒指標，Baker & Wurgler (2006) 投資人情緒框架 |

### 4.3 輿情因子（Claude 排程提供）

| 項目 | 作法 | 文獻 |
|---|---|---|
| 新聞語氣 | 以 Loughran-McDonald 財經詞典的「負面／不確定」概念評分，負面權重高於正面 | Tetlock (2007) *Giving Content to Investor Sentiment*, J. Finance；Loughran & McDonald (2011) J. Finance |
| 社群情緒 | PTT / Reddit / X 討論量異常 + 方向；**只作輔助，權重低** | Antweiler & Frank (2004) J. Finance（討論量預測波動多於方向） |
| 事件旗標 | 財報日、除權息、法說、訴訟、增資、降評 → 風險事件不計分但觸發「暫緩加碼」 | — |
| 整體市場情緒 | VIX、恐懼貪婪、台指期未平倉 → regime 修正 | Baker & Wurgler (2006) |

注意 Antweiler & Frank 與後續研究的結論：社群情緒對**方向**的預測力弱，對**波動**較有用。所以設計上輿情主要用在「否決／降權」與風險提示，不單獨觸發買進。

### 4.4 合成公式

```
1. 每個因子在 universe 內做橫斷面 z-score，winsorize 到 ±3
2. QuantScore   = Σ wᵢ · zᵢ   （等權為預設 — DeMiguel, Garlappi & Uppal (2009) 等權常勝過最佳化）
3. SentimentAdj = sentiment × confidence × w_s   （w_s 預設 0.25，無來源 → 0）
4. Composite    = QuantScore + SentimentAdj
5. Regime 濾網  ：大盤（0050 / SPY）在 200 日均線下 → 買進門檻提高、加碼建議降一級
6. 動作對照    ：Composite 分位數 → 加碼 / 續抱 / 減碼 / 出場；風險事件 → 最多「續抱」
7. 組合風控    ：單檔權重上限、波動目標（Moreira & Muir 2017 *Volatility-Managed Portfolios*）、
                 ATR 停損（沿用短波段實驗的 atr14_）、分數 Kelly 作為加碼金額上限（Kelly 1956；Thorp）
```

### 4.5 防過擬合與成績單

- 參數凍結於 `STOCK_RADAR_MODEL_VERSION`；改公式就升版，新舊版本成績分開統計（沿用短波段 v1/v2 作法）
- 每筆建議記錄當下分數，事後回填 1 / 5 / 20 交易日報酬
- 指標：命中率、**IC（Spearman 排名相關）**、分位數價差（top − bottom）、跟 0050 / SPY 比較、只用 quant vs quant+輿情的增量貢獻
- 調整權重前必須看 Deflated Sharpe Ratio（Bailey & López de Prado 2014），避免多次嘗試後挑到好看的運氣

---

## 5. Firestore Schema

| Collection | Doc ID | 寫入者 | 內容 |
|---|---|---|---|
| `stock_radar_configs` | `default` | 前端 | 權重、風控參數、市場開關、通知設定 |
| `stock_radar_runs` | `{yyyy-MM-dd}_{TW\|US}` | GAS | regime、每檔因子原始值與 z-score、universeKey、狀態 |
| `stock_radar_sentiment` | `{yyyy-MM-dd}_{TW\|US}` | GAS（代 Claude 寫入） | 每檔 sentiment / confidence / catalysts / riskEvents / sources；市場總評 |
| `stock_radar_signals` | `{yyyy-MM-dd}_{TW\|US}` | GAS | 最終動作、分數拆解、風控否決原因、建議股數區間、forward return 回填 |

Rules：四個 collection `isOwner()` 讀；`stock_radar_configs` 可寫，其餘 `write: if false`（只由 GAS service account 寫）— 與 `flight_watches/snapshots` 一致。
單一 doc 存整個市場一天的結果（20–60 檔約數十 KB），Dashboard 讀最近 N 天 = N 次讀取，不會爆量。

---

## 6. 前端（`features/stock-radar/`，route `/stock-radar`）

分頁：**今日 / 個股 / 成績單 / 使用說明**

- **今日**：市場 regime 燈號（TW / US）、今日行動清單（依動作分組）、持股健康度（權重 × 分數泡泡圖）、風險事件、Claude 推送狀態
- **個股**：因子雷達圖、分數拆解瀑布圖、分數 vs 股價走勢、輿情時間軸（含來源連結）、目前持股損益與建議
- **成績單**：分版本命中率、IC 走勢、分位數報酬、vs 0050 / SPY、quant vs quant+輿情
- **使用說明**：演算法說明、論文清單、Claude 排程設定步驟
- **Claude 排程對話框**：token 產生／撤銷、複製提示詞、手動貼上結果（沿用 `features/import/json-repair.ts`）
- **首頁卡片** `stockRadar`：今日需處理的持股數 + 前 3 個建議
- 圖表沿用 Recharts，每天一點（pitfall #13）

---

## 7. Apps Script

| 檔案 | 責任 |
|---|---|
| `StockRadarFactors.gs` | 純函式：因子計算、z-score、regime（可單元測試） |
| `StockRadar.gs` | `runStockRadarQuant`、`synthesizeStockRadar`、forward return 回填、Telegram |
| `StockRadarIngest.gs` | token 管理、`ingestStockSentiment`（token）、`importStockSentiment`（idToken 手動貼上） |
| `Main.gs` / `Triggers.gs` | 路由與 tick 掛載 |

TWSE 三大法人 / 融資融券走 `openapi.twse.com.tw`，`Utilities.sleep` 控速並注意 6 分鐘上限（pitfall #10）。

---

## 8. 分階段交付

| Phase | 內容 | 可單獨使用？ |
|---|---|---|
| **P1 量化引擎** | 因子計算 + regime + 每日 run + 今日／個股頁（只有 quant） | 是 |
| **P2 Claude 輿情** | ingest token、提示詞、手動貼上、合成公式、Telegram | 是 |
| **P3 成績單** | forward return 回填、IC／命中率、版本比較、首頁卡片 | 是 |
| **P4 歷史回測**（選配） | 用既有日 K 做 walk-forward，上線前先看 P1 公式過去 3 年表現 | 是 |

每個 Phase 一個 PR，各自通過 typecheck / lint / build / test。

---

## 9. 已確認的決策（2026-10-29）

| 題目 | 決定 |
|---|---|
| 排程時間 | 分兩次：台股盤前（早上）、美股盤前（20:30 TPE） |
| Claude 權限 | 只寫不讀：提示詞只帶代號清單，庫存與風控由 Apps Script 計算 |
| 追蹤範圍 | 庫存 + 自選股 |
| 起步方式 | 先做 P1 量化引擎，P2 輿情、P3 成績單依序接上 |

P1 實作備註：
- 量化評估掛在 `tick_daily_0800`（TW 日 K 前晚 18:00、US 日 K 07:00 已更新），兩個市場一起跑；P2 接 Claude 時台股合成維持早上、美股合成另掛 20:30 之後的 tick。
- 個人清單檔數少，因子改用文獻的絕對定義轉 [-1, 1]，不做 §4.4 的橫斷面 z-score。
- 台股籌碼因子（§4.2）與 `stock_radar_configs` 延到 P2 之後；P1 參數寫死在 `StockRadarFactors.gs`。

## 10. 已知限制（要在 UI 持續顯示）

- 所有因子的超額報酬在學術上是**統計平均**，個股、短期可能完全相反；論文報酬多為扣成本前
- 輿情來源是 Claude 網路搜尋的整理，可能漏抓或誤讀；必附來源讓 owner 可點開查證
- 台股外資籌碼、融資資料 T+1 才公布，盤前看到的是前一交易日
- 本功能不構成投資建議，不自動下單

---

## 11. 實作備註（與上方規劃的差異）

| 項目 | 規劃 | 實作 |
|---|---|---|
| 因子正規化 | 橫斷面 z-score | 個人清單檔數少，改用文獻的絕對定義轉 [-1, 1]（`StockRadarFactors.gs`） |
| 排程 | 07:00 quant、07:30 Claude、08:15 合成 | 07:30 Claude 台股 → 08:00 量化 + 合併已收到的輿情 + 推播台股；輿情晚到時 ingest 立即重新合成並只推播變化。美股 08:00 量化、20:30 Claude 推送後合成推播、21:00 fallback |
| 合成時機 | 獨立 tick | 不新增 trigger：量化評估與 ingest 兩邊都呼叫同一個 `synthesizeStockRadarItem_`，順序無關、可重複 |
| 提示詞過期偵測 | `universeKey` | GAS 只接受目前追蹤清單的代號；前端用 `stock_radar_configs/default.promptSymbols` 比對提醒重新複製 |
| `stock_radar_configs` | 權重與風控參數 | 只存提示詞同步狀態；參數凍結在模型版本，不開放前端調整（避免事後調參） |
| 籌碼 | 外資 + 融資 | 外資（含外資自營商）+ 投信淨買超 / 成交量（權重 0.5）、融資 20 日變化（反向，0.25）；只有上市股票 |
| 成績單 | forward return 寫回 signals | 獨立 `stock_radar_outcomes`，從建議隔天開盤進場計算（不含拿不到的隔夜跳空）；前端 join 後算命中率、IC、輿情增量 |
| 回測 | 3 年 | Yahoo 5 年日 K（只讀不存），每 5 交易日一期，扣台股 0.6% / 美股 0.1% 來回成本 × 換手率；週日 20:00 |
| Deflated Sharpe | 調權重前檢查 | 不開放調參，所以只在回測頁標示過度擬合與倖存者偏差限制 |
