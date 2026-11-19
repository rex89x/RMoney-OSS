/**
 * SwingSignals — short swing paper-trading lab.
 *
 * Scope:
 * - TW market only in MVP.
 * - Uses existing stocks/{symbol}/candles daily OHLCV.
 * - Creates paper trades only; never touches real portfolio or brokers.
 */

var SWING_BENCHMARK = '0050';
var SWING_COST_PCT = 0.005;
var SWING_STRATEGY_VERSION = 'v2-risk-adjusted';

function defaultSwingWeights_() {
  return {
    return5: 1,
    return10: 1,
    rs20: 1.2,
    breakout20: 1.4,
    volumeRatio20: 1,
    ma5DeviationPenalty: 1,
  };
}

function getOwnerUser_() {
  var users = fsRunQuery_('', {
    from: [{ collectionId: 'users' }],
    where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'owner' } } },
    limit: 1,
  });
  var u = users && users[0];
  if (!u || !u._name) return null;
  u.id = String(u._name).split('/').pop();
  return u;
}

function getSwingConfigs_() {
  var configs = fsListDocs_('swing_strategy_configs', 20).filter(function (c) {
    return c.active !== false;
  });
  if (configs.length) return configs;

  var owner = getOwnerUser_();
  if (!owner || !owner.id) return [];
  var symbols = listTrackedStockSymbols_('TW').slice(0, 120);
  if (symbols.indexOf(SWING_BENCHMARK) === -1) symbols.unshift(SWING_BENCHMARK);
  var now = new Date();
  var config = {
    userId: owner.id,
    name: '短波段實驗',
    active: true,
    universeSymbols: symbols,
    topN: 8,
    maxOpenPositions: 5,
    maxPositionPctOfAssets: 5,
    riskPerTradePct: 0.75,
    virtualCapitalTWD: 100000,
    perTradeBudgetTWD: 20000,
    stopLossPct: 4,
    atrStopMultiplier: 1.5,
    takeProfitPct: 8,
    trailingStopPct: 4,
    maxHoldingDays: 5,
    minAvgVolume20: 500000,
    maxMa5DeviationPct: 8,
    minimumRewardRiskRatio: 1.5,
    marketTrendFilterEnabled: true,
    weights: defaultSwingWeights_(),
    notifyEnabled: true,
    createdAt: now,
    updatedAt: now,
  };
  fsSetDoc_('swing_strategy_configs/default', config, true);
  config._name = 'swing_strategy_configs/default';
  return [config];
}

function getCandlesAsc_(symbol, limit) {
  var rows = fsRunQuery_('stocks/' + symbol, {
    from: [{ collectionId: 'candles' }],
    orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
    limit: limit || 80,
  });
  rows.sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')); });
  return rows.filter(function (c) { return c && c.close && c.date; });
}

function ensureSwingCandles_(symbol) {
  var candles = getCandlesAsc_(symbol, 30);
  if (candles.length >= 25) return candles;
  try {
    backfillTwCandles_(symbol, 4);
    Utilities.sleep(300);
  } catch (err) {
    console.warn('ensureSwingCandles_ backfill failed', symbol, err);
  }
  return getCandlesAsc_(symbol, 80);
}

function mean_(values) {
  if (!values.length) return 0;
  return values.reduce(function (s, v) { return s + v; }, 0) / values.length;
}

function std_(values) {
  if (values.length < 2) return 1;
  var m = mean_(values);
  var variance = mean_(values.map(function (v) { return Math.pow(v - m, 2); }));
  var s = Math.sqrt(variance);
  return s || 1;
}

function z_(value, values) {
  return (value - mean_(values)) / std_(values);
}

function pctChange_(latest, prior) {
  return prior ? ((latest - prior) / prior) * 100 : 0;
}

function avgVolume_(candles, n) {
  return mean_(candles.slice(-n).map(function (c) { return Number(c.volume || 0); }));
}

function atr14_(candles) {
  if (candles.length < 15) return 0;
  var trs = [];
  for (var i = Math.max(1, candles.length - 14); i < candles.length; i++) {
    var c = candles[i];
    var prev = candles[i - 1];
    trs.push(Math.max(
      Number(c.high || c.close) - Number(c.low || c.close),
      Math.abs(Number(c.high || c.close) - Number(prev.close || 0)),
      Math.abs(Number(c.low || c.close) - Number(prev.close || 0)),
    ));
  }
  return mean_(trs);
}

