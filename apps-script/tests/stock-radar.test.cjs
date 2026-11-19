const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({ console, Date, Error, isFinite, JSON, Math, Number, String, Array, Object, Infinity });
for (const file of ['StockRadarFactors.gs', 'StockRadarFlows.gs', 'StockRadarIngest.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
}
// Stocks.gs 的 normalizeStockSymbol_ 同邏輯
vm.runInContext("function normalizeStockSymbol_(s) { return s ? String(s).trim().toUpperCase().replace(/\\.(TW|TWO|US)$/, '') : ''; }", context);

/** 產生 n 根日 K：每日固定漲跌幅 drift，加上交替擾動讓波動率不為 0 */
function candles(n, drift, { start = 100, wiggle = 0.01 } = {}) {
  const out = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    close *= 1 + drift + (i % 2 === 0 ? wiggle : -wiggle);
    const day = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    out.push({ date: day, open: close, high: close * 1.005, low: close * 0.995, close, volume: 1000 });
  }
  return out;
}

test('returns null when history is shorter than three months', () => {
  assert.equal(context.computeStockRadarMetrics_(candles(60, 0.001)), null);
  assert.notEqual(context.computeStockRadarMetrics_(candles(61, 0.001)), null);
});

test('steady uptrend scores positive on trend, momentum and 52-week high', () => {
  const up = context.computeStockRadarMetrics_(candles(260, 0.002));
  const bm = context.computeStockRadarMetrics_(candles(260, 0.0005));
  const factors = context.scoreStockRadarFactors_(up, bm);
  assert.ok(factors.tsmom.score > 0.5, `tsmom ${factors.tsmom.score}`);
  assert.ok(factors.relMom.score > 0, `relMom ${factors.relMom.score}`);
  assert.ok(factors.trend.score > 0.5, `trend ${factors.trend.score}`);
  assert.ok(factors.high52.score > 0.8, `high52 ${factors.high52.score}`);
  // 最近一個月漲多 → 短期反轉扣分
  assert.ok(factors.reversal.score < 0, `reversal ${factors.reversal.score}`);
  for (const f of Object.values(factors)) {
    if (f.score !== null) assert.ok(f.score >= -1 && f.score <= 1);
  }
});

test('downtrend scores negative and short history leaves long factors empty', () => {
  const down = context.computeStockRadarMetrics_(candles(260, -0.002));
  const factors = context.scoreStockRadarFactors_(down, null);
  assert.ok(factors.tsmom.score < -0.5);
  assert.ok(factors.trend.score < -0.5);
  assert.equal(factors.relMom.score, null);

  const short = context.computeStockRadarMetrics_(candles(100, 0.001));
  const shortFactors = context.scoreStockRadarFactors_(short, null);
  assert.equal(shortFactors.tsmom.score, null);
  assert.equal(shortFactors.trend.score, null);
  assert.equal(shortFactors.high52.score, null);
  const score = context.compositeStockRadarScore_(shortFactors);
  // 只剩 reversal + lowVol（權重 0.5 + 0.5，總權重 5）
  assert.equal(score.coverage, 0.2);
});

test('regime follows 200-day average and 12-1 momentum', () => {
  assert.equal(context.stockRadarRegime_(context.computeStockRadarMetrics_(candles(260, 0.002))), 'risk_on');
  assert.equal(context.stockRadarRegime_(context.computeStockRadarMetrics_(candles(260, -0.002))), 'risk_off');
  assert.equal(context.stockRadarRegime_(context.computeStockRadarMetrics_(candles(100, 0.002))), 'unknown');
  assert.equal(context.stockRadarRegime_(null), 'unknown');
});

test('decides actions for held and watchlist symbols', () => {
  const base = { coverage: 1, close: 100, chandelierStop: 90, regime: 'risk_on', weightPct: 10 };
  const decide = (o) => context.decideStockRadarAction_({ ...base, ...o }).action;
  assert.equal(decide({ held: true, composite: 0.5 }), 'add');
  assert.equal(decide({ held: true, composite: 0.1 }), 'hold');
  assert.equal(decide({ held: true, composite: -0.2 }), 'trim');
  assert.equal(decide({ held: true, composite: -0.6 }), 'exit');
  assert.equal(decide({ held: false, composite: 0.5 }), 'buy');
  assert.equal(decide({ held: false, composite: 0.1 }), 'watch');
  assert.equal(decide({ held: false, composite: -0.1 }), 'avoid');
  assert.equal(decide({ held: false, composite: 0.9, coverage: 0.2 }), 'insufficient');
});

