/**
 * TaifexPaper — 台指期虛擬交易的排程與帳戶操作（規劃見 docs/TAIFEX_PAPER_TRADING_PLAN.md §4–§5）。
 *
 * - runTaifexDaily：抓期交所資料 → 逐根處理新 K 棒（stepTaifexAccount_）→ 寫訊號 → 自動模式產生待成交單 → 推播
 * - taifexPreOpenReview：08:00 依盤前輿情否決「新增曝險」的待成交單
 * - placeTaifexOrder / cancelTaifexOrder / resetTaifexPaper / resumeTaifexPaper：前端操作（Firebase + owner）
 * - runTaifexBacktest：完整策略 / 純趨勢 / 大盤三組對照
 *
 * 只寫虛擬帳戶，不接券商、不碰 portfolio。帳戶、訊號、交易紀錄的 Rules 都是 write: false，
 * 只有這裡（service account）能寫，績效無法被手動改寫。
 */

var TAIFEX_ACCOUNT_ID_ = 'default';
var TAIFEX_ACCOUNT_PATH_ = 'taifex_paper_accounts/default';
var TAIFEX_LIVE_PATH_ = 'taifex_live/current';
var TAIFEX_OPT_PATH_ = 'taifex_optimizations/latest';
var TAIFEX_CONFIG_PATH_ = 'taifex_configs/default';
var TAIFEX_CURVE_MAX_ = 750;
var TAIFEX_BACKFILL_MONTHS_ = 24;
var TAIFEX_MIN_BARS_ = 80;

function tfToday_() {
  return Utilities.formatDate(new Date(), TW_TZ, 'yyyy-MM-dd');
}

function tfDaysAgo_(days) {
  return Utilities.formatDate(new Date(Date.now() - days * 86400000), TW_TZ, 'yyyy-MM-dd');
}

function tfStrip_(doc) {
  if (!doc) return null;
  var out = {};
  Object.keys(doc).forEach(function (k) { if (k !== '_name') out[k] = doc[k]; });
  return out;
}

function loadTaifexConfig_() {
  var raw = tfStrip_(fsGetDoc_(TAIFEX_CONFIG_PATH_)) || {};
  var config = tfNormalizeConfig_(raw);
  // 這兩個欄位不影響策略公式，放在 tfNormalizeConfig_ 外面（黃金測試資料不受影響）
  config.strategyVariant = TAIFEX_VARIANTS[raw.strategyVariant] ? raw.strategyVariant : 'baseline';
  config.intradayEnabled = raw.intradayEnabled !== false;
  return config;
}

/** 策略變體帳戶：手動模式也照樣自動跟單（它們是用來比較參數的實驗組） */
function tfVariantConfig_(config) {
  var c = {};
  Object.keys(config).forEach(function (k) { c[k] = config[k]; });
  c.mode = 'auto';
  return c;
}

function tfVariantAccountId_(key) {
  return 'v_' + key;
}

function tfVariantParams_(key, optimized, tuned) {
  var v = TAIFEX_VARIANTS[key] || TAIFEX_VARIANTS.baseline;
  if (key === 'optimized') return optimized || {};
  if (key === 'tuned') return tuned || {};
  return v.params || {};
}

/** 每週最佳化選出的參數（樣本內報酬最大、回撤受限）；還沒跑過就用基準 */
function loadTaifexOptimizedParams_() {
  var doc = fsGetDoc_(TAIFEX_OPT_PATH_);
  return doc && doc.best && doc.best.params ? doc.best.params : null;
}

/** 帳戶用建立當下的契約與資金；設定改契約要重置帳戶才生效（避免持倉中每點價值被換掉） */
function tfAccountConfig_(config, account) {
  if (!account || !account.product) return config;
  var raw = {};
  Object.keys(config).forEach(function (k) { raw[k] = config[k]; });
  raw.product = account.product;
  if (account.product !== config.product) {
    raw.commissionPerSide = TAIFEX_PRODUCTS[account.product].commission;
    raw.marginPerContract = TAIFEX_PRODUCTS[account.product].margin;
  }
  return tfNormalizeConfig_(raw);
}

