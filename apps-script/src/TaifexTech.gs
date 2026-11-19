/**
 * TaifexTech — 台指期「盤中技術模擬」的純函式（不碰 Firestore / UrlFetch / PROP）。
 * 規劃見 docs/TAIFEX_PAPER_TRADING_PLAN.md §12；測試 apps-script/tests/taifex-tech.test.cjs。
 *
 * 目的：日盤（08:45–13:45）與夜盤（15:00–隔日 05:00）每 5 分鐘取一次報價、累積 5 分 K，
 * 讓 4 個「監控頻率」不同的虛擬機器人（每 5 / 15 / 30 / 60 分鐘看一次盤）用同一套技術指標進出場，
 * 比較哪個頻率、哪個時段、開盤後多久進場的結果比較好，作為之後調整演算法的依據。
 *
 * - 交易日曆：tfIsTradingDay_ / tfSessionAt_ / tfNextSession_（週末、國定假日休市不模擬）
 * - 5 分 K：tfTechAppendBar_（由報價取樣）、tfTechAggregate_（依監控頻率合併）
 * - 指標：EMA、RSI、MACD、ATR、通道位置 → tfTechSignal_ 合成分數 [-1, 1]
 * - 機器人：tfTechStep_（每次報價：跨時段平倉 → 停損 → 收盤前平倉 → 到監控時間才做進出場決策）
 *
 * 與日線波段（TaifexStrategy.gs）完全獨立：不共用帳戶、不影響主帳戶績效。規則凍結在 TAIFEX_TECH_VERSION。
 */

var TAIFEX_TECH_VERSION = 'txi-v1';
var TAIFEX_NIGHT_OPEN = '15:00';
var TAIFEX_NIGHT_CLOSE = '05:00';
var TAIFEX_DAY_MINUTES = 300;
var TAIFEX_NIGHT_MINUTES = 840;

/** 監控頻率（分鐘）：每個頻率一個虛擬機器人 */
var TAIFEX_TECH_INTERVALS = [5, 15, 30, 60];

var TAIFEX_TECH_RULES = {
  emaFast: 9,
  emaSlow: 21,
  rsi: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  atr: 14,
  channel: 20,
  /** 至少要有這麼多根（該頻率的）K 棒才開始做決策：MACD 訊號線要 26 + 9 根 */
  minBars: 35,
  entry: 0.4,
  exit: 0.1,
  stopAtr: 2,
  trailAtr: 3,
  /** 收盤前 30 分鐘不開新倉；收盤前 10 分鐘一律平倉（不留倉過時段） */
  noEntryMin: 30,
  flatMin: 10,
  weights: { trend: 0.35, macd: 0.25, rsi: 0.2, breakout: 0.2 },
};

/** Claude 調校可以覆寫的規則（其餘固定）；範圍在 TaifexTuning.gs 驗過才會寫進 taifex_tuning/current */
var TAIFEX_TECH_TUNABLE_KEYS = ['entry', 'exit', 'stopAtr', 'trailAtr'];

/** 預設規則 + 覆寫（entry / exit / stopAtr / trailAtr / weights）；沒有覆寫就是 TAIFEX_TECH_RULES 本身 */
function tfTechRules_(overrides) {
  if (!overrides || typeof overrides !== 'object') return TAIFEX_TECH_RULES;
  var out = {};
  Object.keys(TAIFEX_TECH_RULES).forEach(function (k) { out[k] = TAIFEX_TECH_RULES[k]; });
  TAIFEX_TECH_TUNABLE_KEYS.forEach(function (k) {
    var v = Number(overrides[k]);
    if (overrides[k] !== undefined && overrides[k] !== null && isFinite(v)) out[k] = v;
  });
  if (out.exit >= out.entry) out.exit = Math.max(0, out.entry - 0.1);
  var w = overrides.weights;
  if (w && typeof w === 'object') {
    var weights = {};
    var ok = Object.keys(TAIFEX_TECH_RULES.weights).every(function (k) {
      var v = Number(w[k]);
      weights[k] = v;
      return isFinite(v) && v >= 0;
    });
    if (ok) out.weights = weights;
  }
  return out;
}

/** 5 分 K 保留根數（約 4 個交易日，60 分頻率才湊得到 35 根） */
var TAIFEX_TECH_MAX_BARS = 960;
var TAIFEX_TECH_MAX_SESSIONS = 90;
var TAIFEX_TECH_MAX_DECISIONS = 24;

