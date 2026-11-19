/**
 * FX rates updater
 * - Primary: open.er-api.com/v6/latest/USD (free, no key)
 * - Tracks: USD/TWD, JPY/TWD, EUR/TWD, IDR/TWD (and whatever else is requested)
 */

var DEFAULT_FX_PAIRS = [
  { base: 'USD', quote: 'TWD' },
  { base: 'JPY', quote: 'TWD' },
  { base: 'EUR', quote: 'TWD' },
  { base: 'GBP', quote: 'TWD' },
  { base: 'CNY', quote: 'TWD' },
];

function normalizeCurrencyCode_(code) {
  return String(code || '').trim().toUpperCase();
}

function fxPairId_(base, quote) {
  var b = normalizeCurrencyCode_(base);
  var q = normalizeCurrencyCode_(quote);
  return b && q ? b + '_' + q : '';
}

function addFxPair_(out, base, quote) {
  var id = fxPairId_(base, quote);
  if (!id) return;
  var parts = id.split('_');
  out[id] = { base: parts[0], quote: parts[1] };
}

/**
 * 回傳所有需要自動更新的幣別：
 * - 預設幣對
 * - 已啟用 fx_pairs
 * - 既有 fx_rates 文件
 * - active FX alerts
 *
 * 原本只要 fx_pairs 有資料就完全取代預設清單，會讓既有/default 匯率停止更新。
 */
function listEnabledFxPairs_() {
  var pairs = {};
  var disabled = {};

  DEFAULT_FX_PAIRS.forEach(function (p) { addFxPair_(pairs, p.base, p.quote); });

  try {
    var docs = fsListDocs_('fx_pairs', 100);
    docs.forEach(function (d) {
      if (!d.base || !d.quote) return;
      var id = fxPairId_(d.base, d.quote);
      if (!id) return;
      if (d.enabled === false) {
        disabled[id] = true;
        delete pairs[id];
        return;
      }
      addFxPair_(pairs, d.base, d.quote);
    });
  } catch (err) {
    console.warn('listEnabledFxPairs_', err);
  }

  try {
    fsListDocs_('fx_rates', 100).forEach(function (d) {
      var idFromName = (d._name || '').split('/').pop();
      var id = fxPairId_(d.base, d.quote) || idFromName;
      if (!id || disabled[id]) return;
      var parts = String(id).split('_');
      if (parts.length === 2) addFxPair_(pairs, parts[0], parts[1]);
    });
  } catch (err2) {
    console.warn('listEnabledFxPairs_ fx_rates', err2);
  }

  try {
    fsListDocs_('alerts', 200).forEach(function (a) {
      if (a.active === false || a.type !== 'fx') return;
      var parts = String(a.target || '').toUpperCase().split('_');
      if (parts.length !== 2) return;
      var id = fxPairId_(parts[0], parts[1]);
      if (!id || disabled[id]) return;
      addFxPair_(pairs, parts[0], parts[1]);
    });
  } catch (err3) {
    console.warn('listEnabledFxPairs_ alerts', err3);
  }

  return Object.keys(pairs)
    .filter(function (id) { return !disabled[id]; })
    .sort()
    .map(function (id) { return pairs[id]; });
}

function normalizeRatesMap_(raw) {
  var out = {};
  Object.keys(raw || {}).forEach(function (k) {
    var code = normalizeCurrencyCode_(k);
    var value = Number(raw[k]);
    if (code && isFinite(value)) out[code] = value;
  });
  out.USD = 1;
  return out;
}

function parseFawazRates_(text, base) {
  var data = JSON.parse(text);
  var key = String(base || '').toLowerCase();
  return normalizeRatesMap_(data && data[key]);
}

function currencyApiUrl_(base, dateStr) {
  var b = String(base || 'usd').toLowerCase();
  var version = dateStr ? '@' + encodeURIComponent(dateStr) : '@latest';
  return 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api' + version
    + '/v1/currencies/' + encodeURIComponent(b) + '.json';
}

function fetchFawazRates_(base, dateStr) {
  var b = String(base || 'usd').toLowerCase();
  var url = currencyApiUrl_(b, dateStr);
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)',
      'Accept': 'application/json, */*',
    },
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('currency-api ' + b + ' ' + (dateStr || 'latest') + ' ' + resp.getResponseCode());
  }
  return parseFawazRates_(resp.getContentText(), b);
}

function fetchUsdRates_() {
  var resp = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/USD', { muteHttpExceptions: true });
  if (resp.getResponseCode() === 200) {
    var primary = JSON.parse(resp.getContentText()).rates;
    if (primary) return { rates: normalizeRatesMap_(primary), source: 'open.er-api' };
  }

  var fb = UrlFetchApp.fetch('https://api.exchangerate-api.com/v4/latest/USD', { muteHttpExceptions: true });
  if (fb.getResponseCode() === 200) {
    var fallback = JSON.parse(fb.getContentText()).rates;
    if (fallback) return { rates: normalizeRatesMap_(fallback), source: 'exchangerate-api' };
  }

  return { rates: fetchFawazRates_('USD'), source: 'currency-api' };
}

function computePairRateFromUsdRates_(rates, base, quote) {
  var b = normalizeCurrencyCode_(base);
  var q = normalizeCurrencyCode_(quote);
  if (!b || !q || !rates[q]) return null;
  if (b === 'USD') return rates[q];
  if (!rates[b]) return null;
  return rates[q] / rates[b];
}

function writeFxCandle_(pair, dateStr, rate, source) {
  if (!pair || !dateStr || !rate) return;
  var docId = dateStr.replace(/-/g, '');
  fsSetDoc_('fx_rates/' + pair + '/candles/' + docId, {
    date: dateStr,
    rate: rate,
    source: source,
    updatedAt: new Date(),
  }, true);
}

function updateFxRates() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { ok: false, error: 'could not acquire lock' };
  }
  try {
    var rateResult = fetchUsdRates_();
    var rates = rateResult.rates;
    if (!rates) throw new Error('FX API sources failed');

    var writes = [];
    var now = new Date();
    var today = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd');
    var pairs = listEnabledFxPairs_();
    pairs.forEach(function (p) {
      var pair = p.base + '_' + p.quote;
      var twdPerBase = computePairRateFromUsdRates_(rates, p.base, p.quote);
      if (!twdPerBase) return;
      var payload = {
        base: p.base,
        quote: p.quote,
        rate: twdPerBase,
        source: rateResult.source,
        updatedAt: now,
      };
      fsSetDoc_('fx_rates/' + pair, payload, true);
      writeFxCandle_(pair, today, twdPerBase, rateResult.source);
      writes.push(pair);
    });

    // Check FX alerts after update
    try { checkAllAlerts(); } catch (err) { console.error('checkAllAlerts post-fx', err); }

    return { ok: true, updated: writes };
  } finally {
    lock.releaseLock();
  }
}
