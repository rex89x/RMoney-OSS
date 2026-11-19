# Feature: ask

「問一下」自然語言查帳：app 內 dialog（Cmd+K → 問一下、首頁按鈕）與 Telegram `/ask`。

- 前端只送 `{ question }` 到 Apps Script `action=askFinance`，不持有 Claude API key。
- Apps Script `Ask.gs` 用 Claude tool use（`callClaude_` + manual loop），LLM 只能呼叫白名單聚合函式（依類別 / 月 / 支付方式加總、明細、預算、淨值、投資快照、帳戶餘額），不直接讀 Firestore。
- 回答以 Markdown 渲染（`components/ui/markdown`，禁 raw HTML）。
- 對話狀態只在 dialog 生命週期內，不儲存。
