/**
 * 財政部電子發票整合服務平台 — 載具消費自動同步（階段二）
 *
 * 需要 Script Properties：
 *   EINVOICE_APP_ID          向財政部申請的 App ID
 *   EINVOICE_CARD_NO         手機條碼（例：/ABC+123）
 *   EINVOICE_CARD_ENCRYPT    手機條碼驗證碼（財政部平台設定的密碼）
 *   EINVOICE_PAYMENT_METHOD  （選填）匯入交易的支付方式名稱，預設「信用卡」
 *   EINVOICE_ACCOUNT_ID      （選填）扣款帳戶 id（accounts/{id}，通常是常用的那張信用卡）；
 *                            設了就會記 fromAccountId 並同步調整該帳戶餘額（2026-11 稽核 D6）
 *
 * 流程（每日 01:00 由 tick_daily_0100 呼叫，也可 ?action=syncEInvoices 手動）：
 *   1. carrierInvChk：抓近 N 天載具發票（依月份分段查）
 *   2. 跳過作廢、已存在（transactions.invoiceNumber）、使用者在 web 端按過「忽略」的
 *   3. carrierInvDetail：抓品項
 *   4. 建 transaction：類別用店名 / 品項關鍵字猜，猜不到給 other（會進「需要處理」）
 *   5. 推播 einvoiceSync 摘要
 *
 * 帳戶餘額：沒設 EINVOICE_ACCOUNT_ID 就不動（fromAccountId = null），由對帳 / 帳單流程處理；
 * 設了就走 importAdjustAccount_（與 Telegram / 匯入 / 週期交易同一套規則）。帳戶不存在或已封存時退回不動餘額。
 */

var EINVOICE_API_ = 'https://api.einvoice.nat.gov.tw/PB2CAPIVAN/invapp/InvApp';
var EINVOICE_HEADER_VERSION_ = '0.6';
var EINVOICE_DETAIL_VERSION_ = '0.5';
var EINVOICE_CARD_TYPE_ = '3J0002'; // 手機條碼
var EINVOICE_MAX_PAGES_ = 100;

function einvoiceConfig_() {
  var appID = PROP.getProperty('EINVOICE_APP_ID');
  var cardNo = PROP.getProperty('EINVOICE_CARD_NO');
  var cardEncrypt = PROP.getProperty('EINVOICE_CARD_ENCRYPT');
  if (!appID || !cardNo || !cardEncrypt) return null;
  return {
    appID: appID,
    cardNo: cardNo,
    cardEncrypt: cardEncrypt,
    paymentMethod: PROP.getProperty('EINVOICE_PAYMENT_METHOD') || '信用卡',
    accountId: einvoiceAccountId_(),
  };
}

/** EINVOICE_ACCOUNT_ID 指到的帳戶存在且未封存才用，否則 null（不動餘額） */
function einvoiceAccountId_() {
  var id = String(PROP.getProperty('EINVOICE_ACCOUNT_ID') || '').trim();
  if (!id) return null;
  try {
    var acc = fsGetDoc_('accounts/' + id);
    if (acc && !acc.archivedAt && acc.active !== false) return id;
    console.warn('EINVOICE_ACCOUNT_ID points to a missing / archived account', id);
  } catch (err) {
    console.warn('einvoiceAccountId_', err);
  }
  return null;
}

function einvoicePost_(params, acceptedCodes) {
  var now = Math.floor(Date.now() / 1000);
  var payload = {
    version: EINVOICE_DETAIL_VERSION_,
    cardType: EINVOICE_CARD_TYPE_,
    timeStamp: String(now),
    expTimeStamp: String(now + 120),
    uuid: Utilities.getUuid(),
  };
  Object.keys(params).forEach(function (k) { payload[k] = params[k]; });
  var body = Object.keys(payload).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(payload[k]);
  }).join('&');
  var resp = UrlFetchApp.fetch(EINVOICE_API_, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/x-www-form-urlencoded',
    payload: body,
  });
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code >= 400) throw new Error('einvoice HTTP ' + code + ': ' + text.slice(0, 200));
  var json;
  try { json = JSON.parse(text); } catch (_) { throw new Error('einvoice non-JSON: ' + text.slice(0, 200)); }
  // 財政部 code 為字串或數字的 200 = 成功；其他附 msg
  var codeText = String(json.code);
  var allowed = ['200'].concat(acceptedCodes || []);
  if (allowed.indexOf(codeText) === -1) throw new Error('einvoice code ' + json.code + ': ' + (json.msg || ''));
  return json;
}