/** 進場時間分段（開盤後幾分鐘）：用來看「開盤後多久進場」比較好 */
var TAIFEX_TECH_BUCKETS = {
  day: [{ id: 'd1', to: 30 }, { id: 'd2', to: 90 }, { id: 'd3', to: 180 }, { id: 'd4', to: 9999 }],
  night: [{ id: 'n1', to: 60 }, { id: 'n2', to: 390 }, { id: 'n3', to: 600 }, { id: 'n4', to: 9999 }],
};

// -------- 交易日曆 --------

function tfHhmmToMin_(hhmm) {
  var m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function tfMinToHhmm_(min) {
  var m = ((min % 1440) + 1440) % 1440;
  return tfPad2_(Math.floor(m / 60)) + ':' + tfPad2_(m % 60);
}

function tfAddDays_(dateStr, days) {
  var d = tfStrToDate_(dateStr);
  return d ? tfDateToStr_(new Date(d.getTime() + days * 86400000)) : null;
}

/** 交易日：平日且不在休市表（holidays: { 'yyyy-MM-dd': '名稱' }） */
function tfIsTradingDay_(dateStr, holidays) {
  return tfIsWeekday_(dateStr) && !(holidays && holidays[dateStr]);
}

function tfClosedReason_(dateStr, holidays) {
  if (!tfIsWeekday_(dateStr)) return { reason: 'weekend', holidayName: null };
  if (holidays && holidays[dateStr]) return { reason: 'holiday', holidayName: String(holidays[dateStr]) };
  return null;
}

/**
 * 現在屬於哪個交易時段。回傳：
 * - 交易中：{ session: 'day' | 'night', key, date（時段開始日）, m（開盤後分鐘）, toClose（距收盤分鐘） }
 * - 休市：{ session: null, reason: 'weekend' | 'holiday' | 'break', holidayName }
 * 夜盤跨日：00:00–05:00 屬於「前一天」開始的夜盤（週六凌晨是週五夜盤；週一凌晨沒有夜盤）。
 */
function tfSessionAt_(dateStr, hhmm, holidays) {
  var min = tfHhmmToMin_(hhmm);
  if (min === null || !tfStrToDate_(dateStr)) return { session: null, reason: 'break', holidayName: null };
  var dayOpen = tfHhmmToMin_(TAIFEX_SESSION_OPEN);
  var nightOpen = tfHhmmToMin_(TAIFEX_NIGHT_OPEN);
  var nightClose = tfHhmmToMin_(TAIFEX_NIGHT_CLOSE);
  var closed;
  if (min >= dayOpen && min <= dayOpen + TAIFEX_DAY_MINUTES) {
    closed = tfClosedReason_(dateStr, holidays);
    if (closed) return { session: null, reason: closed.reason, holidayName: closed.holidayName };
    return { session: 'day', key: dateStr + 'D', date: dateStr, m: min - dayOpen, toClose: dayOpen + TAIFEX_DAY_MINUTES - min };
  }
  if (min >= nightOpen) {
    closed = tfClosedReason_(dateStr, holidays);
    if (closed) return { session: null, reason: closed.reason, holidayName: closed.holidayName };
    return { session: 'night', key: dateStr + 'N', date: dateStr, m: min - nightOpen, toClose: TAIFEX_NIGHT_MINUTES - (min - nightOpen) };
  }
  if (min <= nightClose) {
    var prev = tfAddDays_(dateStr, -1);
    closed = tfClosedReason_(prev, holidays);
    if (closed) return { session: null, reason: closed.reason, holidayName: closed.holidayName };
    var m = 1440 - nightOpen + min;
    return { session: 'night', key: prev + 'N', date: prev, m: m, toClose: TAIFEX_NIGHT_MINUTES - m };
  }
  return { session: null, reason: 'break', holidayName: null };
}

/** 下一個會開盤的時段（給畫面顯示「下次開盤」）；最多往後找 20 天 */
function tfNextSession_(dateStr, hhmm, holidays) {
  var min = tfHhmmToMin_(hhmm);
  if (min === null) min = 0;
  var date = dateStr;
  for (var i = 0; i < 20 && date; i++) {
    if (tfIsTradingDay_(date, holidays)) {
      if (i > 0 || min < tfHhmmToMin_(TAIFEX_SESSION_OPEN)) return { session: 'day', date: date, time: TAIFEX_SESSION_OPEN };
      if (min < tfHhmmToMin_(TAIFEX_NIGHT_OPEN)) return { session: 'night', date: date, time: TAIFEX_NIGHT_OPEN };
    }
    date = tfAddDays_(date, 1);
  }
  return null;
}

/** 日期字串寬鬆解析：民國 7 碼（1150101）、西元 8 碼、yyyy-MM-dd、yyyy/M/d、民國 115/1/1 */
function tfParseHolidayDate_(value) {
  var s = String(value === null || value === undefined ? '' : value).trim();
  var y;
  var mo;
  var d;
  var m = /^(\d{2,4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); } else if (/^\d{7}$/.test(s)) {
    y = Number(s.slice(0, 3)); mo = Number(s.slice(3, 5)); d = Number(s.slice(5, 7));
  } else if (/^\d{8}$/.test(s)) {
    y = Number(s.slice(0, 4)); mo = Number(s.slice(4, 6)); d = Number(s.slice(6, 8));
  } else return null;
  if (y < 1911) y += 1911;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return y + '-' + tfPad2_(mo) + '-' + tfPad2_(d);
}

/**
 * 證交所「有價證券集中交易市場開（休）市日期」OpenAPI → { 'yyyy-MM-dd': 名稱 }。
 * 表內也會列「開始交易日 / 最後交易日」，那些是有開盤的日子，要排除。期交所休市日與證交所相同。
 */
function tfParseTwseHolidays_(json) {
  var out = {};
  if (!Array.isArray(json)) return out;
  json.forEach(function (row) {
    if (!row || typeof row !== 'object') return;
    var date = tfParseHolidayDate_(row.Date || row.date || row['日期']);
    var name = String(row.Name || row.name || row['名稱'] || '').trim();
    var desc = String(row.Description || row.description || row['說明'] || '');
    if (!date) return;
    if (/交易日/.test(name) || /開始交易|最後交易/.test(desc)) return;
    out[date] = name || '休市';
  });
  return out;
}

/** 抓不到證交所休市表時的後備：固定日期的國定假日（補假、春節、清明、端午、中秋不在內，靠報價是否更新把關） */
function tfFixedHolidays_(year) {
  var fixed = { '01-01': '元旦', '02-28': '和平紀念日', '04-04': '兒童節', '05-01': '勞動節', '09-28': '教師節', '10-10': '國慶日', '10-25': '光復節', '12-25': '行憲紀念日' };
  var out = {};
  Object.keys(fixed).forEach(function (md) { out[year + '-' + md] = fixed[md]; });
  return out;
}

/** 使用者自訂的臨時休市日（颱風假等）：只收 yyyy-MM-dd，最多 40 筆 */
function tfNormalizeExtraHolidays_(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (v) {
    var d = tfParseHolidayDate_(v);
    if (d && out.indexOf(d) < 0 && out.length < 40) out.push(d);
  });
  return out.sort();
}

