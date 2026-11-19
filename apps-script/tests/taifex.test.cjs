const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({ console, Date, Error, isFinite, JSON, Math, Number, String, Array, Object, Infinity, RegExp });
for (const file of ['TaifexStrategy.gs', 'TaifexData.gs', 'TaifexIngest.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
}
const c = context;

function dateAt(i) {
  return new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
}

/** 產生 n 根日 K：固定漂移 + 交替擾動，單一契約 */
function bars(n, drift, { start = 20000, wiggle = 0.004, contract = '209912', extra = () => ({}) } = {}) {
  const out = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = close * (1 + drift + (i % 2 === 0 ? wiggle : -wiggle));
    out.push({
      date: dateAt(i), contract, open, close,
      high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998,
      ...extra(i),
    });
  }
  return out;
}

const config = c.tfNormalizeConfig_({ product: 'MTX', initialCapital: 2000000, riskPerTradePct: 1, maxContracts: 10 });

test('third Wednesday and front contract selection roll on settlement day', () => {
  assert.equal(c.tfThirdWednesday_(2026, 11), '2026-11-18');
  assert.equal(c.tfThirdWednesday_(2026, 12), '2026-12-16');
  assert.equal(c.tfPickFrontContracts_('2026-11-17', ['202612', '202611', '202701']).front, '202611');
  // 結算日當天近月已換到次月
  const onExpiry = c.tfPickFrontContracts_('2026-11-18', ['202612', '202611', '202701']);
  assert.equal(onExpiry.front, '202612');
  assert.equal(onExpiry.next, '202701');
  assert.equal(c.tfNextWeekday_('2026-11-13'), '2026-11-16');
});

test('config normalization clamps out-of-range values and expands product spec', () => {
  const cfg = c.tfNormalizeConfig_({ product: 'XX', riskPerTradePct: 99, maxContracts: 0, mode: 'manual', allowShort: false });
  assert.equal(cfg.product, 'TMF');
  assert.equal(cfg.pointValue, 10);
  assert.equal(cfg.riskPerTradePct, 1.5);
  assert.equal(cfg.maxContracts, 5);
  assert.equal(cfg.mode, 'manual');
  assert.equal(cfg.allowShort, false);
  assert.equal(cfg.commissionPerSide, 15);
});

test('trade cost includes commission, slippage and futures tax', () => {
  // MTX: 30 + 1×50 + 20000×50×0.00002 = 100 per contract
  assert.equal(c.tfTradeCost_(20000, 2, config), 200);
});

test('back adjustment keeps latest segment raw and records roll gaps', () => {
  const b = [
    { date: '2026-11-16', contract: '202611', open: 100, high: 101, low: 99, close: 100, nextContract: '202612', nextClose: 110 },
    { date: '2026-11-17', contract: '202611', open: 100, high: 102, low: 99, close: 101, nextContract: '202612', nextClose: 111 },
    { date: '2026-11-18', contract: '202612', open: 111, high: 113, low: 110, close: 112 },
  ];
  const { adj, gaps } = c.tfBackAdjust_(b);
  assert.equal(gaps[2], 10);
  assert.equal(adj[2].close, 112);
  assert.equal(adj[1].close, 111);
  assert.equal(adj[0].close, 110);
});

test('indicators: EMA seeds with SMA, ATR and ADX are positive in trend', () => {
  const ema = c.tfEma_([1, 2, 3, 4, 5], 3);
  assert.equal(ema[1], null);
  assert.equal(ema[2], 2);
  assert.equal(ema[3], 3);
  const series = c.tfPrepareSeries_(bars(200, 0.003));
  assert.ok(series.atr20[199] > 0);
  assert.ok(series.adx14[199] > 18, `adx ${series.adx14[199]}`);
});