function einvoiceFetchHeaders_(cfg, startDate, endDate) {
  var invoices = [];
  for (var page = 1; page <= EINVOICE_MAX_PAGES_; page++) {
    var res = einvoicePost_({
      version: EINVOICE_HEADER_VERSION_,
      action: 'carrierInvChk',
      appID: cfg.appID,
      cardNo: cfg.cardNo,
      cardEncrypt: cfg.cardEncrypt,
      startDate: einvoiceFmtDate_(startDate),
      endDate: einvoiceFmtDate_(endDate),
      onlyWinningInv: 'N',
      page: page,
    }, ['996']);
    (res.details || []).forEach(function (invoice) { invoices.push(invoice); });
    if (String(res.code) !== '996') return invoices;
  }
  throw new Error('einvoice pagination exceeded ' + EINVOICE_MAX_PAGES_ + ' pages');
}

function einvoiceFmtDate_(d) {
  return Utilities.formatDate(d, TZ, 'yyyy/MM/dd');
}

/** 解析 invDate：可能是 {year, month, date} 物件、'yyyy/MM/dd'、'yyyyMMdd'；都失敗用 invPeriod（yyyyMM）當月 1 號 */
function einvoiceParseDate_(inv) {
  var d = inv.invDate;
  if (d && typeof d === 'object') {
    var y = parseInt(d.year, 10), m = parseInt(d.month, 10), day = parseInt(d.date != null ? d.date : d.day, 10);
    if (y && m && day) { if (y < 1911) y += 1911; return { y: y, m: m, d: day }; }
  }
  if (typeof d === 'string') {
    var mm = d.match(/^(\d{4})[\/-]?(\d{2})[\/-]?(\d{2})/);
    if (mm) return { y: parseInt(mm[1], 10), m: parseInt(mm[2], 10), d: parseInt(mm[3], 10) };
    mm = d.match(/^(\d{3})[\/-]?(\d{2})[\/-]?(\d{2})/);
    if (mm) return { y: parseInt(mm[1], 10) + 1911, m: parseInt(mm[2], 10), d: parseInt(mm[3], 10) };
  }
  if (inv.invPeriod && /^\d{6}$/.test(String(inv.invPeriod))) {
    return { y: parseInt(String(inv.invPeriod).slice(0, 4), 10), m: parseInt(String(inv.invPeriod).slice(4), 10), d: 1 };
  }
  return null;
}

var EINVOICE_CATEGORY_RULES_ = [
  { category: 'food', pattern: /餐|飯|麵|食|咖啡|茶|飲|烘焙|麵包|甜點|麥當勞|肯德基|摩斯|星巴克|路易莎|85度|鼎泰豐|壽司|火鍋|燒肉|便當|小吃|coffee|cafe|bakery|kitchen/i },
  { category: 'transport', pattern: /中油|台亞|加油|停車|高鐵|台鐵|捷運|客運|uber|計程|租車|悠遊|一卡通|統聯|國光|parking|taxi/i },
  { category: 'home', pattern: /家樂福|全聯|大潤發|好市多|costco|愛買|水費|電費|瓦斯|台電|自來水|中華電信|台灣大哥大|遠傳|電信|寬頻|ikea|宜得利|特力屋|生活工場/i },
  { category: 'medical', pattern: /藥局|藥妝|診所|醫院|牙醫|眼科|中醫|屈臣氏|康是美|大樹|杏一|clinic|pharmacy/i },
  { category: 'shopping', pattern: /統一超商|7-?11|全家|萊爾富|OK超商|超商|便利商店|momo|蝦皮|pchome|博客來|uniqlo|zara|無印|誠品|寶雅|小北|amazon|apple/i },
  { category: 'entertainment', pattern: /威秀|影城|電影|KTV|好樂迪|錢櫃|netflix|spotify|steam|遊戲|健身|world gym|運動中心/i },
  { category: 'education', pattern: /書局|書店|文具|補習|課程|udemy|hahow/i },
];