function computeSwingMetrics_(symbol, benchmarkReturn20) {
  var candles = ensureSwingCandles_(symbol);
  if (candles.length < 25) return null;
  var last = candles[candles.length - 1];
  var close = Number(last.close || 0);
  if (!close) return null;
  var avgVol20 = avgVolume_(candles.slice(0, -1), 20);
  var highs20 = candles.slice(-21, -1).map(function (c) { return Number(c.high || c.close || 0); });
  var high20 = Math.max.apply(null, highs20);
  var ma5 = mean_(candles.slice(-5).map(function (c) { return Number(c.close || 0); }));
  var ma20 = mean_(candles.slice(-20).map(function (c) { return Number(c.close || 0); }));
  var atr14 = atr14_(candles);
  var ret5 = pctChange_(close, Number(candles[candles.length - 6].close || 0));
  var ret10 = pctChange_(close, Number(candles[candles.length - 11].close || 0));
  var ret20 = pctChange_(close, Number(candles[candles.length - 21].close || 0));
  var volume = Number(last.volume || 0);
  return {
    symbol: symbol,
    date: last.date,
    close: close,
    volume: volume,
    avgVolume20: avgVol20,
    return5: ret5,
    return10: ret10,
    return20: ret20,
    rs20: ret20 - benchmarkReturn20,
    breakout20: close > high20 && volume > avgVol20 * 1.5,
    volumeRatio20: avgVol20 ? volume / avgVol20 : 0,
    ma5DeviationPct: ma5 ? ((close - ma5) / ma5) * 100 : 0,
    atr14: atr14,
    atrPct: close ? atr14 / close * 100 : 0,
    ma20: ma20,
    aboveMa20: close > ma20,
  };
}

function scoreSwingCandidates_(metrics, config) {
  var weights = Object.assign(defaultSwingWeights_(), config.weights || {});
  var fields = ['return5', 'return10', 'rs20', 'volumeRatio20'];
  var vectors = {};
  fields.forEach(function (f) { vectors[f] = metrics.map(function (m) { return Number(m[f] || 0); }); });
  return metrics.map(function (m) {
    var overheat = Math.max(0, Number(m.ma5DeviationPct || 0) - Number(config.maxMa5DeviationPct || 8));
    var score = 0;
    score += z_(m.return5, vectors.return5) * weights.return5;
    score += z_(m.return10, vectors.return10) * weights.return10;
    score += z_(m.rs20, vectors.rs20) * weights.rs20;
    score += z_(m.volumeRatio20, vectors.volumeRatio20) * weights.volumeRatio20;
    score += (m.breakout20 ? 1 : 0) * weights.breakout20;
    score -= overheat * weights.ma5DeviationPenalty;
    score -= Math.max(0, Number(m.atrPct || 0) - 3) * 0.35;
    m.score = Number(score.toFixed(3));
    m.notes = [];
    if (m.breakout20) m.notes.push('20日帶量突破');
    if (m.rs20 > 0) m.notes.push('強於0050');
    if (m.aboveMa20) m.notes.push('站上20日均線');
    if (overheat > 0) m.notes.push('乖離偏高');
    return m;
  }).sort(function (a, b) { return b.score - a.score; });
}

function nextWeekday_(dateStr) {
  var parts = String(dateStr).split('-').map(function (p) { return parseInt(p, 10); });
  var d = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return Utilities.formatDate(d, TW_TZ, 'yyyy-MM-dd');
}

function activeSwingTradeCount_(userId) {
  return fsRunQuery_('', {
    from: [{ collectionId: 'swing_paper_trades' }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          { fieldFilter: { field: { fieldPath: 'userId' }, op: 'EQUAL', value: { stringValue: userId } } },
          { fieldFilter: { field: { fieldPath: 'status' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'planned' }, { stringValue: 'open' }] } } } },
        ],
      },
    },
    limit: 50,
  }).length;
}

