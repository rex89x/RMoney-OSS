/**
 * TaifexData — 期交所公開資料抓取與解析（台指期日行情、三大法人未平倉、選擇權 PCR）。
 *
 * - 期交所下載端點回 Big5 CSV；解析器用「欄位名稱關鍵字」找欄位，不依賴欄位順序。
 * - 解析器是純函式（tfParse*），測試在 apps-script/tests/taifex.test.cjs。
 * - 欄位格式若有變，owner 呼叫 diagTaifex 會回傳原始回應前幾行，方便排查。
 * - 結果寫入 taifex_daily/{yyyyMMdd}（每天一筆，近月 + 次月收盤 + 籌碼）。
 */

var TAIFEX_BASE_URL_ = 'https://www.taifex.com.tw/cht/3/';
var TAIFEX_FETCH_HEADERS_ = { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)', 'Accept': 'text/csv, */*' };

// -------- CSV 解析（純函式） --------

/** 簡易 CSV：支援雙引號包住含逗號的欄位，去掉 BOM 與前後空白 */
function tfParseCsv_(text) {
  var rows = [];
  String(text || '').replace(/^﻿/, '').split(/\r?\n/).forEach(function (line) {
    if (!line.trim()) return;
    var cells = [];
    var cur = '';
    var quoted = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (quoted) {
        if (ch === '"' && line.charAt(i + 1) === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  });
  return rows;
}

/** 找第一個包含任一關鍵字、且不含排除字的欄位 */
function tfFindCol_(header, keywords, excludes) {
  for (var i = 0; i < header.length; i++) {
    var name = String(header[i] || '').replace(/\s+/g, '');
    var hit = keywords.some(function (k) { return name.indexOf(k) >= 0; });
    var excluded = (excludes || []).some(function (k) { return name.indexOf(k) >= 0; });
    if (hit && !excluded) return i;
  }
  return -1;
}

function tfParseNumber_(value) {
  var s = String(value === undefined || value === null ? '' : value).replace(/[,%\s]/g, '');
  if (!s || s === '-' || s === '--') return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

/** 2026/11/09、2026-11-09、20261109 → 2026-11-09 */
function tfNormalizeDate_(value) {
  var s = String(value || '').trim();
  var m = /^(\d{4})[\/\-]?(\d{1,2})[\/\-]?(\d{1,2})$/.exec(s);
  if (!m) return null;
  return m[1] + '-' + tfPad2_(Number(m[2])) + '-' + tfPad2_(Number(m[3]));
}

/** 找到標題列（第一列含「日期」的列），回傳 { header, rows } */
function tfCsvTable_(text) {
  var rows = tfParseCsv_(text);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].some(function (c) { return String(c).indexOf('日期') >= 0; })) {
      return { header: rows[i], rows: rows.slice(i + 1) };
    }
  }
  return { header: [], rows: [] };
}

/**
 * 台指期日行情 CSV → { 'yyyy-MM-dd': [ { contract, open, high, low, close, settle, volume, oi } ] }
 * 只留商品 TX、月契約（排除週契約與價差）、一般交易時段。
 */
function tfParseFuturesCsv_(text) {
  var table = tfCsvTable_(text);
  var h = table.header;
  var col = {
    date: tfFindCol_(h, ['交易日期', '日期']),
    product: tfFindCol_(h, ['契約'], ['月份', '週別', '價差', '未沖銷', '未平倉']),
    month: tfFindCol_(h, ['到期月份', '週別']),
    open: tfFindCol_(h, ['開盤']),
    high: tfFindCol_(h, ['最高'], ['歷史']),
    low: tfFindCol_(h, ['最低'], ['歷史']),
    close: tfFindCol_(h, ['收盤']),
    volume: tfFindCol_(h, ['成交量'], ['價差']),
    settle: tfFindCol_(h, ['結算價']),
    oi: tfFindCol_(h, ['未沖銷', '未平倉']),
    session: tfFindCol_(h, ['交易時段']),
  };
  var out = {};
  if (col.date < 0 || col.month < 0 || col.close < 0) return out;
  table.rows.forEach(function (r) {
    var date = tfNormalizeDate_(r[col.date]);
    if (!date) return;
    if (col.product >= 0 && String(r[col.product]).trim() !== 'TX') return;
    var month = String(r[col.month] || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(month)) return;
    if (col.session >= 0 && String(r[col.session]).indexOf('盤後') >= 0) return;
    var close = tfParseNumber_(r[col.close]);
    var open = tfParseNumber_(r[col.open]);
    if (close === null || open === null) return;
    (out[date] = out[date] || []).push({
      contract: month,
      open: open,
      high: tfParseNumber_(r[col.high]) === null ? Math.max(open, close) : tfParseNumber_(r[col.high]),
      low: tfParseNumber_(r[col.low]) === null ? Math.min(open, close) : tfParseNumber_(r[col.low]),
      close: close,
      settle: col.settle >= 0 ? tfParseNumber_(r[col.settle]) : null,
      volume: col.volume >= 0 ? tfParseNumber_(r[col.volume]) : null,
      oi: col.oi >= 0 ? tfParseNumber_(r[col.oi]) : null,
    });
  });
  return out;
}

