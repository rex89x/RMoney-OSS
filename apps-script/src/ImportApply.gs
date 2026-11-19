/**
 * AI 匯入（Apps Script 端）：解析 RMoney 匯入 JSON → 正規化 → 寫入 Firestore。
 *
 * 與前端 `features/import/schema.ts` / `normalize.ts` / `apply.ts` 是同一套規則：
 *  - 記帳 doc id = `ai_` + sha256(內容 basis).slice(0, 40)，跟 web 完全相同 → 在 Telegram 匯過的，
 *    到 web 再貼一次會顯示「已匯入過」，反之亦然。
 *  - 股票成交：更新 portfolio 持倉（lots）、賣出寫 realized_lots、交割帳戶餘額照實扣 / 入。
 *  - 記帳的帳戶餘額也會調整（與 web createTransaction 一致）。
 * 格式說明：docs/AI_IMPORT_FORMAT.md。
 */

var IMPORT_LEDGER_ACCOUNT_TYPES_ = ['cash', 'bank', 'credit_card', 'e_wallet_balance', 'investment_cash'];
var IMPORT_INCOME_ACCOUNT_TYPES_ = ['cash', 'bank', 'e_wallet_balance', 'investment_cash'];
var IMPORT_TRADE_ACCOUNT_TYPES_ = ['bank', 'cash', 'investment_cash', 'e_wallet_balance'];
var IMPORT_MAX_ITEMS_ = 500;
/** 與前端 lib/seed-data.ts DEFAULT_PAYMENT_METHODS 同一份（沒建帳戶 / 支付方式時的預設名單） */
var IMPORT_DEFAULT_PAYMENT_METHODS_ = ['現金', '信用卡-CUBE', '信用卡-JCB', '銀行轉帳', 'LINE Pay', '街口', '悠遊卡', '其他'];
var IMPORT_PM_TYPE_LABEL_ = { cash: '現金', credit: '信用卡', debit: '簽帳金融', mobile: '行動支付', other: '其他' };

/**
 * 從任意文字裡挖出 JSON（容許 ```json 圍欄、前後雜訊、直接貼陣列、全形括號）。
 * 回 { full, cut }：cut 切到最後一個結尾括號（去掉後面說明文字）；full 留到底，截斷時 importRepairJson_ 才看得到。
 */
