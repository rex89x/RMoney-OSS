/**
 * StockRadar — 股市雷達盤前評估。
 *
 * - Universe：正式 portfolio 持股 + watchlist，依市場分成 TW / US。
 * - 讀既有 stocks/{symbol}/candles 日 K；不足一年時用 Yahoo 補 2 年。
 * - 因子、輿情合成、動作判定在 StockRadarFactors.gs（純函式）；台股籌碼在 StockRadarFlows.gs；
 *   Claude 輿情推送在 StockRadarIngest.gs。
 * - 結果寫 stock_radar_runs/{yyyy-MM-dd}_{TW|US}；事後報酬寫 stock_radar_outcomes/{同 id}；
 *   回測寫 stock_radar_backtests/{TW|US}。前端全部唯讀。
 * - 只產生建議，不碰 portfolio、不接券商、不下單。
 *
 * 排程（Triggers.gs）：
 *   01:00 syncStockRadarFlows       台股籌碼
 *   08:00 runStockRadar             兩個市場量化評估 + 合併已收到的輿情；推播台股
 *   20:30 前後 Claude 美股排程推送  → 重新合成美股並推播（StockRadarIngest.gs）
 *   21:00 notifyStockRadarFallback_ 美股若沒收到輿情，推播純量化結果
 *   週日 03:00 runStockRadarBacktest 回測
 *
 * 規劃見 docs/STOCK_RADAR_PLAN.md。
 */

var STOCK_RADAR_BENCHMARKS = { TW: '0050', US: 'SPY' };
var STOCK_RADAR_MIN_CANDLES_ = 253;
var STOCK_RADAR_CANDLE_LIMIT_ = 260;
var STOCK_RADAR_STALE_DAYS_ = 4;
var STOCK_RADAR_OUTCOME_LOOKBACK_DAYS_ = 45;
var STOCK_RADAR_OUTCOME_HORIZONS_ = [1, 5, 20];
// Apps Script 單次 6 分鐘上限（pitfall #10），留餘裕給寫入
var STOCK_RADAR_TIME_BUDGET_MS_ = 4.5 * 60 * 1000;

function stockRadarToday_() {
  return Utilities.formatDate(new Date(), TW_TZ, 'yyyy-MM-dd');
}

function stockRadarRunId_(runDate, market) {
  return runDate + '_' + market;
}

function stockRadarBackfill_(symbol, market, range) {
  if (market === 'TW') return backfillTwYahooCandles_(symbol, range);
  return backfillUsCandles_(symbol, range);
}

/** 讀日 K；歷史不足一年就補 2 年，最新一根太舊（大盤 SPY 未被追蹤時）就補最近一個月 */
function stockRadarCandles_(symbol, market) {
  var candles = getCandlesAsc_(symbol, STOCK_RADAR_CANDLE_LIMIT_);
  var refreshed = false;
  if (candles.length < STOCK_RADAR_MIN_CANDLES_) {
    try {
      stockRadarBackfill_(symbol, market, '2y');
      refreshed = true;
    } catch (err) {
      console.warn('stockRadarCandles_ backfill', symbol, err);
    }
  } else {
    var last = candles[candles.length - 1].date;
    var staleBefore = Utilities.formatDate(
      new Date(Date.now() - STOCK_RADAR_STALE_DAYS_ * 86400000), TW_TZ, 'yyyy-MM-dd');
    if (String(last) < staleBefore) {
      try {
        stockRadarBackfill_(symbol, market, '1mo');
        refreshed = true;
      } catch (err) {
        console.warn('stockRadarCandles_ refresh', symbol, err);
      }
    }
  }
  if (refreshed) {
    Utilities.sleep(200);
    candles = getCandlesAsc_(symbol, STOCK_RADAR_CANDLE_LIMIT_);
  }
  return candles;
}

