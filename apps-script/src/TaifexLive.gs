/**
 * TaifexLive — 台指期盤中模擬、下單建議、參數最佳化的純函式（不碰 Firestore / UrlFetch / PROP）。
 * 規劃見 docs/TAIFEX_PAPER_TRADING_PLAN.md §11；測試 apps-script/tests/taifex-live.test.cjs。
 *
 * - tfOrderValidFrom_：單子最早可成交的交易日（盤中 / 收盤後下的單不能回溯用當天開盤價）
 * - stepTaifexIntraday_：盤中每 5 分鐘處理一次（換月 → 開盤 / 即時成交 → 停損 → 即時損益 → 提醒）
 * - tfBuildOrderTicket_：把待成交單翻成「券商要怎麼下」（委託類別、價格、時效、停損單）
 * - tfOptimizeTaifex_：walk-forward 參數網格，以樣本內報酬最大（回撤受限）選參數，再看樣本外表現
 * - tfParseFugleQuote_ / tfParseYahooSpot_：即時報價解析（欄位寬鬆對應）
 */

var TAIFEX_SESSION_OPEN = '08:45';
var TAIFEX_SESSION_CLOSE = '13:45';
/** 距停損 ≤ 0.5 ATR → 盤中提醒 */
var TAIFEX_NEAR_STOP_ATR = 0.5;

/** 策略變體（策略競賽）；optimized 的參數由每週最佳化寫入 */
var TAIFEX_VARIANTS = {
  baseline: { label: '基準 tx-v1', params: {} },
  conservative: { label: '保守', params: { entry: 0.45, stopAtr: 2.5, trailAtr: 3.5 } },
  aggressive: { label: '積極', params: { entry: 0.25, exit: 0, stopAtr: 1.5, trailAtr: 2.5 } },
  optimized: { label: '最佳化', params: null },
  // 參數來自 taifex_tuning/current（每週檢討的提案經 owner 核准後才寫入，見 TaifexReview.gs）；還沒核准過任何提案時等同基準
  tuned: { label: 'Claude 調校', params: null },
};

/** 參數網格：3 × 4 × 3 = 36 組，每組跑樣本內 + 樣本外兩次回測 */
var TAIFEX_OPT_GRID = {
  entry: [0.25, 0.35, 0.45],
  stopAtr: [1.5, 2, 2.5, 3],
  trailAtr: [2, 3, 4],
};

// -------- 時間 --------

function tfIsWeekday_(dateStr) {
  var d = tfStrToDate_(dateStr);
  return !!d && d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
}

/** 日盤時段內（平日 08:45–13:45；國定假日由 tfSessionAt_ + 休市表另外把關，見 TaifexTech.gs） */
function tfInDaySession_(dateStr, hhmm) {
  return tfIsWeekday_(dateStr) && hhmm >= TAIFEX_SESSION_OPEN && hhmm <= TAIFEX_SESSION_CLOSE;
}

/**
 * 單子最早可成交的交易日：平日 08:45 前下的單 → 當天開盤；之後（含盤中、收盤後、假日）→ 下一個平日。
 * 盤中下的手動單另由 liveOnly 標記，盤中以即時價成交。
 */
function tfOrderValidFrom_(dateStr, hhmm) {
  if (tfIsWeekday_(dateStr) && hhmm < TAIFEX_SESSION_OPEN) return dateStr;
  return tfNextWeekday_(dateStr);
}

// -------- 盤中步進 --------

/**
 * 盤中處理一次報價。quote: { date, time, last, open, high, low, estimated }。
 * ctx: { config, params, gap（今天換月的價差，沒換月為 0）, atr（昨收的 ATR20） }。
 * 不修改傳入的 state，回傳 { state, trades, events }。收盤後 stepTaifexAccount_ 以 ctx.skipGap 避免重複換月。
 */
