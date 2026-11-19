# Personal Hub — 功能 Roadmap 提案 (2026-09)

> 狀態：**已拍板（2026-09-05）**，依 §2 排程執行。決策見 §3。
> 背景：owner 回饋目前主要只用來「看投資狀態」與「看記帳總覽」，希望提升整體實用性。

---

## 0. 現況診斷

盤點結果：系統已經非常完整 —— 20 個 feature 模組、24 張可自訂首頁卡片、25 種 Telegram 推播、12 個設定分頁。

問題不在「功能不夠多」，而是絕大多數功能都是**輸出型**（報表、卡片、推播）。缺的是三種能把 app 變成「每天會打開來用」的能力：

| 缺口 | 說明 | 目前狀況 |
|---|---|---|
| A. 輸入成本 | 記帳還是要手動開 dialog 填 5 個欄位；Telegram 快速記帳只靠 regex，無法帶帳戶/日期 | 沒有範本、沒有自動補完、沒有發票匯入 |
| B. 決策建議 | 投資頁顯示偏差與缺口，但沒有告訴你「今天要買多少、用哪個帳戶」 | allocation-vs-target 只顯示差異 |
| C. 關閉迴圈 | 推播提醒很多，但沒有一個地方集中「待處理事項」讓你勾掉 | 提醒散在 Telegram 與各分頁 |

---

## 1. 提案清單（依優先序）

### P0 — 最快感受到差異（建議第一個 sprint）

#### 1. 待處理 Inbox + 每週回顧
- 首頁最上方一張「需要處理」卡 + `/inbox` 頁，集中：
  - 類別為 `other` / 未填備註的交易
  - 未結清代墊、墊付團未收齊
  - 訂閱偵測到但未確認的候選
  - 信用卡帳單到期未標記已繳、排程支出到期
  - 預算 ≥ 80% 的類別
- 每項可直接在卡片上處理（改類別、標已繳、確認訂閱），處理完就消失。
- 週日晚上推播「本週回顧」，附 deep link 回 inbox。
- **技術**：純前端聚合既有 query，不需要新 collection；只加一個 `inboxDismissed` map 在 `users/{uid}`。

#### 2. 快速記帳降 friction
- **常用交易範本**：「早餐 現金 60」「捷運 悠遊卡 30」一鍵記帳，範本可從歷史高頻交易自動推薦。
- **備註自動補完**：輸入備註前綴時，用近 90 天同名交易帶入類別 / 支付方式 / 金額。
- **PWA shortcuts**：`manifest.webmanifest` 加 `shortcuts`，長按 icon 直接開記帳 / 查投資。
- **Telegram 記帳升級**：`tgQuickEntry_` 改用 Gemini 結構化解析（金額、幣別、類別、帳戶、日期、備註），回覆 inline keyboard 讓你一鍵改類別或取消。

#### 3. 台灣電子發票匯入
- 目標：刷卡 / 載具消費不用手動記，每天自動進 inbox 待確認。
- 分兩階段：
  1. **CSV 匯入**：財政部「發票存摺」或載具平台匯出的 CSV，匯入時比對既有交易（同日 ± 金額）去重，剩下的進 inbox。
  2. **自動同步**：申請財政部電子發票整合服務平台 App ID，GAS 每日 01:00 用手機條碼 + 驗證碼拉取。
- **需要 owner 確認**：是否已有手機條碼載具、是否願意申請 API（見 §3 問題 1）。

### P1 — 投資端變成決策工具

#### 4. 再平衡計算器
- 在 allocation-vs-target 加「要買 / 賣幾股、金額、用哪個帳戶現金」；月投入建議依 target 權重拆到標的。
- 一鍵把建議變成 inbox 待辦，執行後記錄成 portfolio lot。

#### 5. 除息日曆 + 股利稅務試算
- GAS 每日抓 TWSE / TPEx 除權息預告，對持倉標的產生 upcoming 除息事件 + 推播。
- 稅務試算：二代健保補充保費（單筆 ≥ 20,000 元扣 2.11%）、股利所得合併 8.5% 抵減 vs 分離 28%、海外所得 100 萬申報門檻與 670 萬基本所得額。
- 每年 4 月推播「報稅資料整理」：年度股利、海外所得、可抵減額。

