/**
 * TaifexTechRun — 台指期「盤中技術模擬」的排程與資料存取（純函式在 TaifexTech.gs）。
 * 規劃見 docs/TAIFEX_PAPER_TRADING_PLAN.md §12。
 *
 * 資料都放在既有的 taifex_live collection（Rules：owner 唯讀、只有 Apps Script 能寫）：
 * - taifex_live/tech         狀態（目前時段 / 休市原因 / 下次開盤）、4 個監控頻率的機器人、各時段摘要
 * - taifex_live/tech_bars    5 分 K（最多 960 根，約 4 個交易日）
 * - taifex_live/tech_trades  最近 400 筆模擬交易
 * - taifex_live/calendar     證交所休市表快取（每週更新）
 *
 * 每 5 分鐘一輪：約 3 讀（狀態、K 棒、設定）+ 2 寫；有成交時多 1 讀 1 寫。休市與時段外只讀 CacheService。
 */

var TAIFEX_TECH_PATH_ = 'taifex_live/tech';
var TAIFEX_TECH_BARS_PATH_ = 'taifex_live/tech_bars';
var TAIFEX_TECH_TRADES_PATH_ = 'taifex_live/tech_trades';
var TAIFEX_CALENDAR_PATH_ = 'taifex_live/calendar';
var TAIFEX_TECH_MAX_TRADES_ = 400;
var TAIFEX_HOLIDAY_URL_ = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';

// -------- 休市表 --------

function tfFetchTwseHolidays_() {
  var resp = UrlFetchApp.fetch(TAIFEX_HOLIDAY_URL_, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)', Accept: 'application/json' },
  });
  if (resp.getResponseCode() !== 200) throw new Error('證交所休市表 HTTP ' + resp.getResponseCode());
  var parsed = tfParseTwseHolidays_(JSON.parse(resp.getContentText()));
  if (!Object.keys(parsed).length) throw new Error('證交所休市表解析不到任何日期');
  return parsed;
}

/**
 * 休市表 { 'yyyy-MM-dd': 名稱 }：CacheService（6 小時）→ taifex_live/calendar（7 天內）→ 重新抓證交所 OpenAPI。
 * 抓不到時用舊資料 + 固定日期國定假日；再合併設定裡的自訂休市日。force = true 一律重抓。
 */
function loadTaifexHolidays_(force) {
  var cache = CacheService.getScriptCache();
  if (!force) {
    var hit = cache.get('taifexHolidays');
    if (hit) {
      try { return JSON.parse(hit); } catch (err) { console.warn('taifexHolidays cache', err); }
    }
  }
  var today = tfToday_();
  var year = Number(today.slice(0, 4));
  var doc = tfStrip_(fsGetDoc_(TAIFEX_CALENDAR_PATH_)) || {};
  var fetchedAt = doc.fetchedAt ? new Date(doc.fetchedAt).getTime() : 0;
  var fresh = doc.year === year && doc.source === 'twse' && Date.now() - fetchedAt < 7 * 86400000;
  var holidays = doc.holidays && typeof doc.holidays === 'object' ? doc.holidays : {};
  if (force || !fresh) {
    var source = 'twse';
    try {
      var fetched = tfFetchTwseHolidays_();
      // 跨年時 API 換成新年度：保留舊年度已知的日期
      Object.keys(holidays).forEach(function (d) { if (!fetched[d] && d.slice(0, 4) !== String(year)) fetched[d] = holidays[d]; });
      holidays = fetched;
    } catch (err2) {
      console.warn('loadTaifexHolidays_', err2);
      source = 'fallback';
    }
    var fixed = tfFixedHolidays_(year);
    Object.keys(fixed).forEach(function (d) { if (!holidays[d]) holidays[d] = fixed[d]; });
    // 抓失敗也寫回（source = fallback），避免每 5 分鐘重打；一小時後由快取過期再試
    fsSetDoc_(TAIFEX_CALENDAR_PATH_, { year: year, holidays: holidays, source: source, fetchedAt: new Date() }, false);
    if (source === 'fallback') {
      var merged0 = tfMergeExtraHolidays_(holidays);
      cache.put('taifexHolidays', JSON.stringify(merged0), 3600);
      return merged0;
    }
  }
  var merged = tfMergeExtraHolidays_(holidays);
  cache.put('taifexHolidays', JSON.stringify(merged), 21600);
  return merged;
}

function tfMergeExtraHolidays_(holidays) {
  var out = {};
  Object.keys(holidays).forEach(function (d) { out[d] = holidays[d]; });
  var raw = tfStrip_(fsGetDoc_(TAIFEX_CONFIG_PATH_)) || {};
  tfNormalizeTechConfig_(raw.tech).extraHolidays.forEach(function (d) { if (!out[d]) out[d] = '自訂休市'; });
  return out;
}