function stepTaifexIntraday_(prevState, quote, ctx) {
  var state = tfCloneAccount_(prevState);
  var config = ctx.config;
  var trades = [];
  var events = [];
  if (!quote || tfNum_(quote.last) === null) return { state: state, trades: trades, events: events };

  if (!state.intraday || state.intraday.date !== quote.date) {
    state.intraday = { date: quote.date, gapApplied: false, openFilled: false, nearStopAlerted: false };
    if (ctx.gap) {
      if (state.position) {
        var p = state.position;
        p.entryPrice += ctx.gap;
        p.stop = tfRound_(p.stop + ctx.gap, 1);
        p.extreme += ctx.gap;
        state.lastClose += ctx.gap;
        var rollCost = 2 * tfTradeCost_(state.lastClose, p.contracts, config);
        state.equity -= rollCost;
        state.totalCosts += rollCost;
        p.rollCost = (p.rollCost || 0) + rollCost;
        events.push({ type: 'roll', date: quote.date, gap: tfRound_(ctx.gap, 1), cost: rollCost });
      } else if (state.lastClose !== null) {
        state.lastClose += ctx.gap;
      }
      state.intraday.gapApplied = true;
    }
  }

  var pending = state.pending;
  if (pending && (!pending.validFrom || pending.validFrom <= quote.date)) {
    // 開盤前就有效的單（自動單、盤前手動單）以開盤價成交，與回測一致；盤中手動單以即時價
    var useOpen = !pending.liveOnly && tfNum_(quote.open) !== null;
    var price = useOpen ? quote.open : quote.last;
    var filled = tfFillPending_(state, { date: quote.date, open: price }, config);
    trades = trades.concat(filled);
    if (state.position && state.position.entryDate === quote.date) state.position.entryMode = useOpen ? 'open' : 'live';
    state.intraday.openFilled = true;
    events.push({ type: 'fill', date: quote.date, time: quote.time, price: price, mode: useOpen ? 'open' : 'live', estimated: !!quote.estimated });
  }

  var pos = state.position;
  if (pos) {
    var dir = pos.side === 'long' ? 1 : -1;
    // 今天盤中才以即時價進場的部位，當天稍早的高低點與它無關，只看最新價
    var liveEntry = pos.entryDate === quote.date && pos.entryMode === 'live';
    var low = liveEntry || tfNum_(quote.low) === null ? quote.last : quote.low;
    var high = liveEntry || tfNum_(quote.high) === null ? quote.last : quote.high;
    var hit = dir > 0 ? low <= pos.stop : high >= pos.stop;
    if (hit) {
      var gapped = !liveEntry && tfNum_(quote.open) !== null && (dir > 0 ? quote.open < pos.stop : quote.open > pos.stop) && pos.entryDate !== quote.date;
      var exitPx = liveEntry ? quote.last : (gapped ? quote.open : pos.stop);
      state.equity += dir * pos.contracts * config.pointValue * (exitPx - state.lastClose);
      state.lastClose = exitPx;
      var trade = tfClosePortion_(state, exitPx, pos.contracts, quote.date, 'stop', config);
      trade.intraday = true;
      trade.estimated = !!quote.estimated;
      trades.push(trade);
      state.equity = Math.round(state.equity);
      events.push({ type: 'stop', date: quote.date, time: quote.time, price: exitPx, estimated: !!quote.estimated });
    }
  }

  pos = state.position;
  var live = { date: quote.date, time: quote.time, price: quote.last, estimated: !!quote.estimated, unrealized: null, stopDistance: null };
  if (pos) {
    var d = pos.side === 'long' ? 1 : -1;
    live.unrealized = Math.round(d * (quote.last - pos.entryPrice) * pos.contracts * config.pointValue);
    live.stopDistance = tfRound_(d * (quote.last - pos.stop), 1);
    if (ctx.atr && !state.intraday.nearStopAlerted && live.stopDistance <= TAIFEX_NEAR_STOP_ATR * ctx.atr) {
      state.intraday.nearStopAlerted = true;
      events.push({ type: 'near_stop', date: quote.date, time: quote.time, price: quote.last, stop: pos.stop, distance: live.stopDistance });
    }
  }
  state.live = live;
  return { state: state, trades: trades, events: events };
}

// -------- 下單建議單 --------

/**
 * 把待成交單翻成實際下單步驟。input: { pending, position, atr, refPrice, refSource, equity, config, params }。
 * - 進場 / 反手：可成交的限價單（參考價 ± 緩衝）ROD，08:45 開盤前送出；09:00 未成交改範圍市價（MWP）
 * - 平倉：範圍市價（MWP），避免追價
 * - 成交後立刻掛停損單（STP，觸價後以市價出場），每天收盤後依新停損價改單
 */
