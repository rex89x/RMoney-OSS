/**
 * StockRadarFactors — 股市雷達的純函式：因子、市場 regime、輿情合成、動作判定、事後報酬、回測核心。
 *
 * 不讀寫 Firestore、不打外部 API，方便在 node 測試（apps-script/tests/stock-radar.test.cjs）。
 * 前端顯示用的因子 key / 動作 key / 原因 key 定義在 apps/web/src/features/stock-radar/types.ts、options.ts，
 * 改這裡要一起改。
 *
 * 設計：個人追蹤清單通常只有個位數到二十幾檔，橫斷面 z-score 太吵，所以每個因子都用
 * 文獻的「絕對」定義轉成 [-1, 1] 分數，再以固定權重加權平均（DeMiguel et al. 2009：
 * 簡單等權常勝過最佳化權重）。參數一律凍結在 STOCK_RADAR_MODEL_VERSION，改公式就升版。
 */

var STOCK_RADAR_MODEL_VERSION = 'p2-flows-sentiment';

/** 因子權重；缺資料的因子不計入分母（coverage 會反映） */
var STOCK_RADAR_FACTOR_WEIGHTS = {
  tsmom: 1,     // Moskowitz, Ooi & Pedersen (2012) 時間序列動能
  relMom: 1,    // Jegadeesh & Titman (1993) 12-1 動能，相對大盤
  high52: 1,    // George & Hwang (2004) 52 週高點
  trend: 1,     // Faber (2007)、Brock, Lakonishok & LeBaron (1992) 200 日均線
  reversal: 0.5, // Lehmann (1990)、Jegadeesh (1990) 短期反轉
  lowVol: 0.5,  // Ang et al. (2006)、Frazzini & Pedersen (2014) 低波動
  instFlow: 0.5, // 台股外資 + 投信淨買超（Richards 2005 JFQA 等外資流量實證）
  marginChange: 0.25, // 台股融資餘額變化，散戶過熱反向（Baker & Wurgler 2006 情緒框架）
};

/** 只有台股才有的因子：美股不計入 coverage 分母 */
var STOCK_RADAR_TW_ONLY_FACTORS = ['instFlow', 'marginChange'];

var STOCK_RADAR_THRESHOLDS = {
  add: 0.35,            // 持有：綜合分數 ≥ 此值才建議加碼
  buy: 0.35,            // 未持有：綜合分數 ≥ 此值列為買進候選
  buyRiskOff: 0.55,     // 大盤偏空時買進門檻
  trim: -0.15,          // 持有：≤ 此值建議減碼
  exit: -0.45,          // 持有：≤ 此值建議出場
  minCoverage: 0.5,     // 有效因子權重占比低於此值 → 資料不足
  maxWeightPct: 25,     // 單檔占股票部位上限，超過不建議加碼
  chandelierAtr: 3,     // 吊燈停損：22 日最高 − 3 × ATR14（LeBeau）
};

/** 輿情：Tetlock (2007)、Loughran & McDonald (2011)；社群方向性弱（Antweiler & Frank 2004）所以權重低、有上限 */
var STOCK_RADAR_SENTIMENT = {
  weight: 0.25,         // sentiment × confidence × weight
  pead: 0.05,           // 財報 beat / miss 的額外加減分（Bernard & Thomas 1989）
  maxAdj: 0.3,          // 輿情對綜合分數的最大影響
  eventTypes: ['earnings', 'offering', 'legal', 'downgrade', 'guidance'],
  eventDaysBefore: 2,   // 事件在評估日前 2 天內
  eventDaysAfter: 5,    // 到評估日後 5 天內 → 暫緩加碼／買進
  marketRiskOff: -0.5,  // 市場整體輿情 ≤ 此值且信心 ≥ 0.6 → regime 降一級
  marketMinConfidence: 0.6,
};

var SR_TRADING_DAYS_ = 252;