function loadTaifexAccount_() {
  return loadTaifexAccountAt_(TAIFEX_ACCOUNT_ID_);
}

function loadTaifexAccountAt_(id) {
  return tfStrip_(fsGetDoc_('taifex_paper_accounts/' + id));
}

function saveTaifexAccount_(account) {
  saveTaifexAccountAt_(TAIFEX_ACCOUNT_ID_, account);
}

function saveTaifexAccountAt_(id, account) {
  account.updatedAt = new Date();
  account.modelVersion = TAIFEX_MODEL_VERSION;
  if (Array.isArray(account.equityCurve) && account.equityCurve.length > TAIFEX_CURVE_MAX_) {
    account.equityCurve = account.equityCurve.slice(-TAIFEX_CURVE_MAX_);
  }
  fsSetDoc_('taifex_paper_accounts/' + id, account, false);
}

function loadTaifexSentiment_(date) {
  return tfStrip_(fsGetDoc_('taifex_sentiment/' + date));
}

function tfNewAccountDoc_(config, bar, epoch) {
  var state = tfNewAccount_(config, bar ? bar.date : null);
  state.lastClose = bar ? bar.close : null;
  state.product = config.product;
  state.epoch = epoch || 1;
  state.startedAt = new Date();
  state.startDate = bar ? bar.date : null;
  state.equityCurve = bar ? [{ d: bar.date, e: state.equity, p: 0, c: bar.close }] : [];
  state.lastVeto = null;
  return state;
}

function tfSaveTrades_(trades, epoch, accountId) {
  trades.forEach(function (t) {
    t.epoch = epoch || 1;
    t.accountId = accountId || TAIFEX_ACCOUNT_ID_;
    t.modelVersion = TAIFEX_MODEL_VERSION;
    t.createdAt = new Date();
    fsAddDoc_('taifex_paper_trades', t);
  });
}

/** 確保日 K 足夠；不足就回補 TAIFEX_BACKFILL_MONTHS_ 個月，否則只補最近 10 天 */
function tfEnsureBars_(forceMonths) {
  var bars = loadTaifexBars_();
  var errors = [];
  var from;
  if (forceMonths) from = tfDaysAgo_(Math.min(36, forceMonths) * 31);
  else if (bars.length < TAIFEX_MIN_BARS_) from = tfDaysAgo_(TAIFEX_BACKFILL_MONTHS_ * 31);
  else from = tfDaysAgo_(10);
  var synced = syncTaifexRange_(from, tfToday_());
  errors = errors.concat(synced.errors);
  if (synced.bars.length) {
    var byDate = {};
    bars.forEach(function (b) { byDate[b.date] = b; });
    synced.bars.forEach(function (b) { byDate[b.date] = b; });
    bars = Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
  }
  return { bars: bars, errors: errors, synced: synced.bars.length };
}

function tfSignalDoc_(signal, extra) {
  var doc = {};
  Object.keys(signal).forEach(function (k) { doc[k] = signal[k]; });
  Object.keys(extra).forEach(function (k) { doc[k] = extra[k]; });
  doc.modelVersion = TAIFEX_MODEL_VERSION;
  doc.generatedAt = new Date();
  return doc;
}

function tfPositionSnapshot_(position) {
  if (!position) return null;
  return {
    side: position.side,
    contracts: position.contracts,
    entryPrice: tfRound_(position.entryPrice, 1),
    stop: position.stop,
    entryDate: position.entryDate,
  };
}

/** 每日排程入口（18:00）；手動「立即更新」也走這裡 */
function runTaifexDaily(opts) {
  opts = opts || {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: '另一個台指期排程正在執行' };
  try {
    return runTaifexDailyNoLock_(opts);
  } finally {
    lock.releaseLock();
  }
}

