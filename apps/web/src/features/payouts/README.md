# Payouts

墊付團用來記錄「我先付，再向其他人收款」的情境，例如下午茶、團購、同仁生日餐費。

## Responsibility

- `api.ts`：讀寫 `payout_groups`，並同步建立 / 更新連動的 ledger transaction。
- `hooks.ts`：TanStack Query hooks，所有寫入成功後 invalidate `payout-groups` 與 `transactions`。
- `types.ts`：Firestore converter、待收 / 已收 / 分攤計算。
- `mail-export.ts`：產生墊付團 Email 的純文字、HTML 片段、完整 HTML 檔與 Outlook compose URL。
- `components/`：墊付團列表、編輯對話框、收款狀態切換與明細輸出。

## Birthday Split

`PayoutParticipant.amountTWD` 永遠代表實際應收金額，既有 dashboard 與 ledger 邏輯依此計算。

生日或請客情境使用：

- `baseAmountTWD`：該人的原始消費金額。
- `sharedByOthers`：該人的原始金額由其他未被分攤的同仁平均分攤。

儲存前會用 `calculateSharedPayoutParticipants` 重算：

- 被分攤者：`amountTWD = 0`。
- 其他同仁：`amountTWD = baseAmountTWD + 分攤額`。
- `totalAmountTWD` 仍以所有人的原始金額加總，代表我實際先付的總額。

## Message Output

列表提供固定格式輸出：

- 複製分帳明細：貼到 Slack / LINE / Gmail 皆可。
- Email 明細：預覽格式化 HTML、複製 rich HTML 到剪貼簿、複製完整 HTML 原始碼、下載 `.html` 檔，或開啟 Outlook Web compose 並帶入 subject/body。
