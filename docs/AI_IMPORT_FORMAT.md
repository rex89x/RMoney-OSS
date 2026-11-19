# RMoney AI 匯入格式（v1）

任何 AI 或工具只要產出這份 JSON，就能貼進 RMoney 的「記帳 → AI 匯入」匯入；不綁特定模型，也可以自己寫腳本產生。
對應程式：`apps/web/src/features/import/schema.ts`（唯一契約）、`prompt.ts`（給外部 AI 的提示詞）、`apps-script/src/Import.gs`（站內 Claude）。

## Envelope

```json
{
  "version": 1,
  "source": "chatgpt",
  "items": [ ... ]
}
```

- `version`：固定 `1`。
- `source`：產生工具名稱，純紀錄（選填）。
- `items`：1 到 500 筆。也接受直接貼 `items` 陣列、或單一 item 物件；接受 ```json 圍欄與前後雜訊。
- 單筆格式錯誤只會丟掉那一筆，其餘照常預覽。

### 不是合法 JSON 也會先修再解析

LLM 與聊天軟體最常弄壞的是引號，所以 web 與 Telegram 兩邊都先走同一套修復（`features/import/json-repair.ts` / `apps-script/src/ImportJson.gs`），修不好才報錯：

| 狀況 | 例子 | 處理 |
|---|---|---|
| 彎引號（ChatGPT 網頁渲染、iOS 智慧標點、Telegram 轉貼） | `{“kind”: “expense”}` | 當成一般引號 |
| 單引號 / Python dict | `{'kind': 'expense', 'tags': None, 'prepaid': True}` | 轉成雙引號；`None`→`null`、`True`→`true` |
| 字串裡沒跳脫的雙引號 | `"note": "買 "可樂" 兩瓶"` | 看後面是不是 `,` `}` `]` 判斷真假結尾 |
| 尾逗號、`//` 註解、沒加引號的 key、字串內換行 | `{items: [{kind: expense,},]}` | 全部接受 |
| 全形 `｛｝［］：，` | `｛"kind"："expense"｝` | 字串外換成半形 |
| 數字帶千分位 / 貨幣符號 / 引號 | `"amount": "NT$ 1,280"` | 轉成 1280 |
| 選填欄位填 `null` | `"account": null` | 視為沒給 |
| 括號沒收完（Telegram 4096 字切斷） | …`"amount": 9` | 補結尾、**丟掉最後一筆不完整的**並標示；Telegram 會等你貼下一段 |