function runTaifexDailyNoLock_(opts) {
  var ensured = tfEnsureBars_(opts.backfillMonths);
  var bars = ensured.bars;
  if (bars.length < TAIFEX_MIN_BARS_) {
    return { ok: false, error: '期交所日 K 不足（' + bars.length + ' 根），請稍後再試或執行 diagTaifex 排查', errors: ensured.errors };
  }
  var series = tfPrepareSeries_(bars);
  var config = loadTaifexConfig_();
  var optimized = loadTaifexOptimizedParams_();
  var tuned = tfTunedParams_(loadTaifexTuning_());
  var sentimentCache = {};
  var loadSentiment = function (date) {
    if (!sentimentCache[date]) sentimentCache[date] = loadTaifexSentiment_(date) || {};
    return sentimentCache[date];
  };

  var main = tfProcessAccountBars_(TAIFEX_ACCOUNT_ID_, bars, series, {
    config: config,
    params: tfVariantParams_(config.strategyVariant, optimized, tuned),
    variant: config.strategyVariant,
    writeSignals: true,
    loadSentiment: loadSentiment,
  });

  // 策略競賽：同樣的資金與成本，各變體各自一個虛擬帳戶（自動模式、不推播），用來比較哪組參數報酬最高
  var variantResults = {};
  Object.keys(TAIFEX_VARIANTS).forEach(function (key) {
    try {
      var r = tfProcessAccountBars_(tfVariantAccountId_(key), bars, series, {
        config: tfVariantConfig_(config),
        params: tfVariantParams_(key, optimized, tuned),
        variant: key,
        writeSignals: false,
        loadSentiment: loadSentiment,
      });
      variantResults[key] = { processed: r.processed, trades: r.trades.length, equity: r.account.equity };
    } catch (err) {
      console.error('taifex variant ' + key, err);
      variantResults[key] = { error: String(err && err.message || err) };
    }
  });

  saveTaifexLiveContext_(bars, series);

  if (main.processed && config.notifyEnabled && main.lastSignal) {
    try {
      notifyTaifex_(main.account, main.lastSignal, main.lastPlan, main.trades, main.events, main.created);
    } catch (err) { console.error('notifyTaifex_', err); }
  }
  return {
    ok: true,
    processed: main.processed,
    created: main.created,
    latestDate: bars[bars.length - 1].date,
    synced: ensured.synced,
    trades: main.trades.length,
    variants: variantResults,
    errors: ensured.errors,
  };
}

/** 自動模式產生的待成交單：依「現在」時間決定最早可成交日（補跑時若已過開盤，就不能回溯成交） */
function tfStampPending_(pending) {
  if (!pending) return null;
  var now = new Date();
  var out = Object.assign({ createdAt: now }, pending);
  out.validFrom = tfOrderValidFrom_(tfToday_(), Utilities.formatDate(now, TW_TZ, 'HH:mm'));
  return out;
}

/**
 * 處理一個虛擬帳戶的新 K 棒（主帳戶與策略變體共用）。
 * opts: { config, params, variant, writeSignals, loadSentiment }
 */