/** 盤中技術模擬設定（taifex_configs/default.tech）；預設日夜盤都開、不推播 */
function tfNormalizeTechConfig_(raw) {
  raw = raw || {};
  return {
    enabled: raw.enabled !== false,
    day: raw.day !== false,
    night: raw.night !== false,
    notify: raw.notify === true,
    contracts: Math.floor(tfBounded_(raw.contracts, 1, 20, 1)),
    extraHolidays: tfNormalizeExtraHolidays_(raw.extraHolidays),
  };
}

/** 報價時間太舊代表沒在交易（臨時休市、來源停更）；沒有時間戳就無法判斷，視為有效 */
function tfQuoteFresh_(quote, nowMs, maxAgeMin) {
  if (!quote || tfNum_(quote.ts) === null) return true;
  return nowMs - quote.ts <= (maxAgeMin || 20) * 60000;
}

// -------- 5 分 K --------

/** 把時間對齊到 5 分鐘（trigger 觸發時間會飄）並換算成開盤後分鐘數 */
function tfTechSlot_(sess) {
  var m = Math.max(0, Math.floor(sess.m / 5) * 5);
  var openMin = tfHhmmToMin_(sess.session === 'day' ? TAIFEX_SESSION_OPEN : TAIFEX_NIGHT_OPEN);
  var abs = openMin + m;
  var date = abs >= 1440 ? tfAddDays_(sess.date, 1) : sess.date;
  return { m: m, t: date + ' ' + tfMinToHhmm_(abs) };
}

