/**
 * Notifications — 集中所有 Telegram 通知 templating + 全域開關。
 *
 * 命名約定：notify*  - 對外可呼叫（會檢查開關）
 *           tpl*     - 內部 template，回 string
 *
 * 全域開關：Script Property `TG_NOTIFY_ENABLED` (預設 true)
 * 個別開關：Firestore `users/{uid}.preferences.notifications.<key>` (預設 true)
 *           key: ledgerDaily / ledgerMonthly / budgetWarn / recurringRun
 *                tripDaily / tripCountdown / marketDaily / investmentPlanProgress
 *                financialHealthDigest / aiBudget / errors
 * App 內通知：sendNotification_ 同時寫 Firestore `notifications`（見 InAppNotifications.gs）
 *
 * 因為這個 app 是單人使用，目前 user 開關走「第一個 owner」doc。
 */

var TZ = 'Asia/Taipei';

function notifyEnabled_() {
  var v = PROP.getProperty('TG_NOTIFY_ENABLED');
  return v === null || v === undefined || v === '' || v === 'true';
}

var OWNER_PREFS_CACHE_KEY_ = 'ownerNotifyPrefs:v1';

function getOwnerPrefs_() {
  // 取第一個 owner user 的 preferences.notifications；fail-open（找不到視為全開）
  // 每則通知都查一次 users 太浪費 UrlFetch 配額（notifyError 42 個呼叫點），快取 10 分鐘。
  var cache = null;
  try {
    cache = CacheService.getScriptCache();
    var hit = cache.get(OWNER_PREFS_CACHE_KEY_);
    if (hit) return JSON.parse(hit);
  } catch (cacheErr) { console.warn('getOwnerPrefs_ cache', cacheErr); }
  var prefs = loadOwnerPrefs_();
  try { if (cache) cache.put(OWNER_PREFS_CACHE_KEY_, JSON.stringify(prefs), 600); } catch (putErr) { console.warn('getOwnerPrefs_ cache put', putErr); }
  return prefs;
}

/** 第一個 owner user doc；沒有 owner 時退而找 admin。查詢失敗會 throw（由呼叫端決定 fail-open）。 */
function findOwnerUserDoc_() {
  var users = fsRunQuery_('', {
    from: [{ collectionId: 'users' }],
    where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL',
      value: { stringValue: 'owner' } } },
    limit: 1,
  });
  var u = users[0];
  if (!u) {
    // 首位使用者的 role 是 'admin'（ensureUserDoc），沒有 owner 時退而找 admin
    var admins = fsRunQuery_('', {
      from: [{ collectionId: 'users' }],
      where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL',
        value: { stringValue: 'admin' } } },
      limit: 1,
    });
    u = admins[0];
  }
  return u || null;
}

function loadOwnerPrefs_() {
  try {
    var u = findOwnerUserDoc_();
    // 順手把 uid 放進快取：App 內通知（InAppNotifications.gs）寫 userId 用，省一次查詢
    cacheOwnerUid_(ownerUidFromDoc_(u));
    return (u && u.preferences && u.preferences.notifications) || {};
  } catch (err) {
    console.warn('getOwnerPrefs_ failed', err);
    return {};
  }
}

// owner uid 幾乎不會變，快取 6 小時（CacheService 上限）
var OWNER_UID_CACHE_KEY_ = 'ownerUid:v1';
var OWNER_UID_CACHE_SECONDS_ = 21600;

function ownerUidFromDoc_(u) {
  return u && u._name ? String(u._name).split('/').pop() : '';
}

function cacheOwnerUid_(uid) {
  if (!uid) return;
  try { CacheService.getScriptCache().put(OWNER_UID_CACHE_KEY_, uid, OWNER_UID_CACHE_SECONDS_); } catch (err) { console.warn('cacheOwnerUid_', err); }
}

/** owner（或 fallback admin）的 uid；找不到回 null。 */
function getOwnerUid_() {
  try {
    var hit = CacheService.getScriptCache().get(OWNER_UID_CACHE_KEY_);
    if (hit) return hit;
  } catch (cacheErr) { console.warn('getOwnerUid_ cache', cacheErr); }
  try {
    var uid = ownerUidFromDoc_(findOwnerUserDoc_());
    cacheOwnerUid_(uid);
    return uid || null;
  } catch (err) {
    console.warn('getOwnerUid_ failed', err);
    return null;
  }
}

function shouldNotify_(key) {
  if (!notifyEnabled_()) return false;
  var prefs = getOwnerPrefs_();
  // undefined / true → on；只有顯式 false 才關
  return prefs[key] !== false;
}

// -------- low-level send --------

/**
 * 所有 owner 通知的唯一出口：Telegram + App 內通知中心（InAppNotifications.gs）。
 * App 內紀錄與 Telegram 同一道閘門（shouldNotify_），Telegram 失敗也照寫；寫入失敗只 warn，不影響回傳值。
 * meta（可選）：{ title, severity } 覆寫 App 內通知自動推得的標題 / 等級。
 */
function sendNotification_(key, message, parseMode, meta) {
  if (!shouldNotify_(key)) {
    console.log('[notify] skipped (off):', key);
    return { ok: false, skipped: true };
  }
  var result;
  try {
    result = sendTelegram(message, parseMode);
  } catch (err) {
    recordInAppNotification_(key, message, parseMode, { ok: false, error: String(err && err.message || err) }, meta);
    throw err;
  }
  recordInAppNotification_(key, message, parseMode, result, meta);
  return result;
}

// -------- public entrypoints --------

/**
 * 錯誤推播，同一個 scope + 訊息 1 小時內只發一次。
 * tick_15min 一天跑 96 次，FX API 掛掉一天就是 96 則一樣的訊息（2026-11 稽核 O1）；
 * 被壓掉的次數會在下一則同 key 的訊息附上。
 */
var NOTIFY_ERROR_DEDUPE_SECONDS_ = 3600;

function notifyError(scope, err) {
  var detail = String(err && err.message || err);
  var cache = null;
  var key = 'notifyError:' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(scope) + '|' + detail.slice(0, 200)));
  try {
    cache = CacheService.getScriptCache();
    var seen = cache.get(key);
    if (seen) {
      var n = (parseInt(seen, 10) || 1) + 1;
      cache.put(key, String(n), NOTIFY_ERROR_DEDUPE_SECONDS_);
      console.warn('[notifyError] suppressed duplicate', scope, detail.slice(0, 80), 'x' + n);
      return { ok: false, skipped: true, deduped: true, count: n };
    }
    cache.put(key, '1', NOTIFY_ERROR_DEDUPE_SECONDS_);
  } catch (cacheErr) { console.warn('notifyError cache', cacheErr); }
  // errors 開關預設 on；只有用戶顯式關才不發
  var msg = '[Personal Hub] Error\n--------------------\n'
    + 'Scope : ' + scope + '\n'
    + 'Error : ' + detail + '\n'
    + '(同樣的錯誤 1 小時內不再重複推播)';
  return sendNotification_('errors', msg, undefined, { title: '錯誤：' + scope, severity: 'error' });
}

function notifyRecurringRun(created, items) {
  if (!created) return { ok: true, skipped: true };
  var lines = [
    '[Personal Hub] Recurring',
    '--------------------',
    '已自動入帳 ' + created + ' 筆',
  ];
  if (items && items.length) {
    items.slice(0, 10).forEach(function (it) {
      lines.push('· ' + (it.title || it.note || it.category || '?')
        + ' NT$' + Math.round(it.amountTWD || it.amount || 0));
    });
    if (items.length > 10) lines.push('...其餘 ' + (items.length - 10) + ' 筆');
  }
  return sendNotification_('recurringRun', lines.join('\n'));
}

function notifyLedgerDaily() {
  var now = new Date();
  var yStart = new Date(now); yStart.setDate(yStart.getDate() - 1); yStart.setHours(0, 0, 0, 0);
  var yEnd = new Date(yStart); yEnd.setHours(23, 59, 59, 999);
  var dateStr = Utilities.formatDate(yStart, TZ, 'yyyy-MM-dd');

  var txs = queryTxsBetween_(yStart, yEnd);
  var byType = aggByType_(txs);
  var byCat = aggByCategory_(txs, 'expense');
  var topCats = topN_(byCat, 3);

  // 月累計 vs 預算
  var month = Utilities.formatDate(now, TZ, 'yyyy-MM');
  var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  var mTxs = queryTxsBetween_(mStart, mEnd);
  var mExpense = aggByType_(mTxs).expense;
  var budgetTotal = totalMonthBudget_(month);

  var lines = [
    '[Personal Hub] 每日記帳彙整',
    '--------------------',
    '日期  : ' + dateStr,
    '收入  : NT$' + n0(byType.income),
    '支出  : NT$' + n0(byType.expense),
    '淨額  : NT$' + n0(byType.income - byType.expense),
    '筆數  : ' + txs.length,
  ];
  if (topCats.length) {
    lines.push('TOP 類別:');
    topCats.forEach(function (c) {
      lines.push('  · ' + c.key + ' NT$' + n0(c.val));
    });
  }
  lines.push('--------------------');
  lines.push('本月支出: NT$' + n0(mExpense)
    + (budgetTotal ? ' / NT$' + n0(budgetTotal) + ' (' + Math.round(mExpense / budgetTotal * 100) + '%)' : ''));
  return sendNotification_('ledgerDaily', lines.join('\n'));
}

function notifyLedgerMonthly() {
  var now = new Date();
  var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var mStart = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1);
  var mEnd = new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0, 23, 59, 59);
  var monthStr = Utilities.formatDate(mStart, TZ, 'yyyy-MM');

  var txs = queryTxsBetween_(mStart, mEnd);
  var byType = aggByType_(txs);
  var byCat = aggByCategory_(txs, 'expense');
  var top = topN_(byCat, 5);

  // 上上月比較
  var prev = new Date(mStart.getFullYear(), mStart.getMonth() - 1, 1);
  var prevEnd = new Date(prev.getFullYear(), prev.getMonth() + 1, 0, 23, 59, 59);
  var pTxs = queryTxsBetween_(prev, prevEnd);
  var pExpense = aggByType_(pTxs).expense;
  var diff = byType.expense - pExpense;
  var diffPct = pExpense ? (diff / pExpense * 100) : 0;

  var lines = [
    '[Personal Hub] 月度彙整',
    '--------------------',
    '月份  : ' + monthStr,
    '收入  : NT$' + n0(byType.income),
    '支出  : NT$' + n0(byType.expense),
    '淨額  : NT$' + n0(byType.income - byType.expense),
    '筆數  : ' + txs.length,
    '與上月: ' + (diff >= 0 ? '+' : '') + 'NT$' + n0(diff)
      + ' (' + (diffPct >= 0 ? '+' : '') + diffPct.toFixed(1) + '%)',
  ];
  if (top.length) {
    lines.push('TOP 類別:');
    top.forEach(function (c) { lines.push('  · ' + c.key + ' NT$' + n0(c.val)); });
  }
  return sendNotification_('ledgerMonthly', lines.join('\n'));
}

