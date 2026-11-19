/**
 * Claude 排程 → 股市雷達的輿情推送通道。安全設計與 FlightIngest.gs 相同：
 *
 * - 專用 ingest token：前端 CSPRNG 產生，Apps Script 只存 SHA-256；可隨時輪替或撤銷。
 * - 只寫不讀：回應只有每檔的成功／失敗原因，不回傳任何 Firestore 資料（持股股數、成本都不會外流）。
 * - 只接受目前追蹤清單（持股 + 自選股）裡、指定市場的代號；分數範圍、字數、來源 https 都會再驗一次。
 * - 沒有來源的個股輿情照存但 confidence 歸零，不影響分數。
 * - 每個市場每天最多 STOCK_INGEST_DAILY_LIMIT_ 次，同一天多次推送以代號合併（後到覆蓋）。
 * - 推送後若當天評估已存在就重新合成並推播（StockRadar.gs stockRadarApplySentiment_）。
 *
 * 另有 importStockSentiment（Firebase idToken 驗證）給「手動貼上 Claude 輸出」使用，規則相同。
 */

var STOCK_INGEST_TOKEN_PATTERN_ = /^rmsr_[A-Za-z0-9_-]{43}$/;
var STOCK_INGEST_MAX_ITEMS_ = 60;
var STOCK_INGEST_MAX_PAYLOAD_CHARS_ = 200000;
var STOCK_INGEST_DAILY_LIMIT_ = 6;
var STOCK_INGEST_EVENT_TYPES_ = ['earnings', 'ex_dividend', 'offering', 'legal', 'downgrade', 'upgrade', 'guidance', 'macro', 'other'];
var STOCK_INGEST_SURPRISES_ = ['beat', 'miss', 'inline'];

// -------- token 管理（Firebase idToken 驗證後由前端呼叫） --------

function setStockIngestToken(body, authResult) {
  var hash = String((body && body.tokenHash) || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: 'invalid tokenHash' };
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  var createdAt = new Date().toISOString();
  PROP.setProperties({
    STOCK_INGEST_TOKEN_SHA256: hash,
    STOCK_INGEST_UID: authResult.uid,
    STOCK_INGEST_CREATED_AT: createdAt,
  });
  PROP.deleteProperty('STOCK_INGEST_LAST_USED_AT');
  return { ok: true, createdAt: createdAt };
}

function revokeStockIngestToken(body, authResult) {
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  ['STOCK_INGEST_TOKEN_SHA256', 'STOCK_INGEST_UID', 'STOCK_INGEST_CREATED_AT', 'STOCK_INGEST_LAST_USED_AT']
    .forEach(function (key) { PROP.deleteProperty(key); });
  return { ok: true };
}

function getStockIngestStatus(body, authResult) {
  var configured = !!PROP.getProperty('STOCK_INGEST_TOKEN_SHA256');
  return {
    ok: true,
    configured: configured,
    ownedByCaller: configured && !!authResult && PROP.getProperty('STOCK_INGEST_UID') === authResult.uid,
    createdAt: PROP.getProperty('STOCK_INGEST_CREATED_AT') || null,
    lastUsedAt: PROP.getProperty('STOCK_INGEST_LAST_USED_AT') || null,
  };
}

// -------- 推送入口 --------

/** Claude 排程呼叫：ingest token 驗證，沒有 Firebase idToken。 */
function ingestStockSentimentWithToken_(body) {
  var expected = PROP.getProperty('STOCK_INGEST_TOKEN_SHA256');
  var token = String((body && body.ingestToken) || '');
  // 一律回同一個錯誤，不透露是沒設定、格式錯還是 token 不對。
  if (!expected || !STOCK_INGEST_TOKEN_PATTERN_.test(token)
      || !flightIngestSafeEqual_(flightIngestSha256Hex_(token), expected)) {
    return { ok: false, error: 'stock-ingest-unauthorized' };
  }
  PROP.setProperty('STOCK_INGEST_LAST_USED_AT', new Date().toISOString());
  return applyStockSentimentIngest_(body, 'claude');
}

function importStockSentiment(body, authResult) {
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  return applyStockSentimentIngest_(body, 'claude-paste');
}

function srIngestText_(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function srIngestSources_(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).map(function (source) {
    var url = srIngestText_(source && source.url, 500);
    if (!/^https:\/\/[^\s]+$/i.test(url)) return null;
    return { title: srIngestText_(source.title, 100) || url, url: url };
  }).filter(Boolean);
}

/**
 * 驗證並正規化一筆輿情（個股或市場整體）。回傳 { entry } 或 { error }。
 * 純函式（不碰 PROP / Firestore），在 apps-script/tests/stock-radar.test.cjs 測試。
 */
