/**
 * InAppNotifications — App 內通知中心（2026-11 稽核 F1）。
 *
 * 所有走 sendNotification_(key, ...) 的推播（含 notifyError）在送 Telegram 之後，
 * 另寫一筆 Firestore `notifications/{autoId}`，前端鈴鐺讀這個 collection。
 *
 * 規則：
 *   - 與 Telegram 同一道閘門：只有 shouldNotify_(key) 為 true 才寫（全域開關 + 個別開關）。
 *   - Telegram 送失敗也照寫（telegramOk: false），通知不會因為 Telegram 掛掉而消失。
 *   - notifyError 的 1 小時去重在 sendNotification_ 之前就 return，被壓掉的重複錯誤不寫。
 *   - 寫入是 best-effort：任何錯誤只 console.warn，絕不影響 Telegram 發送或呼叫端。
 *   - 保留 60 天：tick_daily_0100 跑 cleanupOldNotifications_()，每次最多刪 300 筆。
 *
 * Doc 格式（firestore.rules：owner-only）：
 *   userId      owner uid（getOwnerUid_）
 *   key         通知 key（同 users/{uid}.preferences.notifications 的 key）
 *   title       訊息第一行（去掉「[Personal Hub]」前綴）
 *   body        其餘內容（去掉分隔線，截 2000 字）
 *   createdAt   Timestamp
 *   readAt      null | Timestamp（前端標已讀時寫）
 *   link        站內路徑（依 key 推得，沒有對應頁面則 null）
 *   severity    'info' | 'warn' | 'error'
 *   telegramOk  Telegram 是否送達
 */

var IN_APP_NOTIFICATION_TITLE_MAX_ = 120;
var IN_APP_NOTIFICATION_BODY_MAX_ = 2000;
var IN_APP_NOTIFICATION_RETENTION_DAYS_ = 60;
var IN_APP_NOTIFICATION_CLEANUP_LIMIT_ = 300;

/** key → 站內路徑。只列 apps/web/src/router.tsx 存在的路由與各頁實際支援的 ?tab=。 */
var IN_APP_NOTIFICATION_LINKS_ = {
  ledgerDaily: '/ledger',
  ledgerMonthly: '/ledger?tab=analysis',
  recurringRun: '/ledger',
  monthlyForecast: '/ledger?tab=analysis',
  categoryAnomaly: '/ledger?tab=analysis',
  loansReminder: '/ledger?tab=loans',
  payoutGroupReminder: '/ledger?tab=loans',
  weeklyReview: '/inbox',
  budgetWarn: '/settings?tab=budget',
  creditCardDue: '/settings?tab=bills',
  loanDue: '/settings?tab=accounts',
  scheduledPaymentDue: '/settings?tab=scheduled',
  subscriptionsDigest: '/settings?tab=subscriptions',
  fixedExpensesMonthly: '/settings?tab=subscriptions',
  savingsGoalProgress: '/settings?tab=goals',
  einvoiceSync: '/settings?tab=einvoice',
  aiBudget: '/settings?tab=ai-budget',
  errors: '/settings?tab=data',
  investmentPlanProgress: '/investments?tab=planner',
  marketDaily: '/investments',
  alertHit: '/investments?tab=alerts',
  swingSignals: '/investments?tab=swing',
  dividendCalendar: '/investments?tab=dividends',
  taxSeason: '/investments?tab=dividends',
  stockRadar: '/stock-radar',
  taifex: '/taifex',
  fxDaily: '/fx',
  tripDaily: '/trips',
  tripCountdown: '/trips',
  tripRecap: '/trips',
  flightDeals: '/flights',
  financialHealthDigest: '/ledger?tab=planning',
};

/** 需要使用者採取行動的提醒 → warn；errors → error；其餘 info。 */
var IN_APP_NOTIFICATION_WARN_KEYS_ = {
  budgetWarn: true,
  creditCardDue: true,
  loanDue: true,
  categoryAnomaly: true,
  scheduledPaymentDue: true,
  alertHit: true,
  aiBudget: true,
};

function inAppNotificationLink_(key) {
  return Object.prototype.hasOwnProperty.call(IN_APP_NOTIFICATION_LINKS_, key)
    ? IN_APP_NOTIFICATION_LINKS_[key]
    : null;
}

function inAppNotificationSeverity_(key) {
  if (key === 'errors') return 'error';
  return IN_APP_NOTIFICATION_WARN_KEYS_[key] === true ? 'warn' : 'info';
}

