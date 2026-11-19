# Feature: review

年度回顧頁 `/review`：收入 / 支出 / 儲蓄率（與去年比）、月度收支、類別 vs 去年、常去商家、出遊、投資收益估算、淨值變化。

- 純讀取，資料來源：`transactions`（本年 + 去年）、`net_worth_snapshots`、`portfolio_snapshots`、`dividends`、`realized_lots`、`trips`。
- 支出一律用 `useMyExpenseShare`（trip 分攤後我的那份）。
- 投資收益估算 = 市值變動 − 新投入成本 + 股息 + 已實現損益；報酬率以年初市值 + 半年投入為基準（Modified Dietz 的簡化版）。
- 匯出用 `window.print()`，`index.css` 已有 print 樣式。