/**
 * 用一筆報價更新 5 分 K 序列（不修改傳入陣列）。bar: { t, s（時段 key）, m, o, h, l, c, sh, sl }。
 * 高低點：取樣價的高低；若報價的「時段最高 / 最低」比上一根記錄的更極端，代表這 5 分鐘內創了新高 / 新低，一併計入。
 */
function tfTechAppendBar_(bars, quote, sess) {
  var out = (bars || []).slice();
  var slot = tfTechSlot_(sess);
  var last = out.length ? out[out.length - 1] : null;
  var price = quote.last;
  var qHigh = tfNum_(quote.high);
  var qLow = tfNum_(quote.low);
  if (last && last.s === sess.key && last.m >= slot.m) {
    var merged = { t: last.t, s: last.s, m: last.m, o: last.o, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price, sh: last.sh, sl: last.sl };
    if (qHigh !== null && last.sh !== null && qHigh > last.sh) { merged.h = Math.max(merged.h, qHigh); merged.sh = qHigh; }
    if (qLow !== null && last.sl !== null && qLow < last.sl) { merged.l = Math.min(merged.l, qLow); merged.sl = qLow; }
    out[out.length - 1] = merged;
    return out;
  }
  var sameSession = !!last && last.s === sess.key;
  var open = sameSession ? last.c : (slot.m === 0 && tfNum_(quote.open) !== null ? quote.open : price);
  var bar = { t: slot.t, s: sess.key, m: slot.m, o: open, h: Math.max(open, price), l: Math.min(open, price), c: price, sh: qHigh, sl: qLow };
  if (sameSession) {
    if (qHigh !== null && last.sh !== null && qHigh > last.sh) bar.h = Math.max(bar.h, qHigh);
    if (qLow !== null && last.sl !== null && qLow < last.sl) bar.l = Math.min(bar.l, qLow);
  }
  out.push(bar);
  return out.length > TAIFEX_TECH_MAX_BARS ? out.slice(-TAIFEX_TECH_MAX_BARS) : out;
}

/**
 * 5 分 K 合併成 interval 分 K（以各時段開盤為起點切段）。開盤那一筆（m = 0）併入第一段。
 * cutoff = { key, m }：目前時段只取到 m（含）為止，確保決策只用已走完的 K 棒。
 */
function tfTechAggregate_(bars, interval, cutoff) {
  var out = [];
  var cur = null;
  (bars || []).forEach(function (b) {
    if (cutoff && b.s === cutoff.key && b.m > cutoff.m) return;
    var idx = Math.max(1, Math.ceil(b.m / interval));
    if (!cur || cur.s !== b.s || cur.idx !== idx) {
      cur = { s: b.s, idx: idx, t: b.t, open: b.o, high: b.h, low: b.l, close: b.c };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, b.h);
      cur.low = Math.min(cur.low, b.l);
      cur.close = b.c;
      cur.t = b.t;
    }
  });
  return out;
}

// -------- 指標 --------