function srClamp_(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function srRound_(value, digits) {
  if (value === null || value === undefined || !isFinite(value)) return null;
  var f = Math.pow(10, digits === undefined ? 4 : digits);
  return Math.round(value * f) / f;
}

function srMean_(values) {
  if (!values.length) return 0;
  var sum = 0;
  for (var i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

function srStd_(values) {
  if (values.length < 2) return 0;
  var m = srMean_(values);
  return Math.sqrt(srMean_(values.map(function (v) { return (v - m) * (v - m); })));
}

function srCloses_(candles) {
  return candles.map(function (c) { return Number(c.close) || 0; });
}

/** yyyy-MM-dd → 從 1970-01-01 起的天數（純日期運算，不受時區影響） */
function srDayNumber_(dateStr) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

/** 年化已實現波動率（日 log return 標準差 × √252） */
function srAnnualVol_(closes, days) {
  var start = Math.max(1, closes.length - days);
  var rets = [];
  for (var i = start; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 20) return null;
  return srStd_(rets) * Math.sqrt(SR_TRADING_DAYS_);
}

function srAtr14_(candles) {
  if (candles.length < 15) return null;
  var trs = [];
  for (var i = candles.length - 14; i < candles.length; i++) {
    var c = candles[i];
    var prevClose = Number(candles[i - 1].close) || 0;
    var high = Number(c.high) || Number(c.close) || 0;
    var low = Number(c.low) || Number(c.close) || 0;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return srMean_(trs);
}

/**
 * 12-1 動能：t-252 → t-21 的報酬，跳過最近一個月（避開短期反轉）。
 * 歷史不足一年但至少半年時，用可用區間（扣掉最近一個月）近似。
 */
function srMomentum12_1_(closes) {
  var n = closes.length;
  if (n < 127) return null;
  var lookback = Math.min(SR_TRADING_DAYS_, n - 1);
  var from = closes[n - 1 - lookback];
  var to = closes[n - 22];
  if (!(from > 0) || !(to > 0)) return null;
  return to / from - 1;
}

/**
 * 計算單一標的原始指標。candles 需依日期升冪。
 * 回傳 null 代表歷史太短（< 61 根）或沒有收盤價。
 */
function computeStockRadarMetrics_(candles) {
  if (!candles || candles.length < 61) return null;
  var closes = srCloses_(candles);
  var n = closes.length;
  var close = closes[n - 1];
  if (!(close > 0)) return null;

  var vol60 = srAnnualVol_(closes, 60);
  var ma200 = n >= 200 ? srMean_(closes.slice(-200)) : null;
  var highWindow = candles.slice(-Math.min(SR_TRADING_DAYS_, n));
  var high52 = n >= 200
    ? Math.max.apply(null, highWindow.map(function (c) { return Number(c.high) || Number(c.close) || 0; }))
    : null;
  var high22 = Math.max.apply(null, candles.slice(-22).map(function (c) { return Number(c.high) || Number(c.close) || 0; }));
  var atr14 = srAtr14_(candles);
  var ret21 = closes[n - 22] > 0 ? close / closes[n - 22] - 1 : null;

  return {
    date: String(candles[n - 1].date || ''),
    close: close,
    historyDays: n,
    mom12_1: srMomentum12_1_(closes),
    ret21: ret21,
    vol60: vol60,
    ma200: ma200,
    high52: high52,
    atr14: atr14,
    chandelierStop: atr14 ? high22 - STOCK_RADAR_THRESHOLDS.chandelierAtr * atr14 : null,
  };
}

/**
 * 原始指標 → 每個價格因子 [-1, 1] 分數；缺資料的因子 score 為 null。
 * benchmark 為大盤（0050 / SPY）的 metrics，用來算相對動能。
 */
function scoreStockRadarFactors_(metrics, benchmark) {
  // 波動率下限 10%，避免低波動標的被放大成極端分數
  var vol = metrics.vol60 ? Math.max(metrics.vol60, 0.1) : null;
  var factors = {};

  factors.tsmom = {
    raw: metrics.mom12_1,
    score: metrics.mom12_1 !== null && vol ? Math.tanh(metrics.mom12_1 / vol) : null,
  };

  var bmMom = benchmark ? benchmark.mom12_1 : null;
  factors.relMom = {
    raw: metrics.mom12_1 !== null && bmMom !== null && bmMom !== undefined ? metrics.mom12_1 - bmMom : null,
    score: null,
  };
  if (factors.relMom.raw !== null && vol) factors.relMom.score = Math.tanh(factors.relMom.raw / vol);

  var proximity = metrics.high52 ? metrics.close / metrics.high52 : null;
  factors.high52 = {
    raw: proximity,
    // 0.85 為中性；貼近高點 → +1，距高點 30% → -1
    score: proximity !== null ? srClamp_((proximity - 0.85) / 0.15, -1, 1) : null,
  };

  var deviation = metrics.ma200 ? metrics.close / metrics.ma200 - 1 : null;
  factors.trend = {
    raw: deviation,
    score: deviation !== null ? Math.tanh(deviation / 0.1) : null,
  };

  // 一個月報酬以自身波動標準化後取負：漲太急扣分、跌深加分
  var monthlyVol = vol ? vol * Math.sqrt(21 / SR_TRADING_DAYS_) : null;
  factors.reversal = {
    raw: metrics.ret21,
    score: metrics.ret21 !== null && monthlyVol ? -Math.tanh(metrics.ret21 / monthlyVol / 2) : null,
  };

  factors.lowVol = {
    raw: metrics.vol60,
    // 年化 30% 為中性，10% → +1，50% → -1
    score: metrics.vol60 !== null ? srClamp_((0.3 - metrics.vol60) / 0.2, -1, 1) : null,
  };

  Object.keys(factors).forEach(function (key) {
    factors[key].raw = srRound_(factors[key].raw, 4);
    factors[key].score = srRound_(factors[key].score, 4);
  });
  return factors;
}

/**
 * 台股籌碼原始輸入：flowDocs 為 stock_radar_flows 每日文件（升冪，含 inst / margin map），
 * candles 提供同日成交股數。至少要 10 個交易日有資料才計算。
 */
function computeStockRadarFlowInputs_(symbol, flowDocs, candles) {
  var volumeByDate = {};
  (candles || []).forEach(function (c) { volumeByDate[c.date] = Number(c.volume) || 0; });
  var recent = (flowDocs || []).filter(function (d) { return d && d.inst; }).slice(-20);
  var instNet = 0;
  var volume = 0;
  var days = 0;
  recent.forEach(function (d) {
    var net = d.inst[symbol];
    var vol = volumeByDate[d.date];
    if (net === undefined || net === null || !vol) return;
    instNet += Number(net) || 0;
    volume += vol;
    days++;
  });
  var margins = recent.filter(function (d) {
    return d.margin && d.margin[symbol] !== undefined && d.margin[symbol] !== null;
  });
  var marginFrom = margins.length >= 10 ? Number(margins[0].margin[symbol]) : null;
  var marginTo = margins.length >= 10 ? Number(margins[margins.length - 1].margin[symbol]) : null;
  return {
    days: days,
    instNetRatio: days >= 10 && volume > 0 ? instNet / volume : null,
    // 融資餘額小於 50 張的冷門股，比例變化沒有意義
    marginChange: marginFrom !== null && marginFrom >= 50 ? marginTo / marginFrom - 1 : null,
  };
}

/** 籌碼因子：淨買超占成交量 5% → 約 +0.76；融資 20 日增加 25% → 約 -0.76 */
function scoreStockRadarFlowFactors_(flow) {
  var inst = flow ? flow.instNetRatio : null;
  var margin = flow ? flow.marginChange : null;
  return {
    instFlow: {
      raw: srRound_(inst, 4),
      score: inst === null || inst === undefined ? null : srRound_(Math.tanh(inst / 0.05), 4),
    },
    marginChange: {
      raw: srRound_(margin, 4),
      score: margin === null || margin === undefined ? null : srRound_(-Math.tanh(margin / 0.25), 4),
    },
  };
}

function compositeStockRadarScore_(factors, market) {
  var totalWeight = 0;
  var usedWeight = 0;
  var sum = 0;
  Object.keys(STOCK_RADAR_FACTOR_WEIGHTS).forEach(function (key) {
    if (market !== 'TW' && STOCK_RADAR_TW_ONLY_FACTORS.indexOf(key) >= 0) return;
    var w = STOCK_RADAR_FACTOR_WEIGHTS[key];
    totalWeight += w;
    var f = factors[key];
    if (f && f.score !== null && f.score !== undefined) {
      usedWeight += w;
      sum += w * f.score;
    }
  });
  return {
    composite: usedWeight ? srRound_(sum / usedWeight, 4) : null,
    coverage: totalWeight ? srRound_(usedWeight / totalWeight, 4) : 0,
  };
}

/**
 * 大盤 regime（Faber 2007 的 10 個月均線 + 時間序列動能）：
 * 站上 200 日均線且 12-1 動能為正 → risk_on；兩者皆負 → risk_off；其餘 neutral。
 */
function stockRadarRegime_(benchmark) {
  if (!benchmark || !benchmark.ma200 || benchmark.mom12_1 === null || benchmark.mom12_1 === undefined) {
    return 'unknown';
  }
  var above = benchmark.close > benchmark.ma200;
  var positive = benchmark.mom12_1 > 0;
  if (above && positive) return 'risk_on';
  if (!above && !positive) return 'risk_off';
  return 'neutral';
}

/**
 * 依綜合分數、regime、停損、持股占比、事件風險決定動作。
 * 持有中：add | hold | trim | exit；未持有：buy | watch | avoid；資料不足：insufficient。
 * reasons 用 key（前端翻成中文），方便日後統計各否決條件觸發幾次。
 */
function decideStockRadarAction_(input) {
  var t = STOCK_RADAR_THRESHOLDS;
  var reasons = [];
  if (input.composite === null || input.composite === undefined || input.coverage < t.minCoverage) {
    return { action: 'insufficient', reasons: ['insufficient_history'] };
  }
  var score = input.composite;
  var belowStop = input.chandelierStop !== null && input.chandelierStop !== undefined
    && input.close < input.chandelierStop;
  if (belowStop) reasons.push('below_stop');
  if (input.regime === 'risk_off') reasons.push('regime_risk_off');
  if (input.marketSentimentAdjusted) reasons.push('market_sentiment');

  if (input.held) {
    if (score <= t.exit) return { action: 'exit', reasons: reasons.concat(['score_very_weak']) };
    if (belowStop) return { action: score <= t.trim ? 'exit' : 'trim', reasons: reasons };
    if (score <= t.trim) return { action: 'trim', reasons: reasons.concat(['score_weak']) };
    if (score >= t.add) {
      if (input.regime === 'risk_off') return { action: 'hold', reasons: reasons };
      if (input.weightPct !== null && input.weightPct !== undefined && input.weightPct >= t.maxWeightPct) {
        return { action: 'hold', reasons: reasons.concat(['concentration']) };
      }
      if (input.eventRisk) return { action: 'hold', reasons: reasons.concat(['event_risk']) };
      return { action: 'add', reasons: reasons.concat(['score_strong']) };
    }
    return { action: 'hold', reasons: reasons };
  }

  var buyThreshold = input.regime === 'risk_off' ? t.buyRiskOff : t.buy;
  if (score >= buyThreshold && !belowStop) {
    if (input.eventRisk) return { action: 'watch', reasons: reasons.concat(['event_risk']) };
    return { action: 'buy', reasons: reasons.concat(['score_strong']) };
  }
  if (score >= 0) return { action: 'watch', reasons: reasons };
  return { action: 'avoid', reasons: reasons.concat(['score_weak']) };
}

/** 單一標的量化評估（不含輿情）：metrics → factors → composite → action */
function evaluateStockRadarItem_(candles, benchmark, regime, holding, market, flowInputs) {
  var metrics = computeStockRadarMetrics_(candles);
  if (!metrics) {
    return {
      metrics: null,
      factors: {},
      composite: null,
      coverage: 0,
      action: 'insufficient',
      reasons: ['insufficient_history'],
    };
  }
  var factors = scoreStockRadarFactors_(metrics, benchmark);
  if (market === 'TW') {
    var flowFactors = scoreStockRadarFlowFactors_(flowInputs || null);
    factors.instFlow = flowFactors.instFlow;
    factors.marginChange = flowFactors.marginChange;
  }
  var score = compositeStockRadarScore_(factors, market);
  var decision = decideStockRadarAction_({
    composite: score.composite,
    coverage: score.coverage,
    close: metrics.close,
    chandelierStop: metrics.chandelierStop,
    regime: regime,
    held: !!(holding && holding.shares > 0),
    weightPct: holding ? holding.weightPct : null,
  });
  return {
    metrics: metrics,
    factors: factors,
    composite: score.composite,
    coverage: score.coverage,
    action: decision.action,
    reasons: decision.reasons,
  };
}

// -------- 輿情合成 --------

function stockRadarHasSources_(entry) {
  return !!(entry && Array.isArray(entry.sources) && entry.sources.length > 0);
}

/** 個股輿情對綜合分數的加減：沒有來源 → 0 */
function stockRadarSentimentAdj_(entry) {
  if (!stockRadarHasSources_(entry)) return 0;
  var s = STOCK_RADAR_SENTIMENT;
  var adj = s.weight * srClamp_(Number(entry.sentiment) || 0, -1, 1) * srClamp_(Number(entry.confidence) || 0, 0, 1);
  if (entry.earningsSurprise === 'beat') adj += s.pead;
  if (entry.earningsSurprise === 'miss') adj -= s.pead;
  return srRound_(srClamp_(adj, -s.maxAdj, s.maxAdj), 4);
}

/** 評估日前後的重大事件（財報、增資、訴訟、降評、財測）→ 暫緩加碼／買進 */
function stockRadarEventRisk_(entry, runDate) {
  if (!entry || !Array.isArray(entry.riskEvents)) return false;
  var s = STOCK_RADAR_SENTIMENT;
  var today = srDayNumber_(runDate);
  return entry.riskEvents.some(function (ev) {
    if (!ev || s.eventTypes.indexOf(ev.type) < 0) return false;
    var day = srDayNumber_(ev.date);
    // 沒有日期的重大事件（例：剛傳出的訴訟）視為近期
    if (day === null || today === null) return true;
    return day >= today - s.eventDaysBefore && day <= today + s.eventDaysAfter;
  });
}

/** 市場整體輿情明顯偏空且有來源 → regime 降一級（Baker & Wurgler 2006 情緒修正） */
function stockRadarEffectiveRegime_(regime, marketView) {
  var s = STOCK_RADAR_SENTIMENT;
  if (!stockRadarHasSources_(marketView)) return { regime: regime, adjusted: false };
  var bearish = (Number(marketView.sentiment) || 0) <= s.marketRiskOff
    && (Number(marketView.confidence) || 0) >= s.marketMinConfidence;
  if (!bearish) return { regime: regime, adjusted: false };
  if (regime === 'risk_on') return { regime: 'neutral', adjusted: true };
  if (regime === 'neutral' || regime === 'unknown') return { regime: 'risk_off', adjusted: true };
  return { regime: regime, adjusted: false };
}

/**
 * 量化 item + 輿情 → 最終 item。量化分數保存在 quantScore，重複合成（輿情晚到、重送）結果一致。
 * regimeInfo 為 stockRadarEffectiveRegime_ 的結果。
 */
function synthesizeStockRadarItem_(item, entry, regimeInfo, runDate) {
  var quant = item.quantScore !== undefined && item.quantScore !== null ? item.quantScore : item.composite;
  var adj = stockRadarSentimentAdj_(entry);
  var composite = quant === null || quant === undefined ? null : srRound_(srClamp_(quant + adj, -1, 1), 4);
  var eventRisk = stockRadarEventRisk_(entry, runDate);
  var metrics = item.metrics || {};
  var decision = decideStockRadarAction_({
    composite: composite,
    coverage: item.coverage,
    close: item.close,
    chandelierStop: metrics.chandelierStop,
    regime: regimeInfo.regime,
    marketSentimentAdjusted: regimeInfo.adjusted,
    held: !!item.held,
    weightPct: item.weightPct,
    eventRisk: eventRisk,
  });
  var out = {};
  Object.keys(item).forEach(function (key) { out[key] = item[key]; });
  out.quantScore = quant === undefined ? null : quant;
  out.sentimentAdj = adj;
  out.composite = composite;
  out.eventRisk = eventRisk;
  out.sentiment = entry ? {
    score: entry.sentiment,
    confidence: entry.confidence,
    summary: entry.summary || '',
    catalysts: entry.catalysts || [],
    riskEvents: entry.riskEvents || [],
    earningsSurprise: entry.earningsSurprise || null,
    sources: entry.sources || [],
  } : null;
  out.action = decision.action;
  out.reasons = decision.reasons;
  return out;
}

function stockRadarActionCounts_(items) {
  var counts = {};
  items.forEach(function (it) { counts[it.action] = (counts[it.action] || 0) + 1; });
  return counts;
}

// -------- 事後報酬（成績單） --------

/**
 * 盤前建議在 priceDate 收盤後產生，實際最早只能在下一根開盤進場：
 * entry = priceDate 之後第一根的 open；fwdN = 第 N 根收盤 / entry − 1。
 */
function stockRadarForwardReturns_(candles, priceDate, horizons) {
  var out = { entryDate: null, entry: null };
  horizons.forEach(function (h) { out['fwd' + h] = null; });
  if (!candles || !priceDate) return out;
  var i = 0;
  while (i < candles.length && String(candles[i].date) <= priceDate) i++;
  if (i >= candles.length) return out;
  var entry = Number(candles[i].open) || Number(candles[i].close) || 0;
  if (!(entry > 0)) return out;
  out.entryDate = candles[i].date;
  out.entry = entry;
  horizons.forEach(function (h) {
    var exit = candles[i + h - 1];
    if (exit && Number(exit.close) > 0) out['fwd' + h] = srRound_(Number(exit.close) / entry - 1, 5);
  });
  return out;
}

// -------- 回測核心 --------

/** Spearman 等級相關（同分取平均名次）；樣本 < 3 回傳 null */
function srSpearman_(xs, ys) {
  var n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  function ranks(values) {
    var idx = values.map(function (v, i) { return i; }).sort(function (a, b) { return values[a] - values[b]; });
    var r = new Array(n);
    var k = 0;
    while (k < n) {
      var j = k;
      while (j + 1 < n && values[idx[j + 1]] === values[idx[k]]) j++;
      var avg = (k + j) / 2;
      for (var m = k; m <= j; m++) r[idx[m]] = avg;
      k = j + 1;
    }
    return r;
  }
  var rx = ranks(xs);
  var ry = ranks(ys);
  var mx = srMean_(rx);
  var my = srMean_(ry);
  var num = 0;
  var dx = 0;
  var dy = 0;
  for (var i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) * (rx[i] - mx);
    dy += (ry[i] - my) * (ry[i] - my);
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

function srCurveStats_(weeklyReturns) {
  var equity = 1;
  var peak = 1;
  var maxDd = 0;
  weeklyReturns.forEach(function (r) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity / peak - 1);
  });
  var weeks = weeklyReturns.length;
  var sd = srStd_(weeklyReturns);
  return {
    totalReturn: srRound_(equity - 1, 4),
    cagr: weeks ? srRound_(Math.pow(equity, 52 / weeks) - 1, 4) : null,
    volatility: srRound_(sd * Math.sqrt(52), 4),
    sharpe: sd ? srRound_(srMean_(weeklyReturns) / sd * Math.sqrt(52), 2) : null,
    maxDrawdown: srRound_(maxDd, 4),
  };
}

var STOCK_RADAR_BACKTEST_BUCKETS = [
  { key: 'strong', min: 0.35, max: Infinity },
  { key: 'positive', min: 0, max: 0.35 },
  { key: 'weak', min: -0.15, max: 0 },
  { key: 'very_weak', min: -Infinity, max: -0.15 },
];

/**
 * Walk-forward 回測：每 step 個交易日，用「當天以前」的 K 線算價格因子分數（與每日評估同一套函式），
 * 對照之後 5 / 20 日相對大盤的超額報酬。不含輿情與籌碼（沒有歷史資料）。
 *
 * - IC：每期 Spearman(score, 20 日超額報酬)
 * - 分數區間：各區間的平均 20 日超額報酬與勝率
 * - 策略：每 5 日等權持有分數 ≥ 0 的標的（大盤偏空時 ≥ 0.35），扣來回成本 × 換手率；對照全部等權與大盤
 *
 * seriesBySymbol：{ symbol: candles 升冪 }；roundTripCost：台股約 0.6%（手續費 + 證交稅）、美股 0.1%
 */
function runStockRadarBacktestCore_(seriesBySymbol, benchmarkCandles, market, opts) {
  opts = opts || {};
  var step = opts.step || 5;
  var cost = opts.roundTripCost === undefined ? 0.006 : opts.roundTripCost;
  var bm = benchmarkCandles || [];
  var symbols = Object.keys(seriesBySymbol);
  var indexBySymbol = {};
  symbols.forEach(function (sym) {
    var map = {};
    seriesBySymbol[sym].forEach(function (c, i) { map[c.date] = i; });
    indexBySymbol[sym] = map;
  });

  var icSeries = [];
  var bucketRows = {};
  STOCK_RADAR_BACKTEST_BUCKETS.forEach(function (b) { bucketRows[b.key] = []; });
  var strategy = [];
  var equalWeight = [];
  var benchmark = [];
  var curve = [];
  var eq = { s: 1, e: 1, b: 1 };
  var prevHoldings = {};
  var samples = 0;

  for (var bi = 253; bi + 20 < bm.length; bi += step) {
    var date = bm[bi].date;
    var bmMetrics = computeStockRadarMetrics_(bm.slice(Math.max(0, bi - 259), bi + 1));
    var regime = stockRadarRegime_(bmMetrics);
    var bmEntry = Number(bm[bi + 1].open) || Number(bm[bi + 1].close);
    var bmFwd5 = Number(bm[bi + 5].close) / bmEntry - 1;
    var bmFwd20 = Number(bm[bi + 20].close) / bmEntry - 1;

    var scores = [];
    var excess20 = [];
    var picks = [];
    var all = [];
    symbols.forEach(function (sym) {
      var k = indexBySymbol[sym][date];
      var series = seriesBySymbol[sym];
      if (k === undefined || k + 20 >= series.length) return;
      var metrics = computeStockRadarMetrics_(series.slice(Math.max(0, k - 259), k + 1));
      if (!metrics) return;
      var factors = scoreStockRadarFactors_(metrics, bmMetrics);
      var score = compositeStockRadarScore_(factors, market);
      if (score.composite === null || score.coverage < STOCK_RADAR_THRESHOLDS.minCoverage) return;
      var entry = Number(series[k + 1].open) || Number(series[k + 1].close);
      if (!(entry > 0)) return;
      var fwd5 = Number(series[k + 5].close) / entry - 1;
      var ex20 = Number(series[k + 20].close) / entry - 1 - bmFwd20;
      samples++;
      scores.push(score.composite);
      excess20.push(ex20);
      all.push({ symbol: sym, fwd5: fwd5 });
      var threshold = regime === 'risk_off' ? STOCK_RADAR_THRESHOLDS.add : 0;
      if (score.composite >= threshold) picks.push({ symbol: sym, fwd5: fwd5 });
      STOCK_RADAR_BACKTEST_BUCKETS.forEach(function (b) {
        if (score.composite >= b.min && score.composite < b.max) bucketRows[b.key].push(ex20);
      });
    });
    if (!all.length) continue;

    var ic = srSpearman_(scores, excess20);
    if (ic !== null) icSeries.push({ date: date, ic: srRound_(ic, 4), n: scores.length });

    // 換手率：新舊等權組合權重差的一半
    var holdings = {};
    picks.forEach(function (p) { holdings[p.symbol] = 1 / picks.length; });
    var turnover = 0;
    Object.keys(holdings).concat(Object.keys(prevHoldings)).forEach(function (sym, i, arr) {
      if (arr.indexOf(sym) !== i) return;
      turnover += Math.abs((holdings[sym] || 0) - (prevHoldings[sym] || 0));
    });
    turnover /= 2;
    prevHoldings = holdings;
    var stratRet = picks.length ? srMean_(picks.map(function (p) { return p.fwd5; })) : 0;
    stratRet -= turnover * cost;
    var ewRet = srMean_(all.map(function (p) { return p.fwd5; }));
    strategy.push(stratRet);
    equalWeight.push(ewRet);
    benchmark.push(bmFwd5);
    eq.s *= 1 + stratRet;
    eq.e *= 1 + ewRet;
    eq.b *= 1 + bmFwd5;
    curve.push({
      date: date,
      strategy: srRound_(eq.s, 4),
      equalWeight: srRound_(eq.e, 4),
      benchmark: srRound_(eq.b, 4),
      holdings: picks.length,
    });
  }

  var ics = icSeries.map(function (p) { return p.ic; });
  var icSd = srStd_(ics);
  var buckets = STOCK_RADAR_BACKTEST_BUCKETS.map(function (b) {
    var rows = bucketRows[b.key];
    return {
      key: b.key,
      n: rows.length,
      avgExcess20: rows.length ? srRound_(srMean_(rows), 4) : null,
      hitRate: rows.length ? srRound_(rows.filter(function (r) { return r > 0; }).length / rows.length, 4) : null,
    };
  });
  return {
    market: market,
    modelVersion: STOCK_RADAR_MODEL_VERSION,
    from: curve.length ? curve[0].date : null,
    to: curve.length ? curve[curve.length - 1].date : null,
    periods: curve.length,
    samples: samples,
    symbols: symbols.length,
    meanIC: ics.length ? srRound_(srMean_(ics), 4) : null,
    icTStat: ics.length > 1 && icSd ? srRound_(srMean_(ics) / (icSd / Math.sqrt(ics.length)), 2) : null,
    icPositiveRate: ics.length ? srRound_(ics.filter(function (v) { return v > 0; }).length / ics.length, 4) : null,
    buckets: buckets,
    strategy: srCurveStats_(strategy),
    equalWeight: srCurveStats_(equalWeight),
    benchmark: srCurveStats_(benchmark),
    curve: curve,
    icSeries: icSeries,
  };
}