function einvoiceGuessCategory_(sellerName, items, allowed) {
  var hay = (sellerName || '') + ' ' + (items || []).join(' ');
  for (var i = 0; i < EINVOICE_CATEGORY_RULES_.length; i++) {
    var r = EINVOICE_CATEGORY_RULES_[i];
    if (allowed[r.category] && r.pattern.test(hay)) return r.category;
  }
  return 'other';
}

/** 使用者在 web 端按「忽略」的發票號碼 */
function einvoiceIgnoredSet_(ownerUid) {
  var set = {};
  try {
    var doc = fsGetDoc_('users/' + ownerUid);
    var ignored = doc && doc.preferences && doc.preferences.einvoice && doc.preferences.einvoice.ignored;
    if (ignored && typeof ignored === 'object') Object.keys(ignored).forEach(function (k) { set[k] = true; });
  } catch (err) { console.warn('einvoiceIgnoredSet_', err); }
  return set;
}

/** 近 N 天交易已帶的 invoiceNumber */
function einvoiceExistingSet_(since) {
  var set = {};
  try {
    var txs = fsRunQuery_('', {
      from: [{ collectionId: 'transactions' }],
      where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL',
        value: { timestampValue: since.toISOString() } } },
      limit: 3000,
    });
    txs.forEach(function (t) { if (t.invoiceNumber) set[String(t.invoiceNumber).toUpperCase()] = true; });
  } catch (err) { console.warn('einvoiceExistingSet_', err); }
  return set;
}

/**
 * 主流程。opts.daysBack 預設 7（最多 60）。回傳 { ok, fetched, created, skipped, uncategorized, totalTWD }
 */
function syncEInvoices(opts) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, skipped: true, error: 'einvoice sync locked' };
  try {
    return syncEInvoicesUnlocked_(opts);
  } finally {
    lock.releaseLock();
  }
}