function notifyBudgetWarn() {
  var now = new Date();
  var month = Utilities.formatDate(now, TZ, 'yyyy-MM');
  var budgets = fsListDocs_('budgets', 50);
  var budget = budgets.filter(function (b) { return b.month === month; })[0];
  if (!budget || !budget.byCategory) return { ok: true, skipped: true };

  var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  var txs = queryTxsBetween_(mStart, mEnd);
  var byCat = aggByCategory_(txs, 'expense');

  var alerts = [];
  Object.keys(budget.byCategory).forEach(function (cat) {
    var lim = budget.byCategory[cat];
    var spent = byCat[cat] || 0;
    if (!lim) return;
    var pct = spent / lim * 100;
    if (pct >= 100) alerts.push({ cat: cat, pct: pct, spent: spent, lim: lim, level: 'over' });
    else if (pct >= 80) alerts.push({ cat: cat, pct: pct, spent: spent, lim: lim, level: 'warn' });
  });
  if (!alerts.length) return { ok: true, skipped: true };

  var lines = ['[Personal Hub] 預算提醒', '--------------------', '月份: ' + month];
  alerts.forEach(function (a) {
    var tag = a.level === 'over' ? '[超標] ' : '[80%] ';
    lines.push(tag + a.cat + ' ' + Math.round(a.pct) + '% '
      + '(' + n0(a.spent) + '/' + n0(a.lim) + ')');
  });
  return sendNotification_('budgetWarn', lines.join('\n'));
}

function notifyTripDaily() {
  var now = new Date();
  var todayStr = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  var trips = fsListAllDocs_('trips', 200);
  var todays = trips.filter(function (t) {
    var sd = t.startDate instanceof Date ? t.startDate : new Date(t.startDate);
    var ed = t.endDate instanceof Date ? t.endDate : new Date(t.endDate);
    if (!sd || !ed) return false;
    return sd <= now && now <= addDays_(ed, 1) && t.status !== 'done';
  });

  if (!todays.length) return { ok: true, skipped: true };

  var lines = ['[Personal Hub] 行程日報', '--------------------', '日期: ' + todayStr];
  todays.forEach(function (t) {
    var sd = t.startDate instanceof Date ? t.startDate : new Date(t.startDate);
    var ed = t.endDate instanceof Date ? t.endDate : new Date(t.endDate);
    var dayIdx = Math.floor((now - sd) / 86400000) + 1;
    var totalDays = Math.floor((ed - sd) / 86400000) + 1;
    lines.push('· ' + (t.name || '行程') + ' (Day ' + dayIdx + '/' + totalDays + ')');
    if (t.destination && t.destination.length) {
      lines.push('  目的地: ' + (Array.isArray(t.destination) ? t.destination.join(', ') : t.destination));
    }
    // 試著抓 itinerary 的今日 items
    if (t.itineraryId) {
      try {
        var dayDoc = 'itineraries/' + t.itineraryId + '/days/' + todayStr;
        var day = fsGetDoc_(dayDoc);
        if (day) {
          var items = fsListDocs_(dayDoc + '/items', 20);
          if (items.length) {
            lines.push('  今日行程:');
            items.slice(0, 5).forEach(function (it) {
              var time = it.startTime || '';
              lines.push('    ' + (time ? time + ' ' : '') + (it.title || it.name || it.placeName || ''));
            });
            if (items.length > 5) lines.push('    ...共 ' + items.length + ' 項');
          }
        }
      } catch (err) {
        console.warn('trip day items', t.itineraryId, err);
      }
    }
  });
  return sendNotification_('tripDaily', lines.join('\n'));
}

function notifyTripCountdown() {
  var now = new Date();
  now.setHours(0, 0, 0, 0);
  var trips = fsListAllDocs_('trips', 200);
  var upcoming = [];
  trips.forEach(function (t) {
    if (t.status === 'done') return;
    var sd = t.startDate instanceof Date ? t.startDate : new Date(t.startDate);
    if (!sd) return;
    var sd0 = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate());
    var diff = Math.round((sd0 - now) / 86400000);
    if (diff === 7 || diff === 3 || diff === 1) {
      upcoming.push({ trip: t, days: diff });
    }
  });
  if (!upcoming.length) return { ok: true, skipped: true };

  var lines = ['[Personal Hub] 出遊倒數', '--------------------'];
  upcoming.forEach(function (u) {
    lines.push('· ' + (u.trip.name || '?') + ' — ' + u.days + ' 天後出發');
    if (u.trip.destination) {
      lines.push('  ' + (Array.isArray(u.trip.destination) ? u.trip.destination.join(', ') : u.trip.destination));
    }
  });
  return sendNotification_('tripCountdown', lines.join('\n'));
}

/**
 * 每日檢查 error_logs 近 24h 的錯誤並發 Telegram 彙整（若有）。
 */
function notifyErrorDigest() {
  var since = new Date(Date.now() - 24 * 3600 * 1000);
  var logs;
  try {
    logs = fsRunQuery_('', {
      from: [{ collectionId: 'error_logs' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'createdAt' },
          op: 'GREATER_THAN',
          value: { timestampValue: since.toISOString() },
        },
      },
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
      limit: 50,
    });
  } catch (err) {
    console.warn('notifyErrorDigest query', err);
    return { ok: true, skipped: true };
  }
  if (!logs || logs.length === 0) return { ok: true, skipped: true };

  // 以 scope+message 前 60 字聚合
  var buckets = {};
  logs.forEach(function (l) {
    var key = (l.scope || 'unknown') + ' :: ' + String(l.message || '').slice(0, 60);
    buckets[key] = (buckets[key] || 0) + 1;
  });
  var lines = ['[Personal Hub] 錯誤彙整（24h）', '--------------------', '共 ' + logs.length + ' 筆 / ' + Object.keys(buckets).length + ' 類型'];
  Object.keys(buckets).slice(0, 10).forEach(function (k) {
    lines.push('  · ' + k + '  x' + buckets[k]);
  });
  return sendNotification_('errors', lines.join('\n'));
}

/**
 * 每日提醒未結清的代墊 / 借貸（splitMode != 'self' 且沒有 loanSettledAt）。
 * 預設掛在每天 21:00 trigger 跑。
 */
function notifyLoansReminder() {
  var txs;
  try {
    // 一年內的 tx
    var since = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    txs = fsRunQuery_('', {
      from: [{ collectionId: 'transactions' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'date' },
          op: 'GREATER_THAN_OR_EQUAL',
          value: { timestampValue: since.toISOString() },
        },
      },
      limit: 500,
    });
  } catch (err) {
    console.warn('notifyLoansReminder query', err);
    return { ok: true, skipped: true };
  }

  // 篩出未結清的代墊 / 借貸
  var openTxs = (txs || []).filter(function (t) {
    if (t.deletedAt) return false;
    if (!t.splitMode || t.splitMode === 'self') return false;
    if (t.loanSettledAt) return false;
    return !!t.counterpartyName;
  });
  if (openTxs.length === 0) return { ok: true, skipped: true };

  // group by counterparty 並計算 net (TWD)
  var byName = {};
  openTxs.forEach(function (t) {
    var name = String(t.counterpartyName || '?');
    if (!byName[name]) byName[name] = { count: 0, owedToMe: 0, iOwe: 0, net: 0, oldestDays: 0 };
    var amt = (t.settledAmountTWD != null) ? t.settledAmountTWD : (t.amountTWD || 0);
    var myShare = (t.myShareTWD != null) ? t.myShareTWD : 0;
    var loanAmt = Math.max(0, amt - myShare);
    if (t.splitMode === 'i-paid-others') {
      byName[name].owedToMe += loanAmt;
      byName[name].net += loanAmt;
    } else {
      byName[name].iOwe += loanAmt;
      byName[name].net -= loanAmt;
    }
    byName[name].count += 1;
    var ageDays = Math.floor((Date.now() - new Date(t.date).getTime()) / 86400000);
    if (ageDays > byName[name].oldestDays) byName[name].oldestDays = ageDays;
  });

  var names = Object.keys(byName).sort(function (a, b) {
    return Math.abs(byName[b].net) - Math.abs(byName[a].net);
  });

  var totalOwedToMe = 0;
  var totalIOwe = 0;
  names.forEach(function (n) {
    totalOwedToMe += byName[n].owedToMe;
    totalIOwe += byName[n].iOwe;
  });

  var lines = [
    '[Personal Hub] 代墊 / 借貸提醒',
    '--------------------',
    '尚未結清 ' + openTxs.length + ' 筆 · ' + names.length + ' 人',
    '應收合計: NT$' + n0(totalOwedToMe),
    '應付合計: NT$' + n0(totalIOwe),
    '淨額    : ' + (totalOwedToMe - totalIOwe >= 0 ? '+' : '') + 'NT$' + n0(totalOwedToMe - totalIOwe),
    '--------------------',
  ];
  names.slice(0, 10).forEach(function (n) {
    var b = byName[n];
    var sign = b.net >= 0 ? '應收' : '應付';
    lines.push('· ' + n + ' [' + sign + ' NT$' + n0(Math.abs(b.net)) + '] '
      + b.count + ' 筆' + (b.oldestDays >= 7 ? ' · 最舊 ' + b.oldestDays + ' 天' : ''));
  });
  if (names.length > 10) lines.push('  …其餘 ' + (names.length - 10) + ' 人');

  return sendNotification_('loansReminder', lines.join('\n'));
}

/**
 * 21:00 跑：先 updateFxRates() 再呼叫此函式報告匯率與當日變化。
 * fxResult 來自 updateFxRates()：{ ok, updated: [pair...], error? }
 */
function notifyFxDaily(fxResult) {
  var lines = ['[匯率日報] ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
    '--------------------'];
  if (fxResult && fxResult.error) {
    lines.push('更新失敗：' + fxResult.error);
    return sendNotification_('fxDaily', lines.join('\n'));
  }
  var rates = fsListDocs_('fx_rates', 50).filter(function (r) { return r.base && r.quote && r.rate; });
  if (rates.length === 0) {
    lines.push('尚無匯率資料');
    return sendNotification_('fxDaily', lines.join('\n'));
  }
  rates.forEach(function (r) {
    var pair = r.base + '_' + r.quote;
    var prev = null;
    try {
      var candles = fsListDocs_('fx_rates/' + pair + '/candles', 5);
      if (candles && candles.length >= 2) prev = candles[candles.length - 2].rate;
    } catch (ignoredErr) { console.warn('[Notifications:460] ignored', ignoredErr); }
    var diff = prev ? r.rate - prev : 0;
    var pct = prev ? (diff / prev * 100) : 0;
    var arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '•';
    lines.push(arrow + ' ' + r.base + '/' + r.quote + ' ' + r.rate.toFixed(4)
      + (prev ? ' (' + (diff >= 0 ? '+' : '') + diff.toFixed(4)
        + ' / ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)' : ''));
  });
  if (fxResult && fxResult.updated) {
    lines.push('--------------------');
    lines.push('已更新 ' + fxResult.updated.length + ' 對');
  }
  return sendNotification_('fxDaily', lines.join('\n'));
}

