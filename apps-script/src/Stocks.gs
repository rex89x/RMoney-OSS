/**
 * Stock price updater
 * - TW: TWSE MIS API (batch, free)
 * - US: Finnhub /quote (60 calls/min limit)
 */

/**
 * 台股代號規則（與前端 apps/web/src/features/investments/symbol-utils.ts 同步）：
 * 4–6 位數字 + 0–2 碼英文字尾 —— 2330、0050、00878、006208、00981A（主動式 ETF）、00679B（債券 ETF）、
 * 2881A（特別股）、00632R（反向 ETF）。以前只認「剛好 4 位數字」，其他都被當成美股去 Finnhub 抓價。
 * ETF（00 開頭）字尾 K / C / M / S / V 是外幣交易，報價不是台幣 → 幣別記 USD。
 */
var TW_SYMBOL_RE_ = /^\d{4,6}[A-Z]{0,2}$/;

function isTwSymbol_(symbol) {
  return TW_SYMBOL_RE_.test(String(symbol || ''));
}

function twSymbolCurrency_(symbol) {
  var m = /^(\d{4,6})([A-Z]{0,2})$/.exec(String(symbol || ''));
  if (!m) return 'TWD';
  var last = m[2].slice(-1);
  if (last && m[1].indexOf('00') === 0 && 'KCMSV'.indexOf(last) >= 0) return 'USD';
  return 'TWD';
}

function normalizeStockSymbol_(s) {
  if (!s) return '';
  return String(s).trim().toUpperCase().replace(/\s+/g, '').replace(/\.(TW|TWO|US)$/, '').replace(/-(KY|DR)$/, '');
}

function inferStockMarket_(symbol, stockDoc) {
  // 數字開頭一定是台股（美股代號都是英文字母開頭）；舊版可能把 00878 這類寫成 US，這裡以代號為準
  if (isTwSymbol_(symbol)) return 'TW';
  if (stockDoc && (stockDoc.market === 'TW' || stockDoc.market === 'US')) {
    return stockDoc.market;
  }
  return 'US';
}

function addTrackedStock_(out, symbol, market) {
  var sym = normalizeStockSymbol_(symbol);
  if (!sym) return;
  if (!out[sym]) {
    out[sym] = { symbol: sym, market: market || inferStockMarket_(sym) };
    return;
  }
  if (!out[sym].market && market) out[sym].market = market;
}

/**
 * 回傳所有需要自動更新的股票：
 * - 既有 stocks seed/doc
 * - watchlist
 * - portfolio positions
 * - 共同投資帳持股（households/{hid}/investment_holdings）
 * - active stock alerts
 *
 * 原本只要 watchlist 有資料就不讀 stocks，會讓 seed / 既有股票停止更新。
 */
function listTrackedStockSymbols_(market) {
  var tracked = {};

  try {
    fsListAllDocs_('stocks', 500).forEach(function (s) {
      var docId = (s._name || '').split('/').pop();
      var sym = s.symbol || docId;
      addTrackedStock_(tracked, sym, inferStockMarket_(normalizeStockSymbol_(sym), s));
    });
  } catch (err) {
    console.warn('listTrackedStockSymbols_ stocks', err);
  }

  try {
    fsListAllDocs_('watchlist', 500).forEach(function (w) {
      addTrackedStock_(tracked, w.symbol);
    });
  } catch (err) {
    console.warn('listTrackedStockSymbols_ watchlist', err);
  }

  try {
    fsListAllDocs_('portfolio', 500).forEach(function (p) {
      var sym = normalizeStockSymbol_(p.symbol);
      if (!sym) return;
      // 外幣交易的台股 ETF（K 字尾等）持倉幣別是 USD，但仍是台股，先看代號
      var inferredMarket = isTwSymbol_(sym) ? 'TW' : (p.currency === 'USD' ? 'US' : inferStockMarket_(sym));
      addTrackedStock_(tracked, sym, inferredMarket);
    });
  } catch (err) {
    console.warn('listTrackedStockSymbols_ portfolio', err);
  }

  // 共同投資帳（含伴侶自己的持股）
  listHouseholdHoldingSymbols_().forEach(function (h) {
    var sym = normalizeStockSymbol_(h.symbol);
    if (sym) addTrackedStock_(tracked, sym, h.market || inferStockMarket_(sym));
  });

  try {
    fsListAllDocs_('alerts', 500).forEach(function (a) {
      if (a.active === false || a.type !== 'stock') return;
      addTrackedStock_(tracked, a.target);
    });
  } catch (err) {
    console.warn('listTrackedStockSymbols_ alerts', err);
  }

  return Object.keys(tracked)
    .filter(function (sym) {
      if (!market) return true;
      return (tracked[sym].market || inferStockMarket_(sym)) === market;
    })
    .sort();
}

