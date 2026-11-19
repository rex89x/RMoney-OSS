# Feature: notifications

App 內通知中心（2026-11 稽核 F1）：Telegram 推播同步出現在 app 的鈴鐺裡，Telegram 掛掉也不會漏。

## 職責邊界
- **寫入只在 Apps Script**：`sendNotification_(key, message, parseMode, meta?)`（`apps-script/src/Notifications.gs`）送完 Telegram 後呼叫 `recordInAppNotification_`（`apps-script/src/InAppNotifications.gs`）寫 `notifications/{autoId}`。前端不建立通知。
- 前端只做：列表（最近 50 則）、未讀數、標已讀（單筆 / 全部，`writeBatch`）、刪除。
- 只給 owner：`firestore.rules` 的 `notifications/{id}` 是 `isOwner()`；`NotificationBell` / `NotificationCenter` 對非 owner 回 `null`，query 也 `enabled: isOwner`。

## 寫入規則（GAS）
| 規則 | 說明 |
|---|---|
| 閘門 | 與 Telegram 相同：`shouldNotify_(key)`（`TG_NOTIFY_ENABLED` + `users/{uid}.preferences.notifications.<key>`）。設定頁關掉某個 key，App 內也不會有。 |
| Telegram 失敗 | 照寫，`telegramOk: false`，面板顯示「Telegram 未送達」。 |
| notifyError | 1 小時去重在 `sendNotification_` 之前 return → 被壓掉的重複錯誤不寫；寫入時 `severity: 'error'`、標題「錯誤：<scope>」。 |
| best-effort | 寫入失敗只 `console.warn`，不影響 Telegram 與呼叫端回傳值。 |
| 保留 | `tick_daily_0100` → `cleanupOldNotifications_()` 刪 60 天前的 doc，每次最多 300 筆。 |
| owner uid | `getOwnerUid_()`：第一個 `role == 'owner'`（沒有則 `admin`）的 users doc id，CacheService 快取 6 小時。 |
| 不經過這裡的 Telegram | 共同帳本成員各自的 chat（`sendTelegramToChat_`）、Telegram bot 對話回覆 —— 不是 owner 通知，不寫。 |

## Doc 格式
`userId` / `key` / `title`（第一行去掉 `[Personal Hub]`）/ `body`（去分隔線、截 2000 字）/ `createdAt` / `readAt: null | Timestamp` / `link`（站內路徑，依 key 對應，見 `IN_APP_NOTIFICATION_LINKS_`）/ `severity: 'info' | 'warn' | 'error'` / `telegramOk`。

新增通知 key 時：若有對應頁面，在 `InAppNotifications.gs` 的 `IN_APP_NOTIFICATION_LINKS_` 加路徑（必須是 `router.tsx` 存在的路由），需要使用者處理的加進 `IN_APP_NOTIFICATION_WARN_KEYS_`；同時把 key 加到 `types/global.ts` 的 `NotificationKey` 與設定頁 `NotificationsPanel`。

## 讀取
- `useNotifications()`：`where userId == uid` + `orderBy createdAt desc` + `limit 50`，composite index 在 `firebase/firestore.indexes.json`。
- 不用 `onSnapshot`（CLAUDE.md §5.5）：`getDocs` + `refetchInterval: 60s` + `refetchOnWindowFocus: true`（只有這個 query 開，全域預設是關的）。
- `useUnreadNotificationCount()`：同一個 query 加 `select: countUnread`，不多一次讀取。
- mutation 成功後先 `setQueriesData` 讓徽章立即更新，再 invalidate。
- `link` 由 `safeNotificationLink()` 過濾，只接受站內 `/xxx` 路徑。

## UI 位置
- 桌面：側欄頂部（`components/layout/sidebar.tsx`）。
- 手機：首頁日期旁（`features/dashboard/home-dashboard.tsx`，`lg:hidden`）+ 底部「更多」分頁的未讀徽章，「更多」面板標題列也有鈴鐺，任何頁面都點得到。
- 面板 `NotificationCenter` 只在 `AppLayout` 掛一份，開關狀態在 `stores/notification-center-store.ts`。

## 主要 exports
`useNotifications`, `useUnreadNotificationCount`, `useMarkNotificationRead`, `useMarkAllNotificationsRead`, `useDeleteNotification`, `NotificationBell`, `NotificationCenter`。

## 測試
- `apps/web/tests/notifications.test.cjs`：`countUnread` / `formatUnreadBadge` / `safeNotificationLink` / `formatNotificationTime`（台北時區）。
- `apps-script/tests/in-app-notifications.test.cjs`：標題 / 內文切分、key → link / severity、閘門、Telegram 失敗、寫入失敗不影響、notifyError 去重、60 天清理。
