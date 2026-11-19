/**
 * TaifexIntraday — 台指期盤中排程：日盤 08:45–13:45 與夜盤 15:00–隔日 05:00，每 5 分鐘。
 * 規劃見 docs/TAIFEX_PAPER_TRADING_PLAN.md §11（日線波段的盤中處理）、§12（盤中技術模擬）。
 *
 * - 報價：Fugle 期貨盤中 API（Script Property FUGLE_API_KEY，夜盤帶 session=afterhours）→ 期交所行情資訊網（MIS）
 *   → Yahoo ^TWII + 基差推估（只有日盤、標記 estimated）
 * - 休市：週末、證交所休市表（TaifexTechRun.gs）、報價時間超過 45 分鐘沒更新 → 都不模擬
 * - 日盤：主帳戶 + 策略變體跑 stepTaifexIntraday_（開盤成交待成交單、盤中停損、即時損益），主帳戶推播
 * - 日盤 + 夜盤：盤中技術模擬 runTaifexTech（4 個監控頻率的虛擬機器人）
 * - tick_taifex_intraday 由 tick_15min 自動安裝（ensureTaifexIntradayTrigger_），部署後不必手動重跑 setupTriggers
 */

var TAIFEX_INTRADAY_FN_ = 'tick_taifex_intraday';
/** 報價時間超過這麼久沒更新就視為沒在交易（臨時休市 / 來源停更）；Yahoo 台股延遲約 20 分鐘，所以抓寬一點 */
var TAIFEX_QUOTE_MAX_AGE_MIN_ = 45;

function tfNowHHmm_() {
  return Utilities.formatDate(new Date(), TW_TZ, 'HH:mm');
}

/** 5 分鐘 trigger 入口：時段外只讀快取就返回（幾乎不耗配額）；日盤共用同一筆報價 */
function tick_taifex_intraday() {
  var today = tfToday_();
  var hhmm = tfNowHHmm_();
  var holidays = {};
  // 休市表讀不到（Firestore 暫時失敗）時仍照週末規則跑，報價時間戳會擋掉真正的休市日
  try { holidays = loadTaifexHolidays_(); } catch (calErr) { console.error('loadTaifexHolidays_', calErr); }
  var sess = tfSessionAt_(today, hhmm, holidays);
  var quote = null;
  if (sess.session === 'day') {
    try {
      var res = runTaifexIntraday({ keepQuote: true });
      quote = res && res.rawQuote ? res.rawQuote : null;
    } catch (err) {
      console.error('tick_taifex_intraday', err);
      notifyError('taifexIntraday', err);
    }
  }
  try {
    runTaifexTech({ quote: quote, today: today, hhmm: hhmm, sess: sess });
  } catch (err2) {
    console.error('tick_taifex_tech', err2);
    notifyError('taifexTech', err2);
  }
}

/** tick_15min 每輪呼叫；6 小時內檢查過就跳過，不存在才建立 5 分鐘 trigger */
function ensureTaifexIntradayTrigger_() {
  var cache = CacheService.getScriptCache();
  if (cache.get('taifexIntradayTriggerOk')) return;
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === TAIFEX_INTRADAY_FN_; });
  if (!exists) ScriptApp.newTrigger(TAIFEX_INTRADAY_FN_).timeBased().everyMinutes(5).create();
  cache.put('taifexIntradayTriggerOk', '1', 21600);
}

// -------- 報價 --------

function tfFetchFugleQuote_(contract, session) {
  var key = PROP.getProperty('FUGLE_API_KEY');
  var symbol = tfFugleSymbol_(contract);
  if (!key || !symbol) return null;
  var url = 'https://api.fugle.tw/marketdata/v1.0/futopt/intraday/quote/' + encodeURIComponent(symbol)
    + (session === 'night' ? '?session=afterhours' : '');
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'X-API-KEY': key, Accept: 'application/json' },
  });
  if (resp.getResponseCode() !== 200) {
    console.warn('fugle quote HTTP ' + resp.getResponseCode(), resp.getContentText().slice(0, 200));
    return null;
  }
  return tfParseFugleQuote_(JSON.parse(resp.getContentText()));
}

/** 期交所行情資訊網（公開、免金鑰）：MarketType 0 = 日盤、1 = 夜盤。非正式 API，欄位改版時用 diagTaifexQuote 排查 */
function tfFetchMisQuote_(contract, session) {
  var resp = UrlFetchApp.fetch('https://mis.taifex.com.tw/futures/api/getQuoteList', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)', Accept: 'application/json' },
    payload: JSON.stringify({
      MarketType: session === 'night' ? '1' : '0', SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '',
      RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A',
    }),
  });
  if (resp.getResponseCode() !== 200) {
    console.warn('taifex mis HTTP ' + resp.getResponseCode(), resp.getContentText().slice(0, 200));
    return null;
  }
  return tfParseMisQuote_(JSON.parse(resp.getContentText()), tfFugleSymbol_(contract));
}