/** 持股彙總（同一 symbol 多筆 position 合併）+ 占全部股票部位的權重 */
function stockRadarHoldings_() {
  var positions = fsListAllDocs_('portfolio', 500) || [];
  var bySymbol = {};
  positions.forEach(function (p) {
    var sym = normalizeStockSymbol_(p.symbol);
    var shares = Number(p.shares) || 0;
    if (!sym || shares <= 0) return;
    if (!bySymbol[sym]) bySymbol[sym] = { symbol: sym, shares: 0, cost: 0, currency: p.currency || null };
    bySymbol[sym].shares += shares;
    bySymbol[sym].cost += shares * (Number(p.avgCost) || 0);
  });

  var fxCache = { TWD: 1 };
  function fx(ccy) {
    if (fxCache[ccy] !== undefined) return fxCache[ccy];
    var doc = null;
    try { doc = fsGetDoc_('fx_rates/' + ccy + '_TWD'); } catch (err) { console.warn('stockRadar fx', ccy, err); }
    fxCache[ccy] = doc && doc.rate ? Number(doc.rate) : null;
    return fxCache[ccy];
  }

  var total = 0;
  Object.keys(bySymbol).forEach(function (sym) {
    var h = bySymbol[sym];
    var stock = null;
    try { stock = fsGetDoc_('stocks/' + sym); } catch (err) { console.warn('stockRadar stock', sym, err); }
    h.stock = stock;
    h.market = stockRadarMarketOf_(sym, stock);
    h.currency = (stock && stock.currency) || h.currency || (h.market === 'TW' ? 'TWD' : 'USD');
    h.avgCost = h.shares ? h.cost / h.shares : 0;
    var price = stock && stock.currentPrice ? Number(stock.currentPrice) : null;
    var rate = fx(h.currency);
    // 沒有報價或匯率就不算市值，也不納入權重分母（不要靜默用 1 算錯）
    h.marketValueTWD = price && rate ? h.shares * price * rate : null;
    h.unrealizedPct = price && h.avgCost ? (price / h.avgCost - 1) * 100 : null;
    if (h.marketValueTWD) total += h.marketValueTWD;
  });
  Object.keys(bySymbol).forEach(function (sym) {
    var h = bySymbol[sym];
    h.weightPct = total && h.marketValueTWD ? h.marketValueTWD / total * 100 : null;
  });
  return { bySymbol: bySymbol, totalValueTWD: total };
}

/** inferStockMarket_ 只認 4 碼數字，00878 這類 5 碼 ETF 會被當成美股；數字開頭一律視為台股 */
function stockRadarMarketOf_(sym, stockDoc) {
  if (stockDoc && (stockDoc.market === 'TW' || stockDoc.market === 'US')) return stockDoc.market;
  return /^\d/.test(sym) ? 'TW' : 'US';
}

function stockRadarWatchlist_() {
  var out = {};
  (fsListAllDocs_('watchlist', 500) || []).forEach(function (w) {
    var sym = normalizeStockSymbol_(w.symbol);
    if (sym) out[sym] = true;
  });
  return out;
}

/** 某市場目前的追蹤清單（排序後的代號陣列）；Claude 推送也用這份驗證 */
function stockRadarUniverse_(market, holdings, watchlist) {
  var symbols = {};
  Object.keys(holdings.bySymbol).forEach(function (sym) {
    if (holdings.bySymbol[sym].market === market) symbols[sym] = true;
  });
  Object.keys(watchlist).forEach(function (sym) {
    var known = holdings.bySymbol[sym];
    if ((known ? known.market : stockRadarMarketOf_(sym, null)) === market) symbols[sym] = true;
  });
  return Object.keys(symbols).sort();
}

/** 手動「立即評估」與排程共用；market 省略 = 兩個市場都跑 */
function runStockRadar(market) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'lock-busy' };
  try {
    return runStockRadarNoLock_(market, { notify: false });
  } finally {
    lock.releaseLock();
  }
}

/** tick_daily_0800：兩個市場都評估，只推播台股（美股等晚上 Claude 推送或 21:00 fallback） */
function runStockRadarScheduled() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'lock-busy' };
  try {
    return runStockRadarNoLock_(null, { notify: true, notifyMarkets: ['TW'] });
  } finally {
    lock.releaseLock();
  }
}

function runStockRadarNoLock_(market, opts) {
  opts = opts || {};
  var startedAt = Date.now();
  var markets = market === 'TW' || market === 'US' ? [market] : ['TW', 'US'];
  var holdings = stockRadarHoldings_();
  var watchlist = stockRadarWatchlist_();
  var results = {};
  markets.forEach(function (m) {
    try {
      var notify = opts.notify && (opts.notifyMarkets || []).indexOf(m) >= 0;
      results[m] = runStockRadarMarket_(m, holdings, watchlist, startedAt, notify);
    } catch (err) {
      console.error('runStockRadarMarket_', m, err);
      results[m] = { ok: false, error: String(err && err.message || err) };
    }
  });
  return { ok: true, results: results };
}