function tfBuildOrderTicket_(input) {
  var pending = input.pending;
  var pos = input.position;
  var config = input.config;
  var params = tfParams_(input.params);
  if (!pending) return { kind: 'none', steps: [], notes: ['沒有待成交單，維持現有部位'] };
  var ref = tfNum_(input.refPrice);
  var atr = tfNum_(input.atr);
  var buffer = atr ? Math.max(10, Math.round(0.25 * atr)) : 30;
  var product = TAIFEX_PRODUCTS[config.product] || TAIFEX_PRODUCTS.TMF;
  var current = pos ? pos.side : 'flat';
  var target = pending.target;
  var want = target === 'flat' ? 0 : pending.contracts;
  var steps = [];

  function limitFor(side) {
    if (ref === null) return null;
    return side === 'buy' ? Math.round(ref + buffer) : Math.round(ref - buffer);
  }

  var kind = 'adjust';
  if (current !== 'flat' && (target === 'flat' || target !== current)) {
    var closeSide = current === 'long' ? 'sell' : 'buy';
    steps.push({ action: 'close', label: '平倉 ' + (current === 'long' ? '多單' : '空單') + ' ' + pos.contracts + ' 口',
      side: closeSide, qty: pos.contracts, orderType: 'MWP', price: null, tif: 'IOC', offset: '平倉' });
    kind = target === 'flat' ? 'close' : 'reverse';
  }
  if (target !== 'flat') {
    var held = current === target ? pos.contracts : 0;
    var delta = want - held;
    if (delta !== 0) {
      var side = (target === 'long') === (delta > 0) ? 'buy' : 'sell';
      var qty = Math.abs(delta);
      steps.push({ action: delta > 0 ? 'open' : 'reduce',
        label: (delta > 0 ? '新倉 ' : '減碼 ') + (target === 'long' ? '多單' : '空單') + ' ' + qty + ' 口',
        side: side, qty: qty, orderType: delta > 0 ? 'LMT' : 'MWP', price: delta > 0 ? limitFor(side) : null,
        tif: delta > 0 ? 'ROD' : 'IOC', offset: delta > 0 ? '新倉' : '平倉' });
      if (kind === 'adjust' && current === 'flat') kind = 'open';
    }
  }

  var stopOrder = null;
  if (target !== 'flat' && ref !== null && atr) {
    var dir = target === 'long' ? 1 : -1;
    var stopPoints = pending.stopPoints || params.stopAtr * atr;
    stopOrder = {
      side: dir > 0 ? 'sell' : 'buy',
      qty: want,
      orderType: 'STP',
      price: Math.round(ref - dir * stopPoints),
      stopPoints: tfRound_(stopPoints, 1),
      note: '成交後立刻掛停損單；實際停損價 = 成交價 ' + (dir > 0 ? '−' : '+') + ' ' + Math.round(stopPoints) + ' 點，之後每天收盤依移動停損改單',
    };
  }

  var notes = [];
  if (steps.some(function (s) { return s.orderType === 'LMT'; })) {
    notes.push('08:45 開盤前送出限價單（ROD）；限價已含 ' + buffer + ' 點緩衝，通常開盤就會成交');
    notes.push('09:00 仍未成交 → 刪單改範圍市價（MWP）；09:15 還沒成交就放棄，等下一個訊號，不要追價');
  }
  if (steps.some(function (s) { return s.action === 'close'; })) notes.push('平倉用範圍市價（MWP），開盤即出場，不要因為想等反彈而改限價');
  if (kind === 'reverse') notes.push('反手：先平倉、確認成交後再送新倉單，避免保證金不足被拒');
  if (input.refSource) notes.push('參考價：' + input.refSource);

  var riskTWD = stopOrder ? Math.round(stopOrder.stopPoints * product.pointValue * want) : null;
  return {
    kind: kind,
    product: config.product,
    productLabel: product.label,
    targetSide: target,
    targetContracts: want,
    refPrice: ref,
    buffer: buffer,
    steps: steps,
    stopOrder: stopOrder,
    riskTWD: riskTWD,
    riskPct: riskTWD !== null && input.equity ? tfRound_(riskTWD / input.equity * 100, 2) : null,
    marginTWD: want ? Math.round(config.marginPerContract * want) : 0,
    validFrom: pending.validFrom || null,
    notes: notes,
  };
}

// -------- 參數最佳化（walk-forward） --------