function importExtractJson_(text) {
  var t = String(text || '').replace(/｛/g, '{').replace(/｝/g, '}').replace(/［/g, '[').replace(/］/g, ']').trim();
  if (!t) return null;
  var fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  var openFence = fence ? null : /```(?:json)?\s*([\s\S]*)$/i.exec(t);
  var body = fence ? fence[1].trim() : openFence ? openFence[1].trim() : t;
  var o = body.indexOf('{');
  var a = body.indexOf('[');
  var starts = [o, a].filter(function (i) { return i >= 0; });
  if (!starts.length) return null;
  var start = Math.min.apply(null, starts);
  var open = body.charAt(start);
  var close = open === '{' ? '}' : ']';
  var end = body.lastIndexOf(close);
  var full = body.slice(start);
  return { full: full, cut: end <= start ? full : body.slice(start, end + 1) };
}

/**
 * 解析 envelope：回 { items, rejected: [{index, message}], error, repaired, truncated }
 *  - repaired：原文不是合法 JSON（彎引號 / 單引號 / 尾逗號…），修復後才成功
 *  - truncated：括號沒收完（Telegram 4096 字切斷），最後一筆已丟掉
 */
function importParseEnvelope_(text) {
  var base = { items: [], rejected: [], error: null, repaired: false, truncated: false };
  var raw = importExtractJson_(text);
  if (raw == null) { base.error = '找不到 JSON（要以 { 或 [ 開頭）'; return base; }
  var parsed = importParseJsonLoosely_(raw.full, raw.cut);
  base.truncated = !!parsed.truncated;
  if (!parsed.ok) { base.error = 'JSON 格式錯誤：' + parsed.error; return base; }
  base.repaired = !!parsed.repaired;
  var data = parsed.data;
  var itemsRaw;
  if (Array.isArray(data)) itemsRaw = data;
  else if (data && typeof data === 'object' && Array.isArray(data.items)) itemsRaw = data.items;
  else if (data && typeof data === 'object' && data.kind) itemsRaw = [data];
  else { base.error = '不是 RMoney 匯入格式（需要 items 陣列）'; return base; }
  if (itemsRaw.length > IMPORT_MAX_ITEMS_) { base.error = '一次最多 ' + IMPORT_MAX_ITEMS_ + ' 筆'; return base; }

  var items = [];
  var rejected = [];
  if (parsed.truncated && itemsRaw.length) {
    itemsRaw.pop();
    rejected.push({ index: itemsRaw.length, message: '內容被截斷，最後一筆不完整（請補貼後面的部分）' });
  }
  itemsRaw.forEach(function (entry, index) {
    var v = importValidateItem_(entry);
    if (v.ok) items.push(v.item); else rejected.push({ index: index, message: v.message });
  });
  base.items = items;
  base.rejected = rejected;
  if (!items.length) base.error = rejected.length ? '每一筆都有格式問題' : '沒有任何項目';
  return base;
}

/** 數字也接受字串（"1,280"、"NT$ 120"）；與前端 schema 的 cleanNumber 同規則 */
function importNum_(v) {
  if (v === null || v === undefined || v === '') return NaN;
  var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.eE+-]/g, ''));
  return isFinite(n) ? n : NaN;
}
function importStr_(v, max) {
  if (v === null || v === undefined) return undefined;
  var s = String(v).trim();
  return s ? s.slice(0, max || 200) : undefined;
}

/** 與前端 Zod schema 相同的欄位檢查（寬鬆：數字可以是字串） */
function importValidateItem_(e) {
  if (!e || typeof e !== 'object') return { ok: false, message: '不是物件' };
  var kind = String(e.kind || '');
  var date = String(e.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: 'date: 日期要是 yyyy-MM-dd' };
  if (kind === 'expense' || kind === 'income') {
    var amount = importNum_(e.amount);
    if (!(amount > 0)) return { ok: false, message: 'amount: 金額需大於 0' };
    var item = {
      kind: kind, date: date, amount: amount,
      currency: (importStr_(e.currency, 5) || 'TWD').toUpperCase(),
      category: importStr_(e.category), note: importStr_(e.note), merchant: importStr_(e.merchant),
      account: importStr_(e.account), paymentMethod: importStr_(e.paymentMethod),
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 10).map(function (t) { return String(t).trim().slice(0, 30); }).filter(Boolean) : [],
      id: importStr_(e.id),
    };
    var fx = importNum_(e.fxRate);
    if (fx > 0) item.fxRate = fx;
    if (item.currency.length < 3) return { ok: false, message: 'currency: 幣別代碼不對' };
    return { ok: true, item: item };
  }
  if (kind === 'trade') {
    var symbol = importStr_(e.symbol, 12);
    if (!symbol) return { ok: false, message: 'symbol: 缺股票代號' };
    var side = String(e.side || '');
    if (side !== 'buy' && side !== 'sell') return { ok: false, message: 'side: 要是 buy 或 sell' };
    var shares = importNum_(e.shares);
    var price = importNum_(e.price);
    if (!(shares > 0)) return { ok: false, message: 'shares: 股數需大於 0' };
    if (!(price > 0)) return { ok: false, message: 'price: 單價需大於 0' };
    var market = e.market === 'TW' || e.market === 'US' ? e.market : undefined;
    var currency = e.currency === 'TWD' || e.currency === 'USD' ? e.currency : undefined;
    var fee = importNum_(e.fee); var tax = importNum_(e.tax);
    var t = {
      kind: 'trade', date: date, symbol: symbol, side: side, shares: shares, price: price,
      market: market, currency: currency,
      fee: fee >= 0 ? fee : 0, tax: tax >= 0 ? tax : 0,
      account: importStr_(e.account), note: importStr_(e.note), id: importStr_(e.id),
    };
    var tfx = importNum_(e.fxRate);
    if (tfx > 0) t.fxRate = tfx;
    return { ok: true, item: t };
  }
  return { ok: false, message: 'kind: 要是 expense / income / trade' };
}

function importSha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var h = (b < 0 ? b + 256 : b).toString(16); return h.length === 1 ? '0' + h : h; }).join('');
}

/** 與前端 importRowKey() 完全相同的 basis，跨管道去重 */
function importRowId_(item) {
  var basis;
  if (item.id) basis = 'ai:id:' + item.kind + ':' + item.id;
  else if (item.kind === 'trade') basis = 'ai:trade:' + item.date + ':' + item.symbol + ':' + item.side + ':' + String(Number(item.shares)) + ':' + String(Number(item.price));
  else basis = 'ai:' + item.kind + ':' + item.date + ':' + String(Number(item.amount)) + ':' + item.currency + ':' + (item.category || '') + ':' + (item.note || item.merchant || '');
  return 'ai_' + importSha256Hex_(basis).slice(0, 40);
}

function importLower_(s) { return String(s || '').trim().toLowerCase(); }

function importResolveCategory_(raw, type, categories) {
  var pool = categories.filter(function (c) { return c.type === type; });
  var q = importLower_(raw);
  var fallbackKeys = type === 'income' ? ['other_income', 'other'] : ['other'];
  var fallback = (pool.filter(function (c) { return fallbackKeys.indexOf(c.key) >= 0; })[0] || pool[0] || { key: fallbackKeys[0] }).key;
  if (!q) return { key: fallback, guessed: true };
  var hit = pool.filter(function (c) { return importLower_(c.key) === q; })[0]
    || pool.filter(function (c) { return importLower_(c.name) === q; })[0]
    || pool.filter(function (c) { var n = importLower_(c.name); return n.indexOf(q) >= 0 || q.indexOf(n) >= 0 || importLower_(c.key).indexOf(q) >= 0; })[0];
  return hit ? { key: hit.key, guessed: false } : { key: fallback, guessed: true };
}

function importResolveAccount_(raw, accounts, types) {
  var q = importLower_(raw);
  if (!q) return null;
  var pool = accounts.filter(function (a) { return types.indexOf(a.type) >= 0; });
  return pool.filter(function (a) { return a.id === raw; })[0]
    || pool.filter(function (a) { return importLower_(a.name) === q; })[0]
    || pool.filter(function (a) { return importLower_(a.legacyPaymentMethod) === q; })[0]
    || pool.filter(function (a) { var n = importLower_(a.name); return n.indexOf(q) >= 0 || q.indexOf(n) >= 0; })[0]
    || null;
}

/** 支付方式名稱 → 剛好一個綁同名的帳戶才自動帶（與前端 PaymentSelect 同規則） */
function importAccountForPaymentMethod_(pmName, accounts, types) {
  var hits = accounts.filter(function (a) {
    return types.indexOf(a.type) >= 0 && ((a.legacyPaymentMethod || a.name) === pmName || a.name === pmName);
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 付款方式：帳戶 → 自訂支付方式（名稱 / key / 末四碼 / 類型名稱）→ 預設名單 → 對不到。
 * 回 { accountId, accountName, paymentMethod, matched }；與前端 normalize.ts resolvePayment 同一套。
 */
function importResolvePayment_(raw, ctx, types) {
  var q = importLower_(raw);
  var account = importResolveAccount_(raw, ctx.accounts, types);
  if (account) return { accountId: account.id, accountName: account.name, paymentMethod: account.legacyPaymentMethod || account.name, matched: true };
  if (!q) return { accountId: null, accountName: null, paymentMethod: '', matched: false };
  var pms = (ctx.paymentMethods || []).filter(function (p) { return !p.archivedAt && p.name; });
  var pm = pms.filter(function (p) { return importLower_(p.name) === q || importLower_(p.key) === q; })[0]
    || pms.filter(function (p) { var n = importLower_(p.name); return n.indexOf(q) >= 0 || q.indexOf(n) >= 0; })[0]
    || pms.filter(function (p) { return p.last4 && /\d{4}$/.test(q) && q.slice(-4) === String(p.last4); })[0];
  if (!pm) {
    var typeKeys = Object.keys(IMPORT_PM_TYPE_LABEL_).filter(function (t) { return importLower_(IMPORT_PM_TYPE_LABEL_[t]) === q; });
    if (typeKeys.length) {
      var sameType = pms.filter(function (p) { return p.type === typeKeys[0]; });
      if (sameType.length === 1) pm = sameType[0];
    }
  }
  if (pm) {
    var linked = importAccountForPaymentMethod_(pm.name, ctx.accounts, types);
    return { accountId: linked ? linked.id : null, accountName: linked ? linked.name : null, paymentMethod: pm.name, matched: true };
  }
  var preset = IMPORT_DEFAULT_PAYMENT_METHODS_.filter(function (p) { return importLower_(p) === q; })[0];
  if (preset) return { accountId: null, accountName: null, paymentMethod: preset, matched: true };
  return { accountId: null, accountName: null, paymentMethod: String(raw || '').trim(), matched: false };
}

/**
 * 給 Telegram 「改付款方式」用的候選清單（順序固定，callback 用 index + 名稱短 hash 對回來）。
 * kind: 'expense' | 'income' | 'trade'。每項 { label, paymentMethod, accountId, accountName }。
 */
function importPaymentOptions_(ctx, kind) {
  var types = kind === 'trade' ? IMPORT_TRADE_ACCOUNT_TYPES_ : kind === 'income' ? IMPORT_INCOME_ACCOUNT_TYPES_ : IMPORT_LEDGER_ACCOUNT_TYPES_;
  var typeLabel = { cash: '現金', bank: '銀行', credit_card: '信用卡', e_wallet_balance: '電子錢包', investment_cash: '交割帳戶', loan: '貸款' };
  var out = [];
  var seen = {};
  function push(label, pmName, acc) {
    var key = pmName + '|' + (acc ? acc.id : '');
    if (seen[key]) return;
    seen[key] = true;
    out.push({ label: label, paymentMethod: pmName, accountId: acc ? acc.id : null, accountName: acc ? acc.name : null });
  }
  ctx.accounts.filter(function (a) { return types.indexOf(a.type) >= 0; }).forEach(function (a) {
    var pmName = a.legacyPaymentMethod || a.name;
    push(a.name + (pmName !== a.name ? '（' + pmName + '）' : '') + ' · ' + (typeLabel[a.type] || a.type), pmName, a);
  });
  if (kind !== 'trade') {
    (ctx.paymentMethods || []).filter(function (p) { return !p.archivedAt && p.name; }).forEach(function (p) {
      if (kind === 'income' && (p.type === 'credit')) return; // 收入不會進信用卡
      var linked = importAccountForPaymentMethod_(p.name, ctx.accounts, types);
      if (linked && seen[p.name + '|' + linked.id]) return;
      push(p.name + (p.last4 ? ' ****' + p.last4 : ''), p.name, linked);
    });
    IMPORT_DEFAULT_PAYMENT_METHODS_.forEach(function (name) {
      if (kind === 'income' && name.indexOf('信用卡') === 0) return;
      var dup = out.some(function (o) { return o.paymentMethod === name; });
      if (!dup) push(name, name, null);
    });
  }
  return out.slice(0, 40);
}

/** 短 hash（callback_data 64 bytes 內要塞 token + index + 校驗碼） */
function importShortHash_(s) {
  return importSha256Hex_(String(s)).slice(0, 4);
}

function importFxRate_(currency) {
  if (currency === 'TWD') return 1;
  try {
    var fx = fsGetDoc_('fx_rates/' + currency + '_TWD');
    if (fx && Number(fx.rate) > 0) return Number(fx.rate);
  } catch (err) { console.warn('importFxRate_', err); }
  return null;
}

function importNormalizeSymbol_(raw) {
  var s = normalizeStockSymbol_(raw);
  if (!s) return { ok: false, reason: '請輸入股票代號' };
  // 台股：4–6 位數字 + 0–2 碼英文字尾（00878、00981A、2881A…），規則見 Stocks.gs isTwSymbol_
  if (/^\d/.test(s)) {
    if (!isTwSymbol_(s)) return { ok: false, reason: '台股代號為 4–6 位數字，可加 1–2 碼英文字尾（如 2330、00878、00981A）' };
    return { ok: true, symbol: s, market: 'TW', currency: twSymbolCurrency_(s) };
  }
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) return { ok: false, reason: '股票代號格式不正確' };
  return { ok: true, symbol: s, market: 'US' };
}

function importDateTW_(ymd) {
  var p = String(ymd).split('-');
  return new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10), 4, 0, 0)); // 台北 12:00
}

/**
 * 正規化成可寫入的列。ctx = { categories, accounts, positions }
 * 回傳 rows[{ id, item, kind, status: 'ready'|'warn'|'error', messages[], resolved }]
 */
function importNormalize_(items, ctx) {
  var rows = [];
  var seen = {};
  items.forEach(function (item, index) {
    var id = importRowId_(item);
    var r = item.kind === 'trade' ? importResolveTrade_(item, ctx) : importResolveLedger_(item, ctx);
    var hard = !!r.hard;
    if (seen[id]) { hard = true; r.messages.push('與上面某一筆重複'); }
    seen[id] = true;
    var row = { id: id, index: index, item: item, kind: item.kind, hard: hard, excluded: false, messages: r.messages, resolved: r.resolved };
    importRecompute_(row);
    rows.push(row);
  });
  return rows;
}

/**
 * 依 hard（不可修的錯：代號、持倉、重複）/ 交割帳戶 / 剩餘訊息重算 status。
 * Telegram 逐筆調整改了類別 / 付款方式後呼叫；web 端對應 patchRow。
 */
function importRecompute_(row) {
  if (row.hard) { row.status = 'error'; return row; }
  if (row.kind === 'trade' && !row.resolved.accountId) { row.status = 'error'; return row; }
  row.status = row.messages.length ? 'warn' : 'ready';
  return row;
}

/** Telegram 逐筆調整：改類別 */
function importSetRowCategory_(row, catKey, ctx) {
  var type = row.kind === 'income' ? 'income' : 'expense';
  var cat = ctx.categories.filter(function (c) { return c.key === catKey && c.type === type; })[0];
  if (!cat) return false;
  row.resolved.categoryKey = cat.key;
  row.resolved.categoryName = cat.name;
  row.messages = row.messages.filter(function (m) { return m.indexOf('類別') < 0; });
  importRecompute_(row);
  return true;
}

/** Telegram 逐筆調整 / 套用全部：改付款方式（option 來自 importPaymentOptions_） */
function importSetRowPayment_(row, option) {
  if (row.kind === 'trade') {
    if (!option.accountId) return false;
    row.resolved.accountId = option.accountId;
    row.resolved.accountName = option.accountName;
    row.messages = row.messages.filter(function (m) { return m.indexOf('交割帳戶') < 0; });
  } else {
    row.resolved.accountId = option.accountId;
    row.resolved.accountName = option.accountName;
    row.resolved.paymentMethod = option.paymentMethod;
    row.resolved.paymentMatched = true;
    row.messages = row.messages.filter(function (m) { return m.indexOf('付款方式') < 0 && m.indexOf('帳戶') < 0; });
  }
  importRecompute_(row);
  return true;
}

function importResolveLedger_(item, ctx) {
  var messages = [];
  var status = 'ready';
  var currency = item.currency || 'TWD';
  var fxRate = item.fxRate || importFxRate_(currency);
  if (fxRate == null) { messages.push('沒有 ' + currency + ' 匯率，先用 1'); fxRate = 1; status = 'warn'; }
  var cat = importResolveCategory_(item.category, item.kind, ctx.categories);
  if (cat.guessed) { messages.push(item.category ? '類別「' + item.category + '」對不到，先放「其他」' : '沒給類別，先放「其他」'); status = 'warn'; }
  var accountRaw = item.account || item.paymentMethod;
  var types = item.kind === 'income' ? IMPORT_INCOME_ACCOUNT_TYPES_ : IMPORT_LEDGER_ACCOUNT_TYPES_;
  var payment = importResolvePayment_(accountRaw, ctx, types);
  if (!payment.matched) {
    if (!payment.paymentMethod) payment.paymentMethod = '現金';
    if (accountRaw) { messages.push('付款方式「' + accountRaw + '」對不到帳戶或支付方式，可按「逐筆調整」選一個'); status = 'warn'; }
  }
  var note = [item.note, item.merchant].filter(Boolean).join(' · ').slice(0, 200);
  return {
    status: status, messages: messages,
    resolved: {
      kind: item.kind, date: item.date, amount: item.amount, currency: currency, fxRate: fxRate,
      amountTWD: Math.round(item.amount * fxRate * 100) / 100,
      categoryKey: cat.key,
      categoryName: (ctx.categories.filter(function (c) { return c.key === cat.key; })[0] || {}).name || cat.key,
      accountId: payment.accountId,
      accountName: payment.accountName,
      paymentMethod: payment.paymentMethod,
      paymentMatched: payment.matched,
      note: note, tags: item.tags || [], sourceId: item.id || null,
    },
  };
}

function importResolveTrade_(item, ctx) {
  var messages = [];
  var status = 'ready';
  var hard = false;
  var norm = importNormalizeSymbol_(item.symbol);
  var symbol = String(item.symbol).trim().toUpperCase();
  var market = item.market || 'US';
  if (norm.ok) { symbol = norm.symbol; market = item.market || norm.market; }
  else { messages.push(norm.reason); status = 'error'; hard = true; }
  // 台股外幣交易 ETF（K / C / M / S / V 字尾）以 USD 計價，見 Stocks.gs twSymbolCurrency_
  var currency = item.currency || (market === 'US' ? 'USD' : twSymbolCurrency_(symbol));
  var fxRate = item.fxRate || importFxRate_(currency);
  if (fxRate == null) { messages.push('沒有 ' + currency + ' 匯率，先用 1'); fxRate = 1; if (status === 'ready') status = 'warn'; }
  var fee = (item.fee || 0) + (item.tax || 0);
  var account = importResolveAccount_(item.account, ctx.accounts, IMPORT_TRADE_ACCOUNT_TYPES_);
  if (!account && ctx.defaultTradeAccountId) account = ctx.accounts.filter(function (a) { return a.id === ctx.defaultTradeAccountId; })[0] || null;
  if (!account) { messages.push(item.account ? '交割帳戶「' + item.account + '」對不到，可按「逐筆調整」選一個' : '沒有可用的交割帳戶'); status = 'error'; }
  var position = (ctx.positions || []).filter(function (p) { return p.symbol === symbol; })[0] || null;
  if (item.side === 'sell') {
    if (!position) { messages.push('沒有 ' + symbol + ' 的持倉可賣'); status = 'error'; hard = true; }
    else if (item.shares > Number(position.shares || 0)) { messages.push('賣出 ' + item.shares + ' 股超過持有 ' + position.shares + ' 股'); status = 'error'; hard = true; }
  }
  return {
    status: status, messages: messages, hard: hard,
    resolved: {
      kind: 'trade', date: item.date, market: market, symbol: symbol, side: item.side,
      shares: item.shares, price: item.price, currency: currency, fee: fee, fxRate: fxRate,
      grossTWD: Math.round(item.shares * item.price * fxRate),
      accountId: account ? account.id : null, accountName: account ? account.name : null,
      positionId: position ? position.id : null, note: item.note || '',
    },
  };
}

/** 讀正規化需要的 context（類別 / 帳戶 / 持倉） */
function importLoadContext_(ownerUid) {
  var ctx = tgLoadEntryContext_();
  var positions = [];
  try {
    positions = fsRunQuery_('', {
      from: [{ collectionId: 'portfolio' }],
      where: { fieldFilter: { field: { fieldPath: 'userId' }, op: 'EQUAL', value: { stringValue: ownerUid } } },
      limit: 500,
    }).map(function (p) { return { id: String(p._name).split('/').pop(), symbol: p.symbol, shares: Number(p.shares) || 0, avgCost: Number(p.avgCost) || 0, currency: p.currency || 'TWD', lots: p.lots || [] }; });
  } catch (err) { console.warn('importLoadContext_ portfolio', err); }
  // 預設交割帳戶：投資現金帳戶優先，其次銀行
  var tradeAcc = ctx.accounts.filter(function (a) { return a.type === 'investment_cash'; })[0]
    || ctx.accounts.filter(function (a) { return IMPORT_TRADE_ACCOUNT_TYPES_.indexOf(a.type) >= 0; })[0];
  return { categories: ctx.categories, accounts: ctx.accounts, paymentMethods: ctx.paymentMethods || [], positions: positions, defaultTradeAccountId: tradeAcc ? tradeAcc.id : null };
}

/** 帳戶餘額調整（與 web applyAccountAdjustments 同一條規則；非 transaction，單人使用可接受） */
function importAdjustAccount_(accountId, currency, deltaNative, deltaTWD) {
  if (!accountId) return;
  var acc = fsGetDoc_('accounts/' + accountId);
  if (!acc) return;
  var accCurrency = acc.currency || 'TWD';
  var isDebt = acc.type === 'credit_card' || acc.type === 'loan';
  // 負債帳戶：支出讓欠款變多 → balance 往正的方向走（與 web signedAccountDelta 一致）
  var sign = isDebt ? -1 : 1;
  var delta;
  if (accCurrency === currency) delta = deltaNative;
  else if (accCurrency === 'TWD') delta = deltaTWD;
  else { var r = importFxRate_(accCurrency) || 1; delta = deltaTWD / r; }
  var balance = (Number(acc.balance) || 0) + sign * delta;
  var rate = accCurrency === 'TWD' ? 1 : (importFxRate_(accCurrency) || 1);
  fsSetDoc_('accounts/' + accountId, { balance: balance, balanceTWD: balance * rate, balanceUpdatedAt: new Date(), updatedAt: new Date() }, true);
}

/** 寫入已選的列。回傳 results[{ id, outcome: 'created'|'skipped'|'failed', message }] */
function importApply_(rows, ownerUid) {
  var results = [];
  rows.forEach(function (row) {
    if (row.status === 'error' || row.excluded) return;
    try {
      if (row.kind === 'trade') results.push(importApplyTrade_(row, ownerUid));
      else results.push(importApplyLedger_(row, ownerUid));
    } catch (err) {
      console.error('importApply_', row.id, err);
      results.push({ id: row.id, outcome: 'failed', message: String(err && err.message || err).slice(0, 80) });
    }
  });
  return results;
}

function importApplyLedger_(row, ownerUid) {
  var r = row.resolved;
  if (fsGetDoc_('transactions/' + row.id)) return { id: row.id, outcome: 'skipped', message: '已匯入過（相同內容）' };
  var now = new Date();
  var doc = {
    userId: ownerUid, type: r.kind, amount: r.amount, currency: r.currency, amountTWD: r.amountTWD, fxRate: r.fxRate,
    category: r.categoryKey, paymentMethod: r.paymentMethod,
    fromAccountId: r.kind === 'expense' ? r.accountId : null,
    toAccountId: r.kind === 'income' ? r.accountId : null,
    note: r.note || null, date: importDateTW_(r.date), createdAt: now, updatedAt: now, deletedAt: null,
    tripId: r.tripId || null, tags: ['ai-import'].concat(r.tags || []).slice(0, 10), recurringId: null, scope: null,
    splitMode: null, counterpartyName: null, myShareTWD: null, loanSettledAt: null,
    settledAmountTWD: null, settledFxRate: null, settledAt: null,
    // r.tripId / r.source 只有 MCP 寫入（HubWriteTools.gs）會帶；Telegram 匯入維持原本的值
    importSourceId: r.sourceId ? 'ai:' + r.sourceId : row.id, source: r.source || 'telegram-import',
  };
  fsSetDoc_('transactions/' + row.id, doc, false);
  if (r.accountId) {
    var sign = r.kind === 'expense' ? -1 : 1;
    importAdjustAccount_(r.accountId, r.currency, sign * r.amount, sign * r.amountTWD);
  }
  return { id: row.id, outcome: 'created' };
}

function importApplyTrade_(row, ownerUid) {
  var r = row.resolved;
  if (!r.accountId) return { id: row.id, outcome: 'failed', message: '沒有交割帳戶' };
  var gross = r.shares * r.price;
  var cashNative = r.side === 'buy' ? gross + r.fee : gross - r.fee;
  var cashTWD = cashNative * r.fxRate;
  var tradeDate = importDateTW_(r.date);
  var lot = { date: tradeDate, shares: r.side === 'buy' ? r.shares : -r.shares, price: r.price };
  var position = r.positionId ? fsGetDoc_('portfolio/' + r.positionId) : null;

  if (r.side === 'buy') {
    if (position) {
      var total = Number(position.shares || 0) + r.shares;
      var avg = total > 0 ? ((Number(position.avgCost || 0) * Number(position.shares || 0)) + cashNative) / total : r.price;
      fsSetDoc_('portfolio/' + r.positionId, { shares: total, avgCost: avg, lots: (position.lots || []).concat([lot]) }, true);
    } else {
      fsAddDoc_('portfolio', { userId: ownerUid, symbol: r.symbol, shares: r.shares, avgCost: cashNative / r.shares, currency: r.currency, lots: [lot] });
      try { refreshSymbol(r.symbol); } catch (err) { console.warn('importApplyTrade_ refreshSymbol', err); }
    }
  } else {
    if (!position) return { id: row.id, outcome: 'failed', message: '找不到可賣出的持倉' };
    var held = Number(position.shares || 0);
    if (r.shares > held) return { id: row.id, outcome: 'failed', message: '賣出股數超過持有股數' };
    // TODO(owner): 尚未支援 users/{uid}.preferences.costBasisMethod = 'fifo'（前端 cost-basis.ts），此處固定平均成本
    var avgCost = Number(position.avgCost || 0);
    var costTWD = avgCost * r.shares * r.fxRate;
    fsAddDoc_('realized_lots', {
      symbol: r.symbol, market: r.market, sellDate: tradeDate, shares: r.shares, avgCost: avgCost, sellPrice: r.price,
      currency: r.currency, fxRate: r.fxRate, costTWD: costTWD, proceedsTWD: cashTWD, realizedPnlTWD: cashTWD - costTWD,
      note: r.note || null, createdAt: new Date(),
    });
    var remaining = held - r.shares;
    if (remaining <= 0) fsDeleteDoc_('portfolio/' + r.positionId);
    else fsSetDoc_('portfolio/' + r.positionId, { shares: remaining, lots: (position.lots || []).concat([lot]) }, true);
  }
  var sign = r.side === 'buy' ? -1 : 1;
  importAdjustAccount_(r.accountId, r.currency, sign * cashNative, sign * cashTWD);
  return { id: row.id, outcome: 'created' };
}

/** 單列一行摘要（Telegram 預覽用） */
function importRowSummary_(row) {
  var r = row.resolved;
  var mark = row.excluded ? '○ ' : row.status === 'error' ? '✗ ' : row.status === 'warn' ? '△ ' : '• ';
  var line;
  if (row.kind === 'trade') {
    line = mark + r.date + ' ' + (r.side === 'buy' ? '買' : '賣') + ' ' + r.symbol + ' ' + r.shares + ' 股 @ ' + r.price + ' ' + r.currency
      + (r.fee ? '（費用 ' + r.fee + '）' : '') + (r.accountName ? ' → ' + r.accountName : '');
  } else {
    var amt = r.currency === 'TWD' ? 'NT$' + Math.round(r.amount).toLocaleString() : r.currency + ' ' + r.amount + '（≈NT$' + Math.round(r.amountTWD).toLocaleString() + '）';
    var pay = r.paymentMethod || '';
    if (r.accountName && r.accountName !== pay) pay += '（' + r.accountName + '）';
    line = mark + r.date + ' ' + (r.kind === 'income' ? '+' : '-') + amt + ' ' + r.categoryName + (r.note ? ' · ' + r.note : '') + (pay ? ' · ' + pay : '');
  }
  if (row.excluded) line += '（已排除）';
  if (row.messages.length) line += '\n    ' + row.messages.join('；');
  return line;
}