test('uptrend produces strong long composite; downtrend strong short', () => {
  const up = c.tfPrepareSeries_(bars(200, 0.003));
  const sUp = c.tfSignalAt_(up, 199, {});
  assert.ok(sUp.factors.trend.score > 0.5, `trend ${sUp.factors.trend.score}`);
  assert.ok(sUp.factors.breakout.score > 0.5);
  assert.ok(sUp.factors.tsmom.score > 0.5);
  assert.equal(sUp.factors.foreignFlow.score, null);
  assert.ok(sUp.composite >= 0.35, `composite ${sUp.composite}`);
  assert.equal(sUp.coverage, 0.7);

  const down = c.tfPrepareSeries_(bars(200, -0.003));
  const sDown = c.tfSignalAt_(down, 199, {});
  assert.ok(sDown.composite <= -0.35, `composite ${sDown.composite}`);
  // 顯示用 EMA 換回真實價格
  assert.ok(Math.abs(sDown.indicators.ema20 - up.ema20[199]) > 0);
});

test('foreign flow and PCR z-scores contribute when data exists', () => {
  const b = bars(200, 0.0, { wiggle: 0.006, extra: (i) => ({ foreignNetOi: i * 100, pcrOi: 100 + (i % 10) }) });
  const s = c.tfSignalAt_(c.tfPrepareSeries_(b), 199, {});
  assert.ok(s.factors.foreignFlow.score > 0, `flow ${s.factors.foreignFlow.score}`);
  assert.notEqual(s.factors.pcr.score, null);
  assert.equal(s.coverage, 1);
});

test('chop filter dampens composite when ADX is low', () => {
  const series = c.tfPrepareSeries_(bars(200, 0.003));
  const trending = c.tfSignalAt_(series, 199, {});
  series.adx14[199] = 12;
  const chop = c.tfSignalAt_(series, 199, {});
  assert.equal(chop.trending, false);
  assert.ok(Math.abs(chop.composite - trending.quantScore * 0.6) < 0.002, `${chop.composite} vs ${trending.quantScore}`);
  assert.ok(chop.reasons.some((r) => r.includes('盤整')));
});

test('sentiment adds at most ±0.2 and requires confidence', () => {
  assert.equal(c.tfSentimentAdj_({ overall: { sentiment: 1, confidence: 1 } }), 0.2);
  assert.equal(c.tfSentimentAdj_({ overall: { sentiment: -1, confidence: 0.5 } }), -0.1);
  assert.equal(c.tfSentimentAdj_({ overall: { sentiment: 1, confidence: 0 } }), 0);
  assert.equal(c.tfSentimentAdj_(null), 0);
});

test('event risk only counts high-importance events on the next weekday', () => {
  const sentiment = { events: [
    { type: 'fomc', importance: 'high', date: '2026-11-16' },
    { type: 'settlement', importance: 'high', date: '2026-11-16' },
    { type: 'cpi', importance: 'medium', date: '2026-11-16' },
  ] };
  const friday = c.tfEventRisk_(sentiment, '2026-11-13');
  assert.equal(friday.risk, true);
  assert.equal(friday.events.length, 1);
  assert.equal(c.tfEventRisk_(sentiment, '2026-11-16').risk, false);
});

test('decision rules: entry, hysteresis, reverse, blockers and halt', () => {
  const base = { coverage: 1, trendScore: 0.5, allowShort: true };
  assert.equal(c.tfDecideTarget_({ ...base, currentSide: 'flat', composite: 0.4 }).desired, 'long');
  assert.equal(c.tfDecideTarget_({ ...base, currentSide: 'flat', composite: 0.3 }).desired, 'flat');
  // 做空需要趨勢同向
  assert.equal(c.tfDecideTarget_({ ...base, currentSide: 'flat', composite: -0.4 }).desired, 'flat');
  assert.equal(c.tfDecideTarget_({ ...base, trendScore: -0.2, currentSide: 'flat', composite: -0.4 }).desired, 'short');
  assert.equal(c.tfDecideTarget_({ ...base, trendScore: -0.2, allowShort: false, currentSide: 'flat', composite: -0.4 }).desired, 'flat');
  // 遲滯：多單在 0.05 以上續抱
  assert.equal(c.tfDecideTarget_({ ...base, currentSide: 'long', composite: 0.1 }).desired, 'long');
  assert.equal(c.tfDecideTarget_({ ...base, currentSide: 'long', composite: 0.05 }).desired, 'flat');
  assert.equal(c.tfDecideTarget_({ ...base, currentSide: 'long', composite: -0.5 }).desired, 'short');
  assert.equal(c.tfDecideTarget_({ ...base, currentSide: 'long', composite: -0.5, allowShort: false }).desired, 'flat');
  // 事件風險：不新開，但既有部位續抱
  const blocked = c.tfDecideTarget_({ ...base, currentSide: 'flat', composite: 0.6, eventRisk: true });
  assert.equal(blocked.desired, 'flat');
  assert.ok(blocked.reasons[0].includes('重大事件'));
  assert.equal(c.tfDecideTarget_({ ...base, currentSide: 'long', composite: 0.6, eventRisk: true }).desired, 'long');
  assert.equal(c.tfDecideTarget_({ ...base, currentSide: 'flat', composite: 0.6, coverage: 0.3 }).desired, 'flat');
  assert.equal(c.tfDecideTarget_({ ...base, currentSide: 'long', composite: 0.9, halted: true }).desired, 'flat');
});