function createPlannedSwingTrades_(runId, config, candidates) {
  if (!config.userId) return 0;
  var slots = Math.max(0, Number(config.maxOpenPositions || 5) - activeSwingTradeCount_(config.userId));
  if (!slots) return 0;
  var created = 0;
  candidates.slice(0, slots).forEach(function (c) {
    var tradeId = runId + '_' + c.symbol;
    var existing = fsGetDoc_('swing_paper_trades/' + tradeId);
    if (existing) return;
    var stopByPct = c.close * (1 - Number(config.stopLossPct || 4) / 100);
    var stopByAtr = c.close - Number(config.atrStopMultiplier || 1.5) * Number(c.atr14 || 0);
    var budgetCap = Math.min(
      Number(config.perTradeBudgetTWD || 20000),
      Number(config.virtualCapitalTWD || 100000) * Number(config.maxPositionPctOfAssets || 5) / 100,
    );
    var stopPrice = Math.max(0, Math.min(stopByPct, stopByAtr || stopByPct));
    var riskBudget = Number(config.virtualCapitalTWD || 100000)
      * Number(config.riskPerTradePct || 0.75) / 100;
    var riskPerShare = Math.max(0, c.close - stopPrice);
    var sharesByBudget = Math.floor(budgetCap / c.close);
    var sharesByRisk = riskPerShare > 0 ? Math.floor(riskBudget / riskPerShare) : 0;
    var shares = Math.min(sharesByBudget, sharesByRisk);
    if (shares < 1) return;
    fsSetDoc_('swing_paper_trades/' + tradeId, {
      userId: config.userId,
      signalRunId: runId,
      symbol: c.symbol,
      name: c.name || c.symbol,
      status: 'planned',
      plannedEntryDate: nextWeekday_(runId),
      entryDate: null,
      entryPrice: null,
      shares: shares,
      plannedCapitalTWD: shares * c.close,
      plannedRiskTWD: shares * riskPerShare,
      strategyVersion: SWING_STRATEGY_VERSION,
      stopPrice: stopPrice,
      takeProfitPrice: c.close * (1 + Number(config.takeProfitPct || 8) / 100),
      trailingStopPct: Number(config.trailingStopPct || 4),
      maxHoldingDays: Number(config.maxHoldingDays || 5),
      highestPrice: null,
      exitDate: null,
      exitPrice: null,
      exitReason: null,
      grossReturnPct: null,
      costPct: SWING_COST_PCT,
      netReturnPct: null,
      realizedPnlTWD: null,
      unrealizedPnlTWD: null,
      holdingDays: 0,
      maxFavorablePct: null,
      maxAdversePct: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, true);
    created++;
  });
  return created;
}

function runSwingScan() {
  return runSwingScanWithOptions_({ useLock: true });
}

function runSwingScanNoLock() {
  return runSwingScanWithOptions_({ useLock: false });
}

function runSwingScanWithOptions_(options) {
  options = options || {};
  var useLock = options.useLock !== false;
  var lock = LockService.getScriptLock();
  if (useLock && !lock.tryLock(60000)) {
    var busyDate = Utilities.formatDate(new Date(), TW_TZ, 'yyyy-MM-dd');
    fsSetDoc_('swing_signal_runs/' + busyDate, {
      runDate: busyDate,
      market: 'TW',
      status: 'lock_busy',
      generatedAt: new Date(),
      benchmarkSymbol: SWING_BENCHMARK,
      benchmarkReturn20: 0,
      candidates: [],
      reason: 'could-not-acquire-script-lock',
    }, true);
    return { ok: false, error: 'lock-busy' };
  }
  try {
    var configs = getSwingConfigs_();
    var out = { ok: true, runs: 0, candidates: 0, plannedTrades: 0, scanned: 0, eligible: 0 };
    if (!configs.length) {
      var noConfigDate = Utilities.formatDate(new Date(), TW_TZ, 'yyyy-MM-dd');
      fsSetDoc_('swing_signal_runs/' + noConfigDate, {
        runDate: noConfigDate,
        market: 'TW',
        status: 'no_config',
        generatedAt: new Date(),
        benchmarkSymbol: SWING_BENCHMARK,
        benchmarkReturn20: 0,
        candidates: [],
        reason: 'no-active-swing-strategy-config',
      }, true);
      return Object.assign(out, { reason: 'no-active-swing-strategy-config' });
    }
    configs.forEach(function (config) {
      var cfgId = String(config._name || 'default').split('/').pop();
      var bench = computeSwingMetrics_(SWING_BENCHMARK, 0);
      var benchmarkReturn20 = bench ? bench.return20 : 0;
      var marketTrendUp = !!(bench && bench.aboveMa20 && bench.return20 > 0);
      var symbols = (config.universeSymbols || []).filter(function (s) { return /^\d{4}$/.test(String(s)); });
      if (symbols.indexOf(SWING_BENCHMARK) === -1) symbols.unshift(SWING_BENCHMARK);
      var metrics = [];
      var scanErrors = [];
      var filteredLowVolume = 0;
      var filteredOverheat = 0;
      var filteredTrend = 0;
      var filteredRewardRisk = 0;
      var insufficientData = 0;
      symbols.forEach(function (sym) {
        try {
          out.scanned++;
          var m = computeSwingMetrics_(sym, benchmarkReturn20);
          if (!m) {
            insufficientData++;
            return;
          }
          if (m.avgVolume20 < Number(config.minAvgVolume20 || 0)) {
            filteredLowVolume++;
            return;
          }
          if (m.ma5DeviationPct > Number(config.maxMa5DeviationPct || 8) + 6) {
            filteredOverheat++;
            return;
          }
          // 0050 只當市場基準，不再把 ETF 自己列入個股候選。
          if (sym === SWING_BENCHMARK) return;
          if (!m.aboveMa20 || m.return10 <= 0 || m.rs20 <= 0) {
            filteredTrend++;
            return;
          }
          var metricStopByPct = m.close * (1 - Number(config.stopLossPct || 4) / 100);
          var metricStopByAtr = m.close - Number(config.atrStopMultiplier || 1.5) * Number(m.atr14 || 0);
          var metricStop = Math.max(0, Math.min(metricStopByPct, metricStopByAtr || metricStopByPct));
          var riskPerShare = m.close - metricStop;
          var rewardPerShare = m.close * Number(config.takeProfitPct || 8) / 100;
          m.rewardRiskRatio = riskPerShare > 0 ? rewardPerShare / riskPerShare : 0;
          if (m.rewardRiskRatio < Number(config.minimumRewardRiskRatio || 1.5)) {
            filteredRewardRisk++;
            return;
          }
          var stock = fsGetDoc_('stocks/' + sym);
          m.name = stock && stock.name ? stock.name : sym;
          metrics.push(m);
          out.eligible++;
        } catch (err) {
          scanErrors.push(sym + ': ' + String(err && err.message || err).slice(0, 160));
          console.warn('swing metrics failed', sym, err);
        }
      });
      var topN = Number(config.topN || 8);
      var rankedMetrics = config.marketTrendFilterEnabled !== false && !marketTrendUp
        ? []
        : scoreSwingCandidates_(metrics, config);
      var candidates = rankedMetrics.slice(0, topN).map(function (m, idx) {
        var stopByPct = m.close * (1 - Number(config.stopLossPct || 4) / 100);
        var stopByAtr = m.close - Number(config.atrStopMultiplier || 1.5) * Number(m.atr14 || 0);
        return {
          rank: idx + 1,
          symbol: m.symbol,
          name: m.name || m.symbol,
          date: m.date,
          score: m.score,
          close: m.close,
          volume: m.volume,
          avgVolume20: m.avgVolume20,
          return5: m.return5,
          return10: m.return10,
          return20: m.return20,
          rs20: m.rs20,
          breakout20: !!m.breakout20,
          volumeRatio20: m.volumeRatio20,
          ma5DeviationPct: m.ma5DeviationPct,
          atr14: m.atr14,
          atrPct: m.atrPct,
          aboveMa20: !!m.aboveMa20,
          rewardRiskRatio: m.rewardRiskRatio,
          suggestedStopPrice: Math.max(0, Math.min(stopByPct, stopByAtr || stopByPct)),
          suggestedTakeProfitPrice: m.close * (1 + Number(config.takeProfitPct || 8) / 100),
          notes: m.notes || [],
        };
      });
      var runId = candidates.length && candidates[0].date
        ? candidates[0].date
        : (bench && bench.date ? bench.date : Utilities.formatDate(new Date(), TW_TZ, 'yyyy-MM-dd'));
      if (candidates.length) {
        var latestCandles = getCandlesAsc_(candidates[0].symbol, 1);
        if (latestCandles.length && latestCandles[0].date) runId = latestCandles[0].date;
      }
      fsSetDoc_('swing_signal_runs/' + runId, {
        runDate: runId,
        market: 'TW',
        status: candidates.length ? 'ok' : 'no_candidates',
        configId: cfgId,
        configName: config.name || '短波段實驗',
        strategyVersion: SWING_STRATEGY_VERSION,
        generatedAt: new Date(),
        benchmarkSymbol: SWING_BENCHMARK,
        benchmarkReturn20: benchmarkReturn20,
        marketTrendUp: marketTrendUp,
        scanned: symbols.length,
        eligible: metrics.length,
        filteredLowVolume: filteredLowVolume,
        filteredOverheat: filteredOverheat,
        filteredTrend: filteredTrend,
        filteredRewardRisk: filteredRewardRisk,
        insufficientData: insufficientData,
        errors: scanErrors.slice(0, 20),
        reason: candidates.length
          ? null
          : (config.marketTrendFilterEnabled !== false && !marketTrendUp
            ? 'market-trend-filter-blocked'
            : 'no-symbol-passed-filters-or-data-requirements'),
        candidates: candidates,
      }, true);
      out.runs++;
      out.candidates += candidates.length;
      if (candidates.length) {
        out.plannedTrades += createPlannedSwingTrades_(runId, config, candidates);
      }
      updateSwingPaperSummary_(config.userId, config);
      if (config.notifyEnabled !== false) {
        notifySwingCandidates_(runId, config, candidates, benchmarkReturn20, marketTrendUp);
      }
      Utilities.sleep(300);
    });
    return out;
  } finally {
    if (useLock) lock.releaseLock();
  }
}

function closeSwingTrade_(trade, candle, reason, exitPrice, highest, low) {
  var entry = Number(trade.entryPrice || 0);
  if (!entry) return;
  var gross = ((exitPrice - entry) / entry) * 100;
  var costPct = Number(trade.costPct || SWING_COST_PCT);
  var net = gross - costPct * 100;
  var realizedPnl = (exitPrice - entry) * Number(trade.shares || 0) - entry * Number(trade.shares || 0) * costPct;
  var fav = highest ? ((highest - entry) / entry) * 100 : 0;
  var adv = low ? ((low - entry) / entry) * 100 : 0;
  var tradeId = String(trade._name || '').split('/').pop();
  fsSetDoc_('swing_paper_trades/' + tradeId, {
    status: 'closed',
    highestPrice: highest,
    exitDate: candle.date,
    exitPrice: exitPrice,
    exitReason: reason,
    grossReturnPct: gross,
    netReturnPct: net,
    realizedPnlTWD: realizedPnl,
    unrealizedPnlTWD: null,
    holdingDays: Number(trade.holdingDays || 0),
    maxFavorablePct: fav,
    maxAdversePct: adv,
    updatedAt: new Date(),
  }, true);
}

function syncSwingPaperTrades() {
  var trades = fsRunQuery_('', {
    from: [{ collectionId: 'swing_paper_trades' }],
    where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'planned' }, { stringValue: 'open' }] } } } },
    limit: 200,
  });
  var out = { ok: true, scanned: trades.length, opened: 0, closed: 0, noEntryCandle: 0, noCandles: 0 };
  trades.forEach(function (trade) {
    try {
      var candles = getCandlesAsc_(trade.symbol, 20);
      if (!candles.length) {
        out.noCandles++;
        return;
      }
      var tradeId = String(trade._name || '').split('/').pop();
      if (trade.status === 'planned') {
        var entryCandle = candles.filter(function (c) { return String(c.date) >= String(trade.plannedEntryDate); })[0];
        if (!entryCandle || !entryCandle.open) {
          out.noEntryCandle++;
          return;
        }
        fsSetDoc_('swing_paper_trades/' + tradeId, {
          status: 'open',
          entryDate: entryCandle.date,
          entryPrice: Number(entryCandle.open),
          plannedCapitalTWD: Number(entryCandle.open) * Number(trade.shares || 0),
          highestPrice: Number(entryCandle.high || entryCandle.open),
          holdingDays: 1,
          updatedAt: new Date(),
        }, true);
        out.opened++;
        return;
      }
      if (trade.status !== 'open' || !trade.entryDate || !trade.entryPrice) return;
      var afterEntry = candles.filter(function (c) { return String(c.date) >= String(trade.entryDate); });
      if (!afterEntry.length) return;
      var latest = afterEntry[afterEntry.length - 1];
      var highest = Math.max.apply(null, afterEntry.map(function (c) { return Number(c.high || c.close || 0); }));
      var lowest = Math.min.apply(null, afterEntry.map(function (c) { return Number(c.low || c.close || 0); }));
      var holdingDays = afterEntry.length;
      var entry = Number(trade.entryPrice);
      // trailing stop 只用「前一交易日以前」的最高價，避免同一根日 K 先創高再觸發
      // 或先觸發再創高的順序無法辨識，造成前視偏誤。
      var priorCandles = afterEntry.slice(0, -1);
      var priorHighest = priorCandles.length
        ? Math.max.apply(null, priorCandles.map(function (c) { return Number(c.high || c.close || 0); }))
        : 0;
      var trailingStop = priorHighest
        ? priorHighest * (1 - Number(trade.trailingStopPct || 4) / 100)
        : 0;
      var stopPrice = Number(trade.stopPrice || 0);
      var takeProfit = Number(trade.takeProfitPrice || 0);
      fsSetDoc_('swing_paper_trades/' + tradeId, {
        highestPrice: highest,
        holdingDays: holdingDays,
        unrealizedPnlTWD: (Number(latest.close || entry) - entry) * Number(trade.shares || 0),
        maxFavorablePct: ((highest - entry) / entry) * 100,
        maxAdversePct: ((lowest - entry) / entry) * 100,
        updatedAt: new Date(),
      }, true);
      var tradeAtClose = Object.assign({}, trade, { holdingDays: holdingDays });
      if (Number(latest.low || latest.close) <= stopPrice) {
        closeSwingTrade_(tradeAtClose, latest, 'stop_loss', Math.min(stopPrice, Number(latest.open || stopPrice)), highest, lowest);
        out.closed++;
      } else if (takeProfit && Number(latest.high || latest.close) >= takeProfit) {
        closeSwingTrade_(tradeAtClose, latest, 'take_profit', takeProfit, highest, lowest);
        out.closed++;
      } else if (holdingDays > 1 && trailingStop && Number(latest.low || latest.close) <= trailingStop) {
        closeSwingTrade_(tradeAtClose, latest, 'trailing_stop', Math.min(trailingStop, Number(latest.open || trailingStop)), highest, lowest);
        out.closed++;
      } else if (holdingDays >= Number(trade.maxHoldingDays || 5)) {
        closeSwingTrade_(tradeAtClose, latest, 'time_exit', Number(latest.close || latest.open), highest, lowest);
        out.closed++;
      }
    } catch (err) {
      console.warn('syncSwingPaperTrades trade failed', trade.symbol, err);
    }
  });
  getSwingConfigs_().forEach(function (config) {
    if (config.userId) updateSwingPaperSummary_(config.userId, config);
  });
  fsSetDoc_('swing_paper_sync_runs/' + Utilities.formatDate(new Date(), TW_TZ, 'yyyy-MM-dd'), {
    runDate: Utilities.formatDate(new Date(), TW_TZ, 'yyyy-MM-dd'),
    generatedAt: new Date(),
    status: 'ok',
    scanned: out.scanned,
    opened: out.opened,
    closed: out.closed,
    noCandles: out.noCandles,
    noEntryCandle: out.noEntryCandle,
  }, true);
  return out;
}