function stripTelegramHtml_(text) {
  return String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Telegram 訊息 → { title, body }。
 * title = 第一個非空行去掉「[Personal Hub]」前綴；body = 其餘行，去掉開頭的空行 / 分隔線（----）。
 */
function splitNotificationMessage_(message, parseMode) {
  var text = String(message == null ? '' : message);
  if (parseMode === 'HTML') text = stripTelegramHtml_(text);
  var lines = text.split(/\r?\n/);
  var idx = 0;
  while (idx < lines.length && !String(lines[idx]).trim()) idx++;
  var rawTitle = idx < lines.length ? String(lines[idx]) : '';
  var title = rawTitle.replace(/^\s*\[Personal Hub\]\s*/i, '').trim();
  var rest = lines.slice(idx + 1);
  while (rest.length && (!String(rest[0]).trim() || /^\s*[-=─—_]{3,}\s*$/.test(rest[0]))) rest.shift();
  var body = rest.join('\n').replace(/\s+$/, '');
  if (!title) title = '通知';
  if (title.length > IN_APP_NOTIFICATION_TITLE_MAX_) title = title.slice(0, IN_APP_NOTIFICATION_TITLE_MAX_ - 1) + '…';
  if (body.length > IN_APP_NOTIFICATION_BODY_MAX_) body = body.slice(0, IN_APP_NOTIFICATION_BODY_MAX_ - 1) + '…';
  return { title: title, body: body };
}

/**
 * 組 notifications doc（純函式，方便測試）。
 * meta（可選）：{ title?: string, severity?: 'info'|'warn'|'error' } — 呼叫端想覆寫自動推得的值時用。
 */
function buildInAppNotification_(key, message, parseMode, ownerUid, telegramResult, now, meta) {
  var parts = splitNotificationMessage_(message, parseMode);
  var m = meta || {};
  var title = m.title ? String(m.title).slice(0, IN_APP_NOTIFICATION_TITLE_MAX_) : parts.title;
  var severity = (m.severity === 'info' || m.severity === 'warn' || m.severity === 'error')
    ? m.severity
    : inAppNotificationSeverity_(key);
  return {
    userId: String(ownerUid),
    key: String(key),
    title: title,
    body: parts.body,
    createdAt: now || new Date(),
    readAt: null,
    link: inAppNotificationLink_(key),
    severity: severity,
    telegramOk: !!(telegramResult && telegramResult.ok),
  };
}

/** best-effort 寫入；回傳 true / false（失敗或找不到 owner）。不會 throw。 */
function recordInAppNotification_(key, message, parseMode, telegramResult, meta) {
  try {
    var uid = getOwnerUid_();
    if (!uid) {
      console.warn('[inAppNotification] owner uid not found; skipped', key);
      return false;
    }
    fsAddDoc_('notifications', buildInAppNotification_(key, message, parseMode, uid, telegramResult, new Date(), meta));
    return true;
  } catch (err) {
    console.warn('[inAppNotification] write failed', key, err);
    return false;
  }
}

/** 刪除 60 天前的 App 內通知（tick_daily_0100）。每次最多 300 筆，剩下的明天再刪。 */
function cleanupOldNotifications_(now) {
  var base = now || new Date();
  var cutoff = new Date(base.getTime() - IN_APP_NOTIFICATION_RETENTION_DAYS_ * 24 * 3600 * 1000);
  var docs;
  try {
    docs = fsRunQuery_('', {
      from: [{ collectionId: 'notifications' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'createdAt' },
          op: 'LESS_THAN',
          value: { timestampValue: cutoff.toISOString() },
        },
      },
      limit: IN_APP_NOTIFICATION_CLEANUP_LIMIT_,
    });
  } catch (err) {
    console.warn('[cleanupOldNotifications_] query', err);
    return { ok: false, deleted: 0 };
  }
  var writes = (docs || [])
    .filter(function (d) { return d && d._name; })
    .map(function (d) { return { delete: d._name }; });
  if (!writes.length) return { ok: true, deleted: 0 };
  try {
    fsBatchWrite_(writes);
    console.log('Cleaned up ' + writes.length + ' old in-app notifications');
    return { ok: true, deleted: writes.length };
  } catch (err) {
    console.warn('[cleanupOldNotifications_] batch delete failed', err);
    return { ok: false, deleted: 0 };
  }
}