/** 每天挑近月與次月 → 日 K（依日期排序） */
function tfBuildDailyBars_(rowsByDate) {
  return Object.keys(rowsByDate).sort().map(function (date) {
    var rows = rowsByDate[date];
    var byContract = {};
    rows.forEach(function (r) { byContract[r.contract] = r; });
    var pick = tfPickFrontContracts_(date, Object.keys(byContract));
    var front = pick.front && byContract[pick.front];
    if (!front) return null;
    var next = pick.next && byContract[pick.next];
    return {
      date: date,
      contract: pick.front,
      open: front.open,
      high: front.high,
      low: front.low,
      close: front.close,
      settle: front.settle,
      volume: front.volume,
      oi: front.oi,
      nextContract: next ? pick.next : null,
      nextClose: next ? next.close : null,
    };
  }).filter(Boolean);
}

/** 三大法人（期貨契約別）CSV → { date: { foreignNetOi, trustNetOi, dealerNetOi } }，只取「臺股期貨」 */
function tfParseInstitutionalCsv_(text) {
  var table = tfCsvTable_(text);
  var h = table.header;
  var col = {
    date: tfFindCol_(h, ['日期']),
    product: tfFindCol_(h, ['商品名稱', '商品']),
    identity: tfFindCol_(h, ['身份別', '身分別']),
    netOi: tfFindCol_(h, ['多空未平倉口數淨額', '未平倉口數淨額']),
  };
  var out = {};
  if (col.date < 0 || col.identity < 0 || col.netOi < 0) return out;
  table.rows.forEach(function (r) {
    var date = tfNormalizeDate_(r[col.date]);
    if (!date) return;
    if (col.product >= 0) {
      var product = String(r[col.product] || '').replace(/\s+/g, '');
      if (!/^(臺|台)股期貨$/.test(product)) return;
    }
    var net = tfParseNumber_(r[col.netOi]);
    if (net === null) return;
    var who = String(r[col.identity] || '');
    var entry = out[date] = out[date] || {};
    if (who.indexOf('外資') >= 0) entry.foreignNetOi = net;
    else if (who.indexOf('投信') >= 0) entry.trustNetOi = net;
    else if (who.indexOf('自營') >= 0) entry.dealerNetOi = net;
  });
  return out;
}

/** 臺指選擇權 Put/Call Ratio CSV → { date: { pcrVol, pcrOi } }（百分比，例如 115.3） */
function tfParsePcrCsv_(text) {
  var table = tfCsvTable_(text);
  var h = table.header;
  var col = {
    date: tfFindCol_(h, ['日期']),
    vol: tfFindCol_(h, ['成交量比率']),
    oi: tfFindCol_(h, ['未平倉量比率', '未平倉比率']),
  };
  var out = {};
  if (col.date < 0) return out;
  table.rows.forEach(function (r) {
    var date = tfNormalizeDate_(r[col.date]);
    if (!date) return;
    out[date] = {
      pcrVol: col.vol >= 0 ? tfParseNumber_(r[col.vol]) : null,
      pcrOi: col.oi >= 0 ? tfParseNumber_(r[col.oi]) : null,
    };
  });
  return out;
}

// -------- 抓取（UrlFetch） --------

function tfSlashDate_(dateStr) {
  return String(dateStr).replace(/-/g, '/');
}

function tfFetchCsv_(endpoint, payload) {
  var resp = UrlFetchApp.fetch(TAIFEX_BASE_URL_ + endpoint, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true,
    followRedirects: true,
    headers: TAIFEX_FETCH_HEADERS_,
  });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error('TAIFEX ' + endpoint + ' HTTP ' + code);
  var text = resp.getContentText('Big5');
  // 查無資料時期交所回 HTML 錯誤頁
  if (/<html/i.test(text.slice(0, 500))) return '';
  return text;
}

function tfFetchFutures_(from, to) {
  return tfFetchCsv_('futDataDown', {
    down_type: '1',
    commodity_id: 'TX',
    commodity_id2: '',
    queryStartDate: tfSlashDate_(from),
    queryEndDate: tfSlashDate_(to),
  });
}

function tfFetchInstitutional_(from, to) {
  return tfFetchCsv_('futContractsDateDown', {
    queryStartDate: tfSlashDate_(from),
    queryEndDate: tfSlashDate_(to),
    commodityId: 'TXF',
  });
}

function tfFetchPcr_(from, to) {
  return tfFetchCsv_('pcRatioDown', {
    queryStartDate: tfSlashDate_(from),
    queryEndDate: tfSlashDate_(to),
  });
}

/** 把 [from, to] 切成一個月一段（期交所下載一次最多一個月） */
function tfMonthChunks_(from, to) {
  var chunks = [];
  var cur = tfStrToDate_(from);
  var end = tfStrToDate_(to);
  while (cur && end && cur <= end) {
    var chunkEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
    if (chunkEnd > end) chunkEnd = end;
    chunks.push({ from: tfDateToStr_(cur), to: tfDateToStr_(chunkEnd) });
    cur = new Date(chunkEnd.getTime() + 86400000);
  }
  return chunks;
}