function updateStockPrices() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { ok: false, error: 'could not acquire lock' };
  }
  try {
    var symbols = listTrackedStockSymbols_();

    var tw = [];
    var us = [];
    symbols.forEach(function (sym) {
      var stockDoc = fsGetDoc_('stocks/' + sym);
      var market = inferStockMarket_(sym, stockDoc);
      (market === 'TW' ? tw : us).push(sym);
    });

    var got = {};
    var twCount = 0;
    var usCount = 0;
    var twError = null;
    var usError = null;
    if (tw.length > 0) {
      try { twCount = updateTwStocks_(tw, got); }
      catch (err) { twError = String(err && err.message || err); }
    }
    if (us.length > 0) {
      try { usCount = updateUsStocks_(us, got); }
      catch (err) { usError = String(err && err.message || err); }
    }
    var failed = symbols.filter(function (s) { return !got[s]; });

    try { checkAllAlerts(); } catch (err) { console.error('checkAllAlerts post-update', err); }

    return {
      ok: true,
      updated: twCount + usCount,
      total: symbols.length,
      twCount: twCount,
      usCount: usCount,
      failed: failed,
      twError: twError,
      usError: usError,
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 重抓單一 symbol — 比 updateStockPrices 細，回單一 symbol 的成敗 + 錯誤原因，
 * 用於前端 watchlist 列「重抓」按鈕。
 */
function refreshSymbol(symbol) {
  if (!symbol) return { ok: false, error: 'symbol-required' };
  var sym = normalizeStockSymbol_(symbol);
  if (!sym) return { ok: false, error: 'invalid-symbol' };
  var stockDoc = fsGetDoc_('stocks/' + sym);
  var market = inferStockMarket_(sym, stockDoc);
  var got = {};
  var err = null;
  try {
    if (market === 'TW') updateTwStocks_([sym], got);
    else updateUsStocks_([sym], got);
  } catch (e) {
    err = String(e && e.message || e);
  }
  return {
    ok: !!got[sym],
    symbol: sym,
    market: market,
    error: got[sym] ? null : (err || 'price-source-returned-no-data'),
  };
}

function updateTwStocks_(symbols, gotOut) {
  if (!symbols || symbols.length === 0) return 0;

  // 三層 fallback：
  //   1) Yahoo Finance v7 quote — 即時、含盤中變化
  //   2) TWSE MIS API (tse_/otc_ 同時) — 含上市/上櫃即時，需 session cookie
  //   3) TWSE STOCK_DAY 月資料 — 取當月最後一根日 K（穩定，不需 cookie），延遲到收盤
  var got = gotOut || {};
  var count = 0;
  try {
    count += updateTwViaYahoo_(symbols, got);
  } catch (yErr) {
    console.warn('Yahoo TW primary failed', yErr);
  }
  var missing = symbols.filter(function (s) { return !got[s]; });
  if (missing.length > 0) {
    try {
      count += updateTwViaTwse_(missing, got);
    } catch (tErr) {
      console.warn('TWSE MIS fallback failed', tErr);
    }
  }
  missing = symbols.filter(function (s) { return !got[s]; });
  if (missing.length > 0) {
    try {
      count += updateTwViaStockDay_(missing, got);
    } catch (sErr) {
      console.warn('TWSE STOCK_DAY fallback failed', sErr);
    }
  }
  missing = symbols.filter(function (s) { return !got[s]; });
  if (missing.length > 0) {
    console.warn('TW stocks unfetched after all sources: ' + missing.join(','));
  }
  return count;
}

/**
 * 第三層 fallback：用 TWSE STOCK_DAY 端點（日 K JSON），抓當月最後一根 K
 * 寫進 stocks/{sym}。比 MIS 慢但不需 session，穩定性最佳。
 */
function updateTwViaStockDay_(symbols, gotOut) {
  var count = 0;
  var now = new Date();
  var ymd = Utilities.formatDate(now, 'Asia/Taipei', 'yyyyMMdd');
  symbols.forEach(function (sym) {
    try {
      var url = 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY'
        + '?response=json&date=' + ymd + '&stockNo=' + encodeURIComponent(sym);
      var resp = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true, followRedirects: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)',
          'Accept': 'application/json, text/plain, */*',
        },
      });
      if (resp.getResponseCode() !== 200) return;
      var json;
      try { json = JSON.parse(resp.getContentText()); } catch (_) { return; }
      if (json.stat !== 'OK' || !Array.isArray(json.data) || json.data.length === 0) return;
      // 取最後一筆（當月最近交易日）
      var last = json.data[json.data.length - 1];
      var prev = json.data.length >= 2 ? json.data[json.data.length - 2] : last;
      var parseNum = function (s) {
        if (s === null || s === undefined) return 0;
        var n = parseFloat(String(s).replace(/,/g, ''));
        return isNaN(n) ? 0 : n;
      };
      var open = parseNum(last[3]);
      var high = parseNum(last[4]);
      var low = parseNum(last[5]);
      var close = parseNum(last[6]);
      var prevClose = parseNum(prev[6]) || close;
      if (!close) return;
      fsSetDoc_('stocks/' + sym, {
        symbol: sym, market: 'TW', name: sym, currency: twSymbolCurrency_(sym),
        currentPrice: close, prevClose: prevClose,
        change: close - prevClose,
        changePercent: prevClose ? (close - prevClose) / prevClose * 100 : 0,
        high: high || close, low: low || close, open: open || close,
        volume: parseNum(last[1]),
        updatedAt: now,
      }, true);
      if (gotOut) gotOut[sym] = true;
      count++;
      Utilities.sleep(300); // 防止對 TWSE 連發
    } catch (err) {
      console.warn('STOCK_DAY ' + sym, err);
    }
  });
  return count;
}