function tfProcessAccountBars_(accountId, bars, series, opts) {
  var config = opts.config;
  var account = loadTaifexAccountAt_(accountId);
  var lastIndex = bars.length - 1;
  var toProcess = [];
  var created = false;
  if (!account) {
    account = tfNewAccountDoc_(config, bars[lastIndex], 1);
    toProcess.push({ index: lastIndex, stepped: false });
    created = true;
  } else {
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].date > account.lastBarDate) toProcess.push({ index: i, stepped: true });
    }
  }
  account.variant = opts.variant || 'baseline';
  account.params = tfParams_(opts.params);
  var paramWeights = tfParamWeights_(opts.params);
  if (paramWeights) account.params.weights = paramWeights;
  var accConfig = tfAccountConfig_(config, account);
  var trades = [];
  var events = [];
  var lastSignal = null;
  var lastPlan = null;

  toProcess.forEach(function (item) {
    var idx = item.index;
    var bar = bars[idx];
    if (item.stepped) {
      var skipGap = !!(account.intraday && account.intraday.date === bar.date && account.intraday.gapApplied);
      var res = stepTaifexAccount_(account, bar, {
        gap: series.gaps[idx], atr: series.atr20[idx], config: accConfig, params: opts.params, skipGap: skipGap,
      });
      var keep = { startedAt: account.startedAt, lastVeto: account.lastVeto || null };
      account = res.state;
      Object.keys(keep).forEach(function (k) { account[k] = keep[k]; });
      account.live = null;
      trades = trades.concat(res.trades);
      events = events.concat(res.events);
      account.equityCurve = account.equityCurve || [];
      account.equityCurve.push({
        d: bar.date,
        e: account.equity,
        p: account.position ? (account.position.side === 'long' ? 1 : -1) * account.position.contracts : 0,
        c: bar.close,
      });
    }
    var sentiment = opts.loadSentiment(bar.date);
    var signal = tfSignalAt_(series, idx, { sentiment: sentiment, params: opts.params });
    var risk = tfEventRisk_(sentiment, bar.date);
    var plan = tfPlanNextOrder_(account, signal, { config: accConfig, eventRisk: risk.risk, params: opts.params });
    var manualPending = account.pending && account.pending.source === 'manual';
    var autoMode = accConfig.mode === 'auto' || !opts.writeSignals;
    if (autoMode && !manualPending) account.pending = tfStampPending_(plan.pending);
    lastSignal = signal;
    lastPlan = plan;
    if (opts.writeSignals) {
      fsSetDoc_('taifex_signals/' + bar.date, tfSignalDoc_(signal, {
        eventRisk: risk.risk,
        riskEvents: risk.events,
        sentiment: sentiment && sentiment.overall ? {
          sentiment: sentiment.overall.sentiment,
          confidence: sentiment.overall.confidence,
          summary: sentiment.overall.summary || '',
        } : null,
        desired: plan.decision.desired,
        decisionReasons: plan.decision.reasons,
        suggestedContracts: plan.sizing.contracts,
        stopPoints: plan.sizing.stopPoints,
        sizingLimitedBy: plan.sizing.limitedBy,
        product: accConfig.product,
        mode: accConfig.mode,
        variant: account.variant,
        params: account.params,
        position: tfPositionSnapshot_(account.position),
        pending: account.pending ? { target: account.pending.target, contracts: account.pending.contracts, source: account.pending.source } : null,
        equity: account.equity,
      }), false);
    }
  });

  if (opts.writeSignals && lastSignal) {
    account.ticket = tfTicketFor_(account, lastSignal, accConfig, opts.params, null);
  }
  tfSaveTrades_(trades, account.epoch, accountId);
  saveTaifexAccountAt_(accountId, account);
  return { account: account, trades: trades, events: events, lastSignal: lastSignal, lastPlan: lastPlan, processed: toProcess.length, created: created };
}

/** 下單建議單：參考價優先用盤後夜盤漲跌推估的開盤價，沒有就用最新收盤 */
function tfTicketFor_(account, signal, accConfig, params, sentiment) {
  var ref = account.lastClose;
  var refSource = '最新收盤 ' + ref;
  var night = sentiment && sentiment.indicators ? tfNum_(sentiment.indicators.nightSessionChangePct) : null;
  if (ref !== null && night !== null) {
    ref = Math.round(ref * (1 + night / 100));
    refSource = '收盤 ' + account.lastClose + ' × 夜盤 ' + (night > 0 ? '+' : '') + night + '% ≈ ' + ref;
  }
  var ticket = tfBuildOrderTicket_({
    pending: account.pending,
    position: account.position,
    atr: signal && signal.indicators ? signal.indicators.atr20 : null,
    refPrice: ref,
    refSource: refSource,
    equity: account.equity,
    config: accConfig,
    params: params,
  });
  ticket.generatedAt = new Date();
  ticket.signalDate = signal ? signal.date : null;
  return ticket;
}

function runTaifexDailyScheduled() {
  return runTaifexDaily({});
}

/**
 * 08:00 盤前：
 * 1. 補跑每日流程（18:00 若因期交所延遲或逾時失敗，這裡補上；已處理過的 K 棒不會重複）
 * 2. 輿情否決新增曝險的待成交單（只取消、不新增）
 * 3. 依夜盤漲跌更新下單建議單並推播「今天開盤要怎麼下」
 */