function notifyMarketDaily() {
  var lines = ['[Personal Hub] 市場日報', '--------------------'];

  // FX
  var rates = fsListDocs_('fx_rates', 30).filter(function (r) { return r.base && r.quote; });
  if (rates.length) {
    lines.push('匯率:');
    rates.forEach(function (r) {
      // 對昨日 candle
      var candles = fsListDocs_('fx_rates/' + r.base + '_' + r.quote + '/candles', 5);
      var prev = candles.length >= 2 ? candles[candles.length - 2].rate : null;
      var diff = prev ? r.rate - prev : 0;
      var pct = prev ? (diff / prev * 100) : 0;
      lines.push('  · ' + r.base + '/' + r.quote + ' ' + r.rate.toFixed(4)
        + (prev ? ' (' + (diff >= 0 ? '+' : '') + diff.toFixed(4) + ' / ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)' : ''));
    });
  }

  // Portfolio — 改讀 portfolio_snapshots（最新 + 前一日）以取得精確的 TWD 凍結值
  try {
    var latest = getLatestSnapshot_();
    if (!latest) {
      // 沒 snapshot 時不提供 portfolio 區塊（避免兩種計算法併存）
      console.log('notifyMarketDaily: no snapshot yet, skipping portfolio block');
    } else {
      lines.push('持倉 (' + latest.date + '):');
      var dayChange = latest.dayChangeTWD || 0;
      var dayPct = latest.dayChangePct || 0;
      lines.push('  總值: NT$' + n0(latest.totalValueTWD)
        + ' (今日 ' + (dayChange >= 0 ? '+' : '') + n0(dayChange)
        + ' / ' + (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '%)');
      var pnl = latest.unrealizedPnlTWD || 0;
      var pnlPct = latest.unrealizedPnlPct || 0;
      lines.push('  總損益: ' + (pnl >= 0 ? '+' : '') + n0(pnl)
        + ' (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%)');

      // 市場拆分
      if (latest.byMarket) {
        var mkLines = [];
        Object.keys(latest.byMarket).forEach(function (mk) {
          var m = latest.byMarket[mk];
          if (!m || !m.valueTWD) return;
          var mc = m.dayChangeTWD || 0;
          mkLines.push('    ' + mk + ' NT$' + n0(m.valueTWD)
            + ' (今日 ' + (mc >= 0 ? '+' : '') + n0(mc) + ')');
        });
        if (mkLines.length) lines.push.apply(lines, mkLines);
      }

      // Top 5 個股（依今日漲跌絕對值排序）
      var positions = (latest.positions || []).slice();
      if (positions.length) {
        positions.sort(function (a, b) { return Math.abs(b.dayChangeTWD || 0) - Math.abs(a.dayChangeTWD || 0); });
        var top = positions.slice(0, 5);
        if (top.length) {
          lines.push('  今日漲跌前 ' + top.length + ' 檔:');
          top.forEach(function (p) {
            var dc = p.dayChangeTWD || 0;
            lines.push('    · ' + p.symbol + ' ' + (dc >= 0 ? '+' : '') + n0(dc)
              + ' (損益 ' + (p.pnlTWD >= 0 ? '+' : '') + n0(p.pnlTWD || 0) + ')');
          });
        }
      }
    }
  } catch (err) {
    console.warn('market daily portfolio (snapshot)', err);
  }

  if (lines.length === 2) return { ok: true, skipped: true };
  return sendNotification_('marketDaily', lines.join('\n'));
}

function getLatestSnapshot_() {
  try {
    var docs = fsRunQuery_('', {
      from: [{ collectionId: 'portfolio_snapshots' }],
      orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
      limit: 1,
    });
    return (docs && docs[0]) ? docs[0] : null;
  } catch (err) {
    console.warn('getLatestSnapshot_', err);
    return null;
  }
}

function notifyInvestmentPlanProgress() {
  var plans;
  try {
    plans = fsRunQuery_('', {
      from: [{ collectionId: 'investment_plans' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'archivedAt' }, op: 'EQUAL', value: { nullValue: null } } },
            { fieldFilter: { field: { fieldPath: 'alertEnabled' }, op: 'EQUAL', value: { booleanValue: true } } },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: 'targetDate' }, direction: 'ASCENDING' }],
      limit: 20,
    });
  } catch (err) {
    console.warn('notifyInvestmentPlanProgress query', err);
    return { ok: true, skipped: true };
  }
  if (!plans || !plans.length) return { ok: true, skipped: true };

  var latest = getLatestSnapshot_();
  var portfolioValue = latest ? (latest.totalValueTWD || 0) : 0;
  var lines = [
    '【投資計畫追蹤】',
    '投資快照｜NT$' + n0(portfolioValue) + (latest && latest.date ? '（' + latest.date + '）' : ''),
  ];

  plans.forEach(function (plan) {
    var target = Number(plan.targetAmountTWD || 0);
    if (!target) return;
    var current = typeof plan.currentAmountTWD === 'number'
      ? plan.currentAmountTWD
      : (plan.fundingSource === 'portfolio' ? portfolioValue : 0);
    var monthly = Number(plan.monthlyContributionTWD || 0);
    var monthsLeft = monthsLeft_(new Date(), plan.targetDate || new Date());
    var monthlyRate = Number(plan.expectedAnnualReturnPct || 0) / 100 / 12;
    var projected = futureValue_(current, monthly, monthlyRate, monthsLeft);
    var required = requiredMonthly_(current, target, monthlyRate, monthsLeft);
    var progress = target ? current / target * 100 : 0;
    var gap = Math.max(0, target - projected);
    lines.push('');
    lines.push('【' + (plan.name || '投資計畫') + '】');
    lines.push('進度｜' + progress.toFixed(1) + '%；NT$' + n0(current) + '／NT$' + n0(target));
    lines.push('期限｜' + formatDateTW_(plan.targetDate || new Date()) + '；剩 ' + monthsLeft + ' 個月');
    lines.push('預估｜NT$' + n0(projected) + (gap > 0 ? '；缺口 NT$' + n0(gap) : '；可望達標'));
    lines.push('月投入｜目前 NT$' + n0(monthly) + '；建議 NT$' + n0(required));
  });

  if (lines.length <= 2) return { ok: true, skipped: true };
  return sendNotification_('investmentPlanProgress', lines.join('\n'));
}

function monthsLeft_(from, to) {
  var f = from instanceof Date ? from : new Date(from);
  var t = to instanceof Date ? to : new Date(to);
  var months = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth());
  if (t.getDate() < f.getDate()) months -= 1;
  return Math.max(1, months);
}

function futureValue_(current, monthlyContribution, monthlyRate, months) {
  if (Math.abs(monthlyRate) < 0.000001) return current + monthlyContribution * months;
  var growth = Math.pow(1 + monthlyRate, months);
  return current * growth + monthlyContribution * ((growth - 1) / monthlyRate);
}

function requiredMonthly_(current, target, monthlyRate, months) {
  if (months <= 0) return Math.max(0, target - current);
  if (Math.abs(monthlyRate) < 0.000001) return Math.max(0, (target - current) / months);
  var growth = Math.pow(1 + monthlyRate, months);
  var futureCurrent = current * growth;
  var annuityFactor = (growth - 1) / monthlyRate;
  return Math.max(0, (target - futureCurrent) / annuityFactor);
}

