/**
 * TaifexTuning — 台指期「每週檢討 → 調校」的純函式（不碰 Firestore / UrlFetch / PROP）。
 * IO 在 TaifexReview.gs；測試 apps-script/tests/taifex-tuning.test.cjs。
 *
 * 可以調的東西分四區，每一區都有寫死的上下限（TAIFEX_TUNING_BOUNDS）：
 *   params  日線進出場門檻與停損（TAIFEX_TUNABLE_KEYS 六個）
 *   weights 日線因子權重（五個，總和 1）
 *   risk    資金管理（taifex_configs/default 的每筆風險 %、最大口數、熔斷回撤 %、是否放空）
 *   tech    盤中技術模擬（entry / exit / stopAtr / trailAtr + 四個指標權重）
 *
 * 提案（MCP 寫入）只是一份建議；要 owner 在 App 按「套用」才會寫進 taifex_tuning/current 與設定。
 * 超出範圍、未知的 key 一律回錯誤（不默默修正），提案的模型才知道它實際改了什麼。
 */

var TAIFEX_TUNING_BOUNDS = {
  params: { entry: [0.15, 0.6], exit: [0, 0.3], adxTrend: [10, 30], chopDamp: [0.3, 1], stopAtr: [1, 4], trailAtr: [1.5, 6] },
  weights: [0, 0.5],
  risk: { riskPerTradePct: [0.25, 3], maxContracts: [1, 20], maxDrawdownPct: [5, 40] },
  tech: { entry: [0.2, 0.7], exit: [0, 0.3], stopAtr: [1, 4], trailAtr: [1.5, 6] },
  techWeights: [0, 0.6],
};
var TAIFEX_TUNING_SECTIONS = ['params', 'weights', 'risk', 'tech'];
var TAIFEX_TUNING_RISK_KEYS = ['riskPerTradePct', 'maxContracts', 'maxDrawdownPct', 'allowShort'];
var TAIFEX_TUNING_HISTORY_MAX = 26;

function tfTuneCopy_(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function (k) { out[k] = obj[k]; });
  return out;
}

function tfTuneInRange_(value, range) {
  return typeof value === 'number' && isFinite(value) && value >= range[0] && value <= range[1];
}

function tfTuningDefaults_() {
  var tech = {};
  TAIFEX_TECH_TUNABLE_KEYS.forEach(function (k) { tech[k] = TAIFEX_TECH_RULES[k]; });
  tech.weights = tfTuneCopy_(TAIFEX_TECH_RULES.weights);
  return { params: tfParams_({}), weights: tfTuneCopy_(TAIFEX_FACTOR_WEIGHTS), tech: tech };
}

/** 一組權重是否合法：key 完整、每個在範圍內、總和 1（±0.005） */
function tfTuneWeightsValid_(weights, keys, range) {
  if (!weights || typeof weights !== 'object') return false;
  var sum = 0;
  var ok = keys.every(function (k) {
    if (!tfTuneInRange_(weights[k], range)) return false;
    sum += weights[k];
    return true;
  });
  return ok && Math.abs(sum - 1) <= 0.005;
}

function tfTuneParamsValid_(params, keys, bounds) {
  if (!params || typeof params !== 'object') return false;
  return keys.every(function (k) { return tfTuneInRange_(params[k], bounds[k]); }) && params.exit < params.entry;
}

/**
 * taifex_tuning/current → 驗過的調校值。任何一區不合法就當作沒設定（回到程式內建的預設），
 * 所以就算文件被手動改壞，策略也不會用到範圍外的數字。
 */