function taifexPreOpenReview() {
  if (tfIsWeekday_(tfToday_())) {
    try { runTaifexDaily({}); } catch (err) { console.error('taifex catch-up 0800', err); }
  }
  var account = loadTaifexAccount_();
  if (!account || !account.pending) return { ok: true, skipped: 'no-pending' };
  var today = tfToday_();
  var sentiment = loadTaifexSentiment_(today);
  var config = loadTaifexConfig_();
  var accConfig = tfAccountConfig_(config, account);
  var signal = account.lastBarDate ? tfStrip_(fsGetDoc_('taifex_signals/' + account.lastBarDate)) : null;
  var veto = sentiment ? tfPreOpenVeto_(account.pending, account.position, sentiment, today) : { veto: false };
  if (!veto.veto) {
    account.ticket = tfTicketFor_(account, signal, accConfig, account.params, sentiment);
    saveTaifexAccount_(account);
    if (config.notifyEnabled && account.ticket.validFrom && account.ticket.validFrom <= today) {
      try { notifyTaifexTicket_(account.ticket, account); } catch (err) { console.error('notifyTaifexTicket_', err); }
    }
    return { ok: true, veto: false, ticket: account.ticket.kind };
  }
  account.lastVeto = { date: today, reason: veto.reason, order: account.pending, at: new Date() };
  account.pending = null;
  account.ticket = tfBuildOrderTicket_({ pending: null, config: accConfig });
  saveTaifexAccount_(account);
  try {
    sendNotification_('taifex', '【台指期模擬｜盤前否決】' + today + '\n已取消待成交單：' + veto.reason + '\n僅虛擬交易，不構成投資建議。');
  } catch (err) { console.error('taifexPreOpenReview notify', err); }
  return { ok: true, veto: true, reason: veto.reason };
}

// -------- 前端操作 --------

function placeTaifexOrder(body) {
  var account = loadTaifexAccount_();
  if (!account) return { ok: false, error: '虛擬帳戶尚未建立，請先執行「立即更新」' };
  var config = tfAccountConfig_(loadTaifexConfig_(), account);
  var target = body && body.target;
  if (['long', 'short', 'flat'].indexOf(target) < 0) return { ok: false, error: 'target 必須是 long / short / flat' };
  var contracts = Math.floor(Number(body.contracts) || 0);
  if (target !== 'flat' && (contracts < 1 || contracts > config.maxContracts)) {
    return { ok: false, error: '口數必須介於 1 到 ' + config.maxContracts };
  }
  if (target === 'short' && !config.allowShort) return { ok: false, error: '設定為不允許放空' };
  if (account.halted && target !== 'flat') return { ok: false, error: '帳戶已熔斷，請先解除熔斷' };
  var latest = fsGetDoc_('taifex_signals/' + account.lastBarDate);
  var atr = latest && latest.indicators ? tfNum_(latest.indicators.atr20) : null;
  var now = new Date();
  var today = tfToday_();
  var hhmm = Utilities.formatDate(now, TW_TZ, 'HH:mm');
  // 盤中下單：今天以即時價成交（5 分鐘內的盤中模擬處理）；盤外下單：下一個交易日開盤價
  var inSession = tfInDaySession_(today, hhmm);
  account.pending = {
    target: target,
    contracts: target === 'flat' ? 0 : contracts,
    stopPoints: atr ? tfRound_(tfParams_(account.params).stopAtr * atr, 1) : null,
    source: 'manual',
    note: tfIngestText_(body.note, 100),
    createdAt: now,
    validFrom: inSession ? today : tfOrderValidFrom_(today, hhmm),
    liveOnly: inSession,
  };
  if (latest) account.ticket = tfTicketFor_(account, tfStrip_(latest), config, account.params, null);
  saveTaifexAccount_(account);
  return { ok: true, pending: { target: account.pending.target, contracts: account.pending.contracts, validFrom: account.pending.validFrom, liveOnly: inSession } };
}

function cancelTaifexOrder() {
  var account = loadTaifexAccount_();
  if (!account || !account.pending) return { ok: true, cancelled: false };
  account.pending = null;
  account.ticket = tfBuildOrderTicket_({ pending: null, config: loadTaifexConfig_() });
  saveTaifexAccount_(account);
  return { ok: true, cancelled: true };
}