function normalizeStockSentimentEntry_(raw, opts) {
  opts = opts || {};
  if (!raw || typeof raw !== 'object') return { error: '格式錯誤' };
  var sentiment = Number(raw.sentiment);
  var confidence = Number(raw.confidence);
  if (!isFinite(sentiment) || sentiment < -1 || sentiment > 1) return { error: 'sentiment 必須介於 -1 到 1' };
  if (!isFinite(confidence) || confidence < 0 || confidence > 1) return { error: 'confidence 必須介於 0 到 1' };
  var sources = srIngestSources_(raw.sources);
  var entry = {
    sentiment: srRound_(sentiment, 3),
    // 沒有可查證來源 → 信心歸零，照存但不影響分數
    confidence: sources.length ? srRound_(confidence, 3) : 0,
    summary: srIngestText_(raw.summary, 300),
    sources: sources,
  };
  if (!opts.market) {
    entry.symbol = normalizeStockSymbol_(raw.symbol);
    entry.catalysts = (Array.isArray(raw.catalysts) ? raw.catalysts : []).slice(0, 5)
      .map(function (c) { return srIngestText_(c, 100); }).filter(Boolean);
    entry.riskEvents = (Array.isArray(raw.riskEvents) ? raw.riskEvents : []).slice(0, 5).map(function (ev) {
      if (!ev || STOCK_INGEST_EVENT_TYPES_.indexOf(ev.type) < 0) return null;
      var date = /^\d{4}-\d{2}-\d{2}$/.test(String(ev.date || '')) ? String(ev.date) : null;
      return { type: ev.type, date: date, note: srIngestText_(ev.note, 100) };
    }).filter(Boolean);
    entry.earningsSurprise = STOCK_INGEST_SURPRISES_.indexOf(raw.earningsSurprise) >= 0 ? raw.earningsSurprise : null;
  } else {
    entry.events = (Array.isArray(raw.events) ? raw.events : []).slice(0, 5)
      .map(function (c) { return srIngestText_(c, 100); }).filter(Boolean);
  }
  return { entry: entry, warning: sources.length ? null : '沒有 https 來源，不計分' };
}

function srIngestCounterKey_(market, runDate) {
  return 'STOCK_INGEST_COUNT_' + market + '_' + runDate.replace(/-/g, '');
}

function applyStockSentimentIngest_(body, provider) {
  if (JSON.stringify(body || {}).length > STOCK_INGEST_MAX_PAYLOAD_CHARS_) return { ok: false, error: 'payload too large' };
  var market = body && body.market;
  if (market !== 'TW' && market !== 'US') return { ok: false, error: 'market 必須是 TW 或 US' };
  var rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length && !body.marketView) return { ok: false, error: '沒有 items' };
  if (rawItems.length > STOCK_INGEST_MAX_ITEMS_) return { ok: false, error: '一次最多 ' + STOCK_INGEST_MAX_ITEMS_ + ' 檔' };

  var runDate = stockRadarToday_();
  var counterKey = srIngestCounterKey_(market, runDate);
  var count = Number(PROP.getProperty(counterKey) || 0);
  if (count >= STOCK_INGEST_DAILY_LIMIT_) return { ok: false, error: '今日推送次數已達上限' };
  PROP.setProperty(counterKey, String(count + 1));
  // 清掉前一天的計數，Script Properties 不會無限累積
  var yesterday = Utilities.formatDate(new Date(Date.now() - 86400000), TW_TZ, 'yyyy-MM-dd');
  PROP.deleteProperty(srIngestCounterKey_(market, yesterday));

  var universe = {};
  stockRadarUniverse_(market, stockRadarHoldings_(), stockRadarWatchlist_()).forEach(function (sym) { universe[sym] = true; });

  var results = [];
  var accepted = {};
  rawItems.forEach(function (raw) {
    var symbol = normalizeStockSymbol_(raw && raw.symbol);
    if (!symbol || !universe[symbol]) {
      results.push({ symbol: symbol || null, ok: false, error: '不在追蹤清單（請重新複製提示詞）' });
      return;
    }
    var normalized = normalizeStockSentimentEntry_(raw, {});
    if (normalized.error) {
      results.push({ symbol: symbol, ok: false, error: normalized.error });
      return;
    }
    accepted[symbol] = normalized.entry;
    results.push({ symbol: symbol, ok: true, warning: normalized.warning || undefined });
  });

  var marketView = null;
  if (body.marketView) {
    var mv = normalizeStockSentimentEntry_(body.marketView, { market: true });
    if (mv.error) results.push({ symbol: 'marketView', ok: false, error: mv.error });
    else marketView = mv.entry;
  }

  var acceptedCount = Object.keys(accepted).length;
  if (!acceptedCount && !marketView) return { ok: false, error: '沒有可用的結果', results: results };

  var docPath = 'stock_radar_sentiment/' + stockRadarRunId_(runDate, market);
  var existing = fsGetDoc_(docPath);
  var merged = {};
  ((existing && existing.items) || []).forEach(function (entry) { if (entry && entry.symbol) merged[entry.symbol] = entry; });
  Object.keys(accepted).forEach(function (sym) { merged[sym] = accepted[sym]; });
  var sentimentDoc = {
    runDate: runDate,
    market: market,
    provider: provider,
    receivedAt: new Date(),
    marketView: marketView || (existing && existing.marketView) || null,
    items: Object.keys(merged).sort().map(function (sym) { return merged[sym]; }),
  };
  fsSetDoc_(docPath, sentimentDoc, false);

  var resynth = stockRadarResynthesize_(runDate, market, sentimentDoc);
  return { ok: true, runDate: runDate, accepted: acceptedCount, results: results, resynthesized: resynth.updated };
}

/** 當天評估已存在 → 合併輿情重新判定並推播（第一次推播發完整版，之後只發動作變化） */
function stockRadarResynthesize_(runDate, market, sentimentDoc) {
  var runPath = 'stock_radar_runs/' + stockRadarRunId_(runDate, market);
  var run = fsGetDoc_(runPath);
  if (!run || !Array.isArray(run.items) || !run.items.length) return { updated: false };
  var previousActions = {};
  run.items.forEach(function (item) { previousActions[item.symbol] = item.action; });
  var wasNotified = !!run.notifiedAt;
  var synthesized = stockRadarApplySentiment_(run, sentimentDoc);
  Object.keys(synthesized).forEach(function (key) { run[key] = synthesized[key]; });
  try {
    notifyStockRadar_(run, wasNotified ? previousActions : null);
  } catch (err) {
    console.error('notifyStockRadar_ resynth', market, err);
  }
  synthesized.notifiedAt = run.notifiedAt || new Date();
  fsSetDoc_(runPath, synthesized, true);
  return { updated: true };
}