function updateSwingPaperSummary_(userId, config) {
  if (!userId) return null;
  var trades = fsRunQuery_('', {
    from: [{ collectionId: 'swing_paper_trades' }],
    where: { fieldFilter: { field: { fieldPath: 'userId' }, op: 'EQUAL', value: { stringValue: userId } } },
    limit: 500,
  });
  trades.sort(function (a, b) {
    return new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime();
  });
  var closed = trades.filter(function (t) { return t.status === 'closed'; });
  var open = trades.filter(function (t) { return t.status === 'open' || t.status === 'planned'; });
  var skipped = trades.filter(function (t) { return t.status === 'skipped'; });
  var returns = closed
    .map(function (t) { return typeof t.netReturnPct === 'number' ? t.netReturnPct : null; })
    .filter(function (v) { return v !== null; });
  var wins = returns.filter(function (v) { return v > 0; });
  var losses = returns.filter(function (v) { return v < 0; });
  var realized = closed.reduce(function (s, t) { return s + Number(t.realizedPnlTWD || 0); }, 0);
  var unrealized = open.reduce(function (s, t) { return s + Number(t.unrealizedPnlTWD || 0); }, 0);
  var virtualCapital = Number(config.virtualCapitalTWD || 100000);
  var grossProfit = wins.reduce(function (s, v) { return s + v; }, 0);
  var grossLoss = Math.abs(losses.reduce(function (s, v) { return s + v; }, 0));
  var winRate = returns.length ? wins.length / returns.length * 100 : 0;
  var avgWin = wins.length ? grossProfit / wins.length : 0;
  var avgLoss = losses.length ? Math.abs(losses.reduce(function (s, v) { return s + v; }, 0) / losses.length) : 0;
  var expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;
  var maxConsecutiveLosses = 0;
  var currentLosses = 0;
  var equity = virtualCapital;
  var peak = virtualCapital;
  var maxDrawdownPct = 0;
  closed.forEach(function (t) {
    var pnl = Number(t.realizedPnlTWD || 0);
    equity += pnl;
    if (equity > peak) peak = equity;
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
    if (pnl < 0) currentLosses++;
    else currentLosses = 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
  });
  var currentEquity = virtualCapital + realized + unrealized;
  var summary = {
    userId: userId,
    updatedAt: new Date(),
    virtualCapitalTWD: virtualCapital,
    openTrades: open.length,
    closedTrades: closed.length,
    skippedTrades: skipped.length,
    realizedPnlTWD: realized,
    unrealizedPnlTWD: unrealized,
    equityTWD: currentEquity,
    totalReturnPct: virtualCapital ? ((currentEquity - virtualCapital) / virtualCapital) * 100 : 0,
    winRate: winRate,
    averageWinPct: avgWin,
    averageLossPct: avgLoss,
    expectancyPct: expectancy,
    profitFactor: grossLoss ? grossProfit / grossLoss : 0,
    maxConsecutiveLosses: maxConsecutiveLosses,
    maxDrawdownPct: maxDrawdownPct,
  };
  fsSetDoc_('swing_paper_summaries/' + userId, summary, true);
  return summary;
}

