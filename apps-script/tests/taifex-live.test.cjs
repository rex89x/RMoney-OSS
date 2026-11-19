const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({ console, Date, Error, isFinite, JSON, Math, Number, String, Array, Object, Infinity, RegExp });
for (const file of ['TaifexStrategy.gs', 'TaifexLive.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
}
const c = context;
const plain = (x) => JSON.parse(JSON.stringify(x));
const config = c.tfNormalizeConfig_({ product: 'MTX', initialCapital: 2000000, riskPerTradePct: 1, maxContracts: 10 });

function account(extra = {}) {
  const s = c.tfNewAccount_(config, '2026-11-09');
  s.lastClose = 20000;
  return Object.assign(s, extra);
}

function longPos(extra = {}) {
  return { side: 'long', contracts: 2, entryPrice: 19800, entryDate: '2026-11-02', stop: 19700, extreme: 20000, entryCost: 200, rollCost: 0, bars: 5, source: 'auto', ...extra };
}

test('params override tunable rules only and keep exit below entry', () => {
  const p = c.tfParams_({ entry: 0.25, stopAtr: 3, minCoverage: 0.9 });
  assert.equal(p.entry, 0.25);
  assert.equal(p.stopAtr, 3);
  assert.equal(p.trailAtr, 3);
  assert.equal(p.minCoverage, undefined);
  assert.equal(c.tfParams_({ entry: 0.1, exit: 0.2 }).exit, 0);
  assert.deepEqual(plain(c.tfParams_(null)), plain(c.tfParams_({})));
});

test('order validFrom: before 08:45 on a weekday → today, otherwise next weekday', () => {
  assert.equal(c.tfOrderValidFrom_('2026-11-10', '08:30'), '2026-11-10');
  assert.equal(c.tfOrderValidFrom_('2026-11-10', '08:45'), '2026-11-11');
  assert.equal(c.tfOrderValidFrom_('2026-11-10', '18:00'), '2026-11-11');
  assert.equal(c.tfOrderValidFrom_('2026-11-13', '18:00'), '2026-11-16');
  assert.equal(c.tfOrderValidFrom_('2026-11-14', '07:00'), '2026-11-16');
  assert.equal(c.tfInDaySession_('2026-11-10', '09:00'), true);
  assert.equal(c.tfInDaySession_('2026-11-10', '13:50'), false);
  assert.equal(c.tfInDaySession_('2026-11-14', '09:00'), false);
});

test('daily step does not fill an order before its validFrom (no look-ahead)', () => {
  const s = account({ pending: { target: 'long', contracts: 1, stopPoints: 300, source: 'manual', validFrom: '2026-11-11' } });
  const bar = { date: '2026-11-10', open: 20000, high: 20100, low: 19900, close: 20050 };
  const r = c.stepTaifexAccount_(s, bar, { gap: 0, atr: 100, config });
  assert.equal(r.state.position, null);
  assert.equal(r.state.pending.target, 'long');
  const next = c.stepTaifexAccount_(r.state, { ...bar, date: '2026-11-11', open: 20060 }, { gap: 0, atr: 100, config });
  assert.equal(next.state.position.entryPrice, 20060);
});

test('daily step fills a same-day live-only order at the close and skips that day stop check', () => {
  const s = account({ pending: { target: 'long', contracts: 1, stopPoints: 50, source: 'manual', validFrom: '2026-11-10', liveOnly: true } });
  const bar = { date: '2026-11-10', open: 20000, high: 20100, low: 19500, close: 20050 };
  const r = c.stepTaifexAccount_(s, bar, { gap: 0, atr: 100, config });
  assert.equal(r.state.position.entryPrice, 20050);
  assert.equal(r.trades.length, 0);
});

test('intraday: fills auto order at the open, then marks live P&L without touching equity', () => {
  const s = account({ pending: { target: 'long', contracts: 2, stopPoints: 400, source: 'auto', validFrom: '2026-11-10' } });
  const r = c.stepTaifexIntraday_(s, { date: '2026-11-10', time: '09:05', last: 20100, open: 20020, high: 20120, low: 20000 }, { config, atr: 200, gap: 0 });
  assert.equal(r.state.position.entryPrice, 20020);
  assert.equal(r.state.position.entryMode, 'open');
  assert.equal(r.state.pending, null);
  assert.equal(r.state.live.unrealized, 2 * 50 * 80);
  assert.equal(r.state.lastClose, 20020);
  assert.equal(r.events[0].type, 'fill');
  // 收盤 step：不再重複成交、從開盤價 mark 到收盤
  const d = c.stepTaifexAccount_(r.state, { date: '2026-11-10', open: 20020, high: 20150, low: 19990, close: 20140 }, { gap: 0, atr: 200, config, skipGap: true });
  assert.equal(d.state.position.contracts, 2);
  assert.equal(d.state.equity, Math.round(r.state.equity + 2 * 50 * 120));
});

test('intraday manual order placed during session fills at the live price', () => {
  const s = account({ pending: { target: 'short', contracts: 1, stopPoints: 300, source: 'manual', validFrom: '2026-11-10', liveOnly: true } });
  const r = c.stepTaifexIntraday_(s, { date: '2026-11-10', time: '10:30', last: 19950, open: 20020, high: 20120, low: 19900 }, { config, atr: 200, gap: 0 });
  assert.equal(r.state.position.entryPrice, 19950);
  assert.equal(r.state.position.entryMode, 'live');
  // 當天稍早的高點 20120 不會觸發停損（停損 20250），之後只看最新價
  assert.equal(r.trades.length, 0);
});

test('intraday stop: exits at stop price, or at the open when gapping through', () => {
  const s = account({ position: longPos() });
  const hit = c.stepTaifexIntraday_(s, { date: '2026-11-10', time: '10:00', last: 19690, open: 19900, high: 19950, low: 19650 }, { config, atr: 150, gap: 0 });
  assert.equal(hit.trades.length, 1);
  assert.equal(hit.trades[0].exitPrice, 19700);
  assert.equal(hit.trades[0].intraday, true);
  assert.equal(hit.state.position, null);
  assert.equal(hit.state.lastClose, 19700);
  const gap = c.stepTaifexIntraday_(s, { date: '2026-11-10', time: '08:50', last: 19600, open: 19600, high: 19620, low: 19580 }, { config, atr: 150, gap: 0 });
  assert.equal(gap.trades[0].exitPrice, 19600);
  // 收盤 step：部位已經沒了，不會重複出場
  const d = c.stepTaifexAccount_(gap.state, { date: '2026-11-10', open: 19600, high: 19700, low: 19500, close: 19650 }, { gap: 0, atr: 150, config, skipGap: true });
  assert.equal(d.trades.length, 0);
  assert.equal(d.state.equity, gap.state.equity);
});

test('intraday near-stop alert fires once per day', () => {
  const s = account({ position: longPos() });
  const q = { date: '2026-11-10', time: '10:00', last: 19760, open: 19900, high: 19950, low: 19740 };
  const a = c.stepTaifexIntraday_(s, q, { config, atr: 150, gap: 0 });
  assert.ok(a.events.some((e) => e.type === 'near_stop'));
  const b = c.stepTaifexIntraday_(a.state, { ...q, time: '10:05' }, { config, atr: 150, gap: 0 });
  assert.equal(b.events.some((e) => e.type === 'near_stop'), false);
});

test('intraday roll shifts once; daily step skips the gap afterwards', () => {
  const s = account({ position: longPos() });
  const r = c.stepTaifexIntraday_(s, { date: '2026-11-18', time: '09:00', last: 20060, open: 20050, high: 20070, low: 20040 }, { config, atr: 300, gap: 50 });
  assert.equal(r.state.position.entryPrice, 19850);
  assert.equal(r.state.intraday.gapApplied, true);
  const again = c.stepTaifexIntraday_(r.state, { date: '2026-11-18', time: '09:05', last: 20060, open: 20050, high: 20070, low: 20040 }, { config, atr: 300, gap: 50 });
  assert.equal(again.state.position.entryPrice, 19850);
  const d = c.stepTaifexAccount_(again.state, { date: '2026-11-18', open: 20050, high: 20100, low: 20000, close: 20080 }, { gap: 50, atr: 300, config, skipGap: true });
  assert.equal(d.state.position.entryPrice, 19850);
});

test('order ticket: open long uses a marketable limit with buffer and a protective stop', () => {
  const t = c.tfBuildOrderTicket_({
    pending: { target: 'long', contracts: 2, stopPoints: 400, validFrom: '2026-11-11' },
    position: null, atr: 200, refPrice: 20000, equity: 2000000, config,
  });
  assert.equal(t.kind, 'open');
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].side, 'buy');
  assert.equal(t.steps[0].orderType, 'LMT');
  assert.equal(t.steps[0].price, 20050);
  assert.equal(t.stopOrder.price, 19600);
  assert.equal(t.stopOrder.side, 'sell');
  assert.equal(t.riskTWD, 400 * 50 * 2);
  assert.equal(t.riskPct, 2);
  assert.equal(t.marginTWD, 2 * 87500);
});