#### 6. 相對型持倉警報
- 現有 alerts 只支援固定門檻；新增規則：跌破 N 日均線、創 52 週新高 / 新低、單一標的佔比 > X%、距成本 ± Y%。

### P2 — 回顧與洞察

#### 7. 年度回顧頁
- 跨年比較（支出 / 收入 / 儲蓄率）、淨值變化拆解（本金投入 vs 市值變動）、Top 商家、出遊總花費、投資年化報酬。
- 可匯出 PDF 或分享圖片。

#### 8. 自然語言查詢
- Telegram `/ask 上個月餐飲花多少` 或 app 內「問一下」輸入框。
- Gemini function calling 對應到既有的聚合函式（by category / by month / by account），不讓 LLM 直接碰 Firestore。

#### 9. 全域搜尋 Cmd+K
- **已存在**（`components/command-palette.tsx`：頁面 / 動作 / 股票 / 旅程，含 G+字母 hotkey）。S1 只補了「需要處理」入口；剩下可加的是搜交易備註，併入 S4 視需要。

### P3 — 資料品質

#### 10. 帳戶對帳
- 輸入銀行 / 信用卡實際餘額，差額自動建「調整」交易並標記對帳日。
- 信用卡帳單 CSV 匯入比對（先支援 1 到 2 家常用銀行格式），未對上的進 inbox。

#### 11. 首頁精簡
- 24 張卡太多，改為「今日焦點」+ 三段（現金流 / 投資 / 待辦），其餘折疊；目前的自訂排序保留。

---

## 2. 建議排程

| Sprint | 內容 | 預估 |
|---|---|---|
| S1 | #1 Inbox + #2 快速記帳（範本、補完、PWA shortcuts、Telegram Gemini 解析）+ 每週回顧推播 | **完成 2026-09-05**（branch `claude/busy-cori-sq5u20`） |
| S2 | #3 電子發票 CSV 匯入 + #11 首頁精簡 | **完成 2026-09-05** |
| S3 | #4 再平衡計算器 + #5 除息日曆與稅務試算 | **完成 2026-09-05** |
| S4 | #7 年度回顧 + #8 自然語言查詢 | **完成 2026-09-05** |
| S5 | #3 階段二自動同步、#6 相對型警報、#10 對帳 | **完成 2026-09-06** |

---

## 3. owner 的決策（2026-09-05）

| # | 問題 | 決定 | 影響 |
|---|---|---|---|
| 1 | 電子發票載具 | **已綁定手機條碼** | #3 兩階段都做：S2 先 CSV 匯入，之後申請財政部 API 自動同步 |
| 2 | 股利稅務試算 | **要** | #5 納入 S3 |
| 3 | 家庭成員 | **考慮讓伴侶使用** | Inbox 與範本以 `ownerId` 區分；dismissed 狀態存在各自 `users/{uid}`；household scope 的項目兩人都看得到 |
| 4 | 首頁改版 | **放 S2** | #11 與 #3 同一個 sprint |
| 5 | Telegram 或 app 內 | **app 內也要** | #2 範本 / 補完做在 QuickEntryDialog；#8 自然語言查詢做 Telegram + app 內「問一下」 |

---

## 4. S1 交付紀錄（2026-09-05）

| Commit | 內容 |
|---|---|
| `feat(inbox)` | `features/inbox` 聚合 7 類待辦；`/inbox` 頁、首頁頂端卡片、側欄「需要處理」；略過狀態存 `users/{uid}.preferences.inbox.dismissed` |
| `feat(ledger)` | 快速記帳「常用」chips（近 90 天同備註+類別+支付方式 ≥ 2 次）與備註自動補完 |
| `feat(pwa)` | manifest `shortcuts`：記帳 / 收入 / 需要處理 / 投資；`/?quickEntry=expense` 自動開 dialog |
| `feat(telegram)` | 自由文字改 Gemini 2.5 Flash 結構化解析（金額 / 幣別 / 類別 / 支付方式 / 日期 / 備註），回覆附「改類別」「刪除」inline 按鈕；無 key 時退回 regex |
| `feat(notifications)` | 週日 20:00 每週回顧推播（本週 vs 上週、TOP 類別、待辦數量 + `/inbox` 連結）；新增 `?action=setupTriggers` |