function resumeTaifexPaper() {
  var account = loadTaifexAccount_();
  if (!account) return { ok: false, error: '虛擬帳戶尚未建立' };
  account.halted = false;
  account.haltReason = null;
  // 回撤基準重設為目前權益，否則一解除就會立刻再熔斷
  account.peakEquity = account.equity;
  saveTaifexAccount_(account);
  return { ok: true };
}

/** 重置：持倉以最後收盤價平倉（記錄為 reset），以目前設定重新開帳戶（epoch + 1） */
function resetTaifexPaper() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: '另一個台指期排程正在執行' };
  try {
    var config = loadTaifexConfig_();
    var bars = loadTaifexBars_();
    var last = bars.length ? bars[bars.length - 1] : null;
    var mainEpoch = null;
    // 主帳戶與所有策略變體一起重置，策略競賽才是同一天、同一筆資金起跑
    [TAIFEX_ACCOUNT_ID_].concat(Object.keys(TAIFEX_VARIANTS).map(tfVariantAccountId_)).forEach(function (id) {
      var account = loadTaifexAccountAt_(id);
      var epoch = account && account.epoch ? account.epoch + 1 : 1;
      if (account && account.position && tfNum_(account.lastClose) !== null) {
        var accConfig = tfAccountConfig_(config, account);
        var trade = tfClosePortion_(account, account.lastClose, account.position.contracts, account.lastBarDate, 'reset', accConfig);
        tfSaveTrades_([trade], account.epoch, id);
      }
      var fresh = tfNewAccountDoc_(config, last, epoch);
      if (account && account.variant) { fresh.variant = account.variant; fresh.params = account.params; }
      saveTaifexAccountAt_(id, fresh);
      if (id === TAIFEX_ACCOUNT_ID_) mainEpoch = epoch;
    });
    return { ok: true, epoch: mainEpoch };
  } finally {
    lock.releaseLock();
  }
}

/** 回補歷史資料（前端空狀態按鈕）；回補完順便跑一次每日流程 */
function backfillTaifex(body) {
  var months = Math.max(3, Math.min(36, Math.floor(Number(body && body.months) || TAIFEX_BACKFILL_MONTHS_)));
  return runTaifexDaily({ backfillMonths: months });
}

// -------- 回測 --------

function tfCompactCurve_(curve) {
  return tfDownsample_(curve, 300).map(function (p) { return { d: p.date, e: p.equity }; });
}

function runTaifexBacktest() {
  var bars = loadTaifexBars_();
  if (bars.length < TAIFEX_MIN_BARS_ + 20) return { ok: false, error: '日 K 不足，請先回補歷史資料' };
  var config = loadTaifexConfig_();
  var series = tfPrepareSeries_(bars);
  var full = runTaifexBacktest_(bars, config, { series: series, weights: TAIFEX_FACTOR_WEIGHTS });
  var trend = runTaifexBacktest_(bars, config, { series: series, weights: TAIFEX_TREND_ONLY_WEIGHTS });
  var bh = runTaifexBuyHold_(bars, config.initialCapital, series);
  var flowDays = bars.filter(function (b) { return b.foreignNetOi !== null; }).length;
  var doc = {
    generatedAt: new Date(),
    modelVersion: TAIFEX_MODEL_VERSION,
    from: full.from,
    to: full.to,
    bars: bars.length,
    flowDays: flowDays,
    product: config.product,
    initialCapital: config.initialCapital,
    riskPerTradePct: config.riskPerTradePct,
    variants: {
      full: { metrics: full.metrics, curve: tfCompactCurve_(full.curve) },
      trendOnly: { metrics: trend.metrics, curve: tfCompactCurve_(trend.curve) },
      buyHold: { metrics: bh.metrics, curve: tfCompactCurve_(bh.curve) },
    },
    recentTrades: full.trades.slice(-40),
  };
  fsSetDoc_('taifex_backtests/latest', doc, false);
  return { ok: true, from: doc.from, to: doc.to, full: full.metrics, trendOnly: trend.metrics, buyHold: bh.metrics };
}