function formatDateTW_(date) {
  var d = date instanceof Date ? date : new Date(date);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

/**
 * 信用卡帳單到期提醒。
 *
 * 邏輯：
 *   - 對每張 type='credit' 且 billingEnabled=true 的 payment method
 *   - 計算「最近一個 dueDate ≤ today」當作本期 cycle (cycleMonth = dueDate 的 YYYY-MM)
 *   - 查 credit_card_bills/{pmId}__{cycleMonth}：若不存在 / paidAt 為 null → 該卡列入提醒
 *   - 同時 lazily 建立 bill doc（方便 UI 看到歷史）
 *   - daysOverdue >= 0 才提醒（今日到期 / 已逾期）；尚未到期不發
 *   - 全部彙整成一則 Telegram 訊息（一次推播多張卡）
 */
function notifyCreditCardDues() {
  var pms;
  try {
    pms = fsListAllDocs_('payment_methods', 200);
  } catch (err) {
    console.warn('notifyCreditCardDues list pms', err);
    return { ok: true, skipped: true };
  }

  var today = startOfDayTW_(new Date());
  var lines = ['[Personal Hub] 信用卡繳款提醒', '--------------------'];
  var hits = 0;

  (pms || []).forEach(function (pm) {
    if (!pm) return;
    if (pm.archivedAt) return;
    if (pm.type !== 'credit') return;
    if (pm.billingEnabled !== true) return;
    var dueDay = parseInt(pm.dueDay, 10);
    if (!dueDay || dueDay < 1 || dueDay > 31) return;

    var origDueDate = currentDueDate_(dueDay, today);
    var cycleMonth = cycleMonthKey_(origDueDate);

    // bill doc id 格式：{pmKey}__{YYYY-MM}（前端用的也是這樣）
    var pmId = pm._name ? pm._name.split('/').pop() : (pm.key || pm.id);
    var billDocId = pmId + '__' + cycleMonth;
    var bill;
    try {
      bill = fsGetDoc_('credit_card_bills/' + billDocId);
    } catch (err) {
      console.warn('notifyCreditCardDues get bill', billDocId, err);
      bill = null;
    }
    if (bill && bill.paidAt) return; // 已繳費，跳過

    // 連假調整：若 bill 有 dueDateOverride 就用它，否則用 pm.dueDay 推算的原始日
    var effDueDate = (bill && bill.dueDateOverride) ? bill.dueDateOverride : origDueDate;
    if (!(effDueDate instanceof Date)) effDueDate = new Date(effDueDate);
    var dueDate = effDueDate;
    var daysOverdue = Math.round((today.getTime() - dueDate.getTime()) / 86400000);
    if (daysOverdue < 0) return; // 尚未到期

    hits += 1;
    var label = pm.name || pmId;
    if (pm.last4) label += ' (****' + pm.last4 + ')';
    var stateTxt = daysOverdue === 0 ? '今日到期'
      : '已逾期 ' + daysOverdue + ' 天';
    var dueTxt = Utilities.formatDate(dueDate, TZ, 'MM/dd');
    var origTxt = Utilities.formatDate(origDueDate, TZ, 'MM/dd');
    var dueLabel = (bill && bill.dueDateOverride)
      ? ('繳款日 ' + dueTxt + ' (原 ' + origTxt + ')')
      : ('繳款日 ' + dueTxt);
    lines.push('· ' + label + ' — ' + stateTxt + ' (' + dueLabel + ')');

    // Lazy 建立 bill doc，方便 UI 與後續記錄；存在則跳過
    if (!bill) {
      try {
        var stmtDate = pm.statementDay ? deriveStatementDate_(origDueDate, parseInt(pm.statementDay, 10)) : null;
        fsSetDoc_('credit_card_bills/' + billDocId, {
          paymentMethodId: pmId,
          cycleMonth: cycleMonth,
          // dueDate 永遠存原始（pm.dueDay 推算）的，override 寫在獨立欄位
          dueDate: origDueDate,
          dueDateOverride: null,
          overrideReason: null,
          statementDate: stmtDate,
          paidAt: null,
          amount: null,
          note: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }, false);
      } catch (err) {
        console.warn('notifyCreditCardDues create bill', billDocId, err);
      }
    }
  });

  if (hits === 0) return { ok: true, skipped: true };
  lines.push('--------------------');
  lines.push('於 App「設定 → 帳單」標記已繳費後即停止提醒');
  return sendNotification_('creditCardDue', lines.join('\n'));
}

/**
 * 掃 accounts 中 type=loan 的帳戶，提醒 nextDueDate 在 N 天內或已逾期。
 * 提醒視窗：今天起算 7 天內或已逾期。
 */
function notifyAccountLoansDue() {
  var accounts;
  try {
    accounts = fsListAllDocs_('accounts', 200);
  } catch (err) {
    console.warn('notifyAccountLoansDue list', err);
    return { ok: true, skipped: true };
  }

  var today = startOfDayTW_(new Date());
  var horizon = new Date(today.getTime() + 7 * 86400000);
  var lines = ['[Personal Hub] 貸款繳款提醒', '--------------------'];
  var hits = 0;

  (accounts || []).forEach(function (account) {
    if (!account) return;
    if (account.type !== 'loan') return;
    if (account.active === false) return;
    if (account.archivedAt) return;
    var loan = account.loan;
    if (!loan || !loan.nextDueDate) return;
    var dueDate = new Date(loan.nextDueDate);
    if (isNaN(dueDate.getTime())) return;
    if (dueDate.getTime() > horizon.getTime()) return;

    hits += 1;
    var daysToDue = Math.round((dueDate.getTime() - today.getTime()) / 86400000);
    var status = daysToDue < 0 ? ('已逾期 ' + Math.abs(daysToDue) + ' 天')
      : daysToDue === 0 ? '今日到期'
        : (daysToDue + ' 天後到期');
    var dueTxt = Utilities.formatDate(dueDate, TZ, 'MM/dd');
    var amountTxt = (typeof loan.monthlyPayment === 'number' && loan.monthlyPayment > 0)
      ? ('NT$' + Math.round(loan.monthlyPayment).toLocaleString('en-US'))
      : '未設定金額';
    var balanceTxt = (typeof account.balanceTWD === 'number')
      ? ('剩餘 NT$' + Math.round(Math.abs(account.balanceTWD)).toLocaleString('en-US'))
      : '';
    lines.push('· ' + (account.name || '貸款') + ' — ' + status + ' (' + dueTxt + ')');
    lines.push('  本期 ' + amountTxt + (balanceTxt ? ' · ' + balanceTxt : ''));
  });

  if (hits === 0) return { ok: true, skipped: true };
  lines.push('--------------------');
  lines.push('於 App「帳戶」點該筆貸款的「繳款」即會自動扣款並前進下期日');
  return sendNotification_('loanDue', lines.join('\n'));
}

// -------- 保單：保費 / 滿期提醒（2026-11 F9） --------

var INSURANCE_PREMIUM_AHEAD_DAYS_ = 14;
var INSURANCE_MATURITY_AHEAD_DAYS_ = 30;

/**
 * 純函式（tests/insurance-due.test.cjs 直接測）：挑出要提醒的保單事件。
 * 與前端 features/accounts/insurance.ts insuranceReminders 同規則：
 *   - premium：nextPremiumDate 在 14 天內或已逾期（還沒在 App 按「已繳保費」就持續提醒）
 *   - maturity：maturityDate 在 0–30 天內
 * today 必須是台北當天 00:00（startOfDayTW_）；日期差以台北日曆天計。
 */
function insuranceDueItems_(accounts, today) {
  var items = [];
  var todayMs = today.getTime();
  function daysTo(value) {
    var d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return Math.round((startOfDayTW_(d).getTime() - todayMs) / 86400000);
  }
  (accounts || []).forEach(function (account) {
    if (!account || account.type !== 'insurance') return;
    if (account.active === false || account.archivedAt) return;
    var ins = account.insurance;
    if (!ins) return;
    var premium = Number(ins.premiumTWD || 0);
    if (ins.nextPremiumDate && premium > 0) {
      var pd = daysTo(ins.nextPremiumDate);
      if (pd !== null && pd <= INSURANCE_PREMIUM_AHEAD_DAYS_) {
        items.push({ kind: 'premium', name: account.name || '保單', insurer: ins.insurer || '', date: new Date(ins.nextPremiumDate), days: pd, premiumTWD: premium });
      }
    }
    if (ins.maturityDate) {
      var md = daysTo(ins.maturityDate);
      if (md !== null && md >= 0 && md <= INSURANCE_MATURITY_AHEAD_DAYS_) {
        items.push({ kind: 'maturity', name: account.name || '保單', insurer: ins.insurer || '', date: new Date(ins.maturityDate), days: md });
      }
    }
  });
  items.sort(function (a, b) { return a.days - b.days; });
  return items;
}

function notifyInsuranceDue() {
  var accounts;
  try {
    accounts = fsListAllDocs_('accounts', 200);
  } catch (err) {
    console.warn('notifyInsuranceDue list', err);
    return { ok: true, skipped: true };
  }
  var items = insuranceDueItems_(accounts, startOfDayTW_(new Date()));
  if (items.length === 0) return { ok: true, skipped: true };

  var lines = ['[Personal Hub] 保單提醒', '--------------------'];
  items.forEach(function (it) {
    var dateTxt = Utilities.formatDate(it.date, TZ, 'MM/dd');
    var label = it.name + (it.insurer ? '（' + it.insurer + '）' : '');
    if (it.kind === 'premium') {
      var status = it.days < 0 ? ('已逾期 ' + Math.abs(it.days) + ' 天')
        : it.days === 0 ? '今日到期' : (it.days + ' 天後');
      lines.push('· 保費｜' + label + ' NT$' + Math.round(it.premiumTWD).toLocaleString('en-US') + ' — ' + status + ' (' + dateTxt + ')');
    } else {
      lines.push('· 滿期｜' + label + ' — ' + (it.days === 0 ? '今天滿期' : it.days + ' 天後滿期') + ' (' + dateTxt + ')');
    }
  });
  lines.push('--------------------');
  lines.push('於 App「帳戶」點保單的「已繳保費」會記一筆支出並前進下次繳費日');
  return sendNotification_('insuranceDue', lines.join('\n'));
}

// -------- credit-card date helpers --------

function startOfDayTW_(d) {
  var y = parseInt(Utilities.formatDate(d, TZ, 'yyyy'), 10);
  var m = parseInt(Utilities.formatDate(d, TZ, 'M'), 10);
  var day = parseInt(Utilities.formatDate(d, TZ, 'd'), 10);
  // 用 TW 的 yyyy-mm-dd 00:00 換回 UTC date
  return new Date(y, m - 1, day, 0, 0, 0, 0);
}

function clampDayToMonth_(year, monthIdx, day) {
  var lastDay = new Date(year, monthIdx + 1, 0).getDate();
  return Math.max(1, Math.min(day, lastDay));
}

function currentDueDate_(dueDay, baseDate) {
  var y = baseDate.getFullYear();
  var m = baseDate.getMonth();
  var d = baseDate.getDate();
  var thisDue = clampDayToMonth_(y, m, dueDay);
  if (d >= thisDue) return new Date(y, m, thisDue);
  var prev = new Date(y, m - 1, 1);
  var prevDue = clampDayToMonth_(prev.getFullYear(), prev.getMonth(), dueDay);
  return new Date(prev.getFullYear(), prev.getMonth(), prevDue);
}

function deriveStatementDate_(dueDate, statementDay) {
  if (!statementDay) return null;
  var dueDay = dueDate.getDate();
  if (statementDay < dueDay) {
    var day = clampDayToMonth_(dueDate.getFullYear(), dueDate.getMonth(), statementDay);
    return new Date(dueDate.getFullYear(), dueDate.getMonth(), day);
  }
  var prev = new Date(dueDate.getFullYear(), dueDate.getMonth() - 1, 1);
  var pday = clampDayToMonth_(prev.getFullYear(), prev.getMonth(), statementDay);
  return new Date(prev.getFullYear(), prev.getMonth(), pday);
}

function cycleMonthKey_(d) {
  var mm = String(d.getMonth() + 1);
  if (mm.length < 2) mm = '0' + mm;
  return d.getFullYear() + '-' + mm;
}

// -------- 訂閱費彙整 (#3 / #11) --------

/**
 * 月初一號 09:00 推一次「訂閱費月度健檢」：
 * - 啟用中訂閱、月平均合計
 * - 過去 60 天偵測但未啟用的疑似訂閱
 */
function notifySubscriptionsDigest() {
  var subs;
  try { subs = fsListAllDocs_('subscriptions', 200); }
  catch (err) { console.warn('subscriptions list', err); subs = []; }
  var active = (subs || []).filter(function (s) { return s.active !== false; });
  if (active.length === 0) return { ok: true, skipped: true };

  var monthly = 0;
  active.forEach(function (s) {
    var amt = s.amountTWD || 0;
    var c = s.billingCycle || 'monthly';
    if (c === 'weekly') monthly += amt * 52 / 12;
    else if (c === 'biweekly') monthly += amt * 26 / 12;
    else if (c === 'yearly') monthly += amt / 12;
    else monthly += amt;
  });

  var lines = [
    '[Personal Hub] 訂閱費健檢',
    '--------------------',
    '啟用中：' + active.length + ' 個',
    '月平均合計：NT$' + n0(monthly),
  ];
  // Top 5
  var sorted = active.slice().sort(function (a, b) {
    var aMonthly = (a.billingCycle === 'yearly' ? a.amountTWD / 12 : a.amountTWD) || 0;
    var bMonthly = (b.billingCycle === 'yearly' ? b.amountTWD / 12 : b.amountTWD) || 0;
    return bMonthly - aMonthly;
  });
  if (sorted.length) {
    lines.push('TOP:');
    sorted.slice(0, 5).forEach(function (s) {
      lines.push('  · ' + (s.name || '?') + ' NT$' + n0(s.amountTWD || 0) + '/' + (s.billingCycle || 'monthly'));
    });
  }
  return sendNotification_('subscriptionsDigest', lines.join('\n'));
}

// -------- 月底結餘預測 (#1) --------

/**
 * 「消費支出 / 實際收入」口徑 — 與前端 features/analytics/metrics.ts 同一份清單：
 * 租賃購入（資產轉換）、對帳調整、共同帳結算不是真的花掉 / 賺到。
 */
var NON_CONSUMPTION_EXPENSE_CATEGORIES_ = ['rental_purchase', 'adjustment', 'household_settlement'];
var NON_EARNED_INCOME_CATEGORIES_ = ['adjustment_income', 'household_settlement_income'];
var FORECAST_EXCLUDED_CATEGORIES_ = NON_CONSUMPTION_EXPENSE_CATEGORIES_;

function isConsumptionExpense_(t) {
  return !!t && !t.deletedAt && t.type === 'expense' && NON_CONSUMPTION_EXPENSE_CATEGORIES_.indexOf(t.category) < 0;
}

function isEarnedIncome_(t) {
  return !!t && !t.deletedAt && t.type === 'income' && NON_EARNED_INCOME_CATEGORIES_.indexOf(t.category) < 0;
}
/** `paidByUid` 保留值：共同支出由 household 公基金支付（與前端 HOUSEHOLD_FUND_PAYER_ID 一致） */
var HOUSEHOLD_FUND_PAYER_ID_ = '__household_fund__';
/** 公基金付的共同支出：不是 owner 的個人花費，也不形成成員間應收／應付 */
function isHouseholdFundPaid_(t) {
  return !!t && !!t.householdId && t.paidByUid === HOUSEHOLD_FUND_PAYER_ID_;
}

function isForecastExcludedExpense_(t) {
  return t && t.type === 'expense' && FORECAST_EXCLUDED_CATEGORIES_.indexOf(t.category) >= 0;
}

/**
 * owner「自己負擔」的支出金額（與前端 ledger/types.ts `personalShareTWD` 同一口徑）：
 *  - 公基金付的共同支出 → 0
 *  - 代墊 / 共同分攤 / 旅程分攤（myShareTWD 有值）→ myShareTWD（任何人改分攤時都會重算這個欄位）
 *  - 其他 → 實際入帳金額（settledAmountTWD）或估算 amountTWD
 */
function personalShareTWD_(t) {
  if (!t) return 0;
  if (isHouseholdFundPaid_(t)) return 0;
  var split = (t.splitMode && t.splitMode !== 'self') || t.householdId || t.tripId;
  if (split && t.myShareTWD != null) return Number(t.myShareTWD) || 0;
  return Number(t.settledAmountTWD != null ? t.settledAmountTWD : (t.amountTWD || t.amount || 0)) || 0;
}

function forecastExpenseAmountTWD_(t) {
  return personalShareTWD_(t);
}

function notifyMonthlyForecast() {
  // 用最新到目前為止的 transactions 估算
  var now = new Date();
  var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  var thisMonthTxs = queryTxsBetween_(mStart, mEnd);

  // 過去 6 個月
  var pStart = new Date(now.getFullYear(), now.getMonth() - 6, 1);
  var pEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  var pastTxs = queryTxsBetween_(pStart, pEnd);

  var lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  var dayOfMonth = parseInt(Utilities.formatDate(now, TZ, 'd'), 10);
  var pctElapsed = dayOfMonth / lastDay;

  var spentSoFar = 0; var incomeSoFar = 0; var excludedExpenseTWD = 0;
  thisMonthTxs.forEach(function (t) {
    if (t.deletedAt) return;
    if (t.type === 'expense') {
      var expAmt = forecastExpenseAmountTWD_(t);
      if (isForecastExcludedExpense_(t)) {
        excludedExpenseTWD += expAmt;
        return;
      }
      spentSoFar += expAmt;
    } else if (isEarnedIncome_(t)) {
      incomeSoFar += Number(t.amountTWD || 0);
    }
  });

  // 過去 6 個月平均
  var monthlyExpenseSum = 0; var monthlyIncomeSum = 0; var months = 0;
  for (var i = 1; i <= 6; i++) {
    var mS = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var mE = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    var exp = 0; var inc = 0;
    pastTxs.forEach(function (t) {
      if (t.deletedAt) return;
      var d = t.date instanceof Date ? t.date : new Date(t.date);
      if (d < mS || d > mE) return;
      if (t.type === 'expense') {
        if (isForecastExcludedExpense_(t)) return;
        exp += forecastExpenseAmountTWD_(t);
      } else if (isEarnedIncome_(t)) {
        inc += Number(t.amountTWD || 0);
      }
    });
    if (exp > 0 || inc > 0) { monthlyExpenseSum += exp; monthlyIncomeSum += inc; months++; }
  }
  var monthlyExpenseAvg = months ? monthlyExpenseSum / months : 0;
  var monthlyIncomeAvg = months ? monthlyIncomeSum / months : 0;
  var elapsedBaselineExpense = monthlyExpenseAvg * pctElapsed;
  var remainingBaselineExpense = Math.max(0, monthlyExpenseAvg * (1 - pctElapsed));
  var overspendSoFar = Math.max(0, spentSoFar - elapsedBaselineExpense);
  var expectedExp = pctElapsed < 0.1
    ? Math.max(spentSoFar, monthlyExpenseAvg)
    : spentSoFar + remainingBaselineExpense + overspendSoFar * 0.5;
  var expectedInc = Math.max(incomeSoFar, monthlyIncomeAvg);
  var expectedNet = expectedInc - expectedExp;

  var month = Utilities.formatDate(now, TZ, 'yyyy-MM');
  var budgetTotal = totalMonthBudget_(month);

  var lines = [
    '[Personal Hub] 月底結餘預測',
    '--------------------',
    '月份: ' + month + '（已過 ' + Math.round(pctElapsed * 100) + '%）',
    '已支出: NT$' + n0(spentSoFar),
    '已收入: NT$' + n0(incomeSoFar),
    '預估月支出: NT$' + n0(expectedExp),
    '預估月收入: NT$' + n0(expectedInc),
    '預估結餘: ' + (expectedNet >= 0 ? '+' : '') + 'NT$' + n0(expectedNet),
  ];
  if (budgetTotal && expectedExp > budgetTotal) {
    lines.push('預估超支: NT$' + n0(expectedExp - budgetTotal));
  }
  if (excludedExpenseTWD > 0) {
    lines.push('已排除資產轉換: NT$' + n0(excludedExpenseTWD));
  }
  return sendNotification_('monthlyForecast', lines.join('\n'));
}

// -------- 類別異常 (#2) --------

function notifyCategoryAnomaly() {
  var now = new Date();
  var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  var dayOfMonth = parseInt(Utilities.formatDate(now, TZ, 'd'), 10);
  var thisMonthTxs = queryTxsBetween_(mStart, mEnd);

  var pStart = new Date(now.getFullYear(), now.getMonth() - 6, 1);
  var pEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  var pastTxs = queryTxsBetween_(pStart, pEnd);

  // 本月各類別累計
  var thisMonth = {};
  thisMonthTxs.forEach(function (t) {
    if (!isConsumptionExpense_(t)) return;
    var d = t.date instanceof Date ? t.date : new Date(t.date);
    if (d.getDate() > dayOfMonth) return;
    var k = t.category || 'other';
    thisMonth[k] = (thisMonth[k] || 0) + (t.amountTWD || 0);
  });

  // 過去 6 個月各月同期間
  var monthlyMaps = []; // [{cat: amount}]
  for (var i = 1; i <= 6; i++) {
    var mS = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var mE = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    var map = {};
    pastTxs.forEach(function (t) {
      if (!isConsumptionExpense_(t)) return;
      var d = t.date instanceof Date ? t.date : new Date(t.date);
      if (d < mS || d > mE) return;
      if (d.getDate() > dayOfMonth) return;
      var k = t.category || 'other';
      map[k] = (map[k] || 0) + (t.amountTWD || 0);
    });
    monthlyMaps.push(map);
  }

  var anomalies = [];
  Object.keys(thisMonth).forEach(function (cat) {
    var thisVal = thisMonth[cat];
    if (thisVal < 500) return;
    var samples = monthlyMaps.map(function (m) { return m[cat] || 0; }).filter(function (v) { return v > 0; });
    if (samples.length < 3) return;
    samples.sort(function (a, b) { return a - b; });
    var median = samples[Math.floor(samples.length / 2)];
    if (!median || median <= 0) return;
    var ratio = thisVal / median;
    if (ratio < 1.5) return;
    anomalies.push({ cat: cat, thisVal: thisVal, median: median, ratio: ratio });
  });
  anomalies.sort(function (a, b) { return b.ratio - a.ratio; });

  if (anomalies.length === 0) return { ok: true, skipped: true };

  var lines = ['[Personal Hub] 類別花費異常', '--------------------'];
  anomalies.slice(0, 5).forEach(function (a) {
    lines.push('· ' + a.cat + ' 本月 NT$' + n0(a.thisVal)
      + ' vs 中位 NT$' + n0(a.median) + ' (×' + a.ratio.toFixed(1) + ')');
  });
  return sendNotification_('categoryAnomaly', lines.join('\n'));
}

// -------- 排程支出到期 (#12) --------

function notifyScheduledPaymentDue() {
  var items;
  try { items = fsListAllDocs_('scheduled_payments', 200); }
  catch (err) { console.warn('scheduled list', err); items = []; }
  if (!items || items.length === 0) return { ok: true, skipped: true };
  var today = startOfDayTW_(new Date());
  var hits = [];
  items.forEach(function (p) {
    if (!p) return;
    if (p.recurrence === 'one-time' && p.paidAt) return;
    var due = p.dueDate instanceof Date ? p.dueDate : new Date(p.dueDate);
    var days = Math.round((due.getTime() - today.getTime()) / 86400000);
    var remind = typeof p.remindBeforeDays === 'number' ? p.remindBeforeDays : 7;
    // 提前 N 天 / 當天 / 已逾期 都推
    if (days <= remind) {
      hits.push({ p: p, days: days });
    }
  });
  if (hits.length === 0) return { ok: true, skipped: true };

  var lines = ['[Personal Hub] 排程支出到期', '--------------------'];
  hits.sort(function (a, b) { return a.days - b.days; });
  hits.forEach(function (h) {
    var label = h.days < 0 ? '已逾期 ' + Math.abs(h.days) + ' 天' :
      h.days === 0 ? '今日到期' : (h.days + ' 天後');
    lines.push('· ' + (h.p.name || '?') + ' NT$' + n0(h.p.amountTWD || 0) + ' — ' + label);
  });
  return sendNotification_('scheduledPaymentDue', lines.join('\n'));
}

// -------- 儲蓄目標進度 (#15) --------

function notifySavingsGoalProgress() {
  var goals;
  try { goals = fsListDocs_('savings_goals', 100); }
  catch (err) { return { ok: true, skipped: true }; }
  if (!goals || goals.length === 0) return { ok: true, skipped: true };

  var lines = ['【儲蓄目標進度】'];
  var any = false;
  goals.forEach(function (g) {
    if (g.archivedAt) return;
    var pct = g.targetTWD ? Math.min(100, (g.currentTWD || 0) / g.targetTWD * 100) : 0;
    var bar = '';
    var filled = Math.round(pct / 10);
    for (var i = 0; i < 10; i++) bar += i < filled ? '█' : '░';
    lines.push('');
    lines.push((g.name || '未命名目標') + '｜' + bar + ' ' + Math.round(pct) + '%');
    lines.push('金額｜NT$' + n0(g.currentTWD || 0) + '／NT$' + n0(g.targetTWD || 0));
    any = true;
  });
  if (!any) return { ok: true, skipped: true };
  return sendNotification_('savingsGoalProgress', lines.join('\n'));
}

// -------- 整合理財健檢 --------

/** 投資計畫是否為退休規劃：明確勾選 isRetirement 優先；舊資料沒有旗標時退回名稱比對 */
function isRetirementPlan_(plan) {
  if (!plan) return false;
  if (plan.isRetirement === true) return true;
  if (plan.isRetirement === false) return false;
  return /退休|retire/i.test(String(plan.name || ''));
}

/**
 * 每月中檢視近 3 個完整月份的現金流、緊急預備金、儲蓄／退休目標與配置偏差。
 * 僅提供決策提示；不自動交易、不取代個別財務建議。
 */
function notifyFinancialHealthDigest() {
  var owner = getFinancialHealthOwner_();
  if (!owner) return { ok: true, skipped: true, reason: 'owner-not-found' };

  var range = previousThreeFullMonths_();
  var txs = queryTxsBetween_(range.start, range.end).filter(function (t) {
    if (t.deletedAt) return false;
    return !t.userId || t.userId === owner.id;
  });
  var totalIncome = 0;
  var totalExpense = 0;
  txs.forEach(function (t) {
    if (isEarnedIncome_(t)) {
      totalIncome += Number(t.settledAmountTWD != null ? t.settledAmountTWD : (t.amountTWD || t.amount || 0)) || 0;
    } else if (isConsumptionExpense_(t)) {
      totalExpense += financialHealthExpenseAmount_(t);
    }
  });
  var monthlyIncome = totalIncome / 3;
  var monthlyExpense = totalExpense / 3;
  var monthlySurplus = monthlyIncome - monthlyExpense;
  var savingsRate = monthlyIncome > 0 ? monthlySurplus / monthlyIncome * 100 : null;

  var accounts = safeListDocs_('accounts', 300);
  var legacyCash = safeListDocs_('cash_accounts', 100);
  var liquidTWD = financialHealthLiquidTWD_(accounts, legacyCash, owner.id);
  var prefs = owner.preferences || {};
  var emergencyConfig = prefs.emergencyFund || {};
  var emergencyTargetMonths = Number(emergencyConfig.targetMonths || 6);
  var emergencyBaseline = typeof emergencyConfig.monthlyBaseline === 'number'
    ? emergencyConfig.monthlyBaseline
    : monthlyExpense;
  var emergencyMonths = emergencyBaseline > 0 ? liquidTWD / emergencyBaseline : 0;

  var goals = safeListDocs_('savings_goals', 100).filter(function (g) { return !g.archivedAt; });
  var goalTarget = 0;
  var goalCurrent = 0;
  goals.forEach(function (g) {
    goalTarget += Number(g.targetTWD || 0);
    goalCurrent += Number(g.currentTWD || 0);
  });
  var goalProgress = goalTarget > 0 ? Math.min(100, goalCurrent / goalTarget * 100) : null;

  var plans = safeListDocs_('investment_plans', 100).filter(function (p) { return !p.archivedAt; });
  var monthlyInvestment = 0;
  var retirementPlans = 0;
  plans.forEach(function (p) {
    monthlyInvestment += Number(p.monthlyContributionTWD || 0);
    if (isRetirementPlan_(p)) retirementPlans++;
  });
  // 退休帳戶（勞退個人專戶 / 自提）也算有退休規劃（前端 ledger/use-financial-health.ts 同口徑）
  accounts.forEach(function (a) {
    if (a && a.type === 'pension' && a.active !== false && !a.archivedAt) retirementPlans++;
  });

  var latest = getLatestSnapshot_();
  var allocation = financialHealthAllocation_(prefs.allocationTargets || [], latest, liquidTWD);
  var recommendations = [];
  if (savingsRate === null) {
    recommendations.push('補齊收入記帳，才能計算儲蓄率。');
  } else if (savingsRate < 0) {
    recommendations.push('平均支出高於收入，先處理現金流缺口。');
  } else if (savingsRate < 10) {
    recommendations.push('儲蓄率低於 10%，檢視固定與非必要支出。');
  }
  if (emergencyBaseline <= 0) {
    recommendations.push('設定緊急預備金的月支出基準。');
  } else if (emergencyMonths < 3) {
    recommendations.push('緊急預備金低於 3 個月，優先補足流動資金。');
  } else if (emergencyMonths < emergencyTargetMonths) {
    recommendations.push('持續補足 ' + emergencyTargetMonths + ' 個月緊急預備金目標。');
  }
  if (!retirementPlans) recommendations.push('建立退休帳戶（勞退）或在投資計畫勾選「退休規劃」。');
  if (monthlySurplus > 0 && monthlyInvestment > monthlySurplus) {
    recommendations.push('每月投資規劃高於平均結餘，請調整投入額。');
  }
  if (!allocation.rows.length) {
    recommendations.push('設定股票、現金等資產配置目標。');
  } else if (allocation.maxAbsDelta >= 5) {
    recommendations.push('配置偏差已達 ' + allocation.maxAbsDelta.toFixed(1) + ' 個百分點，評估以新資金再平衡。');
  }
  if (!recommendations.length) {
    recommendations.push('目前沒有明顯缺口，維持記帳並按月檢視配置。');
  }

  var lines = [
    '【每月理財健檢】',
    '統計期間｜' + range.label,
    '',
    '【現金流】',
    '平均收入｜NT$' + n0(monthlyIncome),
    '平均支出｜NT$' + n0(monthlyExpense),
    '平均結餘｜' + signedTWD_(monthlySurplus),
    '儲蓄率｜' + (savingsRate === null ? '資料不足' : savingsRate.toFixed(1) + '%'),
    '',
    '【安全墊與目標】',
    '流動資金｜NT$' + n0(liquidTWD),
    '緊急預備金｜' + (emergencyBaseline > 0
      ? emergencyMonths.toFixed(1) + '／' + emergencyTargetMonths + ' 個月'
      : '尚未設定支出基準'),
    '儲蓄目標｜' + (goalProgress === null
      ? '尚未建立'
      : goalProgress.toFixed(1) + '%；NT$' + n0(goalCurrent) + '／NT$' + n0(goalTarget)),
    '退休計畫｜' + (retirementPlans ? '已建立 ' + retirementPlans + ' 筆' : '尚未建立'),
    '每月投資規劃｜NT$' + n0(monthlyInvestment),
  ];

  if (allocation.rows.length) {
    lines.push('', '【資產配置】');
    allocation.rows.forEach(function (row) {
      lines.push(row.label + '｜目標 ' + row.targetPct.toFixed(1) + '%；'
        + (row.actualPct === null
          ? '尚未連結資料'
          : '實際 ' + row.actualPct.toFixed(1) + '%；偏差 ' + signedPctPoint_(row.deltaPct)));
    });
  }

  lines.push('', '【本月待辦】');
  recommendations.slice(0, 5).forEach(function (item, index) {
    lines.push((index + 1) + '．' + item);
  });
  lines.push('', '說明｜依現有記帳資料估算，僅供個人規劃參考。');

  return sendNotification_('financialHealthDigest', lines.join('\n'));
}

function getFinancialHealthOwner_() {
  try {
    var users = fsRunQuery_('', {
      from: [{ collectionId: 'users' }],
      where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL',
        value: { stringValue: 'owner' } } },
      limit: 1,
    });
    var owner = users && users[0];
    if (!owner || !owner._name) return null;
    owner.id = String(owner._name).split('/').pop();
    return owner;
  } catch (err) {
    console.warn('getFinancialHealthOwner_', err);
    return null;
  }
}