**部署後需要做一次**：呼叫 `setupTriggers`（web 端任一已登入 session 對 Apps Script POST `action=setupTriggers`，或 editor 執行 `setupTriggers()`）讓新的週日 20:00 trigger 生效。

## 5. S2–S4 交付紀錄（2026-09-05，同一條 branch / PR #1）

| Commit | 內容 |
|---|---|
| `feat(einvoice)` | 設定 → 發票：財政部載具下載檔（M/D pipe、Big5）與含 header 的 CSV；同號去重、同日同金額標「可能已記」可連結；新交易走 `createTransaction`；`transactions.invoiceNumber` |
| `feat(dashboard)` | 首頁分四段：今日焦點 / 現金流 / 投資 / 更多（預設折疊），折疊狀態存 `preferences.dashboard.collapsedSections` |
| `feat(investments)` 再平衡 | 投資儀表板「再平衡計算」：目標 vs 實際差額拆到個股買賣股數、額外投入、只買不賣、投資現金是否足夠 |
| `feat(investments)` 除息 | GAS `updateDividendCalendar`（TWSE / TPEx 預告 → `stocks/{symbol}.upcomingDividend`）、`notifyDividendCalendar`（7 天內除息）、`notifyTaxSeason`（4/1、5/1）；股息分頁新增除息日曆卡與年度稅務試算卡 |
| `feat(review)` | `/review` 年度回顧：收支 / 儲蓄率 vs 去年、月度、類別、商家、出遊、投資收益估算、淨值變化，可列印 |
| `feat(ask)` | GAS `askFinance`（Gemini function calling，白名單聚合工具）；Telegram `/ask`；app 內「問一下」dialog |

**部署後需要確認**：
1. `setupTriggers` 重新註冊（新增週日 20:00 每週回顧）。
2. 手動打一次 `updateDividendCalendar`（股息分頁「更新」按鈕），確認 TWSE / TPEx 欄位對應正確；本次開發環境無法連 twse.com.tw，欄位用正則比對，若 log 出現 `headers not recognised` 請把 fields 貼給我。
3. Telegram 傳一句「昨天 星巴克 180 刷玉山」與 `/ask 上個月餐飲花多少` 各測一次。

**後續待辦（未做）**：無，roadmap 全部完成。

## 7. S6 收尾（2026-09-06，PR #4）

| Commit | 內容 |
|---|---|
| `feat(ledger)` | 快速記帳「掃描收據」：Gemini 2.5 Flash 看圖帶入金額 / 幣別 / 日期 / 店名 / 品項 / 類別，照片存 Storage 為 `photoUrl`（SPEC §12 #7 OCR） |
| `feat(inbox)` | 手動待辦（`preferences.inbox.todos`）：需要處理頁可新增、完成；再平衡計算「加入待辦」把買賣建議變成待辦（roadmap #4 第二點） |
| `feat(palette)` | Cmd+K 搜近 90 天交易備註 / 類別 / 支付方式 / 金額，跳到記帳頁帶入搜尋（roadmap #9 補完） |


## 6. S5 交付紀錄（2026-09-06，PR #3）

| Commit | 內容 |
|---|---|
| `feat(alerts)` | 股價警報新增指標：站上 / 跌破 N 日均線、52 週新高 / 新低、距平均成本 %、持倉佔比 %；GAS 由日 K + portfolio + 快照計算，Telegram 訊息說明觸發原因 |
| `feat(accounts)` | 帳戶列「對帳」：輸入實際餘額 → 差額自動建 `adjustment` / `adjustment_income` 交易並記 `lastReconciledAt`；月底預測排除對帳調整 |
| `feat(einvoice)` | GAS `syncEInvoices`：財政部 API 自動同步載具發票（每日 01:00 + 面板「立即同步」）；需 `EINVOICE_APP_ID` / `EINVOICE_CARD_NO` / `EINVOICE_CARD_ENCRYPT` Script Properties |

