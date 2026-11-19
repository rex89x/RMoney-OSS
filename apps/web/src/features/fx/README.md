# Feature: fx

匯率 + alerts (fx/stock 共用)。

- `fx_rates/{pair}` 只存 latest (SPEC 要求)
- `alerts/{id}` 支援 `type: fx | stock`
- 觸發寫入 `alert_logs/{id}` + 發 Telegram
- `cooldownMinutes` 控制觸發頻率
