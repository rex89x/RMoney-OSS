/**
 * 除權息預告（台股）+ 報稅季提醒
 *
 * updateDividendCalendar()
 *   來源：TWSE TWT48U（上市除權除息預告）rwd JSON → openapi fallback；TPEx openapi（上櫃）。
 *   只處理 portfolio / watchlist 追蹤的 TW 代號，結果 merge 到 stocks/{symbol}.upcomingDividend：
 *     { exDate: 'yyyy-MM-dd', cashPerShare, stockPerShare, kind: 'cash'|'stock'|'both', source, updatedAt }
 *   不開新 collection（rules 不用改）。除息日已過的舊資料由前端過濾、下次更新時清掉。
 *
 * notifyDividendCalendar()
 *   持倉標的 7 天內除息 → 推播（key: dividendCalendar）。
 *
 * notifyTaxSeason()
 *   4/1、5/1 推播去年股利 / 海外所得整理（key: taxSeason）。
 */

var TW_DIVIDEND_HEADERS_ = {
  code: /股票代號|代號|^Code$|StockCode|SecuritiesCompanyCode/i,
  name: /名稱|Name/i,
  exDate: /除權息日期|除權息交易日|除息交易日|除權交易日|ExDate|ExDividend|ExRight|Date$/i,
  kind: /除權息$|權\/息|權息別|Type/i,
  cash: /息值|現金股利|CashDividend|Cash/i,
  stock: /^權值|股票股利|StockDividend/i,
};

function findHeaderIndex_(fields, re) {
  for (var i = 0; i < fields.length; i++) if (re.test(String(fields[i]))) return i;
  return -1;
}

function parseTwDate_(s) {
  var t = String(s || '').trim();
  var m = t.match(/^(\d{2,3})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m && m[1].length === 3) {
    return { y: parseInt(m[1], 10) + 1911, m: parseInt(m[2], 10), d: parseInt(m[3], 10) };
  }
  m = t.match(/^(\d{4})[\/\-]?(\d{2})[\/\-]?(\d{2})/);
  if (m) return { y: parseInt(m[1], 10), m: parseInt(m[2], 10), d: parseInt(m[3], 10) };
  m = t.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (m) return { y: parseInt(m[1], 10) + 1911, m: parseInt(m[2], 10), d: parseInt(m[3], 10) };
  return null;
}

function dateKeyFromParts_(p) {
  if (!p) return null;
  return p.y + '-' + ('0' + p.m).slice(-2) + '-' + ('0' + p.d).slice(-2);
}

