/**
 * Claude 排程 → 台指期輿情推送通道。安全設計與 StockRadarIngest.gs 相同：
 *
 * - 專用 ingest token（rmtf_ 前綴）：前端 CSPRNG 產生，Apps Script 只存 SHA-256；可隨時輪替或撤銷。
 * - 只寫不讀：回應只有接受 / 拒收原因，不回傳帳戶、部位或任何 Firestore 資料。
 * - 分數範圍、字數、https 來源、事件日期都會再驗一次；沒有 https 來源 → confidence 歸零（不計分）。
 * - 每天最多 TAIFEX_INGEST_DAILY_LIMIT_ 次；同一天多次推送：overall 與 indicators 後到覆蓋，事件合併去重。
 *
 * 另有 importTaifexSentiment（Firebase idToken 驗證）給「手動貼上 Claude 輸出」使用，規則相同。
 * 純函式 normalizeTaifexSentiment_ / tfPreOpenVeto_ 在 apps-script/tests/taifex.test.cjs 測試。
 */

var TAIFEX_INGEST_TOKEN_PATTERN_ = /^rmtf_[A-Za-z0-9_-]{43}$/;
var TAIFEX_INGEST_MAX_PAYLOAD_CHARS_ = 60000;
var TAIFEX_INGEST_DAILY_LIMIT_ = 8;
var TAIFEX_DRIVER_TYPES_ = ['us_market', 'tsmc_adr', 'fed', 'macro_data', 'geopolitics', 'foreign_flow', 'retail_sentiment', 'earnings', 'fx', 'other'];
var TAIFEX_INDICATOR_BOUNDS_ = {
  vix: [5, 100],
  spxChangePct: [-20, 20],
  soxChangePct: [-25, 25],
  tsmAdrChangePct: [-25, 25],
  nightSessionChangePct: [-15, 15],
};

// -------- 純函式 --------

function tfIngestText_(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function tfIngestSources_(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map(function (source) {
    var url = tfIngestText_(source && source.url, 500);
    if (!/^https:\/\/[^\s]+$/i.test(url)) return null;
    return { title: tfIngestText_(source.title, 100) || url, url: url };
  }).filter(Boolean);
}

/** 驗證並正規化一次推送。回傳 { entry, warning } 或 { error }。 */
function normalizeTaifexSentiment_(raw) {
  if (!raw || typeof raw !== 'object' || !raw.overall || typeof raw.overall !== 'object') return { error: '缺少 overall' };
  var s = Number(raw.overall.sentiment);
  var conf = Number(raw.overall.confidence);
  if (!isFinite(s) || s < -1 || s > 1) return { error: 'overall.sentiment 必須介於 -1 到 1' };
  if (!isFinite(conf) || conf < 0 || conf > 1) return { error: 'overall.confidence 必須介於 0 到 1' };
  var sources = tfIngestSources_(raw.overall.sources);

  var drivers = (Array.isArray(raw.drivers) ? raw.drivers : []).slice(0, 8).map(function (d) {
    if (!d || TAIFEX_DRIVER_TYPES_.indexOf(d.type) < 0) return null;
    var dir = Number(d.direction);
    return {
      type: d.type,
      direction: dir > 0 ? 1 : (dir < 0 ? -1 : 0),
      note: tfIngestText_(d.note, 120),
    };
  }).filter(Boolean);

  var events = (Array.isArray(raw.events) ? raw.events : []).slice(0, 10).map(function (ev) {
    if (!ev || TAIFEX_EVENT_TYPES.indexOf(ev.type) < 0) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ev.date || ''))) return null;
    return {
      type: ev.type,
      date: String(ev.date),
      importance: TAIFEX_EVENT_IMPORTANCE.indexOf(ev.importance) >= 0 ? ev.importance : 'medium',
      note: tfIngestText_(ev.note, 100),
    };
  }).filter(Boolean);

  var indicators = {};
  var rawInd = raw.indicators && typeof raw.indicators === 'object' ? raw.indicators : {};
  Object.keys(TAIFEX_INDICATOR_BOUNDS_).forEach(function (key) {
    var v = Number(rawInd[key]);
    var b = TAIFEX_INDICATOR_BOUNDS_[key];
    indicators[key] = rawInd[key] !== null && rawInd[key] !== undefined && isFinite(v) && v >= b[0] && v <= b[1]
      ? Math.round(v * 100) / 100 : null;
  });

  return {
    entry: {
      overall: {
        sentiment: Math.round(s * 1000) / 1000,
        confidence: sources.length ? Math.round(conf * 1000) / 1000 : 0,
        summary: tfIngestText_(raw.overall.summary, 400),
        sources: sources,
      },
      drivers: drivers,
      events: events,
      indicators: indicators,
    },
    warning: sources.length ? null : '沒有 https 來源，輿情不計分（事件仍會記錄）',
  };
}

/**
 * 盤前否決：只取消「新增曝險」的待成交單（空手開倉、反手、加碼），平倉與減碼永遠不擋。
 * 條件：今天有高重要性事件，或輿情（分數 × 信心）與目標方向強烈相反。
 */