test('risk-off regime, concentration and stop veto aggressive actions', () => {
  const base = { coverage: 1, close: 100, chandelierStop: 90, regime: 'risk_on', weightPct: 10 };
  const decide = (o) => context.decideStockRadarAction_({ ...base, ...o });
  assert.equal(decide({ held: true, composite: 0.5, regime: 'risk_off' }).action, 'hold');
  const concentrated = decide({ held: true, composite: 0.5, weightPct: 30 });
  assert.equal(concentrated.action, 'hold');
  assert.ok(concentrated.reasons.includes('concentration'));
  // 大盤偏空時買進門檻提高到 0.55
  assert.equal(decide({ held: false, composite: 0.5, regime: 'risk_off' }).action, 'watch');
  assert.equal(decide({ held: false, composite: 0.6, regime: 'risk_off' }).action, 'buy');
  // 跌破吊燈停損：分數尚可也減碼，未持有不列買進
  const stopped = decide({ held: true, composite: 0.2, close: 85 });
  assert.equal(stopped.action, 'trim');
  assert.ok(stopped.reasons.includes('below_stop'));
  assert.equal(decide({ held: true, composite: -0.2, close: 85 }).action, 'exit');
  assert.equal(decide({ held: false, composite: 0.5, close: 85 }).action, 'watch');
});

test('evaluateStockRadarItem_ marks short history as insufficient', () => {
  const result = context.evaluateStockRadarItem_(candles(30, 0.001), null, 'unknown', null);
  assert.equal(result.action, 'insufficient');
  assert.equal(result.composite, null);
  const full = context.evaluateStockRadarItem_(candles(260, 0.002), null, 'risk_on', { shares: 10, weightPct: 5 }, 'US', null);
  assert.equal(full.action, 'add');
});

test('US coverage ignores TW-only chip factors; TW counts them', () => {
  const metrics = context.computeStockRadarMetrics_(candles(260, 0.002));
  const factors = context.scoreStockRadarFactors_(metrics, null); // relMom 缺
  assert.equal(context.compositeStockRadarScore_(factors, 'US').coverage, 0.8);
  assert.equal(context.compositeStockRadarScore_(factors, 'TW').coverage, 0.6957);
});

test('parses TWSE T86 and margin tables by header name', () => {
  const t86 = {
    stat: 'OK',
    fields: ['證券代號', '證券名稱', '外陸資買進股數(不含外資自營商)', '外陸資賣出股數(不含外資自營商)',
      '外陸資買賣超股數(不含外資自營商)', '外資自營商買進股數', '外資自營商賣出股數', '外資自營商買賣超股數',
      '投信買進股數', '投信賣出股數', '投信買賣超股數', '自營商買賣超股數', '三大法人買賣超股數'],
    data: [
      ['2330  ', '台積電', '1', '1', '1,000,000', '0', '0', '5,000', '0', '0', '-200,000', '9', '9'],
      ['0050', '元大台灣50', '0', '0', '-300', '0', '0', '0', '0', '0', '100', '0', '0'],
    ],
  };
  assert.deepEqual({ ...context.parseTwseT86_(t86) }, { 2330: 805000, '0050': -200 });
  assert.equal(context.parseTwseT86_({ stat: '很抱歉，沒有符合條件的資料!' }), null);

  const margin = {
    stat: 'OK',
    tables: [
      { title: '信用交易統計', fields: ['項目', '買進', '今日餘額'], data: [['融資(交易單位)', '1', '2']] },
      { title: '融資融券彙總', fields: ['代號', '名稱', '買進', '賣出', '現金償還', '前日餘額', '今日餘額', '次一營業日限額', '買進', '賣出', '現券償還', '前日餘額', '今日餘額'],
        data: [['2330', '台積電', '1', '1', '0', '20,000', '21,500', '0', '0', '0', '0', '300', '310']] },
    ],
  };
  assert.deepEqual({ ...context.parseTwseMargin_(margin) }, { 2330: 21500 });
  const legacy = { stat: 'OK', creditFields: ['股票代號', '股票名稱', '今日餘額'], creditList: [['1101', '台泥', '3,000']] };
  assert.deepEqual({ ...context.parseTwseMargin_(legacy) }, { 1101: 3000 });
});

