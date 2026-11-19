# import — AI 匯入（通用 JSON）

## 職責
- 定義 RMoney 的**通用匯入契約**（`schema.ts`，Zod，version 1）：支出 / 收入 / 股票成交三種 item。任何 LLM 或腳本只要產出這個 JSON 就能匯入，不綁特定模型（規格見 `docs/AI_IMPORT_FORMAT.md`）。
- `json-repair.ts`：把 LLM / 聊天軟體弄壞的 JSON 修回來（彎引號、單引號 / Python dict、字串內未跳脫引號、尾逗號、註解、全形標點、千分位、截斷）。`schema.ts` 的 `parseImportEnvelope` 先標準 `JSON.parse`，失敗才修，回傳 `repaired` / `truncated` 讓 UI 標示；截斷時丟掉最後一筆不完整的。Apps Script 的 `ImportJson.gs` 是同邏輯的 ES5 版本，**兩邊要一起改**。
- `prompt.ts`：產生給外部 AI 的提示詞（含使用者的類別 key、帳戶與自訂支付方式名稱、今天日期，以及嚴格的引號 / 逗號規則）。`fenced: true`（外部聊天模型）要求包 ```json 圍欄，讓聊天介面給複製鍵、不會渲染成彎引號；站內 Claude 解析用 `fenced: false`。使用者複製到 ChatGPT / Claude / Gemini，自己貼原始內容，不花 API 費。
- Apps Script `Import.gs` 的 `parseImport`：同一份規則，站內用 Claude 轉換（計入 Claude 額度，受 `assertClaudeBudgetAvailable_` 控管）。
- `normalize.ts`：驗證後正規化 → 預覽列（類別模糊比對、付款方式比對、匯率換算、賣出股數檢查、同批重複偵測）。
  付款方式 `resolvePayment()`：帳戶 → 自訂支付方式（`payment_methods`，名稱 / key / 末四碼 / 類型名）→ `DEFAULT_PAYMENT_METHODS` → 對不到（`paymentMatched: false` + 警告）。
  對到信用卡等自訂支付方式時只記名稱，不扣帳戶；剛好有一個帳戶綁同名支付方式才帶上 `accountId`。
- `apply.ts`：寫入。記帳走 `createTransaction(input, id)`，doc id = 內容 hash（`ai_…`），重貼同一筆會被略過；股票走 `executePortfolioTrade`（持倉 + 交割帳戶同一個 transaction），支援成交日與手續費。
- UI：`AiImportPanel`，掛在 記帳 → 「AI 匯入」分頁（owner only）。每列記帳用與快速記帳同一個 `PaymentSelect`（自訂支付方式 + 帳戶 + 預設），新增支付方式後自動出現；股票列選交割帳戶。
- Telegram（`apps-script/src/ImportTelegram.gs` + `ImportApply.gs`）：貼 JSON / `/import` / 傳 .json 檔 / `/ai <原始文字>`，預覽後按鈕確認才寫入；
  `/prompt <原始文字>` 回「規則 + 內容」的提示詞（`<pre>` 可長按複製、太長改傳 .txt、附 ChatGPT / Claude 預填連結與「改用站內 Claude」按鈕），走外部模型零 API 費。
  互動：預覽有「付款方式套用」（一次把信用卡 / 帳戶套到沒指定的列）與「逐筆調整」（改類別 / 改付款方式 / 排除）；
  被 Telegram 切斷的 JSON 會等下一段自動接起來（`/cancel` 清除）；多行多筆的自由文字先問要 Claude 轉匯入、產生提示詞或當一筆記帳。
  快速記帳也多了「改支付方式」按鈕，清單同樣動態來自帳戶 + 支付方式（`importPaymentOptions_`），有帳戶的會同步餘額。
  Apps Script 端有自己的驗證 / 正規化 / 寫入（Firestore REST，沒有 client SDK），記帳 doc id 與 web `importRowKey()` 同一套 basis，跨管道去重；
  記帳與交割帳戶餘額都會調整（`importAdjustAccount_`），測試在 `apps-script/tests/import-apply.test.cjs`。

## 與其他 feature 的關係
- `ledger`：`createTransaction` / `getTransaction`、類別、`payment-method-types.ts`（純型別，不拉 firebase）與 `PaymentSelect`。匯入的交易帶 tag `ai-import`、`importSourceId`。
- `investments`：`executePortfolioTrade` 新增 `date` / `fee` / `note`；`normalizeStockSymbol` 判斷台股 / 美股。
- `accounts` / `fx`：帳戶比對與匯率。

## 改格式時
四處一起改：`schema.ts`、`prompt.ts`、`apps-script/src/Import.gs`、`apps-script/src/ImportApply.gs`，再更新 `docs/AI_IMPORT_FORMAT.md` 與 `apps/web/tests/ai-import.test.cjs`、`apps-script/tests/import-apply.test.cjs`、`apps-script/tests/import-telegram.test.cjs`。
JSON 修復：`json-repair.ts` ↔ `apps-script/src/ImportJson.gs` 同步改。
