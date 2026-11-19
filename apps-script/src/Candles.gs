/**
 * Candles — daily OHLC + FX historical rates
 *
 * Sources:
 *   TW stocks : TWSE  /exchangeReport/STOCK_DAY?response=json&date=YYYYMMDD&stockNo=2330
 *               (一次回該月所有日 K)
 *   US stocks : Yahoo Finance /v8/finance/chart/{SYM}?range=1y&interval=1d
 *               (unofficial, 穩定且免費；若 Yahoo 改動需要換源)
 *   FX pairs  : currency-api CDN historical JSON (supports TWD, no key)
 *
 * Firestore schema:
 *   stocks/{sym}/candles/{YYYYMMDD}  { date, open, high, low, close, volume, source }
 *   fx_rates/{pair}/candles/{YYYYMMDD}  { date, rate, source }
 */

var TW_TZ = 'Asia/Taipei';

// ---------- TW stocks ----------

function backfillTwCandles_(symbol, months) {
  months = months || 12;
  var now = new Date();
  var total = 0;
  for (var i = 0; i < months; i++) {
    // 取第 i 個月前的 1 號
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var yyyymmdd = Utilities.formatDate(d, TW_TZ, 'yyyyMMdd');
    try {
      total += fetchTwMonth_(symbol, yyyymmdd);
      Utilities.sleep(300); // TWSE rate limit friendly
    } catch (err) {
      console.warn('backfillTwCandles_ month failed', symbol, yyyymmdd, err);
    }
  }
  if (total < 25) {
    try {
      total += backfillTwYahooCandles_(symbol, '6mo');
    } catch (err) {
      console.warn('backfillTwCandles_ yahoo fallback failed', symbol, err);
    }
  }
  return total;
}

function backfillTwYahooCandles_(symbol, range) {
  range = range || '6mo';
  var tickers = [symbol + '.TW', symbol + '.TWO'];
  for (var i = 0; i < tickers.length; i++) {
    var wrote = fetchYahooDailyCandles_(tickers[i], symbol, range, TW_TZ, 'yahoo-tw');
    if (wrote > 0) return wrote;
    Utilities.sleep(150);
  }
  return 0;
}

function fetchYahooDailyCandles_(ticker, storageSymbol, range, timezone, source) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker)
    + '?range=' + encodeURIComponent(range || '1y') + '&interval=1d';
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)',
      'Accept': 'application/json, */*',
    },
  });
  if (resp.getResponseCode() !== 200) {
    if (resp.getResponseCode() !== 404) {
      console.warn('Yahoo daily chart', ticker, resp.getResponseCode(), resp.getContentText().slice(0, 200));
    }
    return 0;
  }
  var json;
  try { json = JSON.parse(resp.getContentText()); }
  catch (err) {
    console.warn('Yahoo daily chart parse', ticker, err);
    return 0;
  }
  var result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) return 0;
  var ts = result.timestamp || [];
  var q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  var opens = q.open || [];
  var highs = q.high || [];
  var lows = q.low || [];
  var closes = q.close || [];
  var vols = q.volume || [];

  var writes = [];
  for (var i = 0; i < ts.length; i++) {
    var close = closes[i];
    if (close === null || close === undefined) continue;
    var d = new Date(ts[i] * 1000);
    var docId = Utilities.formatDate(d, timezone, 'yyyyMMdd');
    writes.push({
      update: {
        name: fsDocPath_('stocks/' + storageSymbol + '/candles/' + docId),
        fields: encodeFields_({
          date: Utilities.formatDate(d, timezone, 'yyyy-MM-dd'),
          open: opens[i] || close,
          high: highs[i] || close,
          low: lows[i] || close,
          close: close,
          volume: vols[i] || 0,
          source: source,
          updatedAt: new Date(),
        }),
      },
    });
  }
  if (writes.length > 0) {
    for (var j = 0; j < writes.length; j += 450) {
      fsBatchWrite_(writes.slice(j, j + 450));
    }
  }
  return writes.length;
}