function tfGridVariants_(grid) {
  var out = [];
  grid.entry.forEach(function (entry) {
    grid.stopAtr.forEach(function (stopAtr) {
      grid.trailAtr.forEach(function (trailAtr) {
        out.push({ entry: entry, stopAtr: stopAtr, trailAtr: trailAtr });
      });
    });
  });
  return out;
}

/** 報酬最大化目標：回撤超過上限或交易太少直接淘汰（-Infinity），否則以年化報酬排序 */
function tfObjective_(metrics, maxDrawdownPct, minTrades) {
  if (!metrics || metrics.cagrPct === null) return -Infinity;
  if (metrics.maxDrawdownPct > maxDrawdownPct) return -Infinity;
  if (metrics.trades < minTrades) return -Infinity;
  return metrics.cagrPct;
}

function tfSpearman_(a, b) {
  var n = a.length;
  if (n < 3) return null;
  function ranks(v) {
    var idx = v.map(function (x, i) { return { x: x, i: i }; }).sort(function (p, q) { return p.x - q.x; });
    var r = new Array(n);
    for (var k = 0; k < n;) {
      var j = k;
      while (j + 1 < n && idx[j + 1].x === idx[k].x) j++;
      for (var m = k; m <= j; m++) r[idx[m].i] = (k + j) / 2 + 1;
      k = j + 1;
    }
    return r;
  }
  var ra = ranks(a);
  var rb = ranks(b);
  var ma = ra.reduce(function (s, x) { return s + x; }, 0) / n;
  var mb = rb.reduce(function (s, x) { return s + x; }, 0) / n;
  var num = 0;
  var da = 0;
  var db = 0;
  for (var i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) * (ra[i] - ma);
    db += (rb[i] - mb) * (rb[i] - mb);
  }
  return da && db ? tfRound_(num / Math.sqrt(da * db), 3) : null;
}

/**
 * Walk-forward：前 trainRatio 當樣本內、其餘當樣本外。每組參數各跑一次，
 * 以「樣本內」報酬最大（回撤 ≤ 上限、交易 ≥ 5 筆）選出參數，再報告它在「樣本外」的表現，與基準參數比較。
 * 只在樣本外也贏基準時才建議採用；IS/OOS 報酬的排名相關係數低代表參數不穩定（容易過擬合）。
 */
function tfOptimizeTaifex_(bars, rawConfig, opts) {
  opts = opts || {};
  var config = tfNormalizeConfig_(rawConfig);
  var series = opts.series || tfPrepareSeries_(bars);
  var start = TAIFEX_RULES.warmup;
  var n = bars.length;
  if (n < start + 120) return null;
  var split = start + Math.floor((n - start) * (opts.trainRatio || 0.6));
  var maxDd = config.maxDrawdownPct;
  var grid = tfGridVariants_(opts.grid || TAIFEX_OPT_GRID);

  function evalParams(params) {
    var is = runTaifexBacktest_(bars, config, { series: series, params: params, endIndex: split });
    var oos = runTaifexBacktest_(bars, config, { series: series, params: params, startIndex: split });
    return { params: params, inSample: is ? is.metrics : null, outOfSample: oos ? oos.metrics : null };
  }

  var results = grid.map(evalParams);
  results.forEach(function (r) { r.score = tfObjective_(r.inSample, maxDd, 5); });
  var ranked = results.slice().sort(function (a, b) { return b.score - a.score; });
  var best = ranked[0] && ranked[0].score > -Infinity ? ranked[0] : null;
  var baseline = evalParams(tfParams_({}));

  var valid = results.filter(function (r) { return r.inSample && r.outOfSample; });
  var stability = tfSpearman_(
    valid.map(function (r) { return r.inSample.totalReturnPct; }),
    valid.map(function (r) { return r.outOfSample.totalReturnPct; }),
  );
  var bestOos = best && best.outOfSample ? best.outOfSample.totalReturnPct : null;
  var baseOos = baseline.outOfSample ? baseline.outOfSample.totalReturnPct : null;
  var adopt = !!best && bestOos !== null && baseOos !== null && bestOos > baseOos
    && best.outOfSample.maxDrawdownPct <= maxDd;

  // 報酬最大化的風險建議：回撤大致與每筆風險成正比，把完整期間回撤拉到上限的 80%
  var full = runTaifexBacktest_(bars, config, { series: series, params: adopt ? best.params : null });
  var suggestedRiskPct = null;
  if (full && full.metrics && full.metrics.maxDrawdownPct > 0) {
    suggestedRiskPct = tfRound_(tfClip_(config.riskPerTradePct * (0.8 * maxDd) / full.metrics.maxDrawdownPct, 0.25, 3), 2);
  }

  return {
    trainFrom: bars[start].date,
    trainTo: bars[split - 1].date,
    testFrom: bars[split].date,
    testTo: bars[n - 1].date,
    maxDrawdownPct: maxDd,
    variants: ranked.map(function (r) {
      return { params: r.params, inSample: r.inSample, outOfSample: r.outOfSample, eligible: r.score > -Infinity };
    }),
    best: best ? { params: best.params, inSample: best.inSample, outOfSample: best.outOfSample } : null,
    baseline: { params: baseline.params, inSample: baseline.inSample, outOfSample: baseline.outOfSample },
    stability: stability,
    adopt: adopt,
    suggestedRiskPct: suggestedRiskPct,
    fullPeriod: full ? full.metrics : null,
  };
}