function stockRadarLoadSentiment_(runDate, market) {
  try {
    return fsGetDoc_('stock_radar_sentiment/' + stockRadarRunId_(runDate, market));
  } catch (err) {
    console.warn('stockRadar sentiment load', runDate, market, err);
    return null;
  }
}

function stockRadarSentimentBySymbol_(sentimentDoc) {
  var out = {};
  ((sentimentDoc && sentimentDoc.items) || []).forEach(function (entry) {
    if (entry && entry.symbol) out[entry.symbol] = entry;
  });
  return out;
}

/** run 的 items（量化）+ 輿情 doc → 合成後的 run 欄位 */
function stockRadarApplySentiment_(run, sentimentDoc) {
  var regimeInfo = stockRadarEffectiveRegime_(run.regime, sentimentDoc ? sentimentDoc.marketView : null);
  var bySymbol = stockRadarSentimentBySymbol_(sentimentDoc);
  var items = (run.items || []).map(function (item) {
    return synthesizeStockRadarItem_(item, bySymbol[item.symbol] || null, regimeInfo, run.runDate);
  });
  items.sort(function (a, b) {
    return (b.composite === null ? -9 : b.composite) - (a.composite === null ? -9 : a.composite);
  });
  return {
    items: items,
    effectiveRegime: regimeInfo.regime,
    marketView: sentimentDoc && sentimentDoc.marketView ? sentimentDoc.marketView : null,
    sentimentAt: sentimentDoc ? (sentimentDoc.receivedAt || null) : null,
    sentimentCount: Object.keys(bySymbol).length,
    actionCounts: stockRadarActionCounts_(items),
  };
}

function runStockRadarMarket_(market, holdings, watchlist, startedAt, notify) {
  var runDate = stockRadarToday_();
  var universe = stockRadarUniverse_(market, holdings, watchlist);
  var benchmarkSymbol = STOCK_RADAR_BENCHMARKS[market];
  var benchmarkCandles = stockRadarCandles_(benchmarkSymbol, market);
  var benchmarkMetrics = computeStockRadarMetrics_(benchmarkCandles);
  var regime = stockRadarRegime_(benchmarkMetrics);
  var flowDocs = market === 'TW' ? loadStockRadarFlowDocs_() : [];

  var candleCache = {};
  candleCache[benchmarkSymbol] = benchmarkCandles;
  var items = [];
  var errors = [];
  var partial = false;
  universe.forEach(function (sym) {
    if (Date.now() - startedAt > STOCK_RADAR_TIME_BUDGET_MS_) {
      partial = true;
      return;
    }
    try {
      var holding = holdings.bySymbol[sym] || null;
      var stock = holding ? holding.stock : null;
      if (!holding) {
        try { stock = fsGetDoc_('stocks/' + sym); } catch (err) { console.warn('stockRadar stock', sym, err); }
      }
      var candles = stockRadarCandles_(sym, market);
      candleCache[sym] = candles;
      var flowInputs = market === 'TW' && flowDocs.length ? computeStockRadarFlowInputs_(sym, flowDocs, candles) : null;
      var evaluation = evaluateStockRadarItem_(candles, benchmarkMetrics, regime, holding, market, flowInputs);
      var m = evaluation.metrics;
      items.push({
        symbol: sym,
        name: (stock && stock.name) || sym,
        held: !!holding,
        inWatchlist: !!watchlist[sym],
        shares: holding ? holding.shares : 0,
        avgCost: holding ? srRound_(holding.avgCost, 4) : null,
        currency: (holding && holding.currency) || (stock && stock.currency) || (market === 'TW' ? 'TWD' : 'USD'),
        marketValueTWD: holding ? srRound_(holding.marketValueTWD, 0) : null,
        weightPct: holding ? srRound_(holding.weightPct, 2) : null,
        unrealizedPct: holding ? srRound_(holding.unrealizedPct, 2) : null,
        close: m ? m.close : null,
        priceDate: m ? m.date : null,
        quantScore: evaluation.composite,
        composite: evaluation.composite,
        coverage: evaluation.coverage,
        action: evaluation.action,
        reasons: evaluation.reasons,
        factors: evaluation.factors,
        metrics: m ? {
          historyDays: m.historyDays,
          mom12_1: srRound_(m.mom12_1, 4),
          ret21: srRound_(m.ret21, 4),
          vol60: srRound_(m.vol60, 4),
          ma200: srRound_(m.ma200, 4),
          high52: srRound_(m.high52, 4),
          atr14: srRound_(m.atr14, 4),
          chandelierStop: srRound_(m.chandelierStop, 4),
        } : null,
      });
    } catch (err) {
      console.warn('stockRadar item', sym, err);
      errors.push(sym + ': ' + String(err && err.message || err));
    }
  });

  var run = {
    runDate: runDate,
    market: market,
    modelVersion: STOCK_RADAR_MODEL_VERSION,
    generatedAt: new Date(),
    status: !universe.length ? 'empty' : partial ? 'partial' : 'ok',
    regime: regime,
    benchmark: {
      symbol: benchmarkSymbol,
      close: benchmarkMetrics ? benchmarkMetrics.close : null,
      priceDate: benchmarkMetrics ? benchmarkMetrics.date : null,
      ma200: benchmarkMetrics ? srRound_(benchmarkMetrics.ma200, 4) : null,
      mom12_1: benchmarkMetrics ? srRound_(benchmarkMetrics.mom12_1, 4) : null,
    },
    universeSize: universe.length,
    flowDays: flowDocs.length,
    items: items,
    errors: errors.slice(0, 20),
    notifiedAt: null,
  };
  var synthesized = stockRadarApplySentiment_(run, stockRadarLoadSentiment_(runDate, market));
  Object.keys(synthesized).forEach(function (key) { run[key] = synthesized[key]; });

  if (notify && run.items.length) {
    try {
      notifyStockRadar_(run, null);
      run.notifiedAt = new Date();
    } catch (err) {
      console.error('notifyStockRadar_', market, err);
    }
  }
  fsSetDoc_('stock_radar_runs/' + stockRadarRunId_(runDate, market), run, false);

  var outcomes = { updated: 0 };
  if (Date.now() - startedAt < STOCK_RADAR_TIME_BUDGET_MS_) {
    try {
      outcomes = updateStockRadarOutcomes_(market, candleCache, startedAt);
    } catch (err) {
      console.error('updateStockRadarOutcomes_', market, err);
    }
  }
  return {
    ok: true,
    runDate: runDate,
    status: run.status,
    evaluated: items.length,
    regime: regime,
    outcomesUpdated: outcomes.updated,
  };
}