預覽會註明「已自動修正」或「內容被截斷」。提示詞本身也把這些規則寫進去了（只能用半形直雙引號、字串內引號改「」、不要尾逗號 / 註解 / null、外部模型要包 ```json 圍欄以便一鍵複製）。

## Item：支出 / 收入

| 欄位 | 必填 | 說明 |
|---|---|---|
| `kind` | 是 | `expense` 或 `income` |
| `date` | 是 | `yyyy-MM-dd`（台北時間） |
| `amount` | 是 | 原幣金額，正數 |
| `currency` | 否 | ISO 代碼，預設 `TWD` |
| `category` | 否 | 類別 key 或名稱；模糊比對，對不到放「其他」並標示 |
| `note` / `merchant` | 否 | 備註、店名（會合併成備註） |
| `account` / `paymentMethod` | 否 | 付款方式。依序比對：帳戶名稱 / 舊支付方式名 → 設定裡的自訂支付方式（名稱、key、末四碼；「信用卡」這種類型名只有一張卡時才對）→ 預設名單（現金、LINE Pay…）。對到帳戶就扣（或入）該帳戶餘額；對到自訂支付方式（例如信用卡）只記名稱，若剛好有一個帳戶綁同名支付方式會一起帶上；都對不到會標示並讓你在預覽選 |
| `tags` | 否 | 最多 10 個 |
| `fxRate` | 否 | 1 單位原幣 = ? TWD；沒給用 app 當下匯率 |
| `id` | 否 | 來源單號（發票號碼等），用來去重 |

## Item：股票成交

| 欄位 | 必填 | 說明 |
|---|---|---|
| `kind` | 是 | `trade` |
| `date` | 是 | 成交日 |
| `symbol` | 是 | 台股 4 位數字（`2330`）或美股代號（`AAPL`） |
| `side` | 是 | `buy` / `sell` |
| `shares` | 是 | 股數 |
| `price` | 是 | 成交單價（原幣） |
| `market` | 否 | `TW` / `US`，沒給從代號判斷 |
| `currency` | 否 | `TWD` / `USD`，沒給依 market |
| `fee` / `tax` | 否 | 手續費 / 交易稅（原幣）。買進算進成本、賣出從所得扣除、交割帳戶照實扣 |
| `account` | 否 | 交割帳戶名稱；沒給用第一個可交割帳戶，預覽時可改 |
| `note` / `id` | 否 | |

賣出會檢查持倉：沒有該檔或股數不足就標錯誤、不匯入。

## 去重

- 記帳：doc id = 內容 hash（`id` 有給就用 `kind + id`，否則用 日期 + 金額 + 幣別 + 類別 + 備註）。同一筆重貼第二次會顯示「已匯入過」並略過。
- 股票：沒有冪等 id（每次都會更新持倉），同一批成交不要重複匯入。

## 範例

```json
{
  "version": 1,
  "source": "claude",
  "items": [
    { "kind": "expense", "date": "2026-10-21", "amount": 1280, "currency": "JPY", "category": "food", "note": "一蘭拉麵", "account": "信用卡" },
    { "kind": "income", "date": "2026-10-20", "amount": 500, "category": "refund", "note": "蝦皮退款", "account": "玉山" },
    { "kind": "trade", "date": "2026-10-21", "market": "TW", "symbol": "2330", "side": "buy", "shares": 1000, "price": 1050, "fee": 150, "account": "元大交割戶", "id": "F2026102100123" },
    { "kind": "trade", "date": "2026-10-21", "market": "US", "symbol": "AAPL", "side": "sell", "shares": 10, "price": 231.5, "fee": 1.2, "tax": 0.05 }
  ]
}
```

## 從 Telegram 匯入

owner 的 bot 對話支援以下方式，都會先回「匯入預覽」（筆數、每筆摘要、需留意的項目），按「確認匯入」才寫入；預覽 1 小時內有效。

| 方式 | 說明 |
|---|---|
| 直接貼 JSON | 訊息以 `{`、`[` 或 ```` ``` ```` 開頭（前面有彎引號 / 全形括號也行）就當匯入，不用加指令（例如把 ChatGPT 的輸出直接轉貼） |
| `/import <JSON>` | 同上，明確指令 |
| 貼到一半被切斷 | Telegram 把長訊息切成幾則時，bot 會回「JSON 還沒結束」並等你貼下一段，自動接起來；也可按「就用目前這 N 筆」或 `/cancel` |
| 傳 `.json` / `.txt` 檔 | 很長時用（上限 512KB） |
| `/ai <原始文字>` | 券商成交通知、明細、口語 → Claude 轉成 JSON → 同一條預覽流程（計入 Claude 額度） |
| `/prompt <原始文字>` | **不花 API 費**：bot 回一段「規則 + 你的內容」提示詞（長按複製，或按「在 ChatGPT / Claude 開啟」預填），拿去任何模型跑出 JSON 後貼回來。訊息下方另有「改用站內 Claude 直接轉換」按鈕 |
| `/prompt`（不帶內容） | 只回基礎提示詞：存成 Claude Project / Custom GPT / Gemini Gem 的指令，之後只丟原始內容給它，再把 JSON 貼回 bot |
| 直接貼多行 / 多筆文字 | 不是 JSON、也不像一句話的記帳（≥ 3 行、或 ≥ 2 行且 ≥ 2 個金額、或超過 160 字）→ bot 先問：**Claude 轉匯入** / **產生提示詞** / **當一筆記帳** |

### 預覽訊息的按鈕

| 按鈕 | 做什麼 |
|---|---|
| 確認匯入 N 筆 / 取消 | 寫入或放棄；排除的、有錯的不會寫 |
| 付款方式套用（N 筆未指定） | 列出所有帳戶 + 自訂支付方式（信用卡、LINE Pay…）+ 預設名單，選一個套到「來源沒指定付款方式」的記帳；全部都指定了就套全部。收入不會套到信用卡。清單動態來自 Firestore，之後新增的支付方式會自動出現 |
| 逐筆調整 | 一筆一筆看：**改類別**、**改付款方式**（股票是改交割帳戶）、**排除 / 納入**，上一筆 / 下一筆，改完「回預覽」再確認 |

同一套清單也用在自由文字記帳後的「改支付方式」按鈕；有對到帳戶的記帳（刷玉山、用 LINE Pay…）會同步調整帳戶餘額，改支付方式或刪除時會還原。

### 建議的日常流程（零 API 費）

1. 一次性：`/prompt` → 把基礎提示詞存成你常用模型的 Project / GPT / Gem 指令。
2. 每天：把券商通知、明細截圖的文字或一句「今天午餐 150 刷玉山、晚上買 2330 一張 1050」丟給那個 Project。
3. 把它回的 JSON 直接貼回 Telegram bot（或傳 .json 檔）→ 預覽 → 確認匯入。
4. 偶爾要省事就用 `/ai`（站內 Claude）。

ChatGPT / Claude 的「一鍵開啟」是用網址預填提示詞；提示詞太長（超過約 6000 字元編碼後）就只保留複製方式。Gemini 沒有預填連結。
模型回的 JSON 請用聊天介面程式碼區塊的「複製」按鈕複製（提示詞要求它放在 ```json 圍欄裡），不要從渲染後的文字選取 — 那是彎引號的主要來源。就算真的變成彎引號也會自動修。

Telegram 與 web 用同一套 id 規則：在 Telegram 匯過的記帳，到 web 再貼會顯示「已匯入過」，反之亦然。股票成交沒有去重。

## 從 MCP 寫入

開了寫入的 MCP 連線（Claude.ai / Claude Code）用同一份 item 格式呼叫 `preview_entries` → `commit_entries`
（`apps-script/src/HubWriteTools.gs`，說明見 `docs/MCP_TOOLS.md`），不用貼 JSON。差異：

- 記帳 item 多一個選填的 `tripId`（歸到旅程）；寫入的交易 `source = 'mcp'`，可用 `undo_entry` 復原。
- id 規則與 web / Telegram 相同，所以三邊互相去重；預覽時就會標出「已有內容相同的記帳」。

## 兩種取得 JSON 的方式（web）

1. **外部 AI（免 API 費）**：在 app 按「複製提示詞」，貼到 ChatGPT / Claude / Gemini，再貼原始內容，把回覆貼回 app。提示詞已含你的類別 key 與帳戶名稱。
2. **站內 Claude**：直接貼原始內容，按「用 Claude 轉換」（Apps Script `parseImport`，計入 Claude 額度）。

## 改格式時

`schema.ts`、`prompt.ts`、`Import.gs`、`ImportApply.gs`（Apps Script 的驗證 / 正規化 / 寫入）四處一起改
（MCP 的 `hubWriteToolDefs_` item schema 也要跟著加欄位），版本號加一，並更新本文件與 `apps/web/tests/ai-import.test.cjs`、`apps-script/tests/import-apply.test.cjs`。
JSON 修復邏輯改 `json-repair.ts` 與 `ImportJson.gs` 兩邊；Telegram 互動在 `ImportTelegram.gs`（測試 `apps-script/tests/import-telegram.test.cjs`）。