function tfFetchYahooSpotQuote_(futuresPrevClose) {
  var resp = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=5m&range=1d', {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)', Accept: 'application/json' },
  });
  if (resp.getResponseCode() !== 200) return null;
  return tfParseYahooSpot_(JSON.parse(resp.getContentText()), futuresPrevClose);
}

/**
 * 今天的近月：結算日當天換到次月。換月時參考價（期貨昨收）改用次月昨收，盤中換月價差 = 次月昨收 − 近月昨收。
 */
function tfTodayContract_(context, today) {
  var pick = tfPickFrontContracts_(today, [context.contract, context.nextContract].filter(Boolean));
  var rolled = !!pick.front && pick.front !== context.contract && pick.front === context.nextContract && tfNum_(context.nextClose) !== null;
  return {
    contract: pick.front || context.contract,
    prevClose: rolled ? context.nextClose : context.lastClose,
    gap: rolled ? context.nextClose - context.lastClose : 0,
  };
}

/**
 * 取一筆台指期近月報價。session: 'day' | 'night'；date = 時段開始日。
 * 依序 Fugle → 期交所 MIS → Yahoo 現貨 + 基差（只有日盤且有日 K 快取時）。
 * 與昨收差距超過 15% 的報價視為解析錯誤直接丟棄，避免錯價成交。
 */
function fetchTaifexQuote_(context, date, session) {
  context = context || {};
  session = session || 'day';
  var front = context.contract ? tfTodayContract_(context, date) : { contract: tfFrontContractFor_(date), prevClose: null, gap: 0 };
  // 日 K 快取太舊（近月、次月都已到期）→ 直接由日期推算近月，參考價不可信就不用
  var expiry = tfContractExpiry_(front.contract);
  if (!expiry || expiry <= date) front = { contract: tfFrontContractFor_(date), prevClose: null, gap: 0 };
  var ref = tfNum_(front.prevClose);
  var quote = null;
  var tried = [];
  function attempt(name, fn) {
    if (quote) return;
    try {
      var q = fn();
      if (q && tfQuoteSane_(q, ref)) quote = q;
      else tried.push(name + (q ? ':insane' : ':empty'));
    } catch (err) {
      console.warn(name + ' quote', err);
      tried.push(name + ':error');
    }
  }
  attempt('fugle', function () { return tfFetchFugleQuote_(front.contract, session); });
  attempt('mis', function () { return tfFetchMisQuote_(front.contract, session); });
  if (session === 'day' && ref !== null) attempt('yahoo', function () { return tfFetchYahooSpotQuote_(ref); });
  if (!quote) {
    console.warn('taifex quote unavailable', tried.join(','));
    return null;
  }
  quote.date = tfToday_();
  quote.time = tfNowHHmm_();
  quote.contract = front.contract;
  quote.gap = front.gap;
  if (tfNum_(quote.prevClose) === null) quote.prevClose = ref;
  return quote;
}

// -------- 盤中流程 --------

function runTaifexIntraday(opts) {
  opts = opts || {};
  var today = tfToday_();
  var live = tfStrip_(fsGetDoc_(TAIFEX_LIVE_PATH_)) || {};
  var context = live.context;
  if (!context || !context.lastDate) return { ok: false, error: '尚未有日 K 快取，請先執行每日更新' };
  var config = loadTaifexConfig_();
  if (!config.intradayEnabled && !opts.force) return { ok: true, skipped: 'intraday-disabled' };
  // 快取的最後一根必須是今天之前的交易日；今天收盤後的 18:00 才會更新成今天
  if (context.lastDate >= today) return { ok: true, skipped: 'already-closed' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: '另一個台指期排程正在執行' };
  try {
    // 國定假日（平日）不模擬：否則 Yahoo 會回前一個交易日的價格，待成交單會被錯價成交
    var closed = tfClosedReason_(today, loadTaifexHolidays_());
    if (closed) return { ok: true, skipped: 'market-closed', reason: closed.holidayName || closed.reason };
    var quote = fetchTaifexQuote_(context, today, 'day');
    if (!quote) return { ok: false, error: '取不到即時報價' };
    if (!tfQuoteFresh_(quote, Date.now(), TAIFEX_QUOTE_MAX_AGE_MIN_)) {
      return { ok: true, skipped: 'stale-quote', rawQuote: opts.keepQuote ? quote : undefined };
    }
    var optimized = loadTaifexOptimizedParams_();
    var tuned = tfTunedParams_(loadTaifexTuning_());
    var summary = {};
    var mainEvents = [];
    var mainTrades = [];
    var mainAccount = null;
    [TAIFEX_ACCOUNT_ID_].concat(Object.keys(TAIFEX_VARIANTS).map(tfVariantAccountId_)).forEach(function (id) {
      var account = loadTaifexAccountAt_(id);
      if (!account || !account.lastBarDate || account.lastBarDate !== context.lastDate) return;
      var isMain = id === TAIFEX_ACCOUNT_ID_;
      var params = isMain ? tfVariantParams_(config.strategyVariant, optimized, tuned) : tfVariantParams_(account.variant || id.replace(/^v_/, ''), optimized, tuned);
      var accConfig = tfAccountConfig_(isMain ? config : tfVariantConfig_(config), account);
      var res = stepTaifexIntraday_(account, quote, { config: accConfig, params: params, gap: quote.gap, atr: context.atr20 });
      var keep = { startedAt: account.startedAt, lastVeto: account.lastVeto || null, ticket: account.ticket || null };
      var next = res.state;
      Object.keys(keep).forEach(function (k) { next[k] = keep[k]; });
      if (res.trades.length) tfSaveTrades_(res.trades, next.epoch, id);
      saveTaifexAccountAt_(id, next);
      summary[id] = { events: res.events.map(function (e) { return e.type; }), equity: next.equity, unrealized: next.live && next.live.unrealized };
      if (isMain) { mainEvents = res.events; mainTrades = res.trades; mainAccount = next; }
    });

    live.quote = {
      date: quote.date,
      time: quote.time,
      contract: quote.contract,
      last: quote.last,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      prevClose: quote.prevClose,
      basis: quote.basis === undefined ? null : quote.basis,
      estimated: !!quote.estimated,
      source: quote.source,
    };
    live.quoteUpdatedAt = new Date();
    fsSetDoc_(TAIFEX_LIVE_PATH_, live, false);

    if (mainAccount && config.notifyEnabled && mainEvents.length) {
      try { notifyTaifexIntraday_(mainAccount, quote, mainEvents, mainTrades); } catch (err) { console.error('notifyTaifexIntraday_', err); }
    }
    return { ok: true, quote: live.quote, accounts: summary, rawQuote: opts.keepQuote ? quote : undefined };
  } finally {
    lock.releaseLock();
  }
}