// -------- 事後報酬 --------

/**
 * 回填過去評估的 1 / 5 / 20 交易日報酬（從建議隔天開盤進場算），與大盤同期比較。
 * 過去 run 的標的若今天不在追蹤清單，另外讀 K 線。20 日都有值或超過 45 天就標記 complete 不再更新。
 */
function updateStockRadarOutcomes_(market, candleCache, startedAt) {
  var updated = 0;
  var today = stockRadarToday_();
  var benchmarkSymbol = STOCK_RADAR_BENCHMARKS[market];
  function candlesFor(sym) {
    if (!candleCache[sym]) candleCache[sym] = getCandlesAsc_(sym, 60);
    return candleCache[sym];
  }
  for (var i = 1; i <= STOCK_RADAR_OUTCOME_LOOKBACK_DAYS_; i++) {
    if (Date.now() - startedAt > STOCK_RADAR_TIME_BUDGET_MS_) break;
    var runDate = Utilities.formatDate(new Date(Date.now() - i * 86400000), TW_TZ, 'yyyy-MM-dd');
    if (runDate >= today) continue;
    var id = stockRadarRunId_(runDate, market);
    var existing = fsGetDoc_('stock_radar_outcomes/' + id);
    if (existing && existing.complete) continue;
    var run = fsGetDoc_('stock_radar_runs/' + id);
    if (!run || !Array.isArray(run.items) || !run.items.length) continue;

    var returns = {};
    var allDone = true;
    run.items.forEach(function (item) {
      if (!item.priceDate) return;
      var fwd = stockRadarForwardReturns_(candlesFor(item.symbol), item.priceDate, STOCK_RADAR_OUTCOME_HORIZONS_);
      returns[item.symbol] = fwd;
      if (fwd.fwd20 === null) allDone = false;
    });
    var bmPriceDate = run.benchmark && run.benchmark.priceDate;
    var bench = stockRadarForwardReturns_(candlesFor(benchmarkSymbol), bmPriceDate, STOCK_RADAR_OUTCOME_HORIZONS_);
    if (bench.fwd20 === null) allDone = false;
    fsSetDoc_('stock_radar_outcomes/' + id, {
      runDate: runDate,
      market: market,
      modelVersion: run.modelVersion || '',
      returns: returns,
      benchmark: bench,
      complete: allDone || i >= STOCK_RADAR_OUTCOME_LOOKBACK_DAYS_ - 5,
      updatedAt: new Date(),
    }, false);
    updated++;
  }
  return { updated: updated };
}