/** Wilder RSI；資料不足回傳 null */
function tfRsi_(closes, period) {
  var n = closes.length;
  var out = new Array(n);
  var gain = 0;
  var loss = 0;
  for (var i = 0; i < n; i++) {
    if (i === 0) { out[i] = null; continue; }
    var ch = closes[i] - closes[i - 1];
    var g = ch > 0 ? ch : 0;
    var l = ch < 0 ? -ch : 0;
    if (i <= period) {
      gain += g;
      loss += l;
      if (i < period) { out[i] = null; continue; }
      gain /= period;
      loss /= period;
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** MACD：{ macd, signal, hist } 三個等長陣列（不足為 null） */
function tfMacd_(closes, fast, slow, signalPeriod) {
  var ef = tfEma_(closes, fast);
  var es = tfEma_(closes, slow);
  var macd = closes.map(function (_, i) { return ef[i] === null || es[i] === null ? null : ef[i] - es[i]; });
  var start = slow - 1;
  var sig = tfEma_(macd.slice(start), signalPeriod);
  var signal = macd.map(function (_, i) { return i < start ? null : sig[i - start]; });
  var hist = macd.map(function (v, i) { return v === null || signal[i] === null ? null : v - signal[i]; });
  return { macd: macd, signal: signal, hist: hist };
}

/**
 * 最後一根 K 的技術訊號。aggBars: [{ open, high, low, close }]。
 * 因子（各 [-1, 1]）：均線趨勢、MACD 柱狀體、RSI 動能、20 根通道位置 → 加權合成分數。
 * 資料不足回傳 null。
 */
function tfTechSignal_(aggBars, rules) {
  var R = rules || TAIFEX_TECH_RULES;
  var n = aggBars.length;
  if (n < R.minBars) return null;
  var i = n - 1;
  var closes = aggBars.map(function (b) { return b.close; });
  var emaF = tfEma_(closes, R.emaFast)[i];
  var emaS = tfEma_(closes, R.emaSlow)[i];
  var rsi = tfRsi_(closes, R.rsi)[i];
  var macd = tfMacd_(closes, R.macdFast, R.macdSlow, R.macdSignal);
  var atr = tfAtr_(aggBars, R.atr)[i];
  if (emaF === null || emaS === null || rsi === null || macd.hist[i] === null || !atr) return null;
  var hi = -Infinity;
  var lo = Infinity;
  for (var k = i - R.channel; k < i; k++) {
    hi = Math.max(hi, aggBars[k].high);
    lo = Math.min(lo, aggBars[k].low);
  }
  var close = closes[i];
  var half = (hi - lo) / 2;
  var factors = {
    trend: tfClip_((emaF - emaS) / atr, -1, 1),
    macd: tfClip_(macd.hist[i] / (0.25 * atr), -1, 1),
    rsi: tfClip_((rsi - 50) / 20, -1, 1),
    breakout: half > 0 ? tfClip_((close - (hi + lo) / 2) / half, -1, 1) : 0,
  };
  var score = 0;
  Object.keys(R.weights).forEach(function (key) { score += R.weights[key] * factors[key]; });
  return {
    close: close,
    emaFast: tfRound_(emaF, 1),
    emaSlow: tfRound_(emaS, 1),
    rsi: tfRound_(rsi, 1),
    macd: tfRound_(macd.macd[i], 1),
    macdSignal: tfRound_(macd.signal[i], 1),
    macdHist: tfRound_(macd.hist[i], 1),
    atr: tfRound_(atr, 1),
    channelHigh: hi,
    channelLow: lo,
    factors: { trend: tfRound_(factors.trend, 2), macd: tfRound_(factors.macd, 2), rsi: tfRound_(factors.rsi, 2), breakout: tfRound_(factors.breakout, 2) },
    score: tfRound_(score, 3),
  };
}

/**
 * 進出場決策。side: 'long' | 'short' | null（空手）；canEnter：收盤前 30 分鐘內為 false；allowShort 依設定。
 * 回傳 { action: 'hold' | 'enter' | 'exit' | 'reverse', target, reason }。
 */
function tfTechDecide_(signal, side, canEnter, allowShort, rules) {
  var R = rules || TAIFEX_TECH_RULES;
  if (!signal) return { action: 'hold', target: side || 'flat', reason: '資料不足' };
  var s = signal.score;
  var wantLong = s >= R.entry && signal.close > signal.emaSlow;
  var wantShort = s <= -R.entry && signal.close < signal.emaSlow && allowShort;
  if (!side) {
    if (!canEnter) return { action: 'hold', target: 'flat', reason: '接近收盤，不開新倉' };
    if (wantLong) return { action: 'enter', target: 'long', reason: '分數 ' + s + ' ≥ ' + R.entry + ' 且站上慢線' };
    if (wantShort) return { action: 'enter', target: 'short', reason: '分數 ' + s + ' ≤ -' + R.entry + ' 且跌破慢線' };
    return { action: 'hold', target: 'flat', reason: '分數 ' + s + ' 未達進場門檻' };
  }
  var dir = side === 'long' ? 1 : -1;
  var opposite = dir > 0 ? wantShort : wantLong;
  if (opposite && canEnter) return { action: 'reverse', target: dir > 0 ? 'short' : 'long', reason: '分數 ' + s + ' 強烈反向' };
  if (dir * s < R.exit) return { action: 'exit', target: 'flat', reason: '分數 ' + s + ' 回到出場區' };
  return { action: 'hold', target: side, reason: '分數 ' + s + ' 續抱' };
}

// -------- 機器人 --------

function tfTechNewStat_() {
  return { n: 0, wins: 0, net: 0, grossWin: 0, grossLoss: 0, points: 0 };
}

function tfTechAddStat_(stat, trade) {
  var s = stat || tfTechNewStat_();
  s.n += 1;
  if (trade.netPnl > 0) { s.wins += 1; s.grossWin += trade.netPnl; } else s.grossLoss += -trade.netPnl;
  s.net += trade.netPnl;
  s.points = tfRound_(s.points + trade.points, 1);
  return s;
}

function tfTechBotId_(interval) {
  return 'm' + interval;
}

function tfTechNewBot_(interval) {
  return {
    interval: interval,
    position: null,
    realized: 0,
    peak: 0,
    maxDrawdown: 0,
    checks: 0,
    lastCheck: null,
    stats: { all: tfTechNewStat_(), day: tfTechNewStat_(), night: tfTechNewStat_() },
    buckets: {},
    lastDecision: null,
    decisions: [],
  };
}

function tfTechNewState_() {
  var bots = {};
  TAIFEX_TECH_INTERVALS.forEach(function (n) { bots[tfTechBotId_(n)] = tfTechNewBot_(n); });
  return { modelVersion: TAIFEX_TECH_VERSION, epoch: 1, startDate: null, bots: bots, sessions: [] };
}

function tfTechBucketId_(session, entryM) {
  var list = TAIFEX_TECH_BUCKETS[session] || [];
  for (var i = 0; i < list.length; i++) if (entryM < list[i].to) return list[i].id;
  return null;
}

/** 平倉並記一筆交易（進出場各算一次成本），更新機器人的累計統計 */
function tfTechClose_(bot, price, time, reason, config, estimated) {
  var p = bot.position;
  var dir = p.side === 'long' ? 1 : -1;
  var points = tfRound_(dir * (price - p.entryPrice), 1);
  var gross = Math.round(points * p.contracts * config.pointValue);
  var costs = tfTradeCost_(p.entryPrice, p.contracts, config) + tfTradeCost_(price, p.contracts, config);
  var trade = {
    bot: tfTechBotId_(bot.interval),
    interval: bot.interval,
    session: p.session,
    sessionKey: p.sessionKey,
    side: p.side,
    contracts: p.contracts,
    entryTime: p.entryTime,
    entryPrice: p.entryPrice,
    entryM: p.entryM,
    entryScore: p.entryScore,
    exitTime: time,
    exitPrice: price,
    points: points,
    grossPnl: gross,
    costs: costs,
    netPnl: gross - costs,
    reason: reason,
    estimated: !!(estimated || p.estimated),
  };
  bot.position = null;
  bot.realized += trade.netPnl;
  bot.peak = Math.max(bot.peak, bot.realized);
  bot.maxDrawdown = Math.max(bot.maxDrawdown, bot.peak - bot.realized);
  bot.stats.all = tfTechAddStat_(bot.stats.all, trade);
  bot.stats[p.session] = tfTechAddStat_(bot.stats[p.session], trade);
  var bucket = tfTechBucketId_(p.session, p.entryM);
  if (bucket) bot.buckets[bucket] = tfTechAddStat_(bot.buckets[bucket], trade);
  return trade;
}

function tfTechOpen_(bot, side, signal, bar, sess, contracts, estimated, rules) {
  var dir = side === 'long' ? 1 : -1;
  bot.position = {
    side: side,
    contracts: contracts,
    entryPrice: bar.c,
    entryTime: bar.t,
    entryM: bar.m,
    entryScore: signal.score,
    session: sess.session,
    sessionKey: sess.key,
    stop: tfRound_(bar.c - dir * (rules || TAIFEX_TECH_RULES).stopAtr * signal.atr, 1),
    extreme: bar.c,
    estimated: !!estimated,
  };
}

function tfTechLastBarOf_(bars, key) {
  for (var i = bars.length - 1; i >= 0; i--) if (bars[i].s === key) return bars[i];
  return null;
}

/**
 * 一個機器人處理一筆最新的 5 分 K。順序：
 * 1. 上個時段沒平掉的倉（排程漏跑）→ 以該時段最後一根收盤價平倉
 * 2. 停損（每筆報價都檢查，等同掛在交易所的停損單，不受監控頻率影響）
 * 3. 收盤前 flatMin 分鐘 → 平倉
 * 4. 到了這個機器人的監控時間（開盤後每 interval 分鐘）→ 算指標、做進出場決策、更新移動停損
 * 不修改傳入的 bot，回傳 { bot, trades, events }。
 */
function tfTechStepBot_(prevBot, bars, sess, ctx) {
  var bot = JSON.parse(JSON.stringify(prevBot));
  var R = tfTechRules_(ctx.rules);
  var config = ctx.config;
  var trades = [];
  var events = [];
  var bar = bars[bars.length - 1];
  var est = !!ctx.estimated;

  function close(price, time, reason) {
    var side = bot.position.side;
    var trade = tfTechClose_(bot, price, time, reason, config, est);
    trades.push(trade);
    events.push({ type: 'exit', bot: trade.bot, side: side, price: price, time: time, reason: reason, netPnl: trade.netPnl });
  }

  if (bot.position && bot.position.sessionKey !== sess.key) {
    var old = tfTechLastBarOf_(bars, bot.position.sessionKey);
    close(old ? old.c : bot.position.entryPrice, old ? old.t : bot.position.entryTime, 'session_end');
  }

  var pos = bot.position;
  if (pos && bar.t !== pos.entryTime) {
    var dir = pos.side === 'long' ? 1 : -1;
    if (dir > 0 ? bar.l <= pos.stop : bar.h >= pos.stop) close(pos.stop, bar.t, 'stop');
    else pos.extreme = dir > 0 ? Math.max(pos.extreme, bar.c) : Math.min(pos.extreme, bar.c);
  }

  if (bot.position && sess.toClose <= R.flatMin) close(bar.c, bar.t, 'session_end');

  var bucket = Math.floor(bar.m / bot.interval);
  var due = bucket >= 1 && (!bot.lastCheck || bot.lastCheck.key !== sess.key || bot.lastCheck.idx < bucket);
  if (due && sess.toClose > R.flatMin) {
    bot.lastCheck = { key: sess.key, idx: bucket };
    bot.checks += 1;
    var agg = tfTechAggregate_(bars, bot.interval, { key: sess.key, m: bucket * bot.interval });
    var signal = tfTechSignal_(agg, R);
    var side = bot.position ? bot.position.side : null;
    var decision = tfTechDecide_(signal, side, sess.toClose > R.noEntryMin, config.allowShort, R);
    if (signal && (decision.action === 'exit' || decision.action === 'reverse')) close(bar.c, bar.t, decision.action === 'reverse' ? 'reverse' : 'signal');
    if (signal && (decision.action === 'enter' || decision.action === 'reverse')) {
      tfTechOpen_(bot, decision.target, signal, bar, sess, ctx.contracts || 1, est, R);
      events.push({ type: 'enter', bot: tfTechBotId_(bot.interval), side: decision.target, price: bar.c, time: bar.t, stop: bot.position.stop, score: signal.score });
    } else if (signal && bot.position && decision.action === 'hold') {
      // 移動停損：持倉期間最佳收盤 ∓ trailAtr × ATR，只往有利方向移動
      var p = bot.position;
      var d = p.side === 'long' ? 1 : -1;
      var trail = tfRound_(p.extreme - d * R.trailAtr * signal.atr, 1);
      p.stop = d > 0 ? Math.max(p.stop, trail) : Math.min(p.stop, trail);
    }
    var record = {
      t: bar.t,
      session: sess.session,
      price: bar.c,
      score: signal ? signal.score : null,
      action: decision.action,
      target: decision.target,
      reason: decision.reason,
      bars: agg.length,
      indicators: signal ? {
        emaFast: signal.emaFast, emaSlow: signal.emaSlow, rsi: signal.rsi, macdHist: signal.macdHist, atr: signal.atr,
        channelHigh: signal.channelHigh, channelLow: signal.channelLow,
      } : null,
      factors: signal ? signal.factors : null,
    };
    bot.lastDecision = record;
    bot.decisions = (bot.decisions || []).concat([{ t: record.t, price: record.price, score: record.score, action: record.action, target: record.target }])
      .slice(-TAIFEX_TECH_MAX_DECISIONS);
  }

  if (bot.position) {
    var q = bot.position;
    var dd = q.side === 'long' ? 1 : -1;
    q.unrealized = Math.round(dd * (bar.c - q.entryPrice) * q.contracts * config.pointValue);
  }
  return { bot: bot, trades: trades, events: events };
}

/**
 * 整體步進：更新 5 分 K → 每個機器人各跑一次 → 更新本時段摘要。
 * ctx: { config（tfNormalizeConfig_ 結果）, contracts, estimated, rules（Claude 調校的覆寫，可省略） }。不修改傳入的 state / bars。
 */
function tfTechStep_(prevState, prevBars, quote, sess, ctx) {
  var state = JSON.parse(JSON.stringify(prevState || tfTechNewState_()));
  var bars = tfTechAppendBar_(prevBars, quote, sess);
  var trades = [];
  var events = [];
  if (!state.startDate) state.startDate = sess.date;
  TAIFEX_TECH_INTERVALS.forEach(function (n) {
    var id = tfTechBotId_(n);
    var res = tfTechStepBot_(state.bots[id] || tfTechNewBot_(n), bars, sess, ctx);
    state.bots[id] = res.bot;
    trades = trades.concat(res.trades);
    events = events.concat(res.events);
  });

  var sessions = state.sessions || [];
  var cur = sessions.length && sessions[sessions.length - 1].key === sess.key ? sessions[sessions.length - 1] : null;
  var bar = bars[bars.length - 1];
  if (!cur) {
    cur = { key: sess.key, session: sess.session, date: sess.date, open: bar.o, high: bar.h, low: bar.l, close: bar.c, ticks: 0, pnl: {}, trades: {} };
    sessions.push(cur);
  }
  cur.high = Math.max(cur.high, bar.h);
  cur.low = Math.min(cur.low, bar.l);
  cur.close = bar.c;
  cur.ticks += 1;
  trades.forEach(function (t) {
    // 跨時段補平倉的交易算在它原本的時段
    var target = cur;
    if (t.sessionKey !== cur.key) {
      target = sessions.filter(function (s) { return s.key === t.sessionKey; })[0] || cur;
    }
    target.pnl[t.bot] = (target.pnl[t.bot] || 0) + t.netPnl;
    target.trades[t.bot] = (target.trades[t.bot] || 0) + 1;
  });
  state.sessions = sessions.slice(-TAIFEX_TECH_MAX_SESSIONS);
  return { state: state, bars: bars, trades: trades, events: events };
}

// -------- 即時報價解析（期交所行情資訊網） --------

/**
 * 期交所 MIS getQuoteList 回應 → 報價。symbolPrefix 例如 TXFL6；找不到就取第一個月契約。
 * 欄位名稱寬鬆對應；CDate + CTime 轉成時間戳（判斷報價是否還在更新）。
 */
function tfParseMisQuote_(json, symbolPrefix) {
  var list = json && json.RtData && json.RtData.QuoteList;
  if (!Array.isArray(list)) return null;
  var monthly = list.filter(function (r) { return r && /^TXF[A-L]\d-[FM]$/.test(String(r.SymbolID || '')); });
  var row = monthly.filter(function (r) { return symbolPrefix && String(r.SymbolID).indexOf(symbolPrefix + '-') === 0; })[0] || monthly[0];
  if (!row) return null;
  var last = tfPick_(row, ['CLastPrice', 'LastPrice']);
  if (last === null) return null;
  var ts = null;
  var d = /^(\d{4})(\d{2})(\d{2})$/.exec(String(row.CDate || ''));
  var t = /^(\d{2})(\d{2})(\d{2})/.exec(String(row.CTime || ''));
  // 期交所時間是台北時間（UTC+8，無日光節約）
  if (d && t) ts = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]) - 8, Number(t[2]), Number(t[3]));
  return {
    symbol: String(row.SymbolID),
    last: last,
    open: tfPick_(row, ['COpenPrice', 'OpenPrice']),
    high: tfPick_(row, ['CHighPrice', 'HighPrice']),
    low: tfPick_(row, ['CLowPrice', 'LowPrice']),
    prevClose: tfPick_(row, ['CRefPrice', 'RefPrice']),
    volume: tfPick_(row, ['CTotalVolume', 'TotalVolume']),
    ts: ts,
    estimated: false,
    source: 'taifex_mis',
  };
}

/** 報價合理性：與參考價（昨收）差距超過 15% 視為解析錯誤（漲跌幅限制 10%） */
function tfQuoteSane_(quote, refPrice) {
  if (!quote || tfNum_(quote.last) === null || quote.last <= 0) return false;
  var ref = tfNum_(refPrice);
  if (ref === null || ref <= 0) return true;
  return Math.abs(quote.last / ref - 1) <= 0.15;
}

/** 沒有日 K 快取時，直接由日期推算近月契約（yyyyMM） */
function tfFrontContractFor_(dateStr) {
  var d = tfStrToDate_(dateStr);
  if (!d) return null;
  var list = [];
  for (var i = 0; i < 3; i++) {
    var x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1));
    list.push(x.getUTCFullYear() + tfPad2_(x.getUTCMonth() + 1));
  }
  return tfPickFrontContracts_(dateStr, list).front;
}