test('order ticket: reverse closes first with MWP, then opens; flat closes only', () => {
  const pos = { side: 'long', contracts: 3 };
  const rev = c.tfBuildOrderTicket_({ pending: { target: 'short', contracts: 2, stopPoints: 300 }, position: pos, atr: 200, refPrice: 20000, equity: 1e6, config });
  assert.equal(rev.kind, 'reverse');
  assert.deepEqual(plain(rev.steps.map((s) => [s.action, s.side, s.qty, s.orderType])), [['close', 'sell', 3, 'MWP'], ['open', 'sell', 2, 'LMT']]);
  assert.equal(rev.steps[1].price, 19950);
  assert.equal(rev.stopOrder.price, 20300);
  const flat = c.tfBuildOrderTicket_({ pending: { target: 'flat', contracts: 0 }, position: pos, atr: 200, refPrice: 20000, equity: 1e6, config });
  assert.equal(flat.kind, 'close');
  assert.equal(flat.steps.length, 1);
  assert.equal(flat.stopOrder, null);
  const reduce = c.tfBuildOrderTicket_({ pending: { target: 'long', contracts: 1 }, position: pos, atr: 200, refPrice: 20000, equity: 1e6, config });
  assert.deepEqual(plain(reduce.steps.map((s) => [s.action, s.side, s.qty])), [['reduce', 'sell', 2]]);
  assert.equal(c.tfBuildOrderTicket_({ pending: null, config }).kind, 'none');
});