// -------- Telegram --------

var STOCK_RADAR_ACTION_LABELS_ = {
  add: '加碼', hold: '續抱', trim: '減碼', exit: '出場',
  buy: '買進候選', watch: '觀望', avoid: '避開', insufficient: '資料不足',
};
var STOCK_RADAR_REGIME_LABELS_ = { risk_on: '偏多', neutral: '中性', risk_off: '偏空', unknown: '未知' };
var STOCK_RADAR_REASON_LABELS_ = {
  insufficient_history: '歷史不足', below_stop: '跌破停損', regime_risk_off: '大盤偏空',
  market_sentiment: '市場輿情偏空', score_very_weak: '分數極弱', score_weak: '分數偏弱',
  score_strong: '分數強', concentration: '占比已達上限', event_risk: '近期重大事件',
};

function stockRadarScoreText_(n) {
  if (n === null || n === undefined) return '—';
  return (n >= 0 ? '+' : '') + Number(n).toFixed(2);
}

function stockRadarItemLine_(item) {
  var parts = [item.symbol + ' ' + (item.name && item.name !== item.symbol ? item.name : '')];
  parts.push('分數 ' + stockRadarScoreText_(item.composite));
  if (item.sentimentAdj) parts.push('輿情 ' + stockRadarScoreText_(item.sentimentAdj));
  if (item.held && item.weightPct !== null && item.weightPct !== undefined) parts.push('占比 ' + Number(item.weightPct).toFixed(1) + '%');
  var reasons = (item.reasons || []).filter(function (r) { return r !== 'score_strong'; })
    .map(function (r) { return STOCK_RADAR_REASON_LABELS_[r] || r; });
  if (reasons.length) parts.push(reasons.join('、'));
  var line = '· ' + parts.join('｜');
  if (item.sentiment && item.sentiment.summary) line += '\n  ' + String(item.sentiment.summary).slice(0, 80);
  return line;
}

/** changes 非 null：只列動作有變化的標的（輿情晚到時的更新通知） */
function notifyStockRadar_(run, changes) {
  var marketLabel = run.market === 'TW' ? '台股' : '美股';
  var lines = [
    '【股市雷達｜' + marketLabel + '盤前' + (changes ? '更新' : '') + '】' + run.runDate,
    '大盤 ' + (run.benchmark && run.benchmark.symbol) + '｜' + (STOCK_RADAR_REGIME_LABELS_[run.effectiveRegime || run.regime] || '未知')
      + (run.effectiveRegime && run.effectiveRegime !== run.regime ? '（輿情下修）' : ''),
    '輿情｜' + (run.sentimentCount ? 'Claude 已分析 ' + run.sentimentCount + ' 檔' : '未收到 Claude 推送，僅量化結果'),
  ];
  if (run.marketView && run.marketView.summary) lines.push('市場｜' + String(run.marketView.summary).slice(0, 120));

  var items = run.items || [];
  if (changes) {
    var changed = items.filter(function (it) { return changes[it.symbol] && changes[it.symbol] !== it.action; });
    if (!changed.length) return { ok: true, skipped: true };
    lines.push('', '【動作變化】');
    changed.forEach(function (it) {
      lines.push(stockRadarItemLine_(it).replace('· ', '· ' + STOCK_RADAR_ACTION_LABELS_[changes[it.symbol]] + ' → '
        + STOCK_RADAR_ACTION_LABELS_[it.action] + '｜'));
    });
  } else {
    [['exit', '出場'], ['trim', '減碼'], ['add', '加碼'], ['buy', '買進候選']].forEach(function (pair) {
      var group = items.filter(function (it) { return it.action === pair[0]; });
      if (!group.length) return;
      lines.push('', '【' + pair[1] + '】');
      group.slice(0, 8).forEach(function (it) { lines.push(stockRadarItemLine_(it)); });
    });
    var holdCount = items.filter(function (it) { return it.action === 'hold'; }).length;
    var watchCount = items.filter(function (it) { return it.action === 'watch' || it.action === 'avoid'; }).length;
    lines.push('', '續抱 ' + holdCount + ' 檔、觀望／避開 ' + watchCount + ' 檔');
  }
  lines.push('', '僅供決策參考，不自動下單，不構成投資建議。');
  return sendNotification_('stockRadar', lines.join('\n'));
}