test('chip flow inputs need 10 days and score institutional buying up, margin build-up down', () => {
  const cs = candles(30, 0.001).map((c) => ({ ...c, volume: 1000000 }));
  const docs = cs.slice(-20).map((c, i) => ({ date: c.date, inst: { 2330: 50000 }, margin: { 2330: 1000 + i * 20 } }));
  const flow = context.computeStockRadarFlowInputs_('2330', docs, cs);
  assert.equal(flow.days, 20);
  assert.equal(flow.instNetRatio, 0.05);
  assert.equal(Math.round(flow.marginChange * 100) / 100, 0.38);
  const scored = context.scoreStockRadarFlowFactors_(flow);
  assert.ok(scored.instFlow.score > 0.7);
  assert.ok(scored.marginChange.score < -0.8);

  const sparse = context.computeStockRadarFlowInputs_('2330', docs.slice(-5), cs);
  assert.equal(sparse.instNetRatio, null);
  assert.equal(sparse.marginChange, null);
  assert.equal(context.computeStockRadarFlowInputs_('9999', docs, cs).instNetRatio, null);
});

test('sentiment adjusts score only with sources and is capped', () => {
  const src = [{ title: 'x', url: 'https://example.com' }];
  assert.equal(context.stockRadarSentimentAdj_({ sentiment: 1, confidence: 1, sources: [] }), 0);
  assert.equal(context.stockRadarSentimentAdj_({ sentiment: 0.8, confidence: 0.5, sources: src }), 0.1);
  assert.equal(context.stockRadarSentimentAdj_({ sentiment: -1, confidence: 1, sources: src, earningsSurprise: 'miss' }), -0.3);
  assert.equal(context.stockRadarSentimentAdj_(null), 0);
});

test('event risk window and market sentiment regime downgrade', () => {
  const ev = (type, date) => ({ riskEvents: [{ type, date }] });
  assert.equal(context.stockRadarEventRisk_(ev('earnings', '2026-11-02'), '2026-10-29'), true);
  assert.equal(context.stockRadarEventRisk_(ev('earnings', '2026-11-10'), '2026-10-29'), false);
  assert.equal(context.stockRadarEventRisk_(ev('earnings', '2026-10-26'), '2026-10-29'), false);
  assert.equal(context.stockRadarEventRisk_(ev('legal', null), '2026-10-29'), true);
  assert.equal(context.stockRadarEventRisk_(ev('ex_dividend', '2026-10-30'), '2026-10-29'), false);

  const src = [{ url: 'https://example.com' }];
  assert.deepEqual({ ...context.stockRadarEffectiveRegime_('risk_on', { sentiment: -0.7, confidence: 0.8, sources: src }) },
    { regime: 'neutral', adjusted: true });
  assert.deepEqual({ ...context.stockRadarEffectiveRegime_('risk_on', { sentiment: -0.7, confidence: 0.8, sources: [] }) },
    { regime: 'risk_on', adjusted: false });
  assert.equal(context.stockRadarEffectiveRegime_('neutral', { sentiment: -0.9, confidence: 0.9, sources: src }).regime, 'risk_off');
});

test('synthesis keeps quant score and is idempotent', () => {
  const item = {
    symbol: '2330', held: true, weightPct: 10, close: 100, coverage: 1, quantScore: 0.3, composite: 0.3,
    metrics: { chandelierStop: 90 }, action: 'hold', reasons: [],
  };
  const src = [{ title: 'a', url: 'https://example.com' }];
  const regime = { regime: 'risk_on', adjusted: false };
  const entry = { sentiment: 0.8, confidence: 1, sources: src, riskEvents: [] };
  const once = context.synthesizeStockRadarItem_(item, entry, regime, '2026-10-29');
  assert.equal(once.quantScore, 0.3);
  assert.equal(once.composite, 0.5);
  assert.equal(once.action, 'add');
  const twice = context.synthesizeStockRadarItem_(once, entry, regime, '2026-10-29');
  assert.equal(twice.composite, 0.5);
  const withEvent = context.synthesizeStockRadarItem_(item, { ...entry, riskEvents: [{ type: 'earnings', date: '2026-10-30' }] }, regime, '2026-10-29');
  assert.equal(withEvent.action, 'hold');
  assert.ok(withEvent.reasons.includes('event_risk'));
  const none = context.synthesizeStockRadarItem_(item, null, regime, '2026-10-29');
  assert.equal(none.composite, 0.3);
  assert.equal(none.sentiment, null);
});