function fetchTwMonth_(symbol, yyyymmdd) {
  var url = 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY'
    + '?response=json&date=' + yyyymmdd + '&stockNo=' + encodeURIComponent(symbol);
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)',
      'Accept': 'application/json, text/plain, */*',
    },
  });
  if (resp.getResponseCode() !== 200) {
    console.warn('TWSE STOCK_DAY', resp.getResponseCode(), resp.getContentText().slice(0, 200));
    return 0;
  }
  var json;
  try { json = JSON.parse(resp.getContentText()); }
  catch (_e) { return 0; }
  if (json.stat !== 'OK' || !Array.isArray(json.data)) return 0;

  var writes = [];
  json.data.forEach(function (row) {
    // row: [日期(民國yyy/mm/dd), 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌, 成交筆數]
    var d = parseRocDate_(row[0]);
    if (!d) return;
    var docId = Utilities.formatDate(d, TW_TZ, 'yyyyMMdd');
    var parseNum = function (s) {
      if (s === null || s === undefined) return 0;
      var n = parseFloat(String(s).replace(/,/g, ''));
      return isNaN(n) ? 0 : n;
    };
    var volume = parseNum(row[1]); // 股數
    var open = parseNum(row[3]);
    var high = parseNum(row[4]);
    var low = parseNum(row[5]);
    var close = parseNum(row[6]);
    if (!close) return;
    writes.push({
      update: {
        name: fsDocPath_('stocks/' + symbol + '/candles/' + docId),
        fields: encodeFields_({
          date: Utilities.formatDate(d, TW_TZ, 'yyyy-MM-dd'),
          open: open, high: high, low: low, close: close,
          volume: volume,
          source: 'twse',
          updatedAt: new Date(),
        }),
      },
    });
  });
  if (writes.length > 0) {
    for (var i = 0; i < writes.length; i += 450) {
      fsBatchWrite_(writes.slice(i, i + 450));
    }
  }
  return writes.length;
}

function parseRocDate_(s) {
  // "113/04/23" → Date(2024-04-23)
  var m = String(s || '').split('/');
  if (m.length !== 3) return null;
  var y = parseInt(m[0], 10) + 1911;
  var mo = parseInt(m[1], 10) - 1;
  var d = parseInt(m[2], 10);
  if (!y || isNaN(mo) || !d) return null;
  return new Date(y, mo, d);
}

// ---------- US stocks ----------

function backfillUsCandles_(symbol, range) {
  return fetchYahooDailyCandles_(symbol, symbol, range || '1y', 'America/New_York', 'yahoo');
}

// ---------- FX ----------

function backfillFxCandles_(pair, days) {
  // pair: "USD_TWD"
  days = days || 365;
  var parts = String(pair).split('_');
  if (parts.length !== 2) return 0;
  var base = normalizeCurrencyCode_(parts[0]);
  var quote = normalizeCurrencyCode_(parts[1]);
  if (!base || !quote || base === quote) return 0;

  var now = new Date();
  var dateStrs = [];
  for (var d = days - 1; d >= 0; d--) {
    dateStrs.push(Utilities.formatDate(new Date(now.getTime() - d * 86400000), TW_TZ, 'yyyy-MM-dd'));
  }

  var writes = [];
  for (var i = 0; i < dateStrs.length; i += 25) {
    var chunk = dateStrs.slice(i, i + 25);
    var requests = chunk.map(function (dateStr) {
      return {
        url: currencyApiUrl_(base, dateStr),
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)',
          'Accept': 'application/json, */*',
        },
      };
    });
    var responses = UrlFetchApp.fetchAll(requests);
    responses.forEach(function (resp, idx) {
      if (resp.getResponseCode() !== 200) {
        console.warn('currency-api', pair, chunk[idx], resp.getResponseCode());
        return;
      }
      var rate = null;
      try {
        var rates = parseFawazRates_(resp.getContentText(), base);
        rate = rates[quote];
      } catch (err) {
        console.warn('currency-api parse', pair, chunk[idx], err);
        return;
      }
      if (!rate) return;
      var dateStr = chunk[idx];
      var docId = dateStr.replace(/-/g, '');
      writes.push({
        update: {
          name: fsDocPath_('fx_rates/' + pair + '/candles/' + docId),
          fields: encodeFields_({
            date: dateStr,
            rate: rate,
            source: 'currency-api',
            updatedAt: new Date(),
          }),
        },
      });
    });
    Utilities.sleep(200);
  }

  if (writes.length > 0) {
    for (var j = 0; j < writes.length; j += 450) {
      fsBatchWrite_(writes.slice(j, j + 450));
    }
  }
  return writes.length;
}