/** tick_daily_2100：美股若到現在還沒推播（Claude 沒推送），推播純量化結果 */
function notifyStockRadarFallback_() {
  var id = stockRadarRunId_(stockRadarToday_(), 'US');
  var run = fsGetDoc_('stock_radar_runs/' + id);
  if (!run || run.notifiedAt || !Array.isArray(run.items) || !run.items.length) return { ok: true, skipped: true };
  notifyStockRadar_(run, null);
  fsSetDoc_('stock_radar_runs/' + id, { notifiedAt: new Date() }, true);
  return { ok: true };
}

/** 設定頁「測試通知」：推播最近一次台股評估（不改 notifiedAt） */
function notifyStockRadarLatest_() {
  var run = fsGetDoc_('stock_radar_runs/' + stockRadarRunId_(stockRadarToday_(), 'TW'));
  if (!run || !Array.isArray(run.items) || !run.items.length) return { ok: false, error: '今天還沒有台股評估' };
  return notifyStockRadar_(run, null);
}

// -------- 回測 --------

/** Yahoo 日 K 只讀不寫（回測用 5 年，不佔 Firestore） */
function srFetchYahooSeries_(symbol, market, range) {
  var tickers = market === 'TW' ? [symbol + '.TW', symbol + '.TWO'] : [symbol];
  var timezone = market === 'TW' ? TW_TZ : 'America/New_York';
  for (var t = 0; t < tickers.length; t++) {
    var resp = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(tickers[t])
      + '?range=' + encodeURIComponent(range) + '&interval=1d', {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalHub/1.0)', 'Accept': 'application/json, */*' },
    });
    if (resp.getResponseCode() !== 200) continue;
    var result = null;
    try {
      var json = JSON.parse(resp.getContentText());
      result = json && json.chart && json.chart.result && json.chart.result[0];
    } catch (err) {
      console.warn('srFetchYahooSeries_ parse', tickers[t], err);
    }
    if (!result || !result.timestamp) continue;
    var q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    var out = [];
    result.timestamp.forEach(function (ts, i) {
      var close = q.close && q.close[i];
      if (close === null || close === undefined) return;
      out.push({
        date: Utilities.formatDate(new Date(ts * 1000), timezone, 'yyyy-MM-dd'),
        open: (q.open && q.open[i]) || close,
        high: (q.high && q.high[i]) || close,
        low: (q.low && q.low[i]) || close,
        close: close,
        volume: (q.volume && q.volume[i]) || 0,
      });
    });
    if (out.length) return out;
  }
  return [];
}

function runStockRadarBacktest(market) {
  var markets = market === 'TW' || market === 'US' ? [market] : ['TW', 'US'];
  var holdings = stockRadarHoldings_();
  var watchlist = stockRadarWatchlist_();
  var results = {};
  markets.forEach(function (m) {
    try {
      var universe = stockRadarUniverse_(m, holdings, watchlist);
      if (!universe.length) {
        results[m] = { ok: true, skipped: true, reason: 'empty universe' };
        return;
      }
      var series = {};
      universe.forEach(function (sym) {
        var candles = srFetchYahooSeries_(sym, m, '5y');
        if (candles.length > 280) series[sym] = candles;
        Utilities.sleep(250);
      });
      var benchmarkCandles = srFetchYahooSeries_(STOCK_RADAR_BENCHMARKS[m], m, '5y');
      var result = runStockRadarBacktestCore_(series, benchmarkCandles, m, { step: 5, roundTripCost: m === 'TW' ? 0.006 : 0.001 });
      result.generatedAt = new Date();
      result.benchmarkSymbol = STOCK_RADAR_BENCHMARKS[m];
      result.skippedSymbols = universe.filter(function (sym) { return !series[sym]; });
      fsSetDoc_('stock_radar_backtests/' + m, result, false);
      results[m] = { ok: true, periods: result.periods, meanIC: result.meanIC };
    } catch (err) {
      console.error('runStockRadarBacktest', m, err);
      results[m] = { ok: false, error: String(err && err.message || err) };
    }
  });
  return { ok: true, results: results };
}