function previousThreeFullMonths_() {
  var now = new Date();
  var year = parseInt(Utilities.formatDate(now, TZ, 'yyyy'), 10);
  var monthIndex = parseInt(Utilities.formatDate(now, TZ, 'M'), 10) - 1;
  var start = new Date(Date.UTC(year, monthIndex - 3, 1) - 8 * 3600 * 1000);
  var currentMonthStart = new Date(Date.UTC(year, monthIndex, 1) - 8 * 3600 * 1000);
  var end = new Date(currentMonthStart.getTime() - 1);
  return {
    start: start,
    end: end,
    label: Utilities.formatDate(start, TZ, 'yyyy/MM') + '－' + Utilities.formatDate(end, TZ, 'yyyy/MM'),
  };
}

function financialHealthExpenseAmount_(t) {
  return personalShareTWD_(t);
}

function safeListDocs_(collectionId, limit) {
  try {
    return fsListDocs_(collectionId, limit) || [];
  } catch (err) {
    console.warn('safeListDocs_ ' + collectionId, err);
    return [];
  }
}

function normalizeFinancialAccountKey_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function financialHealthLiquidTWD_(accounts, legacyCash, ownerId) {
  var liquidTypes = ['cash', 'bank', 'e_wallet_balance', 'investment_cash'];
  var activeAccounts = accounts.filter(function (a) {
    return a.active !== false
      && !a.archivedAt
      && (!a.ownerId || a.ownerId === ownerId)
      && liquidTypes.indexOf(a.type) >= 0;
  });
  var liquid = activeAccounts.reduce(function (sum, a) {
    return sum + Math.max(0, Number(a.balanceTWD != null ? a.balanceTWD : a.balance || 0));
  }, 0);
  var accountKeys = {};
  activeAccounts.forEach(function (a) {
    [a.name, a.legacyPaymentMethod].forEach(function (value) {
      var key = normalizeFinancialAccountKey_(value);
      if (key) accountKeys[key] = true;
    });
  });
  legacyCash.forEach(function (cash) {
    if (cash.archivedAt || cash.countsAsEmergencyFund === false) return;
    var keys = [cash._name ? String(cash._name).split('/').pop() : '', cash.name,
      cash.bank ? cash.bank + '_' + cash.name : '']
      .map(normalizeFinancialAccountKey_)
      .filter(Boolean);
    if (keys.some(function (key) { return accountKeys[key]; })) return;
    liquid += Math.max(0, Number(cash.amountTWD || cash.amount || 0));
  });
  return liquid;
}