function tfNormalizeTuningDoc_(doc) {
  doc = doc || {};
  var out = { version: Math.max(0, Math.floor(Number(doc.version) || 0)), params: null, weights: null, tech: null, reviewId: doc.reviewId || null };
  if (tfTuneParamsValid_(doc.params, TAIFEX_TUNABLE_KEYS, TAIFEX_TUNING_BOUNDS.params)) {
    out.params = {};
    TAIFEX_TUNABLE_KEYS.forEach(function (k) { out.params[k] = doc.params[k]; });
  }
  var weightKeys = Object.keys(TAIFEX_FACTOR_WEIGHTS);
  if (tfTuneWeightsValid_(doc.weights, weightKeys, TAIFEX_TUNING_BOUNDS.weights)) {
    out.weights = {};
    weightKeys.forEach(function (k) { out.weights[k] = doc.weights[k]; });
  }
  var techKeys = Object.keys(TAIFEX_TECH_RULES.weights);
  if (doc.tech && tfTuneParamsValid_(doc.tech, TAIFEX_TECH_TUNABLE_KEYS, TAIFEX_TUNING_BOUNDS.tech)
    && tfTuneWeightsValid_(doc.tech.weights, techKeys, TAIFEX_TUNING_BOUNDS.techWeights)) {
    out.tech = { weights: {} };
    TAIFEX_TECH_TUNABLE_KEYS.forEach(function (k) { out.tech[k] = doc.tech[k]; });
    techKeys.forEach(function (k) { out.tech.weights[k] = doc.tech.weights[k]; });
  }
  return out;
}

/** 「Claude 調校」變體的參數物件（給 tfVariantParams_）：門檻 + 選填的因子權重 */
function tfTunedParams_(tuning) {
  var out = tfTuneCopy_(tuning && tuning.params);
  if (tuning && tuning.weights) out.weights = tfTuneCopy_(tuning.weights);
  return out;
}

/** 設定文件裡與資金管理有關的四個欄位（已正規化的 config → 精簡物件） */
function tfTuneRiskOf_(config) {
  return {
    riskPerTradePct: config.riskPerTradePct,
    maxContracts: config.maxContracts,
    maxDrawdownPct: config.maxDrawdownPct,
    allowShort: config.allowShort !== false,
  };
}

function tfTuneRound_(value) {
  return Math.round(value * 1000) / 1000;
}

/** 把一區的變更疊到目前的值上；回 { value, diff, errors } */
function tfTuneMergeNumbers_(section, changes, current, bounds, errors, diff) {
  var next = tfTuneCopy_(current);
  Object.keys(changes).forEach(function (key) {
    if (key === 'weights' && section === 'tech') return;
    if (!bounds[key]) { errors.push(section + '.' + key + ' 不是可調整的項目'); return; }
    var v = changes[key];
    if (typeof v !== 'number' || !isFinite(v)) { errors.push(section + '.' + key + ' 必須是數字'); return; }
    v = key === 'maxContracts' ? Math.floor(v) : tfTuneRound_(v);
    if (!tfTuneInRange_(v, bounds[key])) {
      errors.push(section + '.' + key + ' = ' + v + ' 超出範圍 ' + bounds[key][0] + '–' + bounds[key][1]);
      return;
    }
    if (v !== current[key]) diff.push({ section: section, key: key, from: current[key], to: v });
    next[key] = v;
  });
  return next;
}

function tfTuneMergeWeights_(section, changes, current, range, errors, diff) {
  var next = tfTuneCopy_(current);
  var bad = false;
  Object.keys(changes).forEach(function (key) {
    if (current[key] === undefined) { errors.push(section + '.' + key + ' 不是可調整的權重'); bad = true; return; }
    var v = changes[key];
    if (typeof v !== 'number' || !isFinite(v)) { errors.push(section + '.' + key + ' 必須是數字'); bad = true; return; }
    v = tfTuneRound_(v);
    if (!tfTuneInRange_(v, range)) { errors.push(section + '.' + key + ' = ' + v + ' 超出範圍 ' + range[0] + '–' + range[1]); bad = true; return; }
    next[key] = v;
  });
  if (bad) return current;
  var sum = Object.keys(next).reduce(function (s, k) { return s + next[k]; }, 0);
  if (Math.abs(sum - 1) > 0.005) {
    errors.push(section + ' 權重總和要等於 1（現在是 ' + tfTuneRound_(sum) + '）；調高一個就要調低另一個，'
      + '完整的 key：' + Object.keys(current).join(' / '));
    return current;
  }
  Object.keys(next).forEach(function (key) {
    if (next[key] !== current[key]) diff.push({ section: section, key: key, from: current[key], to: next[key] });
  });
  return next;
}