test('forward returns enter at next open', () => {
  const cs = [
    { date: '2026-10-27', open: 99, close: 100 },
    { date: '2026-10-28', open: 100, close: 102 },
    { date: '2026-10-29', open: 104, close: 105 },
    { date: '2026-10-30', open: 106, close: 110 },
  ];
  const fwd = context.stockRadarForwardReturns_(cs, '2026-10-28', [1, 2, 5]);
  assert.equal(fwd.entryDate, '2026-10-29');
  assert.equal(fwd.entry, 104);
  assert.equal(fwd.fwd1, 0.00962);
  assert.equal(fwd.fwd2, 0.05769);
  assert.equal(fwd.fwd5, null);
  assert.equal(context.stockRadarForwardReturns_(cs, '2026-10-30', [1]).fwd1, null);
});

test('spearman handles ties and degenerate input', () => {
  assert.equal(context.srSpearman_([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(context.srSpearman_([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(context.srSpearman_([1, 2], [1, 2]), null);
  assert.equal(context.srSpearman_([1, 1, 1], [1, 2, 3]), null);
});

test('backtest core produces curves, IC and buckets on synthetic data', () => {
  const series = { UP: candles(420, 0.002), DOWN: candles(420, -0.001), FLAT: candles(420, 0.0002) };
  const bm = candles(420, 0.0005);
  const result = context.runStockRadarBacktestCore_(series, bm, 'US', { step: 5, roundTripCost: 0.001 });
  assert.ok(result.periods > 20, `periods ${result.periods}`);
  assert.equal(result.curve.length, result.periods);
  assert.ok(result.meanIC > 0.5, `meanIC ${result.meanIC}`);
  assert.ok(result.strategy.totalReturn > result.equalWeight.totalReturn);
  assert.equal(result.buckets.length, 4);
  assert.equal(result.buckets.reduce((s, b) => s + b.n, 0), result.samples);
});

test('normalizes Claude sentiment entries', () => {
  const ok = context.normalizeStockSentimentEntry_({
    symbol: '2330.tw', sentiment: 0.5, confidence: 0.8, summary: ' 法說會  上修 ',
    catalysts: ['AI 需求', ''], riskEvents: [{ type: 'earnings', date: '2026-11-01', note: '財報' }, { type: 'bogus' }],
    earningsSurprise: 'beat', sources: [{ title: 'A', url: 'https://a.com/x' }, { url: 'http://insecure' }, { url: 'javascript:alert(1)' }],
  }, {});
  assert.equal(ok.entry.symbol, '2330');
  assert.equal(ok.entry.summary, '法說會 上修');
  assert.deepEqual([...ok.entry.catalysts], ['AI 需求']);
  assert.equal(ok.entry.riskEvents.length, 1);
  assert.equal(ok.entry.sources.length, 1);
  assert.equal(ok.entry.confidence, 0.8);

  const noSource = context.normalizeStockSentimentEntry_({ symbol: 'AAPL', sentiment: 0.5, confidence: 0.9 }, {});
  assert.equal(noSource.entry.confidence, 0);
  assert.ok(noSource.warning);
  assert.ok(context.normalizeStockSentimentEntry_({ sentiment: 2, confidence: 0.5 }, {}).error);
  assert.ok(context.normalizeStockSentimentEntry_({ sentiment: 0, confidence: -1 }, {}).error);
  const mv = context.normalizeStockSentimentEntry_({ sentiment: -0.6, confidence: 0.7, events: ['FOMC'], sources: [{ url: 'https://x.com' }] }, { market: true });
  assert.deepEqual([...mv.entry.events], ['FOMC']);
});