function financialHealthAllocation_(targets, latest, liquidTWD) {
  if (!Array.isArray(targets) || !targets.length || !latest) {
    return { rows: [], maxAbsDelta: 0 };
  }
  var portfolioTWD = Number(latest.totalValueTWD || 0);
  var includesCash = targets.some(function (target) { return target.key === 'cash'; });
  var knownTotal = portfolioTWD + (includesCash ? liquidTWD : 0);
  if (knownTotal <= 0) return { rows: [], maxAbsDelta: 0 };
  var byMarket = latest.byMarket || {};
  var maxAbsDelta = 0;
  var rows = targets.map(function (target) {
    var actualValue = null;
    if (target.key === 'TW' || target.key === 'US') {
      actualValue = Number(byMarket[target.key] && byMarket[target.key].valueTWD || 0);
    } else if (target.key === 'cash') {
      actualValue = liquidTWD;
    }
    var actualPct = actualValue === null ? null : actualValue / knownTotal * 100;
    var deltaPct = actualPct === null ? null : actualPct - Number(target.pct || 0);
    if (deltaPct !== null) maxAbsDelta = Math.max(maxAbsDelta, Math.abs(deltaPct));
    return {
      label: target.label || target.key || '未命名配置',
      targetPct: Number(target.pct || 0),
      actualPct: actualPct,
      deltaPct: deltaPct,
    };
  });
  return { rows: rows, maxAbsDelta: maxAbsDelta };
}

function signedTWD_(value) {
  return (value >= 0 ? '+' : '-') + 'NT$' + n0(Math.abs(value));
}

function signedPctPoint_(value) {
  return (value >= 0 ? '+' : '') + value.toFixed(1) + ' 個百分點';
}

// -------- 出遊回顧 (#17) --------

function notifyTripRecap() {
  var trips;
  try { trips = fsListAllDocs_('trips', 200); }
  catch (err) { return { ok: true, skipped: true }; }
  if (!trips || trips.length === 0) return { ok: true, skipped: true };

  var now = new Date();
  var thisMonth = parseInt(Utilities.formatDate(now, TZ, 'M'), 10) - 1;
  var hits = [];
  for (var y = 1; y <= 3; y++) {
    var year = now.getFullYear() - y;
    trips.forEach(function (t) {
      var sd = t.startDate instanceof Date ? t.startDate : new Date(t.startDate);
      if (sd.getFullYear() === year && sd.getMonth() === thisMonth) {
        hits.push({ trip: t, year: year });
      }
    });
  }
  if (hits.length === 0) return { ok: true, skipped: true };

  var lines = ['[Personal Hub] 出遊回顧（' + (thisMonth + 1) + ' 月）', '--------------------'];
  hits.forEach(function (h) {
    var t = h.trip;
    var dest = Array.isArray(t.destination) ? t.destination.join(', ') : (t.destination || '');
    lines.push('· ' + h.year + ' 年 · ' + (t.name || '?') + (dest ? ' — ' + dest : ''));
  });
  return sendNotification_('tripRecap', lines.join('\n'));
}