test('spearman rank correlation', () => {
  assert.equal(c.tfSpearman_([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(c.tfSpearman_([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(c.tfSpearman_([1, 2], [1, 2]), null);
});

test('objective rejects excessive drawdown and too few trades', () => {
  assert.equal(c.tfObjective_({ cagrPct: 30, maxDrawdownPct: 25, trades: 10 }, 20, 5), -Infinity);
  assert.equal(c.tfObjective_({ cagrPct: 30, maxDrawdownPct: 10, trades: 3 }, 20, 5), -Infinity);
  assert.equal(c.tfObjective_({ cagrPct: 30, maxDrawdownPct: 10, trades: 10 }, 20, 5), 30);
});

test('walk-forward optimizer selects on in-sample and reports out-of-sample vs baseline', () => {
  const golden = require('./fixtures/taifex-golden.json');
  const bars = golden.input.bars;
  const res = c.tfOptimizeTaifex_(bars, { product: 'TMF', initialCapital: 2000000, riskPerTradePct: 1, maxDrawdownPct: 25 }, {
    grid: { entry: [0.25, 0.35], stopAtr: [2, 3], trailAtr: [3] },
  });
  assert.equal(res.variants.length, 4);
  assert.ok(res.trainTo < res.testFrom);
  assert.ok(res.baseline.outOfSample);
  if (res.best) {
    // 被選中的是樣本內分數最高的
    const eligible = res.variants.filter((v) => v.eligible);
    assert.deepEqual(plain(res.best.params), plain(eligible[0].params));
  }
  assert.equal(typeof res.adopt, 'boolean');
  assert.ok(res.suggestedRiskPct === null || (res.suggestedRiskPct >= 0.25 && res.suggestedRiskPct <= 3));
  assert.equal(c.tfOptimizeTaifex_(bars.slice(0, 100), {}), null);
});

test('backtest window honors start/end indices', () => {
  const bars = require('./fixtures/taifex-golden.json').input.bars;
  const r = c.runTaifexBacktest_(bars, { product: 'TMF' }, { startIndex: 200, endIndex: 300 });
  assert.equal(r.curve.length, 100);
  assert.equal(r.from, bars[200].date);
  assert.equal(r.to, bars[299].date);
});

test('quote parsers: Fugle fields and Yahoo spot + basis estimate', () => {
  const f = c.tfParseFugleQuote_({ symbol: 'TXFL6', lastPrice: 27100, openPrice: 27000, highPrice: 27150, lowPrice: 26980, previousClose: 26950 });
  assert.equal(f.last, 27100);
  assert.equal(f.estimated, false);
  assert.equal(c.tfParseFugleQuote_({ symbol: 'x' }), null);
  const y = c.tfParseYahooSpot_({ chart: { result: [{ meta: { regularMarketPrice: 27050, chartPreviousClose: 27000 }, indicators: { quote: [{ open: [27010, null, 27040], high: [27060, 27080], low: [26990, 27000] }] } }] } }, 26950);
  assert.equal(y.basis, -50);
  assert.equal(y.last, 27000);
  assert.equal(y.open, 26960);
  assert.equal(y.high, 27030);
  assert.equal(y.low, 26940);
  assert.equal(y.estimated, true);
  assert.equal(c.tfParseYahooSpot_({}, 1), null);
  assert.equal(c.tfFugleSymbol_('202612'), 'TXFL6');
  assert.equal(c.tfFugleSymbol_('202701'), 'TXFA7');
  assert.equal(c.tfFugleSymbol_('bad'), null);
});