/**
 * 抓 [from, to] 的日 K + 籌碼並寫入 taifex_daily。籌碼抓失敗不影響價格（因子缺資料自動不計分）。
 * 回傳 { bars, errors }。
 */
function syncTaifexRange_(from, to) {
  var errors = [];
  var rowsByDate = {};
  var inst = {};
  var pcr = {};
  tfMonthChunks_(from, to).forEach(function (chunk, idx) {
    if (idx > 0) Utilities.sleep(400);
    try {
      var parsed = tfParseFuturesCsv_(tfFetchFutures_(chunk.from, chunk.to));
      Object.keys(parsed).forEach(function (d) { rowsByDate[d] = parsed[d]; });
    } catch (err) { errors.push('futures ' + chunk.from + ': ' + (err && err.message || err)); }
    try {
      var i = tfParseInstitutionalCsv_(tfFetchInstitutional_(chunk.from, chunk.to));
      Object.keys(i).forEach(function (d) { inst[d] = i[d]; });
    } catch (err2) { errors.push('institutional ' + chunk.from + ': ' + (err2 && err2.message || err2)); }
    try {
      var p = tfParsePcrCsv_(tfFetchPcr_(chunk.from, chunk.to));
      Object.keys(p).forEach(function (d) { pcr[d] = p[d]; });
    } catch (err3) { errors.push('pcr ' + chunk.from + ': ' + (err3 && err3.message || err3)); }
  });

  var bars = tfBuildDailyBars_(rowsByDate).map(function (bar) {
    var flow = inst[bar.date] || {};
    var ratio = pcr[bar.date] || {};
    bar.foreignNetOi = tfNum_(flow.foreignNetOi);
    bar.trustNetOi = tfNum_(flow.trustNetOi);
    bar.dealerNetOi = tfNum_(flow.dealerNetOi);
    bar.pcrOi = tfNum_(ratio.pcrOi);
    bar.pcrVol = tfNum_(ratio.pcrVol);
    return bar;
  });

  var writes = bars.map(function (bar) {
    var data = {};
    Object.keys(bar).forEach(function (k) { data[k] = bar[k]; });
    data.updatedAt = new Date();
    return { path: 'taifex_daily/' + bar.date.replace(/-/g, ''), data: data };
  });
  for (var w = 0; w < writes.length; w += 200) tfBatchSet_(writes.slice(w, w + 200));
  return { bars: bars, errors: errors };
}

/** 依 Firestore.gs fsBatchWrite_ 的格式批次覆寫 */
function tfBatchSet_(items) {
  if (!items.length) return;
  fsBatchWrite_(items.map(function (item) {
    return { update: { name: fsDocumentName_(item.path), fields: encodeFields_(item.data) } };
  }));
}

/** 讀全部日 K（依日期排序）。約 3 年 × 245 天，單一 collection 全讀。 */
function loadTaifexBars_() {
  var docs = fsListAllDocs_('taifex_daily', 300);
  return docs.filter(function (d) {
    return d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) && tfNum_(d.close) !== null && tfNum_(d.open) !== null;
  }).map(function (d) {
    return {
      date: d.date,
      contract: d.contract || null,
      open: d.open,
      high: tfNum_(d.high) === null ? Math.max(d.open, d.close) : d.high,
      low: tfNum_(d.low) === null ? Math.min(d.open, d.close) : d.low,
      close: d.close,
      settle: tfNum_(d.settle),
      volume: tfNum_(d.volume),
      oi: tfNum_(d.oi),
      nextContract: d.nextContract || null,
      nextClose: tfNum_(d.nextClose),
      foreignNetOi: tfNum_(d.foreignNetOi),
      trustNetOi: tfNum_(d.trustNetOi),
      dealerNetOi: tfNum_(d.dealerNetOi),
      pcrOi: tfNum_(d.pcrOi),
      pcrVol: tfNum_(d.pcrVol),
    };
  }).sort(function (a, b) { return a.date.localeCompare(b.date); });
}

/** owner 診斷：回傳三個端點原始回應前幾行 + 解析筆數，欄位改名時用來排查 */
function diagTaifex() {
  var to = Utilities.formatDate(new Date(), TW_TZ, 'yyyy-MM-dd');
  var from = Utilities.formatDate(new Date(Date.now() - 10 * 86400000), TW_TZ, 'yyyy-MM-dd');
  var out = { ok: true, from: from, to: to };
  [['futures', tfFetchFutures_, function (t) { return tfBuildDailyBars_(tfParseFuturesCsv_(t)).length; }],
    ['institutional', tfFetchInstitutional_, function (t) { return Object.keys(tfParseInstitutionalCsv_(t)).length; }],
    ['pcr', tfFetchPcr_, function (t) { return Object.keys(tfParsePcrCsv_(t)).length; }]].forEach(function (spec) {
    try {
      var text = spec[1](from, to);
      out[spec[0]] = { sample: text.split(/\r?\n/).slice(0, 4).join('\n').slice(0, 800), parsedDays: spec[2](text) };
    } catch (err) {
      out[spec[0]] = { error: String(err && err.message || err) };
    }
  });
  return out;
}