// -------- 每月固定支出健檢 (#11) --------

function notifyFixedExpensesMonthly() {
  // 訂閱 + recurring tx + 排程
  var subs = (function () { try { return fsListAllDocs_('subscriptions', 200); } catch (e) { return []; } })()
    .filter(function (s) { return s && s.active !== false; });
  var recurring = (function () { try { return fsListAllDocs_('recurring', 200); } catch (e) { return []; } })()
    .filter(function (r) { return r && r.active !== false; });
  var scheduled = (function () { try { return fsListAllDocs_('scheduled_payments', 200); } catch (e) { return []; } })();

  // 已設定自動入帳的訂閱（recurringId 指到仍存在的 recurring）會在「週期記帳」算到，這裡不重複計（2026-11 Q6）
  var recurringIds = {};
  recurring.forEach(function (r) { if (r && r._name) recurringIds[String(r._name).split('/').pop()] = true; });
  var linkedSubs = 0;
  var subMonthly = 0;
  subs.forEach(function (s) {
    if (s.recurringId && recurringIds[s.recurringId]) { linkedSubs++; return; }
    var amt = s.amountTWD || 0;
    var c = s.billingCycle || 'monthly';
    if (c === 'weekly') subMonthly += amt * 52 / 12;
    else if (c === 'biweekly') subMonthly += amt * 26 / 12;
    else if (c === 'yearly') subMonthly += amt / 12;
    else subMonthly += amt;
  });

  var recMonthly = 0;
  recurring.forEach(function (r) {
    var amt = (r.template && r.template.amountTWD) || 0;
    var f = r.frequency || 'monthly';
    if (f === 'weekly') recMonthly += amt * 52 / 12;
    else if (f === 'biweekly') recMonthly += amt * 26 / 12;
    else if (f === 'yearly') recMonthly += amt / 12;
    else recMonthly += amt;
  });

  var schedMonthly = 0;
  scheduled.forEach(function (p) {
    if (!p || (p.recurrence === 'one-time' && p.paidAt)) return;
    var amt = p.amountTWD || 0;
    var r = p.recurrence || 'one-time';
    if (r === 'monthly') schedMonthly += amt;
    else if (r === 'quarterly') schedMonthly += amt / 3;
    else if (r === 'yearly') schedMonthly += amt / 12;
    // one-time 不入月平均
  });

  var total = subMonthly + recMonthly + schedMonthly;
  if (total === 0) return { ok: true, skipped: true };

  var lines = [
    '[Personal Hub] 每月固定支出健檢',
    '--------------------',
    '訂閱費（未自動入帳）：NT$' + n0(subMonthly),
    '週期記帳' + (linkedSubs ? '（含 ' + linkedSubs + ' 個自動入帳訂閱）' : '') + '：NT$' + n0(recMonthly),
    '排程支出（攤平）：NT$' + n0(schedMonthly),
    '--------------------',
    '月固定支出合計：NT$' + n0(total),
  ];
  return sendNotification_('fixedExpensesMonthly', lines.join('\n'));
}

// -------- helpers --------

function queryTxsBetween_(start, end) {
  var rows = fsRunQuery_('', {
    from: [{ collectionId: 'transactions' }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL',
            value: { timestampValue: start.toISOString() } } },
          { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL',
            value: { timestampValue: end.toISOString() } } },
        ],
      },
    },
    limit: 3000,
  });
  return ownerTxsOnly_(rows);
}

/**
 * 只留 owner 自己的交易。共同帳本啟用後 `transactions` 會有伴侶（member）建立的 tx，
 * 每日 / 每週 / 每月摘要與 /ask 都只該算 owner 的（owner 的那份已寫在 myShareTWD）。
 */
var OWNER_UID_CACHE_ = null;
function ownerUidCached_() {
  if (OWNER_UID_CACHE_ === null) {
    try { OWNER_UID_CACHE_ = getOwnerUid_() || ''; } catch (err) { OWNER_UID_CACHE_ = ''; }
  }
  return OWNER_UID_CACHE_;
}
function ownerTxsOnly_(txs) {
  var owner = ownerUidCached_();
  if (!owner) return txs;
  return txs.filter(function (t) { return !t.userId || t.userId === owner; });
}

function aggByType_(txs) {
  var out = { income: 0, expense: 0 };
  txs.forEach(function (t) {
    if (t.deletedAt) return;
    if (isHouseholdFundPaid_(t)) return;
    if (isEarnedIncome_(t)) out.income += (t.amountTWD || t.amount || 0);
    // 支出只算 owner 自己那份（共同分攤 / 旅程分攤 / 代墊都看 myShareTWD），與 app 的 ledger 一致；
    // 對帳調整 / 租賃購入 / 共同帳結算不算消費
    else if (isConsumptionExpense_(t)) out.expense += personalShareTWD_(t);
  });
  return out;
}

function aggByCategory_(txs, type) {
  var out = {};
  txs.forEach(function (t) {
    if (t.deletedAt) return;
    if (type && t.type !== type) return;
    if (t.type === 'expense' && !isConsumptionExpense_(t)) return;
    if (t.type === 'income' && !isEarnedIncome_(t)) return;
    var k = t.category || 'other';
    out[k] = (out[k] || 0) + (t.type === 'expense' ? personalShareTWD_(t) : (t.amountTWD || t.amount || 0));
  });
  return out;
}

function topN_(obj, n) {
  return Object.keys(obj)
    .map(function (k) { return { key: k, val: obj[k] }; })
    .sort(function (a, b) { return b.val - a.val; })
    .slice(0, n);
}

function totalMonthBudget_(month) {
  var budgets = fsListDocs_('budgets', 50);
  var b = budgets.filter(function (x) { return x.month === month; })[0];
  if (!b || !b.byCategory) return 0;
  var sum = 0;
  Object.keys(b.byCategory).forEach(function (k) { sum += b.byCategory[k] || 0; });
  return sum;
}

function n0(n) { return Math.round(n || 0).toLocaleString('en-US'); }

/**
 * 墊付團催繳提醒（下午茶 / 揪團）：每天 21:00 跑。
 * 列出所有未結清（仍有未繳成員）的 payout_groups，整理「誰還沒繳、要收多少」。
 * 通知通道：payoutGroupReminder（settings 可單獨開關）。
 */
function notifyPayoutGroupsReminder() {
  var docs;
  try {
    docs = fsListAllDocs_('payout_groups', 200);
  } catch (err) {
    console.warn('notifyPayoutGroupsReminder list', err);
    return { ok: true, skipped: true };
  }
  if (!docs || docs.length === 0) return { ok: true, skipped: true };

  var open = docs.filter(function (g) {
    if (g.archivedAt) return false;
    var parts = Array.isArray(g.participants) ? g.participants : [];
    if (parts.length === 0) return false;
    return parts.some(function (p) { return !p.paidAt; });
  });
  if (open.length === 0) return { ok: true, skipped: true };

  var totalPending = 0;
  var totalCollected = 0;
  open.forEach(function (g) {
    (g.participants || []).forEach(function (p) {
      var amt = Number(p.amountTWD || 0);
      if (p.paidAt) totalCollected += amt; else totalPending += amt;
    });
  });

  // 依日期降冪
  open.sort(function (a, b) {
    var da = a.date && (a.date.seconds ? a.date.seconds * 1000 : new Date(a.date).getTime()) || 0;
    var db = b.date && (b.date.seconds ? b.date.seconds * 1000 : new Date(b.date).getTime()) || 0;
    return db - da;
  });

  var lines = [
    '[Personal Hub] 墊付團催繳提醒',
    '--------------------',
    '未結清團數：' + open.length,
    '待收合計：NT$' + n0(totalPending) + ' / 已收 NT$' + n0(totalCollected),
    '--------------------',
  ];

  open.slice(0, 8).forEach(function (g) {
    var dateStr = g.date && g.date.seconds
      ? Utilities.formatDate(new Date(g.date.seconds * 1000), 'Asia/Taipei', 'MM/dd')
      : '';
    var unpaid = (g.participants || []).filter(function (p) { return !p.paidAt; });
    var pendingTotal = unpaid.reduce(function (s, p) { return s + Number(p.amountTWD || 0); }, 0);
    lines.push('- ' + (g.title || '(未命名)') + (dateStr ? ' (' + dateStr + ')' : ''));
    lines.push('   待收 NT$' + n0(pendingTotal) + ' · ' + unpaid.length + ' 人未繳');
    unpaid.slice(0, 6).forEach(function (p) {
      lines.push('   - ' + (p.name || '?') + '：NT$' + n0(p.amountTWD));
    });
    if (unpaid.length > 6) lines.push('   …其餘 ' + (unpaid.length - 6) + ' 人');
  });
  if (open.length > 8) lines.push('  …其餘 ' + (open.length - 8) + ' 團');

  return sendNotification_('payoutGroupReminder', lines.join('\n'));
}

function addDays_(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }

// -------- 每週回顧（週日 20:00）--------

/**
 * 本週支出 vs 上週、TOP 3 類別，加上「需要處理」的待辦數量與 /inbox 連結。
 * 待辦口徑與前端 features/inbox 一致（信用卡到期、排程到期、代墊、墊付團、待整理交易、預算 ≥ 80%）。
 */
