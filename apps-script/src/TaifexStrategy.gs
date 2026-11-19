/**
 * TaifexStrategy — 台指期日線波段策略的純函式（不碰 Firestore / UrlFetch / PROP）。
 *
 * 規劃見 docs/TAIFEX_PAPER_TRADING_PLAN.md §3；測試 apps-script/tests/taifex.test.cjs。
 *
 * - 指標：EMA、Wilder ATR / ADX、唐奇安通道、時間序列 z-score
 * - 因子：trend / breakout / tsmom / foreignFlow / pcr → composite
 * - 帳戶：stepTaifexAccount_（換月平移 → 開盤成交 → 停損 → 收盤結算 → 熔斷）
 * - 回測：runTaifexBacktest_ 與虛擬帳戶共用 stepTaifexAccount_，結果不會因程式分岔而對不起來
 *
 * 參數凍結在 TAIFEX_MODEL_VERSION；改公式就升版。所有函式以 tf 為前綴，避免與其他 .gs 的全域名稱衝突。
 */

var TAIFEX_MODEL_VERSION = 'tx-v1';

var TAIFEX_PRODUCTS = {
  TX: { label: '大台', pointValue: 200, commission: 60, margin: 350000 },
  MTX: { label: '小台', pointValue: 50, commission: 30, margin: 87500 },
  TMF: { label: '微台', pointValue: 10, commission: 15, margin: 17500 },
};

var TAIFEX_FACTOR_WEIGHTS = { trend: 0.30, breakout: 0.20, tsmom: 0.20, foreignFlow: 0.20, pcr: 0.10 };
var TAIFEX_TREND_ONLY_WEIGHTS = { trend: 0.30, breakout: 0.20, tsmom: 0.20 };

var TAIFEX_RULES = {
  entry: 0.35,
  exit: 0.05,
  adxTrend: 18,
  chopDamp: 0.6,
  minCoverage: 0.5,
  stopAtr: 2,
  trailAtr: 3,
  sentimentWeight: 0.2,
  sentimentCap: 0.2,
  /** 輿情強烈反向（分數 × 信心）→ 盤前否決新開倉 */
  vetoSentiment: -0.5,
  maxMarginUtil: 0.4,
  /** 期交稅：契約價值 × 十萬分之二（單邊） */
  taxRate: 0.00002,
  warmup: 60,
  zLookback: 120,
  zMinObs: 20,
};

/** 可依策略變體調整的規則（其餘 TAIFEX_RULES 固定）；未指定就用 tx-v1 預設 */
var TAIFEX_TUNABLE_KEYS = ['entry', 'exit', 'adxTrend', 'chopDamp', 'stopAtr', 'trailAtr'];

function tfParams_(params) {
  var out = {};
  TAIFEX_TUNABLE_KEYS.forEach(function (key) {
    var v = params && Number(params[key]);
    out[key] = params && params[key] !== undefined && params[key] !== null && isFinite(v) ? v : TAIFEX_RULES[key];
  });
  // 出場門檻不能高於進場門檻，否則一進場就出場
  if (out.exit >= out.entry) out.exit = Math.max(0, out.entry - 0.1);
  return out;
}

/**
 * 參數物件可以另外帶 `weights`（日線因子權重，五個因子都要有、總和 1）；沒有就用 TAIFEX_FACTOR_WEIGHTS。
 * 只有「Claude 調校」變體會帶（TaifexTuning.gs 驗過範圍才寫進 taifex_tuning/current）。
 */
function tfParamWeights_(params) {
  var w = params && params.weights;
  if (!w || typeof w !== 'object') return null;
  var out = {};
  var sum = 0;
  var ok = Object.keys(TAIFEX_FACTOR_WEIGHTS).every(function (key) {
    var v = Number(w[key]);
    if (!isFinite(v) || v < 0) return false;
    out[key] = v;
    sum += v;
    return true;
  });
  return ok && sum > 0 ? out : null;
}

var TAIFEX_EVENT_TYPES = ['fomc', 'cpi', 'nfp', 'cbc', 'earnings', 'settlement', 'holiday', 'geopolitical', 'policy', 'other'];
var TAIFEX_EVENT_IMPORTANCE = ['high', 'medium', 'low'];

// -------- 基本工具 --------

