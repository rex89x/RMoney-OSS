# Feature: investments

追蹤 TW 股 + US 股；Watchlist / Portfolio / 投資理財規劃 / 歷史 K 線 / 區間刪除。

**職責邊界**：
- 股價來自 Apps Script → TWSE MIS / Finnhub，前端**不直接**打外部 API
- `stocks/{symbol}` latest quote；`stocks/{symbol}/history/{ts}` 歷史快照 (pitfall #5：30 天以上走日 K)
- Watchlist doc id = `{uid}_{symbol}` (deterministic)
- Portfolio 每個 position 保留 `lots[]`，加碼時重算 `avgCost`；買進批次有手續費時記在 `lots[].fee`（FIFO 批次成本用）
- Investment plans 存在 `investment_plans`，用於目標金額、期限、月投入、年化假設與 Telegram 月度追蹤
- 盤中 / 非盤中時段用 `lib/market-hours` 判斷 (pitfall #2 DST)
- 短波段實驗使用 `swing_strategy_configs` / `swing_signal_runs` / `swing_paper_trades`，只做盤後候選與紙上交易，絕不寫入正式 `portfolio`、不接券商 API、不自動下單
- v2 以 0050 趨勢濾網、個股相對強度／流動性／最低風險報酬比篩選，並依每筆風險上限反推紙上股數；歷史 v1 交易保留供分版本比較

## 績效 XIRR / TWR（`performance.ts`、`components/performance-card.tsx`）

儀表板「績效」卡顯示 XIRR（年化）與 TWR（期間 / 超過 365 天才年化），期間可切 今年 / 1 年 / 3 年 / 全部。
「持倉 vs 大盤」的 Portfolio 線也改用 TWR 累積指數，與 0050 / SPY 收盤價同一把尺比較。

**資料來源**（全部前端計算、純讀取）：

| 項目 | 來源 |
|---|---|
| 市值 V | `portfolio_snapshots/{yyyy-MM-dd}.totalValueTWD`（Apps Script `snapshotPortfolioDaily`，當日凍結匯率） |
| 買進 / 賣出流量 | 相鄰兩筆快照間每檔 `positions[].avgCost × shares`（原幣）的變動 × 期末快照 `fxRate`；再扣掉 `createdAt` 落在兩張快照 `createdAt` 之間的 `realized_lots.realizedPnlTWD`，把賣出從「成本減少」修正成「實收賣出款」 |
| 股息 | `dividends.amountTWD`，`payDate`（台北日）落在 (前一快照日, 本快照日] → 視為提出 |
| 期初 | 起點當天或之前最後一筆快照（沒有就用起點後第一筆，卡片會標示快照不足） |

為什麼不用 `portfolio.lots`：lots 沒存匯率、舊資料沒存手續費，而且持倉賣光時整份文件被刪除、買進紀錄跟著消失；
快照差額在快照涵蓋的期間內是完整的（手動調整持倉也會被正確視為投入 / 提出）。代價是：**快照開始之前的績效算不出來**。

**慣例**：
- TWR 子期間 r = (V₁ + 提出) / (V₀ + 投入) − 1：投入視為期初發生、提出視為期末發生（首次買進 V₀ = 0、全部賣光 V₁ = 0 都不會除以 0）
- XIRR：期初市值當作一筆投入，期間 flows 轉投資人視角（買進負、賣出 / 股息正），期末市值為正；Actual/365；Newton-Raphson，不收斂改二分法；全同號 / 不到 1 天 / 無解 → 顯示「—」
- 已知誤差：手動新增、與快照無關的 `realized_lots` 會被當成資金流；賣出的 realized 用賣出當下匯率、成本變動用快照匯率，美股會有小幅匯差
- 年度回顧（`features/review`）仍用 Modified Dietz 簡化版：它的報酬率與同頁「投資收益金額」是一組口徑，換成 TWR 會讓兩個數字對不起來，所以暫不替換

## 賣出成本法：平均成本 / FIFO（`cost-basis.ts`、`components/cost-basis-setting.tsx`）

- 設定存在 `users/{uid}.preferences.costBasisMethod`（`'average' | 'fifo'`，**預設 average**，跟 `allocationTargets` 同一處）；
  在「已實現」分頁頂端切換，只影響之後的賣出，既有 `realized_lots` 不重算。
- `executePortfolioTrade` 賣出時：未傳 `costBasisMethod` 就讀使用者偏好（AI 匯入 `features/import/apply.ts` 也走這條）。
  - **average**：一筆 `realized_lots`，數字與舊版逐位元相同（測試鎖住），持倉 `avgCost` 不變。
  - **fifo**：依日期重播 `lots[]`（買進 +、賣出 −），從最早的買進批次扣；每個被扣的批次寫一筆 `realized_lots`
    （`avgCost` = 該批每股成本含 `fee`、`buyDate` = 批次日期、實收依股數分攤，最後一筆吃尾差），
    持倉 `avgCost` 改成「剩餘批次成本 / 剩餘股數」。成本換 TWD 一律用賣出當下匯率（與平均成本法一致）。
  - 批次不可靠（重播超賣、剩餘股數與持倉對不上，例如手動改過持倉或沒有 lots 的舊資料）→ 退回平均成本，
    該筆 `realized_lots` 標 `costBasisFallback: true`；賣出表單事先提示、已實現列表也會顯示。
  - 舊的 `lots` 沒記 `fee`，FIFO 對那些批次只算成交價（不含手續費）。
- 新欄位（皆選填，舊資料視為 average）：`realized_lots.costBasisMethod` / `costBasisFallback` / `buyDate`。
- TODO(owner): Apps Script `ImportApply.gs`（Telegram 匯入成交）仍固定平均成本、不讀偏好，也不寫 `costBasisMethod`。

## 台股代號規則（2026-11）

`symbol-utils.ts`（前端）與 `apps-script/src/Stocks.gs` 的 `isTwSymbol_` / `twSymbolCurrency_`（後端）同一套規則，`apps/web/tests/tw-symbol.test.cjs` 會對照兩邊：

- 台股 = **4–6 位數字 + 0–2 碼英文字尾**；數字開頭一律是台股（美股代號都是英文字母開頭）。
- `00` 開頭是 ETF，字尾：A 主動式股票、D 主動式債券、B 債券、L 槓桿、R 反向、T 平衡、U 期貨；
  **K / C / M / S / V 是外幣交易**（股票 / 債券 / 槓桿 / 反向 / 期貨），報價不是台幣 → 幣別記 USD。
- 4 位數個股加 A–W 是特別股、X–Z 是可轉換公司債換股權利證書；`91` 開頭 6 位數是 DR。
- 輸入容錯：大小寫、空白、`.TW` / `.TWO`、名稱後綴 `-KY` / `-DR` 都會自動去掉。
- 抓價本來就支援任意代號（TWSE MIS `tse_/otc_`、Yahoo `.TW/.TWO`），以前加不進來是因為只認「剛好 4 位數字」，
  5–6 位 ETF 與帶英文字尾的代號會被擋或被誤判成美股。
- 例外：短波段實驗室（`swing-trading-lab.tsx` / `SwingSignals.gs`）的選股池刻意只收 4 位數個股，不含 ETF / 特別股。