// -------- 推播 --------

var TAIFEX_SIDE_LABELS_ = { long: '多單', short: '空單', flat: '空手' };
var TAIFEX_EXIT_LABELS_ = { signal: '訊號', stop: '停損', reverse: '反手', manual: '手動', reset: '重置', halt: '熔斷' };

function tfSigned_(n) {
  return (n > 0 ? '+' : '') + Number(n).toLocaleString('en-US');
}

function notifyTaifex_(account, signal, plan, trades, events, created) {
  var product = TAIFEX_PRODUCTS[account.product] || TAIFEX_PRODUCTS.TMF;
  var lines = [
    '【台指期模擬｜' + product.label + '】' + signal.date + (created ? '（帳戶建立）' : ''),
    '收盤 ' + signal.close + '｜分數 ' + (signal.composite === null ? '—' : signal.composite) + '｜' + (signal.reasons.join('、') || '無明顯訊號'),
    '建議部位：' + TAIFEX_SIDE_LABELS_[plan.decision.desired] + (plan.decision.reasons.length ? '（' + plan.decision.reasons.join('；') + '）' : ''),
  ];
  trades.forEach(function (t) {
    lines.push('平倉 ' + TAIFEX_SIDE_LABELS_[t.side] + ' ' + t.contracts + ' 口｜' + TAIFEX_EXIT_LABELS_[t.exitReason]
      + '｜' + t.entryPrice + ' → ' + t.exitPrice + '｜淨損益 ' + tfSigned_(t.netPnl) + ' 元');
  });
  events.filter(function (e) { return e.type === 'halt'; }).forEach(function () { lines.push('帳戶熔斷：' + account.haltReason); });
  if (account.position) {
    lines.push('持倉 ' + TAIFEX_SIDE_LABELS_[account.position.side] + ' ' + account.position.contracts + ' 口｜成本 '
      + tfRound_(account.position.entryPrice, 0) + '｜停損 ' + account.position.stop);
  }
  if (account.pending) {
    lines.push('明日開盤待成交：' + TAIFEX_SIDE_LABELS_[account.pending.target]
      + (account.pending.target === 'flat' ? '' : ' ' + account.pending.contracts + ' 口') + '（' + (account.pending.source === 'manual' ? '手動' : '自動') + '）');
  }
  if (account.ticket && account.ticket.kind !== 'none' && account.ticket.steps && account.ticket.steps.length) {
    lines.push('', '【下一個交易日下單建議】');
    lines = lines.concat(tfTicketLines_(account.ticket));
  }
  var ret = (account.equity / account.initialCapital - 1) * 100;
  lines.push('權益 ' + Math.round(account.equity).toLocaleString('en-US') + '（' + (ret >= 0 ? '+' : '') + tfRound_(ret, 2) + '%）｜最大回撤 ' + account.maxDrawdownPct + '%');
  lines.push('', '僅虛擬交易，不接券商、不構成投資建議。');
  return sendNotification_('taifex', lines.join('\n'));
}

function notifyTaifexLatest_() {
  var account = loadTaifexAccount_();
  if (!account || !account.lastBarDate) return { ok: false, error: '台指期虛擬帳戶尚未建立' };
  var signal = tfStrip_(fsGetDoc_('taifex_signals/' + account.lastBarDate));
  if (!signal) return { ok: false, error: '還沒有訊號' };
  return notifyTaifex_(account, signal, { decision: { desired: signal.desired || 'flat', reasons: signal.decisionReasons || [] } }, [], [], false);
}


// -------- 盤中用的快取 --------

/** 盤中每 5 分鐘只讀這一份（不必每次重讀 ~750 根日 K）：最後一根 K、ATR、近月 / 次月、次月收盤 */
function saveTaifexLiveContext_(bars, series) {
  var i = bars.length - 1;
  var bar = bars[i];
  var existing = tfStrip_(fsGetDoc_(TAIFEX_LIVE_PATH_)) || {};
  existing.context = {
    lastDate: bar.date,
    lastClose: bar.close,
    contract: bar.contract || null,
    nextContract: bar.nextContract || null,
    nextClose: tfNum_(bar.nextClose),
    atr20: tfRound_(series.atr20[i], 1),
  };
  existing.contextUpdatedAt = new Date();
  fsSetDoc_(TAIFEX_LIVE_PATH_, existing, false);
}