// -------- 狀態 --------

/**
 * 只更新狀態欄位（休市 / 時段外 / 取不到報價）。同一個狀態只寫一次（CacheService 記住上次寫的內容），
 * 所以休市的整個週末只會多一次寫入。
 */
function tfTechWriteStatus_(status) {
  var cache = CacheService.getScriptCache();
  var sig = [status.state, status.reason || '', status.sessionKey || '', status.next ? status.next.date + status.next.session : ''].join('|');
  if (cache.get('taifexTechStatus') === sig) return false;
  status.updatedAt = new Date();
  fsSetDoc_(TAIFEX_TECH_PATH_, { status: status }, true);
  cache.put('taifexTechStatus', sig, 21600);
  return true;
}

var TAIFEX_CLOSED_LABELS_ = { weekend: '週末休市', holiday: '國定假日休市', break: '非交易時段' };

/**
 * 盤中技術模擬一輪。opts: { quote（日盤可沿用日線波段那筆報價）, today, hhmm, sess, force（手動觸發，忽略開關） }。
 * 休市、時段外、功能關閉、報價過期都不會動到機器人，只更新狀態。
 */
function runTaifexTech(opts) {
  opts = opts || {};
  var today = opts.today || tfToday_();
  var hhmm = opts.hhmm || tfNowHHmm_();
  var holidays = loadTaifexHolidays_();
  var sess = opts.sess || tfSessionAt_(today, hhmm, holidays);
  var next = tfNextSession_(today, hhmm, holidays);
  var base = { date: today, time: hhmm, next: next };

  if (!sess.session) {
    tfTechWriteStatus_(Object.assign({ state: 'closed', reason: sess.reason, label: sess.holidayName || TAIFEX_CLOSED_LABELS_[sess.reason] || '休市' }, base));
    return { ok: true, skipped: 'market-closed', reason: sess.reason, holidayName: sess.holidayName || null, next: next };
  }
  base.session = sess.session;
  base.sessionKey = sess.key;

  var rawConfig = tfStrip_(fsGetDoc_(TAIFEX_CONFIG_PATH_)) || {};
  var tech = tfNormalizeTechConfig_(rawConfig.tech);
  if (!opts.force && (!tech.enabled || !tech[sess.session])) {
    tfTechWriteStatus_(Object.assign({ state: 'disabled', reason: tech.enabled ? sess.session + '-off' : 'off', label: '模擬已關閉' }, base));
    return { ok: true, skipped: 'disabled' };
  }
  var config = tfNormalizeConfig_(rawConfig);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: '另一個台指期排程正在執行' };
  try {
    var quote = opts.quote || null;
    if (!quote) {
      var live = tfStrip_(fsGetDoc_(TAIFEX_LIVE_PATH_)) || {};
      quote = fetchTaifexQuote_(live.context, sess.date, sess.session);
    }
    if (!quote) {
      tfTechWriteStatus_(Object.assign({ state: 'no-quote', reason: 'no-quote', label: sess.session === 'night' ? '取不到夜盤報價' : '取不到報價' }, base));
      return { ok: false, error: sess.session === 'night'
        ? '取不到夜盤報價（需要 FUGLE_API_KEY 或期交所行情資訊網可連線；可用 diagTaifexQuote 排查）'
        : '取不到即時報價' };
    }
    if (!tfQuoteFresh_(quote, Date.now(), TAIFEX_QUOTE_MAX_AGE_MIN_)) {
      tfTechWriteStatus_(Object.assign({ state: 'stale', reason: 'stale-quote', label: '報價沒有更新（可能臨時休市）' }, base));
      return { ok: true, skipped: 'stale-quote' };
    }

    var state = tfStrip_(fsGetDoc_(TAIFEX_TECH_PATH_));
    if (!state || !state.bots) state = Object.assign(tfTechNewState_(), { startedAt: new Date() });
    var barsDoc = tfStrip_(fsGetDoc_(TAIFEX_TECH_BARS_PATH_)) || {};
    var res = tfTechStep_(state, Array.isArray(barsDoc.bars) ? barsDoc.bars : [], quote, sess, {
      config: config, contracts: tech.contracts, estimated: !!quote.estimated, rules: loadTaifexTuning_().tech,
    });

    var next2 = res.state;
    next2.startedAt = state.startedAt || new Date();
    next2.product = config.product;
    next2.contracts = tech.contracts;
    next2.updatedAt = new Date();
    next2.status = Object.assign({
      state: 'running', reason: null, label: sess.session === 'day' ? '日盤交易中' : '夜盤交易中',
      m: sess.m, toClose: sess.toClose, price: quote.last, contract: quote.contract || null,
      source: quote.source || null, estimated: !!quote.estimated, updatedAt: new Date(),
    }, base);
    CacheService.getScriptCache().put('taifexTechStatus', 'running|' + sess.key, 21600);

    fsSetDoc_(TAIFEX_TECH_BARS_PATH_, { bars: res.bars, updatedAt: new Date() }, false);
    fsSetDoc_(TAIFEX_TECH_PATH_, next2, false);
    if (res.trades.length) tfTechSaveTrades_(res.trades, next2.epoch);
    if (tech.notify && res.events.length) {
      try { notifyTaifexTech_(res.events, quote, sess); } catch (err) { console.error('notifyTaifexTech_', err); }
    }
    return {
      ok: true, session: sess.session, time: hhmm, price: quote.last, source: quote.source, bars: res.bars.length,
      trades: res.trades.length, events: res.events.map(function (e) { return e.bot + ':' + e.type; }),
    };
  } finally {
    lock.releaseLock();
  }
}