/**
 * 把模型給的「部分變更」疊到目前的值上並驗證。
 * changes: { params?, weights?, risk?, tech? }（只放要改的 key）
 * base:    { params, weights, risk, tech }（目前生效的完整值）
 * 回傳 { proposed（完整值）, diff: [{ section, key, from, to }], errors: [string] }
 */
function tfProposeTuning_(changes, base) {
  changes = changes && typeof changes === 'object' ? changes : {};
  var errors = [];
  var diff = [];
  Object.keys(changes).forEach(function (section) {
    if (TAIFEX_TUNING_SECTIONS.indexOf(section) < 0) errors.push('不認得的區塊 ' + section + '（可用：' + TAIFEX_TUNING_SECTIONS.join(' / ') + '）');
    else if (!changes[section] || typeof changes[section] !== 'object' || Array.isArray(changes[section])) errors.push(section + ' 必須是物件');
  });
  if (errors.length) return { proposed: null, diff: [], errors: errors };

  var B = TAIFEX_TUNING_BOUNDS;
  var proposed = {
    params: tfTuneCopy_(base.params),
    weights: tfTuneCopy_(base.weights),
    risk: tfTuneCopy_(base.risk),
    tech: tfTuneCopy_(base.tech),
  };
  proposed.tech.weights = tfTuneCopy_(base.tech.weights);

  if (changes.params) {
    proposed.params = tfTuneMergeNumbers_('params', changes.params, base.params, B.params, errors, diff);
    if (proposed.params.exit >= proposed.params.entry) errors.push('params.exit 必須小於 params.entry（否則一進場就出場）');
  }
  if (changes.weights) proposed.weights = tfTuneMergeWeights_('weights', changes.weights, base.weights, B.weights, errors, diff);
  if (changes.risk) {
    var riskNumbers = {};
    Object.keys(changes.risk).forEach(function (key) {
      if (key === 'allowShort') {
        if (typeof changes.risk.allowShort !== 'boolean') { errors.push('risk.allowShort 必須是 true / false'); return; }
        if (changes.risk.allowShort !== base.risk.allowShort) diff.push({ section: 'risk', key: 'allowShort', from: base.risk.allowShort, to: changes.risk.allowShort });
        proposed.risk.allowShort = changes.risk.allowShort;
      } else riskNumbers[key] = changes.risk[key];
    });
    var mergedRisk = tfTuneMergeNumbers_('risk', riskNumbers, base.risk, B.risk, errors, diff);
    Object.keys(B.risk).forEach(function (key) { proposed.risk[key] = mergedRisk[key]; });
  }
  if (changes.tech) {
    var techWeights = proposed.tech.weights;
    var mergedTech = tfTuneMergeNumbers_('tech', changes.tech, base.tech, B.tech, errors, diff);
    if (mergedTech.exit >= mergedTech.entry) errors.push('tech.exit 必須小於 tech.entry');
    if (changes.tech.weights !== undefined) {
      if (!changes.tech.weights || typeof changes.tech.weights !== 'object') errors.push('tech.weights 必須是物件');
      else techWeights = tfTuneMergeWeights_('tech.weights', changes.tech.weights, base.tech.weights, B.techWeights, errors, diff);
    }
    proposed.tech = mergedTech;
    proposed.tech.weights = techWeights;
  }
  return { proposed: errors.length ? null : proposed, diff: errors.length ? [] : diff, errors: errors };
}

/** diff 動到哪幾區（tech.weights 算 tech） */
function tfTuneSections_(diff) {
  var seen = {};
  (diff || []).forEach(function (d) { seen[String(d.section).split('.')[0]] = true; });
  return TAIFEX_TUNING_SECTIONS.filter(function (s) { return seen[s]; });
}

// -------- 週區間與統計 --------