function syncEInvoicesUnlocked_(opts) {
  var cfg = einvoiceConfig_();
  if (!cfg) return { ok: false, skipped: true, error: 'EINVOICE_APP_ID / EINVOICE_CARD_NO / EINVOICE_CARD_ENCRYPT not set' };
  var daysBack = Math.min(60, Math.max(1, parseInt(opts && opts.daysBack, 10) || 7));
  var owner = getOwnerUid_();
  if (!owner) return { ok: false, error: 'owner uid not found' };

  var now = new Date();
  var since = new Date(now.getTime() - daysBack * 86400000);

  // 1. 依月份分段查（API 要求 startDate / endDate 在同一個月）
  var invoices = [];
  var cursor = new Date(since.getTime());
  while (cursor.getTime() <= now.getTime()) {
    var y = parseInt(Utilities.formatDate(cursor, TZ, 'yyyy'), 10);
    var m = parseInt(Utilities.formatDate(cursor, TZ, 'M'), 10);
    var monthEnd = new Date(y, m, 0); // 該月最後一天（本地）
    var segEnd = monthEnd.getTime() < now.getTime() ? monthEnd : now;
    einvoiceFetchHeaders_(cfg, cursor, segEnd).forEach(function (invoice) { invoices.push(invoice); });
    cursor = new Date(y, m, 1); // 下個月 1 號
  }

  // 2. 去重
  var existing = einvoiceExistingSet_(new Date(since.getTime() - 7 * 86400000));
  var ignored = einvoiceIgnoredSet_(owner);
  var allowed = {};
  try {
    fsListDocs_('categories', 100).forEach(function (c) {
      if (c.archivedAt) return;
      var key = c.key || String(c._name).split('/').pop();
      if ((c.type || 'expense') === 'expense') allowed[key] = true;
    });
  } catch (err) { console.warn('syncEInvoices categories', err); }

  var created = 0, skipped = 0, uncategorized = 0, totalTWD = 0;
  var createdRows = [];
  for (var i = 0; i < invoices.length; i++) {
    var inv = invoices[i];
    var invNum = String(inv.invNum || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!invNum) continue;
    var status = String(inv.invStatus || '');
    if (/作廢|註銷|void|cancel/i.test(status)) { skipped++; continue; }
    if (existing[invNum] || ignored[invNum]) { skipped++; continue; }
    var amount = Number(String(inv.amount || '0').replace(/,/g, '')) || 0;
    if (amount <= 0) { skipped++; continue; }
    var dp = einvoiceParseDate_(inv);
    if (!dp) { skipped++; continue; }

    // 3. 明細
    var items = [];
    try {
      var det = einvoicePost_({
        action: 'carrierInvDetail',
        appID: cfg.appID,
        cardNo: cfg.cardNo,
        cardEncrypt: cfg.cardEncrypt,
        invNum: invNum,
        invDate: dp.y + '/' + ('0' + dp.m).slice(-2) + '/' + ('0' + dp.d).slice(-2),
      });
      (det.details || []).forEach(function (row) {
        var name = String(row.description || row.name || '').trim();
        if (name) items.push({ name: name, amountTWD: Number(String(row.amount || '0').replace(/,/g, '')) || 0 });
      });
    } catch (err) {
      console.warn('carrierInvDetail', invNum, err);
    }
    Utilities.sleep(200); // 對財政部 API 客氣一點

    // 4. 建交易
    var sellerName = String(inv.sellerName || '').trim();
    var category = einvoiceGuessCategory_(sellerName, items.map(function (x) { return x.name; }), allowed);
    if (category === 'other') uncategorized++;
    var date = new Date(Date.UTC(dp.y, dp.m - 1, dp.d, 4, 0, 0)); // 台北 12:00
    var ts = new Date();
    fsAddDoc_('transactions', {
      userId: owner,
      type: 'expense',
      amount: amount,
      currency: 'TWD',
      amountTWD: amount,
      fxRate: 1,
      category: category,
      paymentMethod: cfg.paymentMethod,
      fromAccountId: cfg.accountId,
      toAccountId: null,
      note: sellerName || (items[0] && items[0].name) || '電子發票',
      date: date,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      tripId: null,
      tags: [],
      splitMode: null,
      counterpartyName: null,
      myShareTWD: null,
      settledAmountTWD: null,
      settledFxRate: null,
      settledAt: null,
      invoiceNumber: invNum,
      lineItems: items.length > 1 ? items.slice(0, 20).map(function (it, idx) { return { id: 'inv-' + idx, name: it.name, amountTWD: it.amountTWD }; }) : null,
      source: 'einvoice',
    });
    if (cfg.accountId) {
      try { importAdjustAccount_(cfg.accountId, 'TWD', -amount, -amount); }
      catch (adjErr) { console.warn('einvoice adjust account', invNum, adjErr); notifyError('einvoiceAccount', adjErr); }
    }
    existing[invNum] = true;
    created++;
    totalTWD += amount;
    createdRows.push({ seller: sellerName, amount: amount, category: category });
  }

  var summary = { ok: true, daysBack: daysBack, fetched: invoices.length, created: created, skipped: skipped, uncategorized: uncategorized, totalTWD: Math.round(totalTWD) };
  if (created > 0) {
    try { notifyEInvoiceSync_(summary, createdRows); } catch (err) { console.warn('notifyEInvoiceSync_', err); }
  }
  return summary;
}

function notifyEInvoiceSync_(summary, rows) {
  var lines = ['[Personal Hub] 電子發票同步', '--------------------',
    '已匯入 ' + summary.created + ' 張，合計 NT$' + n0(summary.totalTWD)
      + (summary.skipped ? '（略過 ' + summary.skipped + ' 張：作廢 / 已存在 / 已忽略）' : '')];
  rows.slice(0, 8).forEach(function (r) {
    lines.push('· ' + (r.seller || '?') + ' NT$' + n0(r.amount) + (r.category === 'other' ? '（待分類）' : ''));
  });
  if (rows.length > 8) lines.push('…其餘 ' + (rows.length - 8) + ' 張');
  if (summary.uncategorized) {
    lines.push('--------------------', summary.uncategorized + ' 張猜不到類別，已放到需要處理：', appUrl_() + '/inbox');
  }
  return sendNotification_('einvoiceSync', lines.join('\n'));
}
