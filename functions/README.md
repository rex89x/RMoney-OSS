# functions — MCP 閘道

Claude.ai（網頁版 / 手機 App）連 Personal Hub MCP 用的閘道：標準 MCP Streamable HTTP 端點 +
OAuth 2.1 授權伺服器，通過驗證後把 JSON-RPC 轉送到 Apps Script `?action=mcp`。

- `lib/gateway.js` — 全部邏輯（OAuth、token、MCP 轉送），不依賴 firebase，`tests/gateway.test.mjs` 用記憶體 store 測完整流程
- `lib/firestore-store.js` — Firestore 儲存層（Admin SDK）
- `index.js` — Cloud Functions 進入點（`mcp`，`asia-east1`）

設計、一次性設定與排錯見 `docs/INTEGRATIONS_SETUP.md` 3.2 與 `docs/RUNBOOK.md`。
部署由 `.github/workflows/deploy-functions.yml` 處理；`functions/.env`（`APPS_SCRIPT_URL`）由 CI 寫入，不進 repo。

```bash
npm test          # 單元測試（不需要 emulator）
```