function fsDocPath_(relPath) {
  var pid = PROP.getProperty('FIREBASE_PROJECT_ID');
  return 'projects/' + pid + '/databases/(default)/documents/' + relPath;
}

// ---------- Public entrypoints ----------

function backfillCandles(params) {
  // params: { scope: 'tw'|'us'|'fx'|'all', symbol?, pair?, months?, days?, range? }
  params = params || {};
  var scope = params.scope || 'all';
  var out = { ok: true, wrote: {} };

  if (scope === 'tw' || scope === 'all') {
    var twSyms = params.symbol ? [params.symbol] : listStockSymbolsByMarket_('TW');
    twSyms.forEach(function (s) {
      try { out.wrote[s] = backfillTwCandles_(s, params.months || 12); }
      catch (err) { out.wrote[s] = 'error: ' + err; }
    });
  }
  if (scope === 'us' || scope === 'all') {
    var usSyms = params.symbol ? [params.symbol] : listStockSymbolsByMarket_('US');
    usSyms.forEach(function (s) {
      try { out.wrote[s] = backfillUsCandles_(s, params.range || '1y'); Utilities.sleep(300); }
      catch (err) { out.wrote[s] = 'error: ' + err; }
    });
  }
  if (scope === 'fx' || scope === 'all') {
    var pairs;
    if (params.pair) {
      pairs = [params.pair];
    } else {
      pairs = listEnabledFxPairs_().map(function (p) { return p.base + '_' + p.quote; });
    }
    pairs.forEach(function (p) {
      try { out.wrote[p] = backfillFxCandles_(p, params.days || 365); Utilities.sleep(300); }
      catch (err) { out.wrote[p] = 'error: ' + err; }
    });
  }
  return out;
}

function listStockSymbolsByMarket_(market) {
  return listTrackedStockSymbols_(market);
}

/**
 * Daily candle updater — 拉昨天的 K 線。
 * TW 用 STOCK_DAY 拉當月（包含昨日）；US 用 range=5d；FX 拉最近 7 天。
 */
function updateDailyCandles() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) return { ok: false, error: 'lock-busy' };
  try {
    var out = { ok: true, tw: 0, us: 0, fx: 0 };

    listStockSymbolsByMarket_('TW').forEach(function (s) {
      try { out.tw += fetchTwMonth_(s, Utilities.formatDate(new Date(), TW_TZ, 'yyyyMMdd')); Utilities.sleep(250); }
      catch (err) { console.warn('updateDailyCandles tw', s, err); }
    });

    listStockSymbolsByMarket_('US').forEach(function (s) {
      try { out.us += backfillUsCandles_(s, '5d'); Utilities.sleep(300); }
      catch (err) { console.warn('updateDailyCandles us', s, err); }
    });

    listEnabledFxPairs_().forEach(function (pair) {
      var p = pair.base + '_' + pair.quote;
      try { out.fx += backfillFxCandles_(p, 7); Utilities.sleep(300); }
      catch (err) { console.warn('updateDailyCandles fx', p, err); }
    });

    return out;
  } finally {
    lock.releaseLock();
  }
}