// -------- 參數最佳化（每週） --------

/** walk-forward 參數網格，寫 taifex_optimizations/latest；optimized 變體下週起用新參數 */
function runTaifexOptimization() {
  var bars = loadTaifexBars_();
  if (bars.length < TAIFEX_MIN_BARS_ + 120) return { ok: false, error: '日 K 不足（至少約 200 根），請先回補歷史資料' };
  var config = loadTaifexConfig_();
  var result = tfOptimizeTaifex_(bars, config, {});
  if (!result) return { ok: false, error: '資料不足，無法最佳化' };
  var previous = tfStrip_(fsGetDoc_(TAIFEX_OPT_PATH_));
  var doc = {
    generatedAt: new Date(),
    modelVersion: TAIFEX_MODEL_VERSION,
    product: config.product,
    riskPerTradePct: config.riskPerTradePct,
    bars: bars.length,
    trainFrom: result.trainFrom,
    trainTo: result.trainTo,
    testFrom: result.testFrom,
    testTo: result.testTo,
    maxDrawdownPct: result.maxDrawdownPct,
    best: result.best,
    baseline: result.baseline,
    stability: result.stability,
    adopt: result.adopt,
    suggestedRiskPct: result.suggestedRiskPct,
    fullPeriod: result.fullPeriod,
    variants: result.variants,
    // 參數變更紀錄：之後可以檢查最佳化是不是每週都在換（換太兇代表不穩定）
    history: ((previous && previous.history) || []).concat(result.best ? [{ date: tfToday_(), params: result.best.params }] : []).slice(-26),
  };
  fsSetDoc_(TAIFEX_OPT_PATH_, doc, false);
  return { ok: true, adopt: result.adopt, best: result.best ? result.best.params : null, stability: result.stability };
}

// -------- 推播：下單建議單 --------

var TAIFEX_ORDER_TYPE_LABELS_ = { LMT: '限價', MWP: '範圍市價', MKT: '市價', STP: '停損單' };

function tfTicketLines_(ticket) {
  var lines = [];
  ticket.steps.forEach(function (step, i) {
    lines.push((i + 1) + '. ' + step.label + '｜' + (step.side === 'buy' ? '買進' : '賣出') + ' ' + step.qty + ' 口 '
      + TAIFEX_ORDER_TYPE_LABELS_[step.orderType] + (step.price ? ' ' + step.price : '') + '（' + step.tif + '，' + step.offset + '）');
  });
  if (ticket.stopOrder) {
    lines.push('成交後：' + (ticket.stopOrder.side === 'buy' ? '買進' : '賣出') + ' ' + ticket.stopOrder.qty + ' 口 停損單 約 '
      + ticket.stopOrder.price + '（成交價 ' + (ticket.stopOrder.side === 'sell' ? '−' : '+') + ' ' + Math.round(ticket.stopOrder.stopPoints) + ' 點）');
  }
  if (ticket.riskTWD !== null) lines.push('停損風險約 ' + ticket.riskTWD.toLocaleString('en-US') + ' 元（' + ticket.riskPct + '% 權益），保證金約 ' + ticket.marginTWD.toLocaleString('en-US') + ' 元');
  return lines.concat(ticket.notes.map(function (n) { return '· ' + n; }));
}

function notifyTaifexTicket_(ticket, account) {
  if (!ticket || ticket.kind === 'none' || !ticket.steps.length) return { ok: true, skipped: true };
  var lines = ['【台指期模擬｜今日下單建議】' + tfToday_() + '（' + ticket.productLabel + '）'].concat(tfTicketLines_(ticket));
  lines.push('', '系統會以開盤價自動成交虛擬單；要練習實單可照上面步驟在券商下單。僅供研究，不構成投資建議。');
  return sendNotification_('taifex', lines.join('\n'), undefined, { title: '台指期今日下單建議', severity: 'info' });
}