test('position sizing respects risk budget, margin and max contracts', () => {
  // 1% × 2,000,000 = 20,000；停損 2×200=400 點 × 50 = 20,000 → 1 口
  assert.equal(c.tfPositionSize_(2000000, 200, config).contracts, 1);
  // 停損 40 點 → 風險可做 10 口，但保證金 40% × 2,000,000 / 87,500 只夠 9 口
  assert.equal(c.tfPositionSize_(2000000, 20, config).contracts, 9);
  assert.equal(c.tfPositionSize_(2000000, 20, config).limitedBy, 'margin');
  const capped = c.tfNormalizeConfig_({ product: 'MTX', initialCapital: 2000000, riskPerTradePct: 1, maxContracts: 3 });
  assert.equal(c.tfPositionSize_(2000000, 20, capped).contracts, 3);
  assert.equal(c.tfPositionSize_(2000000, 20, capped).limitedBy, 'maxContracts');
  assert.equal(c.tfPositionSize_(100000, 200, config).contracts, 0);
  const tight = c.tfNormalizeConfig_({ product: 'TX', initialCapital: 1000000, riskPerTradePct: 5, maxContracts: 50 });
  // 保證金 40% × 1,000,000 / 350,000 = 1 口
  const sized = c.tfPositionSize_(1000000, 10, tight);
  assert.equal(sized.contracts, 1);
  assert.equal(sized.limitedBy, 'margin');
});

function bar(date, open, high, low, close, contract = '209912') {
  return { date, contract, open, high, low, close };
}

test('account fills pending at open, marks to close, trails stop', () => {
  let state = c.tfNewAccount_(config, '2026-01-01');
  state.lastClose = 20000;
  state.pending = { target: 'long', contracts: 2, stopPoints: 400, source: 'auto' };
  let r = c.stepTaifexAccount_(state, bar('2026-01-02', 20100, 20300, 20050, 20200), { gap: 0, atr: 200, config });
  state = r.state;
  assert.equal(state.position.side, 'long');
  assert.equal(state.position.entryPrice, 20100);
  assert.equal(state.position.stop, 19700);
  // 2 口 × 50 × (20200 − 20100) − 進場成本 2 × (30 + 50 + 20.1) = 10000 − 200
  assert.equal(state.equity, 2000000 + 10000 - 200);
  r = c.stepTaifexAccount_(state, bar('2026-01-03', 20200, 21000, 20150, 21000), { gap: 0, atr: 200, config });
  state = r.state;
  // 移動停損：21000 − 3 × 200 = 20400
  assert.equal(state.position.stop, 20400);
  assert.equal(r.trades.length, 0);
});

test('stop exits at stop price, or at open when gapping through', () => {
  const base = c.tfNewAccount_(config, '2026-01-01');
  base.lastClose = 20000;
  base.position = { side: 'long', contracts: 1, entryPrice: 20000, entryDate: '2026-01-01', stop: 19800, extreme: 20000, entryCost: 100, rollCost: 0, bars: 1, source: 'auto' };
  const hit = c.stepTaifexAccount_(base, bar('2026-01-02', 19950, 19960, 19700, 19750), { gap: 0, atr: 100, config });
  assert.equal(hit.trades.length, 1);
  assert.equal(hit.trades[0].exitPrice, 19800);
  assert.equal(hit.trades[0].exitReason, 'stop');
  assert.equal(hit.state.position, null);

  const gapDown = c.stepTaifexAccount_(base, bar('2026-01-02', 19600, 19700, 19500, 19650), { gap: 0, atr: 100, config });
  assert.equal(gapDown.trades[0].exitPrice, 19600);
  // (19600 − 20000) × 50 = −20000，加進出場成本
  assert.ok(gapDown.trades[0].netPnl < -20000);
  assert.equal(gapDown.state.equity, 2000000 - 20000 - c.tfTradeCost_(19600, 1, config));
});

