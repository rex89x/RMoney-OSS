# joint-investments — 共同投資帳 + 共同帳本 Telegram 報告

掛在 `/shared?tab=invest`（投資分頁）與 `/shared?tab=settings`（Telegram 卡片）。
伴侶（role `member`）只看得到 `/shared`，所以這裡就是她看投資的唯一入口。

## 資料
| 路徑 | 誰寫 | 內容 |
|---|---|---|
| `households/{hid}/investment_holdings/{id}` | 成員（rules 限制見下） | 一檔持股：`symbol / market / currency / bucket / ownerUid / jointShares / lots[] / source` |
| `households/{hid}/investment_snapshots/{YYYY-MM-DD}` | Apps Script | 每日 07:00 / 18:00 快照（走勢圖、Telegram 報告） |
| `households/{hid}.investmentPlan` | 有 `canManageInvestments` 的成員 | 共同目標：金額、日期、年化假設、每人每月投入 |
| `households/{hid}.householdReport` | owner / `canEditSettings` | 報告開關、頻率（daily / weekly / monthly）、內容 |
| `households/{hid}.telegramLinked` | Apps Script | 誰綁定了 Telegram（純 UI 鏡像） |
| `telegram_links/{uid}` | Apps Script | 綁定的 chatId；本人唯讀 |
| `telegram_chats/{chatId}`、`telegram_link_tokens/{token}` | Apps Script | webhook 反查、一次性 token；前端不可讀寫 |

## 持股 bucket
- `joint`（共同持有）：依 `jointShares`（%）歸屬到每個人；`null` = 跟著 `household.splitRatio`
- `personal`（個人）：`ownerUid` 本人的
- `source: 'portfolio'`：owner 從投資頁「連結」進來的部位，`lots` 只是一筆合成買進，股數與均價由
  `portfolio/{sourcePositionId}` 同步（前端「連結我的持股」立即同步、Apps Script 每天 07:00 / 18:00 自動同步）。
  伴侶只看得到被勾選的部位，看不到帳戶、現金、淨值或其他持倉。

## 計算（`calc.ts`，純函式，有單元測試）
- 平均成本法：買進累加成本；賣出以當下均價沖銷、差額記已實現損益；賣超過持股的部分忽略（UI 會先擋）。
- 美股以 `fx_rates/USD_TWD` 換算；沒有報價時市值暫以成本計並顯示警示。
- **Apps Script `HouseholdInvest.gs` 有同一套計算**（快照與 Telegram 報告用），改一邊要改另一邊；
  `apps/web/tests/joint-investments.test.cjs` 會拿同一份資料比對兩邊結果。

## 權限（rules）
- 讀：household 成員都能讀全部持股（共同 + 兩人各自的，這就是功能目的）。
- 寫：`personal` 只有持有人本人；`joint` 需要 `canManageInvestments`（預設開，owner 永遠可以）；
  `source: 'portfolio'` 只有 role owner/admin 能建立且只能連結自己的。`bucket / ownerUid / createdBy / source` 建立後不可改。
- 報價：member 只開 `stocks/{symbol}` 與 `fx_rates/{pair}` 的 **get**（不能 list，避免看到 owner 追蹤的全部股票）。
- Apps Script：role `member` 只能呼叫 `MEMBER_ALLOWED_ACTIONS_`（Main.gs）裡的 action，每個 handler 內再驗 household 成員身分。

## Telegram
- 綁定：`createTelegramLink` → `https://t.me/{bot}?start={token}`（40 碼 hex、24h、單次使用）→ bot 收到 `/start token` 寫 `telegram_links`。
  owner 可以替伴侶產生連結（傳給她就能加入 RMoney Telegram）。誰點開就綁到該帳號，所以只傳給本人；綁錯可在設定解除。
- 已綁定的非 owner chat 只能用 `/report`、`/invest`、`/unlink`、`/help`；owner 的記帳 / 查帳指令不開放。
- 報告：`runHouseholdReports()` 每天 21:00 依頻率發給每位已綁定成員（owner 沒綁定 → `TG_CHAT_ID`）。
  內容：本月共同支出 / 預算 / 誰欠誰 / 公基金 + 共同投資市值 / 損益 / 各自持有 / 前 5 大 / 目標進度。
  設定頁可「立即傳一份給我」。

## 已知限制 / TODO(owner)
- 連結部位只同步股數與均價，不同步 portfolio 的已實現損益與股利。
- 持股沒有記錄「用誰的錢買」；共同持有的歸屬只看 `jointShares`。若要追蹤各自出資，之後可加 `contributions`。
- 報告時間固定 21:00（沿用既有 trigger，不用重新 `setupTriggers`）。