function notifyWeeklyReview() {
  var now = new Date();
  var today0 = startOfDayTW_(now);
  // 本週 = 週一 00:00 ～ 現在；上週 = 上上個週一 ～ 上週日 23:59:59
  var dow = parseInt(Utilities.formatDate(now, TZ, 'u'), 10); // 1-7 Mon-Sun
  var weekStart = new Date(today0.getTime() - (dow - 1) * 86400000);
  var lastWeekStart = new Date(weekStart.getTime() - 7 * 86400000);
  var lastWeekEnd = new Date(weekStart.getTime() - 1);

  var thisTxs = [];
  var lastTxs = [];
  try {
    thisTxs = queryTxsBetween_(weekStart, now);
    lastTxs = queryTxsBetween_(lastWeekStart, lastWeekEnd);
  } catch (err) {
    console.warn('notifyWeeklyReview query', err);
  }
  var thisAgg = aggByType_(thisTxs);
  var lastAgg = aggByType_(lastTxs);
  var byCat = aggByCategory_(thisTxs, 'expense');
  var topCats = topN_(byCat, 3);

  var catNames = {};
  try {
    fsListDocs_('categories', 100).forEach(function (c) {
      var key = c.key || String(c._name).split('/').pop();
      catNames[key] = c.name || key;
    });
  } catch (err) { console.warn('notifyWeeklyReview categories', err); }

  var lines = [
    '[Personal Hub] 每週回顧',
    '--------------------',
    '本週 ' + Utilities.formatDate(weekStart, TZ, 'MM/dd') + ' – ' + Utilities.formatDate(now, TZ, 'MM/dd'),
    '支出  : NT$' + n0(thisAgg.expense) + weeklyDeltaText_(thisAgg.expense, lastAgg.expense),
    '收入  : NT$' + n0(thisAgg.income),
    '筆數  : ' + thisTxs.filter(function (t) { return !t.deletedAt; }).length,
  ];
  if (topCats.length) {
    lines.push('TOP 類別:');
    topCats.forEach(function (c) {
      lines.push('  · ' + (catNames[c.key] || c.key) + ' NT$' + n0(c.val));
    });
  }

  var hhLine = householdBalanceLine_();
  if (hhLine) {
    lines.push('--------------------');
    lines.push(hhLine);
  }

  var todo = weeklyInboxCounts_(today0);
  var todoLines = [];
  if (todo.creditCards) todoLines.push('· 信用卡帳單到期 / 逾期：' + todo.creditCards);
  if (todo.scheduled) todoLines.push('· 排程支出到期：' + todo.scheduled);
  if (todo.budget) todoLines.push('· 預算 ≥ 80% 類別：' + todo.budget);
  if (todo.loans) todoLines.push('· 未結清代墊：' + todo.loans + ' 人');
  if (todo.payouts) todoLines.push('· 墊付團未收齊：' + todo.payouts);
  if (todo.uncategorized) todoLines.push('· 待整理交易（其他）：' + todo.uncategorized);

  lines.push('--------------------');
  if (todoLines.length) {
    lines.push('需要處理 ' + todo.total + ' 項：');
    todoLines.forEach(function (l) { lines.push(l); });
    lines.push(appUrl_() + '/inbox');
  } else {
    lines.push('沒有待處理事項，週末愉快。');
  }
  return sendNotification_('weeklyReview', lines.join('\n'));
}

/**
 * 共同帳本餘額（owner 的 household）：「共同帳：小美 還要付你 NT$X」；沒 household 或兩不相欠回 ''。
 * 算法同前端 features/household/balance.ts：付款人 +total、各成員 −自己那份、結算 from +amt / to −amt。
 */
function householdBalanceLine_() {
  var owner = ownerUidCached_();
  if (!owner) return '';
  var hh = null;
  try {
    var docs = fsRunQuery_('', {
      from: [{ collectionId: 'households' }],
      where: { fieldFilter: { field: { fieldPath: 'memberIds' }, op: 'ARRAY_CONTAINS', value: { stringValue: owner } } },
      limit: 1,
    });
    hh = docs[0] || null;
  } catch (err) { console.warn('householdBalanceLine_ household', err); }
  if (!hh || !Array.isArray(hh.memberIds) || hh.memberIds.length < 2) return '';
  var hid = String(hh._name).split('/').pop();
  var net = {};
  hh.memberIds.forEach(function (id) { net[id] = 0; });
  try {
    var since = new Date(Date.now() - 730 * 86400000);
    var txs = fsRunQuery_('', {
      from: [{ collectionId: 'transactions' }],
      where: {
        compositeFilter: { op: 'AND', filters: [
          { fieldFilter: { field: { fieldPath: 'householdId' }, op: 'EQUAL', value: { stringValue: hid } } },
          { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: since.toISOString() } } },
        ] },
      },
      limit: 2000,
    });
    txs.forEach(function (t) {
      if (t.deletedAt || t.type !== 'expense') return;
      // 公基金付的支出已由基金餘額負擔，不算進成員彼此的應收／應付
      if (isHouseholdFundPaid_(t)) return;
      var total = (t.settledAmountTWD != null ? t.settledAmountTWD : t.amountTWD) || 0;
      var payer = t.paidByUid || t.userId;
      net[payer] = (net[payer] || 0) + total;
      var cs = Array.isArray(t.customShares) ? t.customShares : [];
      if (cs.length) {
        var csTotal = cs.reduce(function (s, c) { return s + (c.amountTWD || 0); }, 0);
        var ratio = csTotal > 0 ? total / csTotal : 1;
        cs.forEach(function (c) { net[c.memberId] = (net[c.memberId] || 0) - (c.amountTWD || 0) * ratio; });
      } else {
        net[payer] = (net[payer] || 0) - total;
      }
    });
    fsListAllDocs_('households/' + hid + '/settlements', 200).forEach(function (s) {
      net[s.fromUid] = (net[s.fromUid] || 0) + (s.amountTWD || 0);
      net[s.toUid] = (net[s.toUid] || 0) - (s.amountTWD || 0);
    });
  } catch (err) { console.warn('householdBalanceLine_ txs', err); return ''; }
  var mine = Math.round(net[owner] || 0);
  var other = hh.memberIds.filter(function (id) { return id !== owner; })[0];
  var otherName = (hh.members && hh.members[other] && hh.members[other].displayName) || '對方';
  var line = Math.abs(mine) < 1
    ? '共同帳：目前兩不相欠'
    : mine > 0
      ? '共同帳：' + otherName + ' 還要付你 NT$' + n0(mine)
      : '共同帳：你還要付 ' + otherName + ' NT$' + n0(-mine);
  // 共同月預算（有設才顯示）
  var budget = typeof hh.monthlyBudgetTWD === 'number' ? hh.monthlyBudgetTWD : 0;
  if (budget > 0) {
    try {
      var now = new Date();
      var mStart = new Date(Utilities.formatDate(now, TZ, 'yyyy-MM') + '-01T00:00:00+08:00');
      var spent = 0;
      fsRunQuery_('', {
        from: [{ collectionId: 'transactions' }],
        where: {
          compositeFilter: { op: 'AND', filters: [
            { fieldFilter: { field: { fieldPath: 'householdId' }, op: 'EQUAL', value: { stringValue: hid } } },
            { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: mStart.toISOString() } } },
          ] },
        },
        limit: 1000,
      }).forEach(function (t) {
        if (t.deletedAt || t.type !== 'expense') return;
        spent += (t.settledAmountTWD != null ? t.settledAmountTWD : t.amountTWD) || 0;
      });
      line += '\n共同預算：NT$' + n0(spent) + '／NT$' + n0(budget) + '（' + Math.round(spent / budget * 100) + '%）';
    } catch (err) { console.warn('householdBalanceLine_ budget', err); }
  }
  return line;
}

function weeklyDeltaText_(cur, prev) {
  if (!prev) return '';
  var pct = Math.round((cur - prev) / prev * 100);
  var sign = pct > 0 ? '+' : '';
  return ' (上週 NT$' + n0(prev) + '，' + sign + pct + '%)';
}

function appUrl_() {
  return PROP.getProperty('APP_URL') || '';
}

/** 各類待辦數量；每一段各自 try/catch，任何一段失敗不影響其他 */
function weeklyInboxCounts_(today0) {
  var out = { creditCards: 0, scheduled: 0, budget: 0, loans: 0, payouts: 0, uncategorized: 0, total: 0 };

  // 信用卡：5 天內到期 / 今天 / 逾期且未繳
  try {
    fsListAllDocs_('payment_methods', 200).forEach(function (pm) {
      if (!pm || pm.archivedAt || pm.type !== 'credit' || pm.billingEnabled !== true) return;
      var dueDay = parseInt(pm.dueDay, 10);
      if (!dueDay || dueDay < 1 || dueDay > 31) return;
      var origDue = currentDueDate_(dueDay, today0);
      var pmId = pm._name ? pm._name.split('/').pop() : (pm.key || pm.id);
      var bill = null;
      try { bill = fsGetDoc_('credit_card_bills/' + pmId + '__' + cycleMonthKey_(origDue)); } catch (ignoredErr) { console.warn('[Notifications:1803] ignored', ignoredErr); }
      if (bill && bill.paidAt) return;
      var eff = (bill && bill.dueDateOverride) ? new Date(bill.dueDateOverride) : origDue;
      var days = Math.round((eff.getTime() - today0.getTime()) / 86400000);
      if (days <= 5) out.creditCards += 1;
    });
  } catch (err) { console.warn('weeklyInboxCounts_ cc', err); }

  // 排程支出
  try {
    fsListAllDocs_('scheduled_payments', 200).forEach(function (p) {
      if (!p || (p.recurrence === 'one-time' && p.paidAt)) return;
      var due = p.dueDate instanceof Date ? p.dueDate : new Date(p.dueDate);
      var days = Math.round((due.getTime() - today0.getTime()) / 86400000);
      var remind = typeof p.remindBeforeDays === 'number' ? p.remindBeforeDays : 7;
      if (days <= remind) out.scheduled += 1;
    });
  } catch (err) { console.warn('weeklyInboxCounts_ scheduled', err); }

  // 預算 ≥ 80%（本月）
  try {
    var now = new Date();
    var month = Utilities.formatDate(now, TZ, 'yyyy-MM');
    var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    var mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    var b = fsListDocs_('budgets', 50).filter(function (x) { return x.month === month; })[0];
    if (b) {
      var mTxs = queryTxsBetween_(mStart, mEnd);
      var spentByCat = aggByCategory_(mTxs, 'expense');
      var totalSpent = aggByType_(mTxs).expense;
      if (b.total > 0 && totalSpent / b.total >= 0.8) out.budget += 1;
      Object.keys(b.byCategory || {}).forEach(function (k) {
        var limit = b.byCategory[k] || 0;
        if (limit > 0 && (spentByCat[k] || 0) / limit >= 0.8) out.budget += 1;
      });
    }
  } catch (err) { console.warn('weeklyInboxCounts_ budget', err); }

  // 代墊（超過 7 天未結清，依對方去重）與待整理交易（45 天內類別為其他）
  try {
    var since = new Date(Date.now() - 365 * 86400000);
    var txs = fsRunQuery_('', {
      from: [{ collectionId: 'transactions' }],
      where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL',
        value: { timestampValue: since.toISOString() } } },
      limit: 2000,
    });
    var names = {};
    var cutoff45 = Date.now() - 45 * 86400000;
    txs.forEach(function (t) {
      if (t.deletedAt) return;
      var d = t.date instanceof Date ? t.date : new Date(t.date);
      if (t.splitMode && t.splitMode !== 'self' && t.counterpartyName && !t.loanSettledAt && !t.householdId
          && t.category !== 'payout-group' && (today0.getTime() - d.getTime()) / 86400000 >= 7) {
        names[t.counterpartyName] = true;
      }
      if (d.getTime() >= cutoff45 && t.type !== 'transfer'
          && (t.category === 'other' || t.category === 'other_income')) {
        out.uncategorized += 1;
      }
    });
    out.loans = Object.keys(names).length;
  } catch (err) { console.warn('weeklyInboxCounts_ txs', err); }

  // 墊付團
  try {
    fsListAllDocs_('payout_groups', 200).forEach(function (g) {
      if (!g || g.archivedAt) return;
      var parts = Array.isArray(g.participants) ? g.participants : [];
      if (parts.some(function (p) { return !p.paidAt && Number(p.amountTWD || 0) > 0; })) out.payouts += 1;
    });
  } catch (err) { console.warn('weeklyInboxCounts_ payouts', err); }

  out.total = out.creditCards + out.scheduled + out.budget + out.loans + out.payouts + out.uncategorized;
  return out;
}