test('roll shifts entry/stop by the gap and charges two-sided cost without P&L jump', () => {
  const s = c.tfNewAccount_(config, '2026-11-17');
  s.lastClose = 20000;
  s.position = { side: 'long', contracts: 1, entryPrice: 19900, entryDate: '2026-11-10', stop: 19500, extreme: 20000, entryCost: 100, rollCost: 0, bars: 5, source: 'auto' };
  // ATR 大到移動停損不會超過平移後的停損，方便單獨驗證平移
  const r = c.stepTaifexAccount_(s, bar('2026-11-18', 20050, 20100, 20000, 20050, '202612'), { gap: 50, atr: 300, config });
  assert.equal(r.state.position.entryPrice, 19950);
  assert.equal(r.state.position.stop, 19550);
  assert.equal(r.events[0].type, 'roll');
  // 次月 20050 收在前一天換月後價格 20050 → 價差 0，只扣換月成本
  assert.equal(r.state.equity, 2000000 - r.events[0].cost);
});

test('reverse order closes long and opens short at the same open', () => {
  const s = c.tfNewAccount_(config, '2026-01-01');
  s.lastClose = 20000;
  s.position = { side: 'long', contracts: 1, entryPrice: 19000, entryDate: '2025-12-01', stop: 18000, extreme: 20000, entryCost: 100, rollCost: 0, bars: 10, source: 'auto' };
  s.pending = { target: 'short', contracts: 2, stopPoints: 300, source: 'auto' };
  const r = c.stepTaifexAccount_(s, bar('2026-01-02', 20100, 20150, 19900, 19950), { gap: 0, atr: 200, config });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].exitReason, 'reverse');
  assert.equal(r.trades[0].pnlPoints, 1100);
  assert.equal(r.state.position.side, 'short');
  assert.equal(r.state.position.contracts, 2);
  assert.equal(r.state.position.stop, 20400);
  assert.equal(r.state.tradeCount, 1);
  assert.equal(r.state.winCount, 1);
});

test('manual partial reduce realizes a partial trade', () => {
  const s = c.tfNewAccount_(config, '2026-01-01');
  s.lastClose = 20000;
  s.position = { side: 'long', contracts: 3, entryPrice: 19800, entryDate: '2025-12-01', stop: 19000, extreme: 20000, entryCost: 300, rollCost: 0, bars: 3, source: 'auto' };
  s.pending = { target: 'long', contracts: 1, source: 'manual' };
  const r = c.stepTaifexAccount_(s, bar('2026-01-02', 20000, 20100, 19950, 20000), { gap: 0, atr: 100, config });
  assert.equal(r.trades[0].contracts, 2);
  assert.equal(r.trades[0].exitReason, 'manual');
  assert.equal(r.state.position.contracts, 1);
});

test('drawdown breaker halts the account and plans a flat order', () => {
  const s = c.tfNewAccount_(c.tfNormalizeConfig_({ product: 'TX', initialCapital: 1000000, maxDrawdownPct: 10 }), '2026-01-01');
  const cfg = c.tfNormalizeConfig_({ product: 'TX', initialCapital: 1000000, maxDrawdownPct: 10 });
  s.lastClose = 20000;
  s.position = { side: 'long', contracts: 1, entryPrice: 20000, entryDate: '2025-12-01', stop: 15000, extreme: 20000, entryCost: 100, rollCost: 0, bars: 3, source: 'auto' };
  const r = c.stepTaifexAccount_(s, bar('2026-01-02', 19600, 19600, 19400, 19450), { gap: 0, atr: 100, config: cfg });
  assert.equal(r.state.halted, true);
  assert.ok(r.events.some((e) => e.type === 'halt'));
  const signal = { date: '2026-01-02', composite: 0.8, coverage: 1, factors: { trend: { score: 0.5 } }, indicators: { atr20: 100 } };
  const plan = c.tfPlanNextOrder_(r.state, signal, { config: cfg });
  assert.equal(plan.pending.target, 'flat');
});