function updateTwViaYahoo_(symbols, gotOut) {
  // Yahoo v7 quote endpoint 已被 401 deprecate。改用 v8 chart endpoint
  //   /v8/finance/chart/{symbol}?interval=1d&range=5d
  // chart 端點需單筆 fetch（不能 batch），但回傳含 meta.regularMarketPrice 等所有需要欄位。
  // 上市先試 .TW，沒抓到再試 .TWO（上櫃）。
  var count = 0;
  symbols.forEach(function (sym) {
    var quote = fetchYahooChart_(sym + '.TW');
    if (!quote || quote.regularMarketPrice == null) {
      Utilities.sleep(150);
      quote = fetchYahooChart_(sym + '.TWO');
    }
    if (!quote || quote.regularMarketPrice == null) {
      Utilities.sleep(150);
      return;
    }
    var price = quote.regularMarketPrice;
    var prev = quote.previousClose != null ? quote.previousClose : (quote.chartPreviousClose != null ? quote.chartPreviousClose : price);
    fsSetDoc_('stocks/' + sym, {
      symbol: sym, market: 'TW', name: sym, currency: twSymbolCurrency_(sym),
      currentPrice: price, prevClose: prev,
      change: price - prev,
      changePercent: prev ? (price - prev) / prev * 100 : 0,
      high: quote.regularMarketDayHigh != null ? quote.regularMarketDayHigh : price,
      low: quote.regularMarketDayLow != null ? quote.regularMarketDayLow : price,
      open: quote.regularMarketOpen != null ? quote.regularMarketOpen : price,
      volume: quote.regularMarketVolume || 0,
      updatedAt: new Date(),
    }, true);
    if (gotOut) gotOut[sym] = true;
    count++;
    Utilities.sleep(150); // 對 Yahoo 端友善的速率
  });
  return count;
}