/** 含這一天的那一週（週一到週日）。日期字串 yyyy-MM-dd */
function tfWeekRange_(dateStr) {
  var d = tfStrToDate_(dateStr);
  var dow = (d.getUTCDay() + 6) % 7; // 週一 = 0
  var start = new Date(d.getTime() - dow * 86400000);
  return { start: tfDateToStr_(start), end: tfDateToStr_(new Date(start.getTime() + 6 * 86400000)) };
}

/** 權益曲線（[{ d, e, p, c }]）在一週內的變化；起點是這週之前最後一筆（沒有就用 initial） */
function tfCurveWindow_(curve, start, end, initial) {
  var before = null;
  var inside = [];
  (curve || []).forEach(function (pt) {
    if (!pt || !pt.d) return;
    if (pt.d < start) before = pt;
    else if (pt.d <= end) inside.push(pt);
  });
  if (!inside.length) return { days: 0, startEquity: before ? before.e : initial, endEquity: before ? before.e : initial, pnl: 0, pct: 0, maxDrawdownPct: 0, indexChangePct: null };
  var startEquity = before ? before.e : initial;
  var last = inside[inside.length - 1];
  var peak = startEquity;
  var maxDd = 0;
  inside.forEach(function (pt) {
    peak = Math.max(peak, pt.e);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - pt.e) / peak);
  });
  var firstClose = before && before.c ? before.c : inside[0].c;
  return {
    days: inside.length,
    startEquity: Math.round(startEquity),
    endEquity: Math.round(last.e),
    pnl: Math.round(last.e - startEquity),
    pct: startEquity > 0 ? tfRound_((last.e / startEquity - 1) * 100, 2) : 0,
    maxDrawdownPct: tfRound_(maxDd * 100, 2),
    indexChangePct: firstClose && last.c ? tfRound_((last.c / firstClose - 1) * 100, 2) : null,
    daily: inside.map(function (pt) { return { date: pt.d, equity: Math.round(pt.e), position: pt.p || 0, close: pt.c }; }),
  };
}

/** 一批已平倉交易的統計（netPnl 為準） */
function tfTradeStats_(trades) {
  var out = { n: 0, wins: 0, net: 0, grossWin: 0, grossLoss: 0, best: null, worst: null, byReason: {} };
  (trades || []).forEach(function (t) {
    var net = Number(t.netPnl) || 0;
    out.n += 1;
    out.net += net;
    if (net > 0) { out.wins += 1; out.grossWin += net; } else out.grossLoss += -net;
    out.best = out.best === null ? net : Math.max(out.best, net);
    out.worst = out.worst === null ? net : Math.min(out.worst, net);
    var reason = t.exitReason || t.reason || 'other';
    out.byReason[reason] = (out.byReason[reason] || 0) + 1;
  });
  out.winRatePct = out.n ? tfRound_(out.wins / out.n * 100, 1) : null;
  out.profitFactor = out.grossLoss > 0 ? tfRound_(out.grossWin / out.grossLoss, 2) : null;
  return out;
}

/** 盤中技術模擬一週的交易 → 每個監控頻率、每個時段、每個進場時間分段的統計（exitTime 落在區間內） */
function tfTechWeekStats_(trades, start, end) {
  var bots = {};
  var hi = end + ' 99';
  (trades || []).forEach(function (t) {
    var when = String(t.exitTime || '');
    if (when < start || when > hi) return;
    var bot = bots[t.bot] || (bots[t.bot] = { all: [], day: [], night: [], buckets: {} });
    bot.all.push(t);
    if (bot[t.session]) bot[t.session].push(t);
    var bucket = tfTechBucketId_(t.session, t.entryM);
    if (bucket) (bot.buckets[bucket] || (bot.buckets[bucket] = [])).push(t);
  });
  var out = {};
  Object.keys(bots).forEach(function (id) {
    var buckets = {};
    Object.keys(bots[id].buckets).forEach(function (b) {
      var s = tfTradeStats_(bots[id].buckets[b]);
      buckets[b] = { n: s.n, net: s.net, winRatePct: s.winRatePct };
    });
    out[id] = { all: tfTradeStats_(bots[id].all), day: tfTradeStats_(bots[id].day), night: tfTradeStats_(bots[id].night), entryBuckets: buckets };
  });
  return out;
}