function tfTechSaveTrades_(trades, epoch) {
  var doc = tfStrip_(fsGetDoc_(TAIFEX_TECH_TRADES_PATH_)) || {};
  var list = Array.isArray(doc.trades) ? doc.trades : [];
  trades.forEach(function (t) {
    t.epoch = epoch || 1;
    t.modelVersion = TAIFEX_TECH_VERSION;
    list.push(t);
  });
  fsSetDoc_(TAIFEX_TECH_TRADES_PATH_, { trades: list.slice(-TAIFEX_TECH_MAX_TRADES_), updatedAt: new Date() }, false);
}

var TAIFEX_TECH_REASON_LABELS_ = { signal: '訊號', stop: '停損', reverse: '反手', session_end: '收盤平倉' };

function notifyTaifexTech_(events, quote, sess) {
  var est = quote.estimated ? '（推估價）' : '';
  var lines = events.map(function (e) {
    var who = e.bot.replace(/^m/, '') + ' 分';
    if (e.type === 'enter') return who + '｜進場 ' + TAIFEX_SIDE_SHORT_[e.side] + ' ' + e.price + est + '｜停損 ' + e.stop + '｜分數 ' + e.score;
    return who + '｜' + (TAIFEX_TECH_REASON_LABELS_[e.reason] || e.reason) + '出場 ' + TAIFEX_SIDE_SHORT_[e.side] + ' ' + e.price + est
      + '｜淨損益 ' + (e.netPnl > 0 ? '+' : '') + Number(e.netPnl).toLocaleString('en-US') + ' 元';
  });
  return sendNotification_('taifex', ['【台指期技術模擬｜' + (sess.session === 'day' ? '日盤' : '夜盤') + '】' + tfToday_() + ' ' + tfNowHHmm_()]
    .concat(lines).concat(['僅虛擬交易，不構成投資建議。']).join('\n'), undefined, { title: '台指期技術模擬', severity: 'info' });
}

/** 手動觸發一次（前端按鈕）：休市 / 時段外不會模擬，只回報狀態 */
function runTaifexTechManual() {
  return runTaifexTech({ force: true });
}

/** 重置：清掉機器人、交易與 5 分 K，重新累積（epoch + 1）。調整演算法升版後用 */
function resetTaifexTech() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: '另一個台指期排程正在執行' };
  try {
    var prev = tfStrip_(fsGetDoc_(TAIFEX_TECH_PATH_)) || {};
    var fresh = tfTechNewState_();
    fresh.epoch = (prev.epoch || 0) + 1;
    fresh.startedAt = new Date();
    fresh.updatedAt = new Date();
    fresh.status = prev.status || null;
    fsSetDoc_(TAIFEX_TECH_PATH_, fresh, false);
    fsSetDoc_(TAIFEX_TECH_TRADES_PATH_, { trades: [], updatedAt: new Date() }, false);
    // 5 分 K 保留：指標不必重新暖機，重置後下一個監控點就能繼續決策
    CacheService.getScriptCache().remove('taifexTechStatus');
    return { ok: true, epoch: fresh.epoch };
  } finally {
    lock.releaseLock();
  }
}

/** 設定頁改了自訂休市日之後呼叫：清掉快取並重抓證交所休市表 */
function refreshTaifexCalendar() {
  CacheService.getScriptCache().remove('taifexHolidays');
  var holidays = loadTaifexHolidays_(true);
  var today = tfToday_();
  var upcoming = Object.keys(holidays).filter(function (d) { return d >= today; }).sort();
  return { ok: true, count: Object.keys(holidays).length, upcoming: upcoming.slice(0, 12).map(function (d) { return { date: d, name: holidays[d] }; }) };
}
