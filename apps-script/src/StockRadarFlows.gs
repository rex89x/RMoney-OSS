/**
 * StockRadarFlows — 台股籌碼（三大法人買賣超、融資餘額）每日同步，給股市雷達的籌碼因子用。
 *
 * - 來源：TWSE 公開資料 T86（三大法人買賣超日報）、MI_MARGN（融資融券餘額），只有上市股票；上櫃股票因子為空。
 * - 存 stock_radar_flows/{yyyyMMdd}：{ date, inst: { 代號: 外資+投信淨買超股數 }, margin: { 代號: 融資今日餘額(張) } }
 *   全市場都存（約 1,000 檔、數十 KB），追蹤清單改變也不用重抓。
 * - tick_daily_0100 同步（前一交易日資料已公布）；每次最多補 STOCK_FLOWS_MAX_FETCH_ 天，首次回補分幾晚完成，
 *   請求間隔 2.5 秒避免被 TWSE 擋（pitfall #10）。
 * - 欄位用表頭名稱找 index，不寫死欄位順序；解析失敗回 null，因子就留空，不影響價格因子。
 */

var STOCK_FLOWS_LOOKBACK_DAYS_ = 35;
var STOCK_FLOWS_MAX_FETCH_ = 8;
var STOCK_FLOWS_KEEP_DAYS_ = 70;

function srParseTwseNumber_(value) {
  var n = Number(String(value === undefined || value === null ? '' : value).replace(/,/g, '').trim());
  return isFinite(n) ? n : null;
}

function srFieldIndex_(fields, pattern) {
  for (var i = 0; i < fields.length; i++) {
    if (pattern.test(String(fields[i]))) return i;
  }
  return -1;
}

/** T86 → { 代號: 外資(含外資自營商) + 投信 淨買超股數 }；stat 不是 OK（假日、尚未公布）回 null */
function parseTwseT86_(json) {
  if (!json || json.stat !== 'OK' || !Array.isArray(json.fields) || !Array.isArray(json.data)) return null;
  var fields = json.fields;
  var codeIdx = srFieldIndex_(fields, /證券代號/);
  var foreignIdx = srFieldIndex_(fields, /外陸資買賣超股數/);
  var foreignDealerIdx = srFieldIndex_(fields, /外資自營商買賣超股數/);
  var trustIdx = srFieldIndex_(fields, /投信買賣超股數/);
  if (codeIdx < 0 || foreignIdx < 0 || trustIdx < 0) return null;
  var out = {};
  json.data.forEach(function (row) {
    if (!Array.isArray(row)) return;
    var sym = String(row[codeIdx] || '').trim();
    if (!sym) return;
    var foreign = srParseTwseNumber_(row[foreignIdx]);
    var dealer = foreignDealerIdx >= 0 ? srParseTwseNumber_(row[foreignDealerIdx]) : 0;
    var trust = srParseTwseNumber_(row[trustIdx]);
    if (foreign === null || trust === null) return;
    out[sym] = foreign + (dealer || 0) + trust;
  });
  return Object.keys(out).length ? out : null;
}

/**
 * MI_MARGN → { 代號: 融資今日餘額(張) }。新版 rwd 回 tables[]，舊版是 creditFields / creditList；
 * 找同時有「代號」與「今日餘額」的表，第一個「今日餘額」是融資、第二個是融券。
 */
function parseTwseMargin_(json) {
  if (!json || json.stat !== 'OK') return null;
  var tables = [];
  if (Array.isArray(json.tables)) tables = tables.concat(json.tables);
  if (Array.isArray(json.fields)) tables.push({ fields: json.fields, data: json.data });
  if (Array.isArray(json.creditFields)) tables.push({ fields: json.creditFields, data: json.creditList });
  for (var t = 0; t < tables.length; t++) {
    var table = tables[t] || {};
    var fields = Array.isArray(table.fields) ? table.fields : [];
    var codeIdx = srFieldIndex_(fields, /代號/);
    var balanceIdx = srFieldIndex_(fields, /今日餘額/);
    if (codeIdx < 0 || balanceIdx < 0 || !Array.isArray(table.data)) continue;
    var out = {};
    table.data.forEach(function (row) {
      if (!Array.isArray(row)) return;
      var sym = String(row[codeIdx] || '').trim();
      var balance = srParseTwseNumber_(row[balanceIdx]);
      if (sym && balance !== null) out[sym] = balance;
    });
    if (Object.keys(out).length) return out;
  }
  return null;
}