/** 回測指標精簡成比較用的幾個數字 */
function tfTuneMetrics_(metrics) {
  if (!metrics) return null;
  return {
    totalReturnPct: metrics.totalReturnPct,
    cagrPct: metrics.cagrPct,
    sharpe: metrics.sharpe,
    maxDrawdownPct: metrics.maxDrawdownPct,
    trades: metrics.trades,
    winRatePct: metrics.winRatePct,
    profitFactor: metrics.profitFactor,
    exposurePct: metrics.exposurePct,
  };
}

/**
 * 目前 vs 提案的回測對照：完整期間 + 樣本外（後 40%，與每週最佳化同一個切點）。
 * current / proposed: { params（可含 weights）, config（原始設定，會再正規化） }
 */
function tfCompareTuning_(bars, current, proposed, opts) {
  opts = opts || {};
  var start = TAIFEX_RULES.warmup;
  if (bars.length < start + 120) return null;
  var series = opts.series || tfPrepareSeries_(bars);
  var split = start + Math.floor((bars.length - start) * 0.6);
  function run(side) {
    var full = runTaifexBacktest_(bars, side.config, { series: series, params: side.params });
    var oos = runTaifexBacktest_(bars, side.config, { series: series, params: side.params, startIndex: split });
    return { full: tfTuneMetrics_(full && full.metrics), outOfSample: tfTuneMetrics_(oos && oos.metrics) };
  }
  var cur = run(current);
  var next = run(proposed);
  var warnings = [];
  if (cur.outOfSample && next.outOfSample) {
    if (next.outOfSample.totalReturnPct < cur.outOfSample.totalReturnPct) warnings.push('樣本外報酬比目前的參數差');
    if (next.outOfSample.maxDrawdownPct > cur.outOfSample.maxDrawdownPct * 1.25 + 1) warnings.push('樣本外最大回撤明顯變大');
  }
  if (next.full && next.full.trades < 8) warnings.push('完整期間交易次數太少（' + next.full.trades + ' 筆），統計意義不足');
  return {
    from: bars[start].date,
    to: bars[bars.length - 1].date,
    outOfSampleFrom: bars[split].date,
    current: cur,
    proposed: next,
    warnings: warnings,
  };
}

function tfTuneFormatValue_(value) {
  if (value === true) return '允許';
  if (value === false) return '不允許';
  return String(value);
}

var TAIFEX_TUNING_LABELS = {
  'params.entry': '進場門檻', 'params.exit': '出場門檻', 'params.adxTrend': 'ADX 趨勢門檻', 'params.chopDamp': '盤整打折',
  'params.stopAtr': '初始停損（ATR 倍數）', 'params.trailAtr': '移動停損（ATR 倍數）',
  'weights.trend': '權重：均線趨勢', 'weights.breakout': '權重：55 日通道', 'weights.tsmom': '權重：60 日動能',
  'weights.foreignFlow': '權重：外資部位', 'weights.pcr': '權重：選擇權 PCR',
  'risk.riskPerTradePct': '每筆風險 %', 'risk.maxContracts': '最大口數', 'risk.maxDrawdownPct': '熔斷回撤 %', 'risk.allowShort': '放空',
  'tech.entry': '盤中：進場門檻', 'tech.exit': '盤中：出場門檻', 'tech.stopAtr': '盤中：初始停損', 'tech.trailAtr': '盤中：移動停損',
  'tech.weights.trend': '盤中權重：均線', 'tech.weights.macd': '盤中權重：MACD', 'tech.weights.rsi': '盤中權重：RSI', 'tech.weights.breakout': '盤中權重：通道',
};

function tfTuneDiffLines_(diff) {
  return (diff || []).map(function (d) {
    var id = d.section + '.' + d.key;
    return (TAIFEX_TUNING_LABELS[id] || id) + '：' + tfTuneFormatValue_(d.from) + ' → ' + tfTuneFormatValue_(d.to);
  });
}