**部署後需要做**：
1. 財政部平台申請 App ID 後，到 Apps Script Script Properties 設 `EINVOICE_APP_ID`、`EINVOICE_CARD_NO`、`EINVOICE_CARD_ENCRYPT`，再到設定 → 發票按「立即同步」測一次。沒設的話每日排程會安靜跳過。
2. 均線 / 52 週警報需要日 K：設定 → 資料按「回填 K 線（1 年）」一次。


---

## 8. 共同記帳 / 情侶帳務 / 目標（2026-09-06 規劃）

### 8.1 現況
- 已有 `member` 角色與 `Transaction.scope: 'household'` 欄位，但沒有任何 UI；`member` 登入後會在幾乎所有頁面撞到 permission error。
- 既有的「代墊 / 借貸」是姓名比對、單向、伴侶看不到；`savings_goals` 沒有 owner 欄位，不能直接分享。

### 8.2 設計
| 項目 | 決定 |
|---|---|
| 資料模型 | `households/{id}`（成員、分攤比例、共同預算、pendingInvites）+ `households/{id}/settlements`；共同支出仍在 `transactions`，加 `householdId` / `paidByUid` / `customShares`（uid → TWD）/ `myShareTWD` |
| 伴侶身份 | Google 登入 → `config/allowedEmails` → role `member`；只看得到 `/shared`、分享的 `/trips`、`/settings` 一般頁。看不到投資 / 帳戶 / 個人記帳 |
| 誰欠誰 | 純前端計算（`features/household/balance.ts`），GAS 每週回顧同算法多一行 |
| 結算 | settlement doc；owner 可選同時記一筆 `household_settlement(_income)` 交易動帳戶餘額 |
| Rules | 新增 `households`（成員可讀寫、memberIds 只由 GAS 改）、`transactions` 同 householdId 可讀、`categories` member 可讀 |
| 共同目標（C2） | `savings_goals.householdId` + `contributions.byUid`，兩人都能存入、看各自貢獻 |
| 共同預算（C2） | `household.monthlyBudgetTWD`，總覽進度條；≥80% 進 Inbox；首頁「共同帳」卡 |

### 8.3 Sprint
- **C1（本 PR）**：household feature、`/shared` 頁（總覽 / 交易 / 結算紀錄 / 設定）、member 模式導覽、快速記帳「共同分攤」、GAS 邀請 / 接受 / owner 過濾 / 每週回顧
- **C2（同 PR）**：共同目標（`savings_goals.householdId` + `contributions.byUid`、`/shared?tab=goals`）、共同預算警示（總覽 / Inbox / 每週回顧）、首頁「共同帳」卡

### 8.4 C3（2026-09-06）— 登入權限修正 + 權限管理 + 情侶功能補強
- **登入被擋的根因與修正**：登入頁會顯示被拒的 email；新增邀請連結（`/login?join=CODE`，Apps Script `joinHousehold` 免白名單）；GAS 白名單比對改不分大小寫；設定 → 權限有「登入疑難排解」可查某 email 的白名單 / users / 共同帳本狀態，並列出 OAuth 測試模式等 app 外原因。
- **權限管理**：設定 → 權限（admin）= 白名單 / viewer 名單 / 使用者角色 / 共同帳本成員；共同帳本設定可設每位成員 新增支出 / 結算 / 目標 / 改設定 四種權限、移除成員、產生 / 停用邀請連結；rules 同步強制。
- **情侶功能**：自己建立的共同支出可編輯；`/shared` 月報分頁（各自付了 / 應付 / 類別 / 結算，可複製）；目標每月計畫與倒推每月需存；旅程分享對話框一鍵分享給伴侶、可設新旅程自動分享。