function notifySwingCandidates_(runDate, config, candidates, benchmarkReturn20, marketTrendUp) {
  var lines = [
    '【短波段紙上實驗】',
    '日期｜' + runDate,
    '策略｜' + (config.name || '短波段實驗') + '（' + SWING_STRATEGY_VERSION + '）',
    '',
    '【盤勢判讀】',
    '0050 近20日｜' + benchmarkReturn20.toFixed(2) + '%',
    '大盤趨勢｜' + (marketTrendUp ? '偏多，可建立紙上部位' : '未達偏多條件，暫停新增部位'),
  ];
  if (!candidates.length) {
    lines.push('', '【本次結論】', marketTrendUp ? '沒有標的通過全部條件，維持空手觀察。' : '大盤濾網未通過，維持空手觀察。');
  }
  candidates.slice(0, Math.min(5, Number(config.topN || 8))).forEach(function (c) {
    var stopDistance = Math.max(0, c.close - c.suggestedStopPrice);
    var riskBudget = Number(config.virtualCapitalTWD || 100000)
      * Number(config.riskPerTradePct || 0.75) / 100;
    var budgetCap = Math.min(
      Number(config.perTradeBudgetTWD || 20000),
      Number(config.virtualCapitalTWD || 100000) * Number(config.maxPositionPctOfAssets || 5) / 100,
    );
    var shares = stopDistance > 0
      ? Math.min(Math.floor(riskBudget / stopDistance), Math.floor(budgetCap / c.close))
      : 0;
    lines.push('', '【候選 ' + c.rank + '】' + c.symbol + ' ' + (c.name || ''));
    lines.push('收盤價｜' + c.close.toFixed(2));
    lines.push('相對強度｜領先0050 ' + c.rs20.toFixed(2) + '%');
    lines.push('成交量｜20日均量的 ' + c.volumeRatio20.toFixed(2) + ' 倍');
    lines.push('停損／停利｜' + c.suggestedStopPrice.toFixed(2) + '／' + c.suggestedTakeProfitPrice.toFixed(2));
    lines.push('風險報酬比｜' + Number(c.rewardRiskRatio || 0).toFixed(2));
    lines.push('紙上股數｜' + shares + ' 股；預估最大損失 NT$' + Math.round(shares * stopDistance).toLocaleString());
    if (c.notes && c.notes.length) lines.push('條件｜' + c.notes.join('、'));
  });
  lines.push(
    '',
    '【風險規則】',
    '每筆風險上限｜虛擬本金 ' + Number(config.riskPerTradePct || 0.75).toFixed(2) + '%',
    '估計來回成本｜0.50%',
    '性質｜僅紙上交易實驗，不會自動下單，也不構成投資建議。',
  );
  return sendNotification_('swingSignals', lines.join('\n'));
}