test('plan reports zero-contract sizing instead of opening', () => {
  const small = c.tfNormalizeConfig_({ product: 'TX', initialCapital: 100000 });
  const s = c.tfNewAccount_(small, '2026-01-01');
  const signal = { date: '2026-01-02', composite: 0.8, coverage: 1, factors: { trend: { score: 0.5 } }, indicators: { atr20: 300 } };
  const plan = c.tfPlanNextOrder_(s, signal, { config: small });
  assert.equal(plan.pending, null);
  assert.ok(plan.decision.reasons.some((r) => r.includes('0 口')));
});

test('backtest makes money in a clean trend and reports consistent metrics', () => {
  const up = bars(400, 0.0025, { wiggle: 0.003 });
  const result = c.runTaifexBacktest_(up, { product: 'MTX', initialCapital: 2000000, riskPerTradePct: 1, maxContracts: 10 });
  assert.ok(result.metrics.totalReturnPct > 0, `return ${result.metrics.totalReturnPct}`);
  assert.ok(result.metrics.exposurePct > 50);
  assert.equal(result.curve.length, 340);
  const bh = c.runTaifexBuyHold_(up, 2000000);
  assert.ok(bh.metrics.totalReturnPct > 0);
  assert.equal(c.tfDownsample_(result.curve, 50).length, 50);
  assert.equal(c.runTaifexBacktest_(bars(50, 0.001), {}), null);
});

test('futures CSV parser keeps TX monthly regular-session rows only', () => {
  const csv = [
    '交易日期,契約,到期月份(週別),開盤價,最高價,最低價,收盤價,漲跌價,漲跌%,成交量,結算價,未沖銷契約數,最後最佳買價,最後最佳賣價,歷史最高價,歷史最低價,是否因訊息面暫停交易,交易時段,價差對單式委託成交量',
    '2026/11/09,TX,202611     ,23000,23200,22900,23100,100,0.43%,80000,23105,90000,23099,23101,24000,18000,,一般,100',
    '2026/11/09,TX,202612     ,23050,23260,22950,23150,100,0.43%,5000,23155,20000,-,-,24000,18000,,一般,100',
    '2026/11/09,TX,202611W2   ,23000,23200,22900,23090,100,0.43%,3000,-,1000,-,-,-,-,,一般,0',
    '2026/11/09,TX,202611/202612,50,50,50,50,0,0,10,-,-,-,-,-,-,,一般,0',
    '2026/11/09,TX,202611     ,23100,23150,23050,23120,20,0.1%,30000,-,-,-,-,-,-,,盤後,0',
    '2026/11/09,MTX,202611    ,23000,23200,22900,23100,100,0.43%,80000,23105,90000,-,-,-,-,,一般,0',
  ].join('\r\n');
  const parsed = c.tfParseFuturesCsv_(csv);
  assert.equal(parsed['2026-11-09'].length, 2);
  const daily = c.tfBuildDailyBars_(parsed);
  assert.equal(daily.length, 1);
  assert.equal(daily[0].contract, '202611');
  assert.equal(daily[0].close, 23100);
  assert.equal(daily[0].oi, 90000);
  assert.equal(daily[0].nextContract, '202612');
  assert.equal(daily[0].nextClose, 23150);
});

test('institutional CSV parser maps foreign / trust / dealer net OI for TX only', () => {
  const csv = [
    '日期,商品名稱,身份別,多方交易口數,多方交易契約金額(千元),空方交易口數,空方交易契約金額(千元),多空交易口數淨額,多空交易契約金額淨額(千元),多方未平倉口數,多方未平倉契約金額(千元),空方未平倉口數,空方未平倉契約金額(千元),多空未平倉口數淨額,多空未平倉契約金額淨額(千元)',
    '2026/11/09,臺股期貨,自營商,1,1,1,1,0,0,5000,1,6000,1,"-1,000",1',
    '2026/11/09,臺股期貨,投信,1,1,1,1,0,0,30000,1,5000,1,25000,1',
    '2026/11/09,臺股期貨,外資,1,1,1,1,0,0,20000,1,40000,1,-20000,1',
    '2026/11/09,小型臺指期貨,外資,1,1,1,1,0,0,1,1,1,1,999,1',
  ].join('\n');
  const parsed = c.tfParseInstitutionalCsv_(csv);
  assert.deepEqual({ ...parsed['2026-11-09'] }, { dealerNetOi: -1000, trustNetOi: 25000, foreignNetOi: -20000 });
});