function tfClip_(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function tfRound_(x, digits) {
  if (x === null || x === undefined || !isFinite(x)) return null;
  var p = Math.pow(10, digits === undefined ? 2 : digits);
  return Math.round(x * p) / p;
}

function tfNum_(x) {
  return typeof x === 'number' && isFinite(x) ? x : null;
}

function tfPad2_(n) {
  return n < 10 ? '0' + n : String(n);
}

function tfDateToStr_(d) {
  return d.getUTCFullYear() + '-' + tfPad2_(d.getUTCMonth() + 1) + '-' + tfPad2_(d.getUTCDate());
}

function tfStrToDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

/** 下一個平日（不含假日表；週五 → 週一） */
function tfNextWeekday_(dateStr) {
  var d = tfStrToDate_(dateStr);
  if (!d) return null;
  do { d = new Date(d.getTime() + 86400000); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return tfDateToStr_(d);
}

/** 月契約到期日：該月第三個週三（不處理假日順延） */
function tfThirdWednesday_(year, month) {
  var first = new Date(Date.UTC(year, month - 1, 1));
  var offset = (3 - first.getUTCDay() + 7) % 7;
  return tfDateToStr_(new Date(Date.UTC(year, month - 1, 1 + offset + 14)));
}

function tfContractExpiry_(contract) {
  var m = /^(\d{4})(\d{2})$/.exec(String(contract || ''));
  return m ? tfThirdWednesday_(Number(m[1]), Number(m[2])) : null;
}

/** 近月 = 到期日晚於當天的最近月份（結算日當天已換到次月） */
function tfPickFrontContracts_(date, contracts) {
  var live = contracts.filter(function (c) {
    var exp = tfContractExpiry_(c);
    return exp && exp > date;
  }).sort();
  return { front: live[0] || null, next: live[1] || null };
}

// -------- 設定 --------

function tfDefaultConfig_() {
  return {
    mode: 'auto',
    product: 'TMF',
    initialCapital: 1000000,
    riskPerTradePct: 1.5,
    maxContracts: 5,
    allowShort: true,
    maxDrawdownPct: 20,
    commissionPerSide: null,
    slippagePoints: 1,
    marginPerContract: null,
    notifyEnabled: true,
  };
}

function tfBounded_(value, lo, hi, fallback) {
  var n = Number(value);
  return isFinite(n) && n >= lo && n <= hi ? n : fallback;
}

/** 前端寫入的設定再驗一次（範圍外一律回預設），並展開契約規格 */
function tfNormalizeConfig_(raw) {
  raw = raw || {};
  var d = tfDefaultConfig_();
  var product = TAIFEX_PRODUCTS[raw.product] ? raw.product : d.product;
  var spec = TAIFEX_PRODUCTS[product];
  return {
    mode: raw.mode === 'manual' ? 'manual' : 'auto',
    product: product,
    pointValue: spec.pointValue,
    initialCapital: tfBounded_(raw.initialCapital, 50000, 100000000, d.initialCapital),
    riskPerTradePct: tfBounded_(raw.riskPerTradePct, 0.1, 5, d.riskPerTradePct),
    maxContracts: Math.floor(tfBounded_(raw.maxContracts, 1, 50, d.maxContracts)),
    allowShort: raw.allowShort !== false,
    maxDrawdownPct: tfBounded_(raw.maxDrawdownPct, 5, 60, d.maxDrawdownPct),
    commissionPerSide: tfBounded_(raw.commissionPerSide, 0, 1000, spec.commission),
    slippagePoints: tfBounded_(raw.slippagePoints, 0, 50, d.slippagePoints),
    marginPerContract: tfBounded_(raw.marginPerContract, 1000, 5000000, spec.margin),
    notifyEnabled: raw.notifyEnabled !== false,
  };
}

/** 單邊交易成本（手續費 + 滑價 + 期交稅） */
function tfTradeCost_(price, contracts, config) {
  if (!contracts) return 0;
  var perContract = config.commissionPerSide + config.slippagePoints * config.pointValue
    + price * config.pointValue * TAIFEX_RULES.taxRate;
  return Math.round(perContract * contracts);
}

// -------- 指標 --------

/** 往回調整的連續序列：最新一段等於真實價格；gaps[i] = 進入第 i 根時的換月價差 */
function tfBackAdjust_(bars) {
  var n = bars.length;
  var adj = new Array(n);
  var gaps = new Array(n);
  var offset = 0;
  for (var i = n - 1; i >= 0; i--) {
    var b = bars[i];
    adj[i] = { open: b.open + offset, high: b.high + offset, low: b.low + offset, close: b.close + offset };
    gaps[i] = 0;
    if (i > 0 && bars[i - 1].contract && b.contract && bars[i - 1].contract !== b.contract) {
      var prev = bars[i - 1];
      var gap = prev.nextContract === b.contract && tfNum_(prev.nextClose) !== null ? prev.nextClose - prev.close : 0;
      gaps[i] = gap;
      offset += gap;
    }
  }
  return { adj: adj, gaps: gaps };
}

function tfEma_(values, period) {
  var out = new Array(values.length);
  var k = 2 / (period + 1);
  var sum = 0;
  for (var i = 0; i < values.length; i++) {
    if (i < period - 1) { sum += values[i]; out[i] = null; continue; }
    if (i === period - 1) { sum += values[i]; out[i] = sum / period; continue; }
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function tfTrueRanges_(adj) {
  return adj.map(function (b, i) {
    if (i === 0) return b.high - b.low;
    var pc = adj[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/** Wilder 平滑：前 period 根取平均，之後 (prev × (p−1) + x) / p */
function tfWilder_(values, period, startIndex) {
  var out = new Array(values.length);
  var sum = 0;
  var count = 0;
  for (var i = 0; i < values.length; i++) {
    if (i < startIndex) { out[i] = null; continue; }
    if (count < period) {
      sum += values[i];
      count++;
      out[i] = count === period ? sum / period : null;
      continue;
    }
    out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  }
  return out;
}

function tfAtr_(adj, period) {
  return tfWilder_(tfTrueRanges_(adj), period, 0);
}

function tfAdx_(adj, period) {
  var n = adj.length;
  var plusDm = new Array(n);
  var minusDm = new Array(n);
  var tr = tfTrueRanges_(adj);
  for (var i = 0; i < n; i++) {
    if (i === 0) { plusDm[i] = 0; minusDm[i] = 0; continue; }
    var up = adj[i].high - adj[i - 1].high;
    var down = adj[i - 1].low - adj[i].low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  var trS = tfWilder_(tr, period, 1);
  var pS = tfWilder_(plusDm, period, 1);
  var mS = tfWilder_(minusDm, period, 1);
  var dx = new Array(n);
  var firstDx = -1;
  for (var j = 0; j < n; j++) {
    if (trS[j] === null || !trS[j]) { dx[j] = 0; continue; }
    if (firstDx < 0) firstDx = j;
    var pdi = 100 * pS[j] / trS[j];
    var mdi = 100 * mS[j] / trS[j];
    dx[j] = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
  }
  return firstDx < 0 ? dx.map(function () { return null; }) : tfWilder_(dx, period, firstDx);
}

/** values[i] 相對過去 lookback 筆（含自己）的 z-score；有效值不足回 null */
function tfZscoreAt_(values, i, lookback, minObs) {
  if (values[i] === null || values[i] === undefined) return null;
  var window = [];
  for (var k = Math.max(0, i - lookback + 1); k <= i; k++) {
    if (values[k] !== null && values[k] !== undefined && isFinite(values[k])) window.push(values[k]);
  }
  if (window.length < (minObs || TAIFEX_RULES.zMinObs)) return null;
  var mean = window.reduce(function (s, v) { return s + v; }, 0) / window.length;
  var variance = window.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / window.length;
  var sd = Math.sqrt(variance);
  return sd > 0 ? (values[i] - mean) / sd : 0;
}

/** 一次算好整段序列的指標（每天重算全部歷史約 750 根，成本可忽略） */
function tfPrepareSeries_(bars) {
  var ba = tfBackAdjust_(bars);
  var closes = ba.adj.map(function (b) { return b.close; });
  var foreign = bars.map(function (b) { return tfNum_(b.foreignNetOi); });
  var foreignChange = foreign.map(function (v, i) {
    return i >= 5 && v !== null && foreign[i - 5] !== null ? v - foreign[i - 5] : null;
  });
  return {
    bars: bars,
    adj: ba.adj,
    gaps: ba.gaps,
    ema20: tfEma_(closes, 20),
    ema60: tfEma_(closes, 60),
    atr20: tfAtr_(ba.adj, 20),
    adx14: tfAdx_(ba.adj, 14),
    foreign: foreign,
    foreignChange: foreignChange,
    pcr: bars.map(function (b) { return tfNum_(b.pcrOi); }),
  };
}

// -------- 因子與訊號 --------

/**
 * 第 i 根 K 棒收盤後的因子分數。報酬用「調整後價差 ÷ 當時真實價格」，與往回調整的常數位移無關（無前視偏誤）。
 */
function tfFactorsAt_(series, i) {
  var adj = series.adj;
  var bars = series.bars;
  var close = adj[i].close;
  var atr = series.atr20[i];
  var e20 = series.ema20[i];
  var e60 = series.ema60[i];
  var factors = {};

  if (atr && e20 !== null && e60 !== null) {
    var t1 = tfClip_((e20 - e60) / (2 * atr), -1, 1);
    var t2 = tfClip_((close - e60) / (3 * atr), -1, 1);
    factors.trend = { raw: tfRound_(e20 - e60, 1), score: tfRound_((t1 + t2) / 2, 3) };
  } else factors.trend = { raw: null, score: null };

  if (i >= 54) {
    var hi = -Infinity;
    var lo = Infinity;
    for (var k = i - 54; k <= i; k++) { hi = Math.max(hi, adj[k].high); lo = Math.min(lo, adj[k].low); }
    var pos = hi > lo ? (close - lo) / (hi - lo) : 0.5;
    factors.breakout = { raw: tfRound_(pos, 3), score: tfRound_(pos * 2 - 1, 3), high: hi, low: lo };
  } else factors.breakout = { raw: null, score: null };

  if (i >= 60) {
    var rets = [];
    for (var r = i - 59; r <= i; r++) rets.push((adj[r].close - adj[r - 1].close) / bars[r - 1].close);
    var m = rets.reduce(function (s, v) { return s + v; }, 0) / rets.length;
    var sd = Math.sqrt(rets.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / rets.length);
    var ret60 = (close - adj[i - 60].close) / bars[i].close;
    var ts = sd > 0 ? ret60 / (sd * Math.sqrt(60)) : 0;
    factors.tsmom = { raw: tfRound_(ret60, 4), score: tfRound_(tfClip_(ts / 2, -1, 1), 3) };
  } else factors.tsmom = { raw: null, score: null };

  var zl = tfZscoreAt_(series.foreign, i, TAIFEX_RULES.zLookback);
  var zc = tfZscoreAt_(series.foreignChange, i, TAIFEX_RULES.zLookback);
  factors.foreignFlow = zl !== null && zc !== null
    ? { raw: series.foreign[i], score: tfRound_(tfClip_((0.5 * zl + 0.5 * zc) / 2, -1, 1), 3) }
    : { raw: series.foreign[i], score: null };

  var zp = tfZscoreAt_(series.pcr, i, TAIFEX_RULES.zLookback);
  factors.pcr = zp !== null
    ? { raw: series.pcr[i], score: tfRound_(tfClip_(zp / 2, -1, 1), 3) }
    : { raw: series.pcr[i], score: null };

  return factors;
}

function tfQuantScore_(factors, weights) {
  var total = 0;
  var used = 0;
  var all = 0;
  Object.keys(weights).forEach(function (key) {
    all += weights[key];
    var f = factors[key];
    if (f && f.score !== null && f.score !== undefined) {
      total += weights[key] * f.score;
      used += weights[key];
    }
  });
  return { score: used ? total / used : null, coverage: all ? used / all : 0 };
}

/** 輿情加減分：沒有 https 來源（confidence 已被歸零）就是 0 */
function tfSentimentAdj_(sentiment) {
  if (!sentiment || !sentiment.overall) return 0;
  var s = Number(sentiment.overall.sentiment);
  var c = Number(sentiment.overall.confidence);
  if (!isFinite(s) || !isFinite(c)) return 0;
  return tfClip_(s * c * TAIFEX_RULES.sentimentWeight, -TAIFEX_RULES.sentimentCap, TAIFEX_RULES.sentimentCap);
}

/** 下一個交易日有高重要性事件 → 事件風險（只看 Claude 回報的事件；結算日只提示不擋） */
function tfEventRisk_(sentiment, signalDate) {
  var next = tfNextWeekday_(signalDate);
  var events = (sentiment && Array.isArray(sentiment.events)) ? sentiment.events : [];
  var blocking = events.filter(function (ev) {
    return ev && ev.importance === 'high' && ev.type !== 'settlement' && ev.date && ev.date > signalDate && ev.date <= next;
  });
  return { risk: blocking.length > 0, events: blocking };
}

/** 依目前部位與分數決定目標部位（含遲滯）；回傳 desired + 中文原因 */
function tfDecideTarget_(input) {
  var current = input.currentSide || 'flat';
  var c = input.composite;
  var rules = tfParams_(input.params);
  var minCoverage = TAIFEX_RULES.minCoverage;
  var reasons = [];
  if (c === null || c === undefined) return { desired: current, reasons: ['資料不足，維持現狀'] };
  if (input.halted) return { desired: 'flat', reasons: ['帳戶已熔斷：平倉並暫停新進場'] };

  var blockers = [];
  if (input.eventRisk) blockers.push('下一個交易日有重大事件，暫停新開倉');
  if (input.coverage < minCoverage) blockers.push('因子涵蓋率不足，暫停新開倉');
  var canOpen = blockers.length === 0;
  var trend = input.trendScore === null || input.trendScore === undefined ? 0 : input.trendScore;
  var allowShort = input.allowShort !== false;

  var desired = current;
  if (current === 'flat') {
    if (c >= rules.entry && trend >= 0) desired = canOpen ? 'long' : 'flat';
    else if (c <= -rules.entry && trend <= 0 && allowShort) desired = canOpen ? 'short' : 'flat';
    else desired = 'flat';
    if (desired === 'flat' && Math.abs(c) >= rules.entry && !canOpen) reasons = reasons.concat(blockers);
  } else {
    var dir = current === 'long' ? 1 : -1;
    var signed = c * dir;
    if (signed <= -rules.entry) {
      desired = allowShort || current === 'short' ? (canOpen ? (dir > 0 ? 'short' : 'long') : 'flat') : 'flat';
      reasons.push('分數轉為強烈反向');
      if (!canOpen) reasons = reasons.concat(blockers);
    } else if (signed <= rules.exit) {
      desired = 'flat';
      reasons.push('分數轉弱，平倉觀望');
    }
  }
  return { desired: desired, reasons: reasons };
}

/** 中文原因：哪些因子推了最多分 */
function tfFactorReasons_(factors, adx, adxTrend, weights) {
  weights = weights || TAIFEX_FACTOR_WEIGHTS;
  var labels = { trend: '均線趨勢', breakout: '55 日通道', tsmom: '60 日動能', foreignFlow: '外資台指期部位', pcr: '選擇權 PCR' };
  var parts = Object.keys(labels).map(function (key) {
    var f = factors[key];
    return f && f.score !== null ? { key: key, score: f.score * (weights[key] || 0) } : null;
  }).filter(Boolean).sort(function (a, b) { return Math.abs(b.score) - Math.abs(a.score); });
  var reasons = parts.slice(0, 3).filter(function (p) { return Math.abs(p.score) >= 0.02; }).map(function (p) {
    return labels[p.key] + (p.score > 0 ? '偏多' : '偏空');
  });
  if (adx !== null && adx !== undefined && adx < adxTrend) reasons.push('ADX ' + tfRound_(adx, 1) + ' 盤整，訊號打折');
  return reasons;
}

/**
 * 第 i 根收盤後的完整訊號（不含部位決策）。
 * opts: { weights, sentiment }
 */
function tfSignalAt_(series, i, opts) {
  opts = opts || {};
  var weights = opts.weights || tfParamWeights_(opts.params) || TAIFEX_FACTOR_WEIGHTS;
  var params = tfParams_(opts.params);
  var factors = tfFactorsAt_(series, i);
  var q = tfQuantScore_(factors, weights);
  var adx = series.adx14[i];
  var sentimentAdj = opts.sentiment ? tfSentimentAdj_(opts.sentiment) : 0;
  var composite = null;
  if (q.score !== null) {
    composite = tfClip_(q.score + sentimentAdj, -1, 1);
    if (adx !== null && adx < params.adxTrend) composite *= params.chopDamp;
  }
  var bar = series.bars[i];
  return {
    date: bar.date,
    contract: bar.contract || null,
    close: bar.close,
    indicators: {
      ema20: tfRound_(series.ema20[i] === null ? null : series.ema20[i] - (series.adj[i].close - bar.close), 1),
      ema60: tfRound_(series.ema60[i] === null ? null : series.ema60[i] - (series.adj[i].close - bar.close), 1),
      atr20: tfRound_(series.atr20[i], 1),
      adx14: tfRound_(adx, 1),
      donchianHigh: factors.breakout.high === undefined ? null : tfRound_(factors.breakout.high - (series.adj[i].close - bar.close), 1),
      donchianLow: factors.breakout.low === undefined ? null : tfRound_(factors.breakout.low - (series.adj[i].close - bar.close), 1),
    },
    factors: {
      trend: { raw: factors.trend.raw, score: factors.trend.score },
      breakout: { raw: factors.breakout.raw, score: factors.breakout.score },
      tsmom: { raw: factors.tsmom.raw, score: factors.tsmom.score },
      foreignFlow: { raw: factors.foreignFlow.raw, score: factors.foreignFlow.score },
      pcr: { raw: factors.pcr.raw, score: factors.pcr.score },
    },
    quantScore: tfRound_(q.score, 3),
    coverage: tfRound_(q.coverage, 3),
    sentimentAdj: tfRound_(sentimentAdj, 3),
    composite: tfRound_(composite, 3),
    trending: adx === null ? null : adx >= params.adxTrend,
    reasons: tfFactorReasons_(factors, adx, params.adxTrend, weights),
  };
}

// -------- 部位大小 --------

function tfPositionSize_(equity, atr, config, params) {
  if (!atr || atr <= 0 || equity <= 0) return { contracts: 0, stopPoints: null, limitedBy: 'data' };
  var stopPoints = tfParams_(params).stopAtr * atr;
  var byRisk = Math.floor((equity * config.riskPerTradePct / 100) / (stopPoints * config.pointValue));
  var byMargin = Math.floor((equity * TAIFEX_RULES.maxMarginUtil) / config.marginPerContract);
  var contracts = Math.max(0, Math.min(byRisk, byMargin, config.maxContracts));
  var limitedBy = contracts === config.maxContracts ? 'maxContracts' : (byMargin < byRisk ? 'margin' : 'risk');
  return { contracts: contracts, stopPoints: tfRound_(stopPoints, 1), limitedBy: limitedBy };
}

// -------- 虛擬帳戶 --------

function tfNewAccount_(config, startDate) {
  return {
    equity: config.initialCapital,
    initialCapital: config.initialCapital,
    peakEquity: config.initialCapital,
    maxDrawdownPct: 0,
    position: null,
    pending: null,
    lastBarDate: startDate || null,
    lastClose: null,
    halted: false,
    haltReason: null,
    realizedPnl: 0,
    totalCosts: 0,
    tradeCount: 0,
    winCount: 0,
  };
}

function tfCloneAccount_(state) {
  return JSON.parse(JSON.stringify(state));
}

/** 平掉 contracts 口（全部或部分），回傳交易紀錄；equity 已在呼叫前 mark 到 price */
function tfClosePortion_(state, price, contracts, date, reason, config) {
  var pos = state.position;
  var dir = pos.side === 'long' ? 1 : -1;
  var exitCost = tfTradeCost_(price, contracts, config);
  var entryCost = Math.round((pos.entryCost || 0) * contracts / pos.contracts);
  var pnlPoints = dir * (price - pos.entryPrice);
  var gross = Math.round(pnlPoints * contracts * config.pointValue);
  state.equity -= exitCost;
  state.totalCosts += exitCost;
  var net = gross - exitCost - entryCost - Math.round((pos.rollCost || 0) * contracts / pos.contracts);
  state.realizedPnl += net;
  state.tradeCount += 1;
  if (net > 0) state.winCount += 1;
  var trade = {
    side: pos.side,
    contracts: contracts,
    product: config.product,
    openDate: pos.entryDate,
    closeDate: date,
    entryPrice: tfRound_(pos.entryPrice, 1),
    exitPrice: tfRound_(price, 1),
    pnlPoints: tfRound_(pnlPoints, 1),
    grossPnl: gross,
    costs: exitCost + entryCost + Math.round((pos.rollCost || 0) * contracts / pos.contracts),
    netPnl: net,
    holdingBars: pos.bars || 0,
    exitReason: reason,
    source: pos.source || 'auto',
    entryComposite: pos.entryComposite === undefined ? null : pos.entryComposite,
  };
  if (contracts >= pos.contracts) {
    state.position = null;
  } else {
    pos.entryCost = (pos.entryCost || 0) - entryCost;
    pos.rollCost = (pos.rollCost || 0) - Math.round((pos.rollCost || 0) * contracts / pos.contracts);
    pos.contracts -= contracts;
  }
  return trade;
}

function tfOpenPosition_(state, side, contracts, price, date, stopPoints, order, config) {
  var cost = tfTradeCost_(price, contracts, config);
  state.equity -= cost;
  state.totalCosts += cost;
  var dir = side === 'long' ? 1 : -1;
  state.position = {
    side: side,
    contracts: contracts,
    entryPrice: price,
    entryDate: date,
    stop: tfRound_(price - dir * stopPoints, 1),
    extreme: price,
    entryCost: cost,
    rollCost: 0,
    bars: 0,
    source: order.source || 'auto',
    entryComposite: order.composite === undefined ? null : order.composite,
  };
}

/** 依待成交單調整部位（在開盤價成交），回傳已平倉交易 */
function tfFillPending_(state, bar, config) {
  var order = state.pending;
  state.pending = null;
  if (!order) return [];
  var trades = [];
  var price = bar.open;
  var pos = state.position;
  var target = order.target;
  var want = target === 'flat' ? 0 : Math.max(0, Math.floor(order.contracts || 0));
  if (target !== 'flat' && !want) return trades;
  var reason = order.source === 'manual' ? 'manual' : (order.halt ? 'halt' : 'signal');

  if (pos) {
    var dir = pos.side === 'long' ? 1 : -1;
    // 開盤跳空先 mark 到開盤價
    state.equity += dir * pos.contracts * config.pointValue * (price - state.lastClose);
    state.lastClose = price;
    if (target === 'flat' || target !== pos.side) {
      trades.push(tfClosePortion_(state, price, pos.contracts, bar.date, target === 'flat' ? reason : 'reverse', config));
    } else if (want < pos.contracts) {
      trades.push(tfClosePortion_(state, price, pos.contracts - want, bar.date, reason, config));
      return trades;
    } else if (want > pos.contracts) {
      var add = want - pos.contracts;
      var addCost = tfTradeCost_(price, add, config);
      state.equity -= addCost;
      state.totalCosts += addCost;
      pos.entryPrice = (pos.entryPrice * pos.contracts + price * add) / want;
      pos.entryCost = (pos.entryCost || 0) + addCost;
      pos.contracts = want;
      return trades;
    } else {
      return trades;
    }
  }
  if (target !== 'flat' && !state.position) {
    var stopPoints = order.stopPoints && order.stopPoints > 0 ? order.stopPoints : price * 0.03;
    tfOpenPosition_(state, target, want, price, bar.date, stopPoints, order, config);
    state.lastClose = price;
  }
  return trades;
}

/**
 * 處理一根 K 棒：換月平移 → 開盤成交待成交單 → 停損 → 收盤結算 → 移動停損 → 熔斷。
 * ctx: { gap, atr, config }。不修改傳入的 state，回傳 { state, trades, events }。
 */
function stepTaifexAccount_(prevState, bar, ctx) {
  var state = tfCloneAccount_(prevState);
  var config = ctx.config;
  var trailAtr = tfParams_(ctx.params).trailAtr;
  var trades = [];
  var events = [];
  // 盤中已處理過換月（stepTaifexIntraday_）→ 收盤不再平移一次
  var gapToApply = ctx.skipGap ? 0 : ctx.gap;

  if (state.position && gapToApply) {
    var gap = gapToApply;
    var p = state.position;
    p.entryPrice += gap;
    p.stop = tfRound_(p.stop + gap, 1);
    p.extreme += gap;
    state.lastClose += gap;
    var rollCost = 2 * tfTradeCost_(state.lastClose, p.contracts, config);
    state.equity -= rollCost;
    state.totalCosts += rollCost;
    p.rollCost = (p.rollCost || 0) + rollCost;
    events.push({ type: 'roll', date: bar.date, gap: tfRound_(gap, 1), cost: rollCost });
  } else if (!state.position && gapToApply && state.lastClose !== null) {
    state.lastClose += gapToApply;
  }

  // validFrom：單子只能在下單之後的交易時段成交（盤中 / 收盤後下的單不能回溯用當天開盤價）
  if (state.pending && (!state.pending.validFrom || state.pending.validFrom <= bar.date)) {
    // 盤中下的手動單（liveOnly）若盤中沒來得及成交，以當天收盤價成交，不能回溯用開盤價
    var atClose = !!state.pending.liveOnly && state.pending.validFrom === bar.date;
    var fillPrice = atClose ? bar.close : bar.open;
    var filled = tfFillPending_(state, { date: bar.date, open: fillPrice }, config);
    trades = trades.concat(filled);
    events.push({ type: 'fill', date: bar.date, price: fillPrice, atClose: atClose });
    if (atClose && state.position && state.position.entryDate === bar.date) state.position.entryMode = 'close';
  }

  var pos = state.position;
  // 收盤才成交的部位，當天高低點發生在成交之前，不做停損檢查
  if (pos && !(pos.entryDate === bar.date && pos.entryMode === 'close')) {
    var dir = pos.side === 'long' ? 1 : -1;
    // 當天盤中以即時價進場：當天稍早的高低點與部位無關，只用收盤價檢查
    var liveEntry = pos.entryDate === bar.date && pos.entryMode === 'live';
    var hit = liveEntry
      ? (dir > 0 ? bar.close <= pos.stop : bar.close >= pos.stop)
      : (dir > 0 ? bar.low <= pos.stop : bar.high >= pos.stop);
    if (hit) {
      var gapThrough = !liveEntry && (dir > 0 ? bar.open < pos.stop : bar.open > pos.stop);
      var exitPx = liveEntry ? bar.close : (gapThrough ? bar.open : pos.stop);
      state.equity += dir * pos.contracts * config.pointValue * (exitPx - state.lastClose);
      state.lastClose = exitPx;
      trades.push(tfClosePortion_(state, exitPx, pos.contracts, bar.date, 'stop', config));
      events.push({ type: 'stop', date: bar.date, price: exitPx });
    }
  }

  pos = state.position;
  if (pos) {
    var d = pos.side === 'long' ? 1 : -1;
    state.equity += d * pos.contracts * config.pointValue * (bar.close - state.lastClose);
    pos.bars = (pos.bars || 0) + 1;
    if (ctx.atr) {
      if (d > 0) {
        pos.extreme = Math.max(pos.extreme, bar.close);
        pos.stop = tfRound_(Math.max(pos.stop, pos.extreme - trailAtr * ctx.atr), 1);
      } else {
        pos.extreme = Math.min(pos.extreme, bar.close);
        pos.stop = tfRound_(Math.min(pos.stop, pos.extreme + trailAtr * ctx.atr), 1);
      }
    }
  }
  state.lastClose = bar.close;
  state.equity = Math.round(state.equity);
  state.lastBarDate = bar.date;

  state.peakEquity = Math.max(state.peakEquity, state.equity);
  var dd = state.peakEquity > 0 ? (state.peakEquity - state.equity) / state.peakEquity * 100 : 0;
  state.maxDrawdownPct = tfRound_(Math.max(state.maxDrawdownPct || 0, dd), 2);
  if (!state.halted && dd >= config.maxDrawdownPct) {
    state.halted = true;
    state.haltReason = '回撤 ' + tfRound_(dd, 1) + '% 達熔斷門檻 ' + config.maxDrawdownPct + '%';
    events.push({ type: 'halt', date: bar.date, drawdownPct: tfRound_(dd, 2) });
  }
  return { state: state, trades: trades, events: events };
}

/**
 * 收盤後依訊號產生下一根的待成交單（自動模式用；手動單優先，不覆蓋）。
 * 回傳 { pending, decision, sizing }。
 */
function tfPlanNextOrder_(state, signal, ctx) {
  var config = ctx.config;
  var currentSide = state.position ? state.position.side : 'flat';
  var decision = tfDecideTarget_({
    currentSide: currentSide,
    composite: signal.composite,
    trendScore: signal.factors.trend.score,
    coverage: signal.coverage,
    eventRisk: !!ctx.eventRisk,
    allowShort: config.allowShort,
    halted: state.halted,
    params: ctx.params,
  });
  var sizing = tfPositionSize_(state.equity, signal.indicators.atr20, config, ctx.params);
  var pending = null;
  if (decision.desired !== currentSide) {
    if (decision.desired === 'flat') {
      pending = { target: 'flat', contracts: 0, source: 'auto', halt: !!state.halted, signalDate: signal.date, composite: signal.composite };
    } else if (sizing.contracts > 0) {
      pending = {
        target: decision.desired,
        contracts: sizing.contracts,
        stopPoints: sizing.stopPoints,
        source: 'auto',
        signalDate: signal.date,
        composite: signal.composite,
      };
    } else {
      decision.reasons.push('資金不足以符合風險預算（0 口），請改用較小契約或提高資金');
      if (currentSide !== 'flat') pending = { target: 'flat', contracts: 0, source: 'auto', signalDate: signal.date, composite: signal.composite };
    }
  }
  return { pending: pending, decision: decision, sizing: sizing };
}

// -------- 回測 --------

function tfDownsample_(points, max) {
  if (points.length <= max) return points;
  var step = (points.length - 1) / (max - 1);
  var out = [];
  for (var i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function tfBacktestMetrics_(curve, trades, initial) {
  if (!curve.length) return null;
  var last = curve[curve.length - 1].equity;
  var rets = [];
  var peak = initial;
  var maxDd = 0;
  var exposed = 0;
  for (var i = 0; i < curve.length; i++) {
    var prev = i === 0 ? initial : curve[i - 1].equity;
    if (prev > 0) rets.push(curve[i].equity / prev - 1);
    peak = Math.max(peak, curve[i].equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - curve[i].equity) / peak : 0);
    if (curve[i].pos) exposed++;
  }
  var mean = rets.reduce(function (s, v) { return s + v; }, 0) / (rets.length || 1);
  var sd = Math.sqrt(rets.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / (rets.length || 1));
  var years = curve.length / 252;
  var wins = trades.filter(function (t) { return t.netPnl > 0; });
  var grossWin = wins.reduce(function (s, t) { return s + t.netPnl; }, 0);
  var grossLoss = trades.filter(function (t) { return t.netPnl <= 0; }).reduce(function (s, t) { return s + t.netPnl; }, 0);
  return {
    totalReturnPct: tfRound_((last / initial - 1) * 100, 2),
    cagrPct: years > 0 && last > 0 ? tfRound_((Math.pow(last / initial, 1 / years) - 1) * 100, 2) : null,
    sharpe: sd > 0 ? tfRound_(mean / sd * Math.sqrt(252), 2) : null,
    maxDrawdownPct: tfRound_(maxDd * 100, 2),
    trades: trades.length,
    winRatePct: trades.length ? tfRound_(wins.length / trades.length * 100, 1) : null,
    profitFactor: grossLoss < 0 ? tfRound_(grossWin / -grossLoss, 2) : null,
    avgHoldingBars: trades.length ? tfRound_(trades.reduce(function (s, t) { return s + (t.holdingBars || 0); }, 0) / trades.length, 1) : null,
    exposurePct: tfRound_(exposed / curve.length * 100, 1),
    finalEquity: Math.round(last),
  };
}

/**
 * 歷史回測：從 warmup 之後開始，每根先 step 再依收盤訊號下單，與每日虛擬帳戶完全相同的流程。
 * opts: { weights, series（可重用） }
 */
function runTaifexBacktest_(bars, rawConfig, opts) {
  opts = opts || {};
  var config = tfNormalizeConfig_(rawConfig);
  var series = opts.series || tfPrepareSeries_(bars);
  // 沒指定 weights 時交給 tfSignalAt_ 決定（params.weights → 預設）
  var weights = opts.weights || null;
  var params = opts.params || null;
  var start = Math.max(TAIFEX_RULES.warmup, opts.startIndex || 0);
  var end = Math.min(bars.length, opts.endIndex || bars.length);
  if (end <= start + 5) return null;
  var state = tfNewAccount_(config, bars[start - 1].date);
  state.lastClose = bars[start - 1].close;
  var curve = [];
  var trades = [];
  for (var i = start; i < end; i++) {
    var res = stepTaifexAccount_(state, bars[i], { gap: series.gaps[i], atr: series.atr20[i], config: config, params: params });
    state = res.state;
    trades = trades.concat(res.trades);
    var signal = tfSignalAt_(series, i, { weights: weights, params: params });
    var plan = tfPlanNextOrder_(state, signal, { config: config, params: params });
    state.pending = plan.pending;
    curve.push({ date: bars[i].date, equity: state.equity, pos: state.position ? (state.position.side === 'long' ? 1 : -1) : 0 });
  }
  return {
    metrics: tfBacktestMetrics_(curve, trades, config.initialCapital),
    curve: curve,
    trades: trades,
    from: bars[start].date,
    to: bars[end - 1].date,
  };
}

/** 大盤對照：近月連續序列不含槓桿（100% 名目曝險），用來比較風險調整後報酬 */
function runTaifexBuyHold_(bars, initial, series) {
  series = series || tfPrepareSeries_(bars);
  var start = TAIFEX_RULES.warmup;
  if (bars.length <= start + 5) return null;
  var equity = initial;
  var curve = [];
  for (var i = start; i < bars.length; i++) {
    var ret = (series.adj[i].close - series.adj[i - 1].close) / bars[i - 1].close;
    equity *= 1 + ret;
    curve.push({ date: bars[i].date, equity: Math.round(equity), pos: 1 });
  }
  return { metrics: tfBacktestMetrics_(curve, [], initial), curve: curve, trades: [], from: bars[start].date, to: bars[bars.length - 1].date };
}