// -------- 即時報價解析 --------

function tfPick_(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = obj && obj[keys[i]];
    var n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : v;
    if (typeof n === 'number' && isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Fugle 的 lastUpdated / lastTrade.time 是微秒；轉成毫秒（判斷報價是否還在更新）。沒有就回 null */
function tfFugleTs_(json) {
  var raw = tfPick_(json, ['lastUpdated']) || tfPick_(json.lastTrade || {}, ['time']);
  if (raw === null) return null;
  if (raw > 1e14) return Math.round(raw / 1000);
  return raw > 1e11 ? raw : raw * 1000;
}

/** Fugle 期貨盤中 quote（欄位名稱寬鬆對應） */
function tfParseFugleQuote_(json) {
  if (!json || typeof json !== 'object') return null;
  var last = tfPick_(json, ['lastPrice', 'closePrice', 'price']) || tfPick_(json.lastTrade || {}, ['price']);
  if (last === null) return null;
  return {
    symbol: json.symbol || null,
    last: last,
    open: tfPick_(json, ['openPrice', 'open']),
    high: tfPick_(json, ['highPrice', 'high']),
    low: tfPick_(json, ['lowPrice', 'low']),
    prevClose: tfPick_(json, ['previousClose', 'referencePrice', 'prevClose']),
    volume: tfPick_(json.total || {}, ['tradeVolume']),
    ts: tfFugleTs_(json),
    estimated: false,
    source: 'fugle',
  };
}

/**
 * Yahoo 加權指數（^TWII）+ 基差推估台指期：期貨 = 現貨 + (期貨昨收 − 現貨昨收)。
 * 標記 estimated，成交紀錄會註明「推估價」。
 */
function tfParseYahooSpot_(json, futuresPrevClose) {
  var result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.meta || tfNum_(futuresPrevClose) === null) return null;
  var meta = result.meta;
  var spotLast = tfNum_(meta.regularMarketPrice);
  var spotPrev = tfNum_(meta.chartPreviousClose) || tfNum_(meta.previousClose);
  if (spotLast === null || spotPrev === null) return null;
  var basis = futuresPrevClose - spotPrev;
  var q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  var clean = function (arr) { return (arr || []).filter(function (v) { return typeof v === 'number' && isFinite(v); }); };
  var opens = clean(q.open);
  var highs = clean(q.high);
  var lows = clean(q.low);
  return {
    symbol: '^TWII+basis',
    last: tfRound_(spotLast + basis, 0),
    open: opens.length ? tfRound_(opens[0] + basis, 0) : null,
    high: highs.length ? tfRound_(Math.max.apply(null, highs) + basis, 0) : null,
    low: lows.length ? tfRound_(Math.min.apply(null, lows) + basis, 0) : null,
    prevClose: futuresPrevClose,
    basis: tfRound_(basis, 1),
    ts: tfNum_(meta.regularMarketTime) !== null ? meta.regularMarketTime * 1000 : null,
    estimated: true,
    source: 'yahoo_spot_basis',
  };
}

/** Fugle 期貨代號：TXF + 月份字母（A=1 月…L=12 月）+ 年份個位數，例如 202612 → TXFL6 */
function tfFugleSymbol_(contract) {
  var m = /^(\d{4})(\d{2})$/.exec(String(contract || ''));
  if (!m) return null;
  return 'TXF' + 'ABCDEFGHIJKL'.charAt(Number(m[2]) - 1) + m[1].charAt(3);
}