test('PCR CSV parser reads volume and open-interest ratios', () => {
  const csv = '日期,賣權成交量,買權成交量,買賣權成交量比率%,賣權未平倉量,買權未平倉量,買賣權未平倉量比率%\n2026/11/09,100,120,83.33,200,180,111.11';
  const parsed = c.tfParsePcrCsv_(csv);
  assert.equal(parsed['2026-11-09'].pcrVol, 83.33);
  assert.equal(parsed['2026-11-09'].pcrOi, 111.11);
  assert.deepEqual({ ...c.tfParsePcrCsv_('<html>error</html>') }, {});
});

test('month chunks split ranges at month ends', () => {
  const chunks = c.tfMonthChunks_('2026-01-15', '2026-03-02');
  assert.deepEqual(JSON.parse(JSON.stringify(chunks)), [
    { from: '2026-01-15', to: '2026-01-31' },
    { from: '2026-02-01', to: '2026-02-28' },
    { from: '2026-03-01', to: '2026-03-02' },
  ]);
});

test('sentiment ingest normalizer validates ranges, sources and events', () => {
  const ok = c.normalizeTaifexSentiment_({
    overall: { sentiment: 0.4, confidence: 0.7, summary: '美股大漲', sources: [{ title: 'x', url: 'https://example.com/a' }] },
    drivers: [{ type: 'us_market', direction: 1, note: '費半 +3%' }, { type: 'bogus', direction: 1 }],
    events: [{ type: 'fomc', date: '2026-11-18', importance: 'high', note: 'FOMC' }, { type: 'fomc', date: 'bad', importance: 'high' }],
    indicators: { vix: 18.2, spxChangePct: 1.2, tsmAdrChangePct: 99 },
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.entry.overall.confidence, 0.7);
  assert.equal(ok.entry.drivers.length, 1);
  assert.equal(ok.entry.events.length, 1);
  assert.equal(ok.entry.indicators.vix, 18.2);
  assert.equal(ok.entry.indicators.tsmAdrChangePct, null);

  const noSource = c.normalizeTaifexSentiment_({ overall: { sentiment: 0.4, confidence: 0.7, sources: [{ url: 'http://x' }] } });
  assert.equal(noSource.entry.overall.confidence, 0);
  assert.ok(noSource.warning);
  assert.ok(c.normalizeTaifexSentiment_({ overall: { sentiment: 2, confidence: 0.5 } }).error);
  assert.ok(c.normalizeTaifexSentiment_({}).error);
});

test('pre-open veto cancels only new exposure on high event or strong opposite sentiment', () => {
  const pendingLong = { target: 'long', contracts: 1, source: 'auto' };
  assert.equal(c.tfPreOpenVeto_(pendingLong, null, { overall: { sentiment: -0.9, confidence: 0.8 } }, '2026-11-10').veto, true);
  assert.equal(c.tfPreOpenVeto_(pendingLong, null, { overall: { sentiment: -0.3, confidence: 0.8 } }, '2026-11-10').veto, false);
  assert.equal(c.tfPreOpenVeto_(pendingLong, null, { events: [{ type: 'cpi', importance: 'high', date: '2026-11-10' }] }, '2026-11-10').veto, true);
  // 平倉單永遠不否決
  assert.equal(c.tfPreOpenVeto_({ target: 'flat' }, { side: 'long' }, { overall: { sentiment: 1, confidence: 1 } }, '2026-11-10').veto, false);
  // 同方向加碼以外的續抱也不擋：多單 → 多單同口數
  assert.equal(c.tfPreOpenVeto_({ target: 'long', contracts: 1 }, { side: 'long', contracts: 1 }, { overall: { sentiment: -1, confidence: 1 } }, '2026-11-10').veto, false);
});