function srFetchTwseJson_(url) {
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)', 'Accept': 'application/json' },
  });
  if (resp.getResponseCode() !== 200) {
    console.warn('TWSE fetch', url, resp.getResponseCode());
    return null;
  }
  try {
    return JSON.parse(resp.getContentText());
  } catch (err) {
    // TWSE 擋請求時會回 HTML
    console.warn('TWSE parse', url, err);
    return null;
  }
}

/** 最近 N 個平日（不含今天），新 → 舊，yyyyMMdd */
function srRecentWeekdays_(days) {
  var out = [];
  for (var i = 1; i <= days; i++) {
    var d = new Date(Date.now() - i * 86400000);
    var dow = Number(Utilities.formatDate(d, TW_TZ, 'u')); // 1 = 週一 … 7 = 週日
    if (dow >= 6) continue;
    out.push(Utilities.formatDate(d, TW_TZ, 'yyyyMMdd'));
  }
  return out;
}

function syncStockRadarFlows() {
  var fetched = 0;
  var written = 0;
  var errors = [];
  srRecentWeekdays_(STOCK_FLOWS_LOOKBACK_DAYS_).forEach(function (ymd) {
    if (fetched >= STOCK_FLOWS_MAX_FETCH_) return;
    var existing = null;
    try { existing = fsGetDoc_('stock_radar_flows/' + ymd); } catch (err) { console.warn('flows get', ymd, err); }
    if (existing) return;
    fetched++;
    var t86 = srFetchTwseJson_('https://www.twse.com.tw/rwd/zh/fund/T86?date=' + ymd + '&selectType=ALLBUT0999&response=json');
    Utilities.sleep(2500);
    if (!t86) {
      errors.push(ymd + ': T86 fetch failed');
      return;
    }
    var date = ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8);
    if (t86.stat !== 'OK') {
      // stat 不是 OK：國定假日或休市，記下來避免每晚重抓
      fsSetDoc_('stock_radar_flows/' + ymd, { date: date, noData: true, fetchedAt: new Date() }, false);
      written++;
      return;
    }
    var inst = parseTwseT86_(t86);
    if (!inst) {
      // stat OK 但欄位對不上：TWSE 改格式了，不要標成休市，留給下次重試並回報
      errors.push(ymd + ': T86 format changed');
      return;
    }
    var margin = parseTwseMargin_(
      srFetchTwseJson_('https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=' + ymd + '&selectType=ALL&response=json'));
    Utilities.sleep(2500);
    if (!margin) errors.push(ymd + ': MI_MARGN unavailable');
    fsSetDoc_('stock_radar_flows/' + ymd, {
      date: date,
      inst: inst,
      margin: margin || {},
      fetchedAt: new Date(),
    }, false);
    written++;
  });

  var expired = Utilities.formatDate(new Date(Date.now() - STOCK_FLOWS_KEEP_DAYS_ * 86400000), TW_TZ, 'yyyyMMdd');
  try { fsDeleteDoc_('stock_radar_flows/' + expired); } catch (err) { console.warn('flows cleanup', expired, err); }
  if (errors.length) console.warn('syncStockRadarFlows', errors);
  return { ok: true, fetched: fetched, written: written, errors: errors };
}

/** 給評估用：最近的籌碼日資料（升冪、排除休市日） */
function loadStockRadarFlowDocs_() {
  var docs = [];
  srRecentWeekdays_(STOCK_FLOWS_LOOKBACK_DAYS_).forEach(function (ymd) {
    try {
      var doc = fsGetDoc_('stock_radar_flows/' + ymd);
      if (doc && doc.inst && !doc.noData) docs.push(doc);
    } catch (err) {
      console.warn('flows load', ymd, err);
    }
  });
  return docs.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
}