function numOrZero_(v) {
  var n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

/** 把 {fields, data} 或 [obj] 兩種形狀統一成 [{code, name, exDate, cash, stock, kind}] */
function normalizeDividendRows_(payload, source) {
  var rows = [];
  var fields = null;
  var data = null;
  if (payload && Array.isArray(payload.fields) && Array.isArray(payload.data)) {
    fields = payload.fields.map(String);
    data = payload.data;
  } else if (Array.isArray(payload) && payload.length && typeof payload[0] === 'object') {
    fields = Object.keys(payload[0]);
    data = payload.map(function (o) { return fields.map(function (k) { return o[k]; }); });
  } else {
    return rows;
  }
  var idx = {};
  Object.keys(TW_DIVIDEND_HEADERS_).forEach(function (k) { idx[k] = findHeaderIndex_(fields, TW_DIVIDEND_HEADERS_[k]); });
  if (idx.code < 0 || idx.exDate < 0) {
    console.warn('normalizeDividendRows_ ' + source + ': headers not recognised', fields.join(','));
    return rows;
  }
  data.forEach(function (r) {
    var code = String(r[idx.code] || '').trim();
    var exDate = dateKeyFromParts_(parseTwDate_(r[idx.exDate]));
    if (!code || !exDate) return;
    var cash = idx.cash >= 0 ? numOrZero_(r[idx.cash]) : 0;
    var stock = idx.stock >= 0 ? numOrZero_(r[idx.stock]) : 0;
    var kindRaw = idx.kind >= 0 ? String(r[idx.kind] || '') : '';
    var kind = /權息|both/i.test(kindRaw) ? 'both' : /權(?!息)/.test(kindRaw) ? 'stock' : 'cash';
    if (!cash && !stock && kind === 'cash') kind = 'unknown';
    rows.push({ code: code, name: idx.name >= 0 ? String(r[idx.name] || '') : '', exDate: exDate, cash: cash, stock: stock, kind: kind, source: source });
  });
  return rows;
}

function fetchJson_(url) {
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)', 'Accept': 'application/json, text/plain, */*' },
  });
  if (resp.getResponseCode() !== 200) throw new Error(url + ' -> ' + resp.getResponseCode());
  return JSON.parse(resp.getContentText());
}

function fetchTwDividendRows_() {
  var rows = [];
  try {
    rows = rows.concat(normalizeDividendRows_(fetchJson_('https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json'), 'twse'));
  } catch (err) {
    console.warn('TWT48U rwd failed', err);
    try {
      rows = rows.concat(normalizeDividendRows_(fetchJson_('https://openapi.twse.com.tw/v1/exchangeReport/TWT48U'), 'twse-openapi'));
    } catch (err2) { console.warn('TWT48U openapi failed', err2); }
  }
  try {
    rows = rows.concat(normalizeDividendRows_(fetchJson_('https://www.tpex.org.tw/openapi/v1/tpex_exright_pre'), 'tpex'));
  } catch (err3) { console.warn('tpex_exright_pre failed', err3); }
  return rows;
}

function updateDividendCalendar() {
  var symbols = listTrackedStockSymbols_('TW');
  if (!symbols.length) return { ok: true, skipped: true, reason: 'no TW symbols' };
  var wanted = {};
  symbols.forEach(function (s) { wanted[s] = true; });
  var rows = fetchTwDividendRows_();
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var best = {};
  rows.forEach(function (r) {
    if (!wanted[r.code]) return;
    if (r.exDate < today) return;
    // 同代號多筆取最近的一次
    if (!best[r.code] || r.exDate < best[r.code].exDate) best[r.code] = r;
  });
  var updated = 0;
  var cleared = 0;
  var now = new Date();
  symbols.forEach(function (sym) {
    var hit = best[sym];
    if (hit) {
      fsSetDoc_('stocks/' + sym, {
        upcomingDividend: {
          exDate: hit.exDate, cashPerShare: hit.cash, stockPerShare: hit.stock, kind: hit.kind, source: hit.source, updatedAt: now,
        },
      }, true);
      updated++;
      return;
    }
    // 沒有新的預告：若既有資料已過期就清掉
    try {
      var doc = fsGetDoc_('stocks/' + sym);
      if (doc && doc.upcomingDividend && doc.upcomingDividend.exDate && doc.upcomingDividend.exDate < today) {
        fsSetDoc_('stocks/' + sym, { upcomingDividend: null }, true);
        cleared++;
      }
    } catch (err) { console.warn('clear upcomingDividend', sym, err); }
  });
  return { ok: true, symbols: symbols.length, rowsFetched: rows.length, updated: updated, cleared: cleared };
}

function notifyDividendCalendar() {
  var positions;
  try { positions = fsListAllDocs_('portfolio', 200); } catch (err) { return { ok: true, skipped: true }; }
  var today = startOfDayTW_(new Date());
  var hits = [];
  (positions || []).forEach(function (p) {
    if (!p.symbol || !p.shares) return;
    var stock;
    try { stock = fsGetDoc_('stocks/' + p.symbol); } catch (_) { stock = null; }
    var ud = stock && stock.upcomingDividend;
    if (!ud || !ud.exDate) return;
    var parts = ud.exDate.split('-');
    var ex = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    var days = Math.round((ex.getTime() - today.getTime()) / 86400000);
    if (days < 0 || days > 7) return;
    hits.push({ symbol: p.symbol, name: stock.name || p.symbol, days: days, exDate: ud.exDate, cash: ud.cashPerShare || 0, stock: ud.stockPerShare || 0, shares: p.shares });
  });
  if (!hits.length) return { ok: true, skipped: true };
  hits.sort(function (a, b) { return a.days - b.days; });
  var lines = ['[Personal Hub] 除權息日曆', '--------------------'];
  var totalCash = 0;
  hits.forEach(function (h) {
    var est = h.cash * h.shares;
    totalCash += est;
    var when = h.days === 0 ? '今天' : h.days + ' 天後';
    lines.push('· ' + h.symbol + ' ' + h.name + ' — ' + when + '除息 (' + h.exDate.slice(5) + ')'
      + (h.cash ? ' 現金 ' + h.cash + '/股 ≈ NT$' + n0(est) : '')
      + (h.stock ? ' 股票 ' + h.stock : ''));
    if (est >= 20000) lines.push('   單筆 ≥ 2 萬：二代健保 2.11% ≈ NT$' + n0(est * 0.0211));
  });
  if (totalCash) lines.push('--------------------', '預估現金股利合計 NT$' + n0(totalCash));
  return sendNotification_('dividendCalendar', lines.join('\n'));
}

/** 去年股利 / 海外所得整理（4/1、5/1 由 tick_daily_0930 呼叫） */
function notifyTaxSeason() {
  var year = parseInt(Utilities.formatDate(new Date(), TZ, 'yyyy'), 10) - 1;
  var dividends = [];
  var lots = [];
  try { dividends = fsListAllDocs_('dividends', 500); } catch (err) { console.warn('taxSeason dividends', err); }
  try { lots = fsListAllDocs_('realized_lots', 500); } catch (err) { console.warn('taxSeason lots', err); }
  var inYear = function (d) { return d instanceof Date && d.getFullYear() === year; };
  var twDiv = 0, usDiv = 0, nhi = 0, usGain = 0;
  dividends.forEach(function (d) {
    var pay = d.payDate instanceof Date ? d.payDate : new Date(d.payDate);
    if (!inYear(pay)) return;
    var amt = d.amountTWD || 0;
    if (d.market === 'US' || d.currency === 'USD') usDiv += amt;
    else { twDiv += amt; if (amt >= 20000) nhi += amt * 0.0211; }
  });
  lots.forEach(function (l) {
    var sell = l.sellDate instanceof Date ? l.sellDate : new Date(l.sellDate);
    if (!inYear(sell)) return;
    if (l.market === 'US' || l.currency === 'USD') usGain += l.realizedPnlTWD || 0;
  });
  var overseas = usDiv + Math.max(0, usGain);
  var creditA = Math.min(twDiv * 0.085, 80000);
  var taxB = twDiv * 0.28;
  var lines = [
    '[Personal Hub] ' + year + ' 年報稅資料整理',
    '--------------------',
    '台股股利：NT$' + n0(twDiv),
    '  合併計稅可抵減 8.5%：NT$' + n0(creditA) + '（上限 8 萬）',
    '  分離課稅 28%：NT$' + n0(taxB),
    '  二代健保補充保費（單筆 ≥ 2 萬 × 2.11%）：NT$' + n0(nhi),
    '美股股利：NT$' + n0(usDiv) + '（已預扣 30% 者以實收計）',
    '美股已實現損益：NT$' + n0(usGain),
    '海外所得合計：NT$' + n0(overseas)
      + (overseas >= 1000000 ? '（≥ 100 萬須申報）' : '（< 100 萬免申報）'),
    overseas >= 7500000 ? '海外所得 ≥ 750 萬，可能觸及基本所得額' : '',
    '--------------------',
    '數字來自 app 的股息 / 已實現紀錄，請以券商與稅務憑單為準。',
  ].filter(function (l) { return l !== ''; });
  return sendNotification_('taxSeason', lines.join('\n'));
}