function normalizeTwSymbol_(s) {
  if (!s) return '';
  return normalizeStockSymbol_(s);
}

/**
 * Yahoo v8 chart endpoint — 單筆 quote。回傳 meta 物件或 null。
 *   { regularMarketPrice, previousClose, chartPreviousClose,
 *     regularMarketDayHigh/Low/Open, regularMarketVolume, currency, ... }
 */
function fetchYahooChart_(ticker) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker)
    + '?interval=1d&range=5d&includePrePost=false';
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json, */*',
    },
  });
  var code = resp.getResponseCode();
  if (code !== 200) {
    if (code !== 404) console.warn('Yahoo chart ' + ticker + ' ' + code, resp.getContentText().slice(0, 200));
    return null;
  }
  try {
    var data = JSON.parse(resp.getContentText());
    var result = data && data.chart && data.chart.result && data.chart.result[0];
    return result ? result.meta : null;
  } catch (err) {
    console.warn('Yahoo chart parse', ticker, err);
    return null;
  }
}

function updateTwViaTwse_(symbols, gotOut) {
  var commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Referer': 'https://mis.twse.com.tw/stock/index.jsp',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  };
  var cookie = '';
  try {
    var sessionResp = UrlFetchApp.fetch('https://mis.twse.com.tw/stock/index.jsp', {
      muteHttpExceptions: true, followRedirects: true, headers: commonHeaders,
    });
    var setCookies = sessionResp.getAllHeaders()['Set-Cookie'];
    if (setCookies) {
      if (!Array.isArray(setCookies)) setCookies = [setCookies];
      cookie = setCookies.map(function (c) { return String(c).split(';')[0]; }).join('; ');
    }
  } catch (err) {
    console.warn('TWSE session prefetch failed', err);
  }

  // TWSE MIS API 同時支援 tse_ (上市) 與 otc_ (上櫃) prefix。一次帶兩個 prefix，
  // server 自動回有資料的那個，沒抓到的代號就交給後面的紀錄。
  var query = symbols.map(function (s) {
    return 'tse_' + s + '.tw|otc_' + s + '.tw';
  }).join('|');
  var url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + encodeURIComponent(query)
    + '&json=1&delay=0&_=' + Date.now();
  var apiHeaders = {};
  Object.keys(commonHeaders).forEach(function (k) { apiHeaders[k] = commonHeaders[k]; });
  if (cookie) apiHeaders['Cookie'] = cookie;

  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: apiHeaders });
  if (resp.getResponseCode() !== 200) {
    throw new Error('TWSE ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
  }
  var text = resp.getContentText();
  var data;
  try { data = JSON.parse(text); }
  catch (_e) { throw new Error('TWSE non-JSON response: ' + text.slice(0, 200)); }
  var rows = data.msgArray || [];
  var count = 0;
  rows.forEach(function (r) {
    var sym = r.c;
    if (!sym) return;
    // 同代號可能 tse + otc 兩列都回（同名異市場）— 以第一筆為準避免覆蓋
    if (gotOut && gotOut[sym]) return;
    var price = parseFloat(r.z) || parseFloat(r.y) || 0;
    var prev = parseFloat(r.y) || price;
    var change = price - prev;
    var pct = prev ? (change / prev) * 100 : 0;
    fsSetDoc_('stocks/' + sym, {
      symbol: sym, market: 'TW', name: r.n || sym, currency: twSymbolCurrency_(sym),
      currentPrice: price, prevClose: prev, change: change, changePercent: pct,
      high: parseFloat(r.h) || price, low: parseFloat(r.l) || price, open: parseFloat(r.o) || price,
      volume: parseInt(r.v, 10) || 0, updatedAt: new Date(),
    }, true);
    if (gotOut) gotOut[sym] = true;
    count++;
  });
  return count;
}

function updateUsStocks_(symbols, gotOut) {
  // 主源 Finnhub（有 key），副源 Yahoo v8 chart（沒 key 也行）。
  var key = PROP.getProperty('FINNHUB_API_KEY');
  var now = new Date();
  var count = 0;
  symbols.forEach(function (sym) {
    var done = false;
    if (key) {
      try {
        var url = 'https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym)
          + '&token=' + encodeURIComponent(key);
        var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        if (resp.getResponseCode() === 200) {
          var q = JSON.parse(resp.getContentText());
          if (q && q.c !== undefined && q.c !== 0) {
            fsSetDoc_('stocks/' + sym, {
              symbol: sym, market: 'US', name: sym, currency: 'USD',
              currentPrice: q.c, prevClose: q.pc,
              change: q.d, changePercent: q.dp,
              high: q.h, low: q.l, open: q.o,
              volume: q.v || 0, updatedAt: now,
            }, true);
            if (gotOut) gotOut[sym] = true;
            count++;
            done = true;
          }
        }
        Utilities.sleep(1100);
      } catch (err) {
        console.error('finnhub failed', sym, err);
      }
    }
    if (!done) {
      // Fallback: Yahoo v8 chart
      var meta = fetchYahooChart_(sym);
      if (meta && meta.regularMarketPrice != null) {
        var price = meta.regularMarketPrice;
        var prev = meta.previousClose != null ? meta.previousClose : (meta.chartPreviousClose != null ? meta.chartPreviousClose : price);
        fsSetDoc_('stocks/' + sym, {
          symbol: sym, market: 'US', name: sym, currency: 'USD',
          currentPrice: price, prevClose: prev,
          change: price - prev,
          changePercent: prev ? (price - prev) / prev * 100 : 0,
          high: meta.regularMarketDayHigh != null ? meta.regularMarketDayHigh : price,
          low: meta.regularMarketDayLow != null ? meta.regularMarketDayLow : price,
          open: meta.regularMarketOpen != null ? meta.regularMarketOpen : price,
          volume: meta.regularMarketVolume || 0,
          updatedAt: now,
        }, true);
        if (gotOut) gotOut[sym] = true;
        count++;
      }
      Utilities.sleep(150);
    }
  });
  return count;
}

/**
 * Append a history snapshot for each stock (called hourly / during market hours)
 */
function appendStockHistorySnapshot() {
  var stocks = fsListAllDocs_('stocks', 200);
  var writes = [];
  var now = new Date();
  var tsKey = Utilities.formatDate(now, 'UTC', 'yyyyMMddHHmmss');
  stocks.forEach(function (s) {
    if (!s.symbol || !s.currentPrice) return;
    var pid = PROP.getProperty('FIREBASE_PROJECT_ID');
    writes.push({
      update: {
        name: 'projects/' + pid + '/databases/(default)/documents/stocks/' + s.symbol + '/history/' + tsKey,
        fields: encodeFields_({
          price: s.currentPrice,
          volume: s.volume || 0,
          timestamp: now,
        }),
      },
    });
  });
  if (writes.length > 0) {
    // batchWrite limit 500
    for (var i = 0; i < writes.length; i += 450) {
      fsBatchWrite_(writes.slice(i, i + 450));
    }
  }
  return { ok: true, snapshots: writes.length };
}