function tfPreOpenVeto_(pending, position, sentiment, today) {
  if (!pending || pending.target === 'flat') return { veto: false };
  var newExposure = !position || position.side !== pending.target || (pending.contracts || 0) > (position.contracts || 0);
  if (!newExposure) return { veto: false };
  var events = (sentiment && Array.isArray(sentiment.events)) ? sentiment.events : [];
  var todayHigh = events.filter(function (ev) {
    return ev && ev.importance === 'high' && ev.type !== 'settlement' && ev.date === today;
  });
  if (todayHigh.length) {
    return { veto: true, reason: '今天有重大事件：' + todayHigh.map(function (ev) { return ev.note || ev.type; }).join('、') };
  }
  var o = sentiment && sentiment.overall;
  if (o && isFinite(Number(o.sentiment)) && isFinite(Number(o.confidence))) {
    var dir = pending.target === 'long' ? 1 : -1;
    var signed = Number(o.sentiment) * Number(o.confidence) * dir;
    if (signed <= TAIFEX_RULES.vetoSentiment) {
      return { veto: true, reason: '盤前輿情與進場方向強烈相反（' + Math.round(signed * 100) / 100 + '）' };
    }
  }
  return { veto: false };
}

// -------- token 管理 --------

function setTaifexIngestToken(body, authResult) {
  var hash = String((body && body.tokenHash) || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: 'invalid tokenHash' };
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  var createdAt = new Date().toISOString();
  PROP.setProperties({
    TAIFEX_INGEST_TOKEN_SHA256: hash,
    TAIFEX_INGEST_UID: authResult.uid,
    TAIFEX_INGEST_CREATED_AT: createdAt,
  });
  PROP.deleteProperty('TAIFEX_INGEST_LAST_USED_AT');
  return { ok: true, createdAt: createdAt };
}

function revokeTaifexIngestToken(body, authResult) {
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  ['TAIFEX_INGEST_TOKEN_SHA256', 'TAIFEX_INGEST_UID', 'TAIFEX_INGEST_CREATED_AT', 'TAIFEX_INGEST_LAST_USED_AT']
    .forEach(function (key) { PROP.deleteProperty(key); });
  return { ok: true };
}

function getTaifexIngestStatus(body, authResult) {
  var configured = !!PROP.getProperty('TAIFEX_INGEST_TOKEN_SHA256');
  return {
    ok: true,
    configured: configured,
    ownedByCaller: configured && !!authResult && PROP.getProperty('TAIFEX_INGEST_UID') === authResult.uid,
    createdAt: PROP.getProperty('TAIFEX_INGEST_CREATED_AT') || null,
    lastUsedAt: PROP.getProperty('TAIFEX_INGEST_LAST_USED_AT') || null,
  };
}

// -------- 推送入口 --------

function ingestTaifexSentimentWithToken_(body) {
  var expected = PROP.getProperty('TAIFEX_INGEST_TOKEN_SHA256');
  var token = String((body && body.ingestToken) || '');
  if (!expected || !TAIFEX_INGEST_TOKEN_PATTERN_.test(token)
      || !flightIngestSafeEqual_(flightIngestSha256Hex_(token), expected)) {
    return { ok: false, error: 'taifex-ingest-unauthorized' };
  }
  PROP.setProperty('TAIFEX_INGEST_LAST_USED_AT', new Date().toISOString());
  return applyTaifexSentimentIngest_(body, 'claude');
}

function importTaifexSentiment(body, authResult) {
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  return applyTaifexSentimentIngest_(body, 'claude-paste');
}

function tfIngestCounterKey_(date) {
  return 'TAIFEX_INGEST_COUNT_' + date.replace(/-/g, '');
}

function applyTaifexSentimentIngest_(body, provider) {
  if (JSON.stringify(body || {}).length > TAIFEX_INGEST_MAX_PAYLOAD_CHARS_) return { ok: false, error: 'payload too large' };
  var normalized = normalizeTaifexSentiment_(body);
  if (normalized.error) return { ok: false, error: normalized.error };

  var today = Utilities.formatDate(new Date(), TW_TZ, 'yyyy-MM-dd');
  var counterKey = tfIngestCounterKey_(today);
  var count = Number(PROP.getProperty(counterKey) || 0);
  if (count >= TAIFEX_INGEST_DAILY_LIMIT_) return { ok: false, error: '今日推送次數已達上限' };
  PROP.setProperty(counterKey, String(count + 1));
  PROP.deleteProperty(tfIngestCounterKey_(Utilities.formatDate(new Date(Date.now() - 86400000), TW_TZ, 'yyyy-MM-dd')));

  var docPath = 'taifex_sentiment/' + today;
  var existing = fsGetDoc_(docPath);
  var eventKeys = {};
  var events = [];
  normalized.entry.events.concat((existing && existing.events) || []).forEach(function (ev) {
    var key = ev.type + '|' + ev.date;
    if (eventKeys[key]) return;
    eventKeys[key] = true;
    events.push(ev);
  });
  var doc = {
    date: today,
    provider: provider,
    receivedAt: new Date(),
    pushCount: count + 1,
    overall: normalized.entry.overall,
    drivers: normalized.entry.drivers,
    events: events.sort(function (a, b) { return a.date.localeCompare(b.date); }).slice(0, 20),
    indicators: normalized.entry.indicators,
  };
  fsSetDoc_(docPath, doc, false);
  return { ok: true, date: today, events: events.length, warning: normalized.warning || undefined };
}