var TAIFEX_SIDE_SHORT_ = { long: '多單', short: '空單' };

function notifyTaifexIntraday_(account, quote, events, trades) {
  var lines = [];
  var est = quote.estimated ? '（推估價）' : '';
  events.forEach(function (e) {
    if (e.type === 'fill') {
      var pos = account.position;
      lines.push('虛擬成交 ' + e.time + '｜' + (e.mode === 'open' ? '開盤價 ' : '即時價 ') + e.price + est
        + (pos ? '｜持倉 ' + TAIFEX_SIDE_SHORT_[pos.side] + ' ' + pos.contracts + ' 口，停損 ' + pos.stop : '｜已空手'));
      if (pos) lines.push('→ 實單請掛停損單 ' + pos.stop + '（' + (pos.side === 'long' ? '賣出' : '買進') + ' ' + pos.contracts + ' 口 STP）');
    } else if (e.type === 'stop') {
      var t = trades.filter(function (x) { return x.exitReason === 'stop'; })[0];
      lines.push('停損出場 ' + e.time + '｜' + e.price + est + (t ? '｜淨損益 ' + (t.netPnl > 0 ? '+' : '') + t.netPnl.toLocaleString('en-US') + ' 元' : ''));
    } else if (e.type === 'near_stop') {
      lines.push('接近停損 ' + e.time + '｜最新 ' + e.price + est + '，停損 ' + e.stop + '（剩 ' + e.distance + ' 點）');
    } else if (e.type === 'roll') {
      lines.push('換月：價差 ' + e.gap + ' 點，扣換月成本 ' + e.cost + ' 元');
    }
  });
  if (!lines.length) return { ok: true, skipped: true };
  return sendNotification_('taifex', ['【台指期模擬｜盤中】' + quote.date + ' ' + quote.contract].concat(lines)
    .concat(['僅虛擬交易，不構成投資建議。']).join('\n'), undefined, { title: '台指期盤中通知', severity: events.some(function (e) { return e.type === 'stop'; }) ? 'warning' : 'info' });
}

/** owner 診斷：目前時段、休市表、三個報價來源各試一次（日盤 / 夜盤），回傳解析結果（欄位改版時排查用） */
function diagTaifexQuote() {
  var live = tfStrip_(fsGetDoc_(TAIFEX_LIVE_PATH_)) || {};
  var context = live.context || {};
  var today = tfToday_();
  var hhmm = tfNowHHmm_();
  var holidays = loadTaifexHolidays_();
  var sess = tfSessionAt_(today, hhmm, holidays);
  var date = sess.session ? sess.date : today;
  var front = context.contract ? tfTodayContract_(context, date) : { contract: tfFrontContractFor_(date), prevClose: null };
  var out = {
    ok: true, today: today, time: hhmm, session: sess, nextSession: tfNextSession_(today, hhmm, holidays),
    holidays: Object.keys(holidays).sort().map(function (d) { return d + ' ' + holidays[d]; }),
    context: context, front: front, hasFugleKey: !!PROP.getProperty('FUGLE_API_KEY'),
  };
  var session = sess.session || 'day';
  try { out.fugle = tfFetchFugleQuote_(front.contract, session); } catch (err) { out.fugleError = String(err && err.message || err); }
  try { out.mis = tfFetchMisQuote_(front.contract, session); } catch (err3) { out.misError = String(err3 && err3.message || err3); }
  try { out.yahoo = front.prevClose ? tfFetchYahooSpotQuote_(front.prevClose) : null; } catch (err2) { out.yahooError = String(err2 && err2.message || err2); }
  return out;
}
