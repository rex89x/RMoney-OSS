const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react-dom', 'lucide-react', 'firebase/firestore'],
    define: { 'import.meta.env': '{"VITE_APPS_SCRIPT_URL":"https://script.example/exec"}' },
    alias: { '@': path.resolve(__dirname, '../src') } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const base = path.resolve(__dirname, '../src/features/taifex');
const d = loadTs(path.join(base, 'dashboard.ts'));
const t = loadTs(path.join(base, 'types.ts'));
const cs = loadTs(path.join(base, 'claude-schedule.ts'));
const o = loadTs(path.join(base, 'options.ts'));
const tech = loadTs(path.join(base, 'tech.ts'));

function account(extra = {}) {
  return t.parseTaifexAccount('default', {
    product: 'MTX', equity: 1_050_000, initialCapital: 1_000_000, peakEquity: 1_100_000, lastClose: 23_000,
    tradeCount: 4, winCount: 1, ...extra,
  });
}

test('account parser tolerates missing fields and parses equity curve', () => {
  const a = t.parseTaifexAccount('default', { equityCurve: [{ d: '2026-11-09', e: 1000, p: 2, c: 23000 }, { bad: 1 }] });
  assert.equal(a.product, 'TMF');
  assert.equal(a.position, null);
  assert.equal(a.pending, null);
  assert.equal(a.equityCurve.length, 1);
  assert.equal(a.equityCurve[0].position, 2);
  assert.equal(t.parseTaifexAccount('x', undefined), null);
});

test('summarizeAccount computes unrealized P&L, stop risk and drawdown', () => {
  const s = d.summarizeAccount(account({
    position: { side: 'short', contracts: 2, entryPrice: 23_200, entryDate: '2026-11-01', stop: 23_500 },
  }));
  assert.equal(s.pointValue, 50);
  assert.equal(s.unrealizedPoints, 200);
  assert.equal(s.unrealizedPnl, 20_000);
  assert.equal(s.stopDistancePoints, 500);
  assert.equal(s.riskToStop, 50_000);
  assert.ok(Math.abs(s.returnPct - 5) < 1e-9);
  // (1,100,000 − 1,050,000) / 1,100,000
  assert.ok(Math.abs(s.drawdownPct - 50 / 11) < 1e-9);
  assert.equal(s.winRatePct, 25);
  assert.equal(d.summarizeAccount(account()).unrealizedPnl, null);
});

test('tradeStats reports win rate, profit factor and expectancy', () => {
  const trades = [100, -50, 300, -50].map((netPnl, i) => t.parseTaifexTrade(String(i), { netPnl, costs: 10, holdingBars: i + 1 }));
  const s = d.tradeStats(trades);
  assert.equal(s.count, 4);
  assert.equal(s.winRatePct, 50);
  assert.equal(s.profitFactor, 4);
  assert.equal(s.expectancy, 75);
  assert.equal(s.totalCosts, 40);
  assert.equal(s.avgHoldingBars, 2.5);
  assert.equal(d.tradeStats([]).profitFactor, null);
});

test('composite zones and gauge mapping follow the entry/exit thresholds', () => {
  assert.equal(d.compositeZone(0.35), 'strong_long');
  assert.equal(d.compositeZone(0.2), 'lean_long');
  assert.equal(d.compositeZone(0.05), 'neutral');
  assert.equal(d.compositeZone(-0.4), 'strong_short');
  assert.equal(d.compositeZone(null), 'unknown');
  assert.equal(d.gaugePercent(-1), 0);
  assert.equal(d.gaugePercent(0), 50);
  assert.equal(d.gaugePercent(2), 100);
});

test('signal parser and chart data sort by date and expose stop line', () => {
  const s1 = t.parseTaifexSignal('2026-11-10', { date: '2026-11-10', close: 2, indicators: { ema20: 1 }, position: { side: 'long', contracts: 1, stop: 1.5 } });
  const s0 = t.parseTaifexSignal('2026-11-09', { date: '2026-11-09', close: 1, desired: 'bogus' });
  assert.equal(s0.desired, 'flat');
  assert.equal(s0.factors.trend.score, null);
  const chart = d.signalChartData([s1, s0]);
  assert.deepEqual(chart.map((p) => p.date), ['2026-11-09', '2026-11-10']);
  assert.equal(chart[1].stop, 1.5);
  assert.equal(chart[0].stop, null);
});

test('upcoming events filter past dates and rank importance', () => {
  const sentiment = t.parseTaifexSentiment('2026-11-09', {
    events: [
      { type: 'cpi', date: '2026-11-12', importance: 'medium' },
      { type: 'fomc', date: '2026-11-12', importance: 'high' },
      { type: 'cbc', date: '2026-11-01', importance: 'high' },
      { type: 'nope', date: 'x' },
    ],
  });
  const events = d.upcomingEvents(sentiment, '2026-11-09');
  assert.deepEqual(events.map((e) => e.type), ['fomc', 'cpi']);
  assert.deepEqual(d.upcomingEvents(null, '2026-11-09'), []);
});

test('stale check tolerates weekends and short holidays', () => {
  // 週一看上週五：不算舊
  assert.equal(d.isStale('2026-11-06', '2026-11-09'), false);
  assert.equal(d.isStale('2026-11-02', '2026-11-09'), true);
  assert.equal(d.isStale(null, '2026-11-09'), true);
});

test('sentiment parser keeps only https sources', () => {
  const s = t.parseTaifexSentiment('x', { overall: { sentiment: 0.2, confidence: 0.5, sources: [{ url: 'http://a' }, { url: 'https://b', title: 'B' }] } });
  assert.equal(s.overall.sources.length, 1);
  assert.equal(s.overall.sources[0].title, 'B');
});

test('paste parser handles fences, curly quotes, trailing commas and strips token', () => {
  const text = '說明文字\n```json\n{“overall”: {“sentiment”: 0.3, “confidence”: 0.6, “sources”: []}, “events”: [], “ingestToken”: “rmtf_x”,}\n```\n結尾';
  const body = cs.parseTaifexSentimentPaste(text);
  assert.equal(body.overall.sentiment, 0.3);
  assert.equal('ingestToken' in body, false);
  assert.throws(() => cs.parseTaifexSentimentPaste('沒有 json'), /找不到/);
  assert.throws(() => cs.parseTaifexSentimentPaste('{"events": []}'), /overall/);
});

test('prompt contains the ingest endpoint, env var and safety rules but no account data', () => {
  const prompt = cs.buildTaifexPrompt(new Date('2026-11-09T00:00:00Z'));
  assert.ok(prompt.includes('https://script.example/exec?action=ingestTaifexSentiment'));
  assert.ok(prompt.includes(cs.TAIFEX_INGEST_ENV_VAR));
  assert.ok(prompt.includes('安全規則'));
  assert.ok(!/equity|權益|部位口數/.test(prompt));
});

test('number formatters', () => {
  assert.equal(o.formatTWD(-1234.6, true), '-1,235');
  assert.equal(o.formatTWD(1234, true), '+1,234');
  assert.equal(o.formatScore(0.123), '+0.12');
  assert.equal(o.pnlClass(-1), 'text-destructive');
  assert.equal(o.formatPoints(null), '—');
});

const pf = loadTs(path.join(base, 'perf.ts'));

function curveAccount(id, equities, closes, extra = {}) {
  return t.parseTaifexAccount(id, {
    initialCapital: 1_000_000,
    equity: equities[equities.length - 1],
    equityCurve: equities.map((e, i) => ({ d: `2026-${String(1 + Math.floor(i / 21)).padStart(2, '0')}-${String(1 + (i % 21)).padStart(2, '0')}`, e, p: i % 3 === 0 ? 0 : 1, c: closes[i] })),
    ...extra,
  });
}

test('perfMetrics computes return, drawdown, benchmark and skips annualizing short samples', () => {
  const a = curveAccount('default', [1_000_000, 1_050_000, 1_000_000, 1_100_000], [100, 101, 99, 102]);
  const m = pf.perfMetrics(a);
  assert.equal(m.days, 3);
  assert.ok(Math.abs(m.totalReturnPct - 10) < 1e-9);
  assert.ok(Math.abs(m.maxDrawdownPct - (50_000 / 1_050_000) * 100) < 1e-9);
  assert.equal(m.cagrPct, null);
  assert.ok(Math.abs(m.benchmarkReturnPct - 2) < 1e-9);
  assert.ok(Math.abs(m.excessReturnPct - 8) < 1e-9);
});

test('monthly returns chain month-end equities from the initial capital', () => {
  const eq = Array.from({ length: 42 }, (_, i) => 1_000_000 + i * 1000);
  const months = pf.monthlyReturns(curveAccount('default', eq, eq.map(() => 100)));
  assert.equal(months.length, 2);
  assert.equal(months[0].month, '2026-01');
  assert.ok(Math.abs(months[0].returnPct - 2) < 1e-9);
});

test('verdict says insufficient for small samples and grades larger ones', () => {
  const few = pf.perfVerdict({ days: 10, sharpe: 2, maxDrawdownPct: 1, excessReturnPct: 1, exposurePct: 50 }, { count: 2, profitFactor: 3 }, 20, { sharpe: 1.1, maxDrawdownPct: 8 });
  assert.equal(few.level, 'insufficient');
  assert.ok(few.reasons[1].includes('回測'));
  const good = pf.perfVerdict({ days: 120, sharpe: 1.4, maxDrawdownPct: 6, excessReturnPct: 3, exposurePct: 60 }, { count: 20, profitFactor: 1.6 }, 20, null);
  assert.equal(good.level, 'good');
  const poor = pf.perfVerdict({ days: 120, sharpe: -0.5, maxDrawdownPct: 25, excessReturnPct: -10, exposurePct: 60 }, { count: 20, profitFactor: 0.7 }, 20, null);
  assert.equal(poor.level, 'poor');
});

test('leaderboard ranks by return with drawdown breaches last and counts only own trades', () => {
  const main = curveAccount('default', [1_000_000, 1_020_000], [100, 101], { variant: 'baseline' });
  const agg = curveAccount('v_aggressive', [1_000_000, 1_300_000, 1_000_000, 1_250_000], [100, 101, 99, 102], { variant: 'aggressive' });
  const con = curveAccount('v_conservative', [1_000_000, 1_050_000], [100, 101], { variant: 'conservative' });
  const trades = [t.parseTaifexTrade('a', { accountId: 'v_conservative', netPnl: 5, epoch: 1 }), t.parseTaifexTrade('b', { netPnl: 5, epoch: 1 })];
  const rows = pf.leaderboard([main, agg, con], trades, 20);
  assert.deepEqual(rows.map((r) => r.id), ['v_conservative', 'default', 'v_aggressive']);
  assert.equal(rows[2].withinDrawdown, false);
  assert.equal(rows[0].trades.count, 1);
  assert.equal(rows[1].trades.count, 1);
});

test('ticket, live and optimization parsers', () => {
  const ticket = t.parseTaifexTicket({ kind: 'open', steps: [{ action: 'open', side: 'buy', qty: 2, orderType: 'LMT', price: 20050, tif: 'ROD' }, { qty: 0 }], stopOrder: { side: 'sell', qty: 2, price: 19600, stopPoints: 400 }, notes: ['x', 3] });
  assert.equal(ticket.steps.length, 1);
  assert.equal(ticket.steps[0].orderType, 'LMT');
  assert.equal(ticket.stopOrder.price, 19600);
  assert.deepEqual(ticket.notes, ['x']);
  assert.equal(t.parseTaifexTicket({}), null);
  const live = t.parseTaifexLive({ quote: { date: '2026-11-10', last: 27000, estimated: true }, context: { lastDate: '2026-11-09', atr20: 300 } });
  assert.equal(live.quote.estimated, true);
  assert.equal(live.context.atr20, 300);
  assert.equal(t.parseTaifexLive(undefined).quote, null);
  const opt = t.parseTaifexOptimization({ adopt: true, best: { params: { entry: 0.25, bogus: 1 }, outOfSample: { totalReturnPct: 5, trades: 3 } }, variants: [{ params: {}, eligible: false }] });
  assert.deepEqual({ ...opt.best.params }, { entry: 0.25 });
  assert.equal(opt.variants[0].eligible, false);
  const acc = t.parseTaifexAccount('v_x', { variant: 'nope', params: { entry: 0.45 } });
  assert.equal(acc.variant, 'baseline');
  assert.equal(acc.params.entry, 0.45);
  assert.equal(acc.params.stopAtr, 2);
  assert.equal(t.parseTaifexTrade('z', {}).accountId, 'default');
});

// -------- 盤中技術模擬 --------

function techStat(n, wins, net) {
  return { n, wins, net, grossWin: Math.max(net, 0) + 1000, grossLoss: 1000 + Math.max(-net, 0), points: net / 10 };
}

function techDoc(extra = {}) {
  return tech.parseTaifexTech({
    modelVersion: 'txi-v1', epoch: 2, startDate: '2026-11-02', product: 'TMF', contracts: 1,
    status: { state: 'running', label: '夜盤交易中', date: '2026-11-12', time: '21:35', session: 'night', toClose: 445, price: 27123, contract: '202611', source: 'fugle', next: { session: 'day', date: '2026-11-13', time: '08:45' } },
    bots: {
      m5: { interval: 5, checks: 900, realized: -4200, maxDrawdown: 6000, position: { side: 'long', contracts: 1, entryPrice: 27100, entryTime: '2026-11-12 21:30', session: 'night', stop: 27040, unrealized: 230 },
        stats: { all: techStat(48, 20, -4200), day: techStat(20, 9, -1200), night: techStat(28, 11, -3000) }, buckets: { d1: techStat(8, 2, -2400), n3: techStat(10, 6, 900) },
        lastDecision: { t: '2026-11-12 21:35', session: 'night', price: 27123, score: 0.52, action: 'hold', target: 'long', reason: '分數 0.52 續抱', bars: 480, indicators: { emaFast: 27110, emaSlow: 27090, rsi: 61.2, macdHist: 4.1, atr: 28.5, channelHigh: 27130, channelLow: 27040 }, factors: { trend: 0.7, macd: 0.57, rsi: 0.56, breakout: 0.84 } },
        decisions: [{ t: '2026-11-12 21:30', price: 27100, score: 0.44, action: 'enter', target: 'long' }, { t: '2026-11-12 21:35', price: 27123, score: 0.52, action: 'hold', target: 'long' }] },
      m15: { interval: 15, checks: 300, realized: 8600, maxDrawdown: 2500, stats: { all: techStat(34, 17, 8600), day: techStat(14, 6, 1600), night: techStat(20, 11, 7000) }, buckets: { d1: techStat(4, 1, -900), n3: techStat(9, 6, 5200) } },
      m30: { interval: 30, checks: 150, realized: 3000, maxDrawdown: 1800, stats: { all: techStat(12, 6, 3000), day: techStat(5, 3, 2200), night: techStat(7, 3, 800) }, buckets: {} },
      m60: { interval: 60, checks: 70, lastDecision: { t: '2026-11-12 21:00', price: 27080, score: null, action: 'hold', target: 'flat', reason: '資料不足', bars: 22, indicators: null, factors: null } },
    },
    sessions: [
      { key: '2026-11-11N', session: 'night', date: '2026-11-11', open: 27000, high: 27090, low: 26950, close: 27050, ticks: 168, pnl: { m5: -800, m15: 1200 }, trades: { m5: 6, m15: 2 } },
      { key: '2026-11-12D', session: 'day', date: '2026-11-12', open: 27060, high: 27150, low: 27010, close: 27100, ticks: 61, pnl: { m5: 300, m15: -200, m30: 500 }, trades: { m5: 4 } },
      { bad: true },
    ],
    ...extra,
  });
}

test('tech doc parsing tolerates missing bots and fields', () => {
  const doc = techDoc();
  assert.deepEqual(doc.bots.map((b) => b.id), ['m5', 'm15', 'm30', 'm60']);
  assert.equal(doc.bots[0].position.side, 'long');
  assert.equal(doc.bots[0].lastDecision.factors.trend, 0.7);
  assert.equal(doc.bots[3].stats.all.n, 0);
  assert.equal(doc.bots[3].lastDecision.indicators, null);
  assert.equal(doc.bots[3].lastDecision.bars, 22);
  assert.equal(doc.sessions.length, 2);
  assert.equal(doc.status.next.date, '2026-11-13');
  assert.equal(tech.parseTaifexTech(undefined), null);
  const statusOnly = tech.parseTaifexTech({ status: { state: 'closed', reason: 'holiday', label: '國慶日', date: '2026-10-09', time: '09:00' } });
  assert.equal(statusOnly.bots.length, 4);
  assert.equal(statusOnly.status.state, 'closed');
  assert.equal(statusOnly.status.session, null);
});

test('tech ranking puts well-sampled frequencies first, then by net P&L', () => {
  const rows = tech.rankTechBots(techDoc().bots);
  assert.deepEqual(rows.map((r) => r.bot.id), ['m15', 'm5', 'm30', 'm60']);
  assert.equal(rows[0].enoughSample, true);
  assert.equal(rows[2].enoughSample, false);
  assert.equal(Math.round(rows[0].netPerCheck * 100) / 100, 28.67);
  assert.equal(rows[3].netPerCheck, 0);
  assert.equal(Math.round(rows[0].night.winRatePct), 55);
  const v = tech.techVerdict(rows);
  assert.equal(v.level, 'ok');
  assert.match(v.headline, /每 15 分鐘/);
  assert.ok(v.notes.some((n) => n.includes('夜盤')));
  assert.ok(v.notes.some((n) => n.includes('5 分')));
  const empty = tech.techVerdict(tech.rankTechBots(tech.parseTaifexTech({}).bots));
  assert.equal(empty.level, 'insufficient');
  assert.equal(empty.headline, '還沒有交易紀錄');
});

test('tech entry-time buckets and cumulative curve', () => {
  const doc = techDoc();
  const buckets = tech.techBucketRows(doc.bots);
  assert.equal(buckets.length, 8);
  const d1 = buckets.find((b) => b.id === 'd1');
  assert.equal(d1.total.n, 12);
  assert.equal(d1.total.net, -3300);
  assert.equal(d1.byBot.m30.n, 0);
  assert.equal(d1.byBot.m30.avgNet, null);
  const curve = tech.techCurve(doc.sessions);
  assert.deepEqual(curve.map((p) => [p.label, p.m5, p.m15, p.m30, p.m60]), [['11-11 夜', -800, 1200, 0, 0], ['11-12 日', -500, 1000, 500, 0]]);
  assert.equal(tech.techCurve(doc.sessions, 'day').length, 1);
});

test('tech trades parse newest first and drop malformed rows', () => {
  const list = tech.parseTaifexTechTrades({ trades: [
    { bot: 'm5', interval: 5, session: 'day', sessionKey: '2026-11-12D', side: 'long', contracts: 1, entryTime: '2026-11-12 09:10', entryPrice: 27000, entryM: 25, exitTime: '2026-11-12 09:40', exitPrice: 27040, points: 40, grossPnl: 400, costs: 61, netPnl: 339, reason: 'signal', epoch: 2 },
    { bot: 'm15', session: 'night', side: 'short', entryPrice: 27100, exitPrice: 27150, netPnl: -561, reason: 'stop', exitTime: '2026-11-12 22:05' },
    { bot: 'm5', side: 'long' },
  ] });
  assert.equal(list.length, 2);
  assert.equal(list[0].bot, 'm15');
  assert.equal(list[0].reason, 'stop');
  assert.equal(list[1].netPnl, 339);
  assert.deepEqual(tech.parseTaifexTechTrades(undefined), []);
});

test('session by clock and holiday input', () => {
  assert.equal(tech.sessionByClock(2, '09:00'), 'day');
  assert.equal(tech.sessionByClock(2, '14:00'), null);
  assert.equal(tech.sessionByClock(5, '23:00'), 'night');
  assert.equal(tech.sessionByClock(6, '03:00'), 'night');
  assert.equal(tech.sessionByClock(6, '09:00'), null);
  assert.equal(tech.sessionByClock(1, '03:00'), null);
  assert.equal(tech.sessionByClock(7, '20:00'), null);
  assert.deepEqual(tech.parseHolidayInput('2026-07-08, 2026/7/9\n2026-07-08 颱風 2026-13-01'), { dates: ['2026-07-08', '2026-07-09'], invalid: ['颱風', '2026-13-01'] });
});

test('tech config defaults and parsing', () => {
  assert.deepEqual(t.parseTaifexConfig(undefined).tech, { enabled: true, day: true, night: true, notify: false, contracts: 1, extraHolidays: [] });
  const cfg = t.parseTaifexConfig({ tech: { enabled: false, night: false, notify: true, contracts: 3, extraHolidays: ['2026-07-08', 'x', 5] } });
  assert.deepEqual(cfg.tech, { enabled: false, day: true, night: false, notify: true, contracts: 3, extraHolidays: ['2026-07-08'] });
});

// -------- 每週檢討 / 調校 --------
const rv = loadTs(path.join(base, 'review.ts'));

test('review parser keeps a usable proposal and downgrades an empty one', () => {
  const review = rv.parseTaifexReview('2026-11-08', {
    weekStart: '2026-11-02', weekEnd: '2026-11-08', status: 'proposed', summary: '本週持平', findings: ['a', 3, ''],
    prUrl: 'https://github.com/example/RMoney/pull/9', week: { pnl: 1200, pct: 0.12, days: 3, indexChangePct: null },
    createdAt: '2026-11-08T13:30:00.000Z',
    proposal: {
      rationale: 'why', sections: ['params', 'bogus', 'risk'], switchVariant: true,
      diff: [{ section: 'params', key: 'entry', from: 0.35, to: 0.3 }, { section: 'risk', key: 'allowShort', from: true, to: false }, { key: 'x' }],
      backtest: { from: '2025-04-01', to: '2026-11-04', outOfSampleFrom: '2026-03-01', warnings: ['樣本外報酬比目前的參數差'],
        current: { full: { totalReturnPct: 12.5, maxDrawdownPct: 8, sharpe: 1.1, trades: 20 }, outOfSample: null },
        proposed: { full: { totalReturnPct: 14 }, outOfSample: { totalReturnPct: 3 } } },
    },
  });
  assert.equal(review.status, 'proposed');
  assert.deepEqual(review.findings, ['a']);
  assert.deepEqual(review.proposal.sections, ['params', 'risk']);
  assert.equal(review.proposal.diff.length, 2);
  assert.equal(review.proposal.backtest.current.full.trades, 20);
  assert.equal(review.proposal.backtest.current.outOfSample, null);
  assert.equal(review.proposal.backtest.proposed.full.sharpe, null);
  assert.equal(review.week.pnl, 1200);
  assert.ok(review.createdAt instanceof Date);
  assert.equal(rv.tuningLabel(review.proposal.diff[0]), '進場門檻');
  assert.equal(rv.formatTuningValue(false), '不允許');
  assert.equal(rv.tuningLabel({ section: 'x', key: 'y' }), 'x.y');

  const empty = rv.parseTaifexReview('2026-11-01', { status: 'proposed', summary: 's', proposal: { diff: [] }, prUrl: 'javascript:alert(1)' });
  assert.equal(empty.status, 'no_change');
  assert.equal(empty.proposal, null);
  assert.equal(empty.prUrl, null);
  assert.equal(rv.parseTaifexReview('latest', {}), null);
});

test('tuning parser: incomplete sections read as defaults (null)', () => {
  assert.deepEqual(rv.parseTaifexTuning(undefined), { version: 0, reviewId: null, updatedAt: null, params: null, weights: null, tech: null });
  const tuned = rv.parseTaifexTuning({
    version: 2, reviewId: '2026-11-08',
    params: { entry: 0.3, exit: 0.05, adxTrend: 18, chopDamp: 0.6, stopAtr: 2, trailAtr: 3 },
    weights: { trend: 0.3, breakout: 0.2 },
    tech: { entry: 0.5, exit: 0.1, stopAtr: 2, trailAtr: 3, weights: { trend: 0.35, macd: 0.25, rsi: 0.2, breakout: 0.2 } },
  });
  assert.equal(tuned.params.entry, 0.3);
  assert.equal(tuned.weights, null);
  assert.equal(tuned.tech.weights.macd, 0.25);
  assert.ok(t.TAIFEX_VARIANT_KEYS.includes('tuned'));
  assert.ok(o.VARIANT_LABELS.tuned.label);
});

test('review schedule prompt names only the review tools and carries no token', () => {
  const prompt = rv.buildTaifexReviewPrompt(new Date('2026-11-08T13:00:00Z'));
  for (const tool of ['taifex_weekly_review', 'preview_taifex_review', 'commit_taifex_review']) assert.ok(prompt.includes(tool), tool);
  assert.ok(!/rmtf_|rmcp_|TOKEN/.test(prompt));
  assert.ok(!prompt.includes('commit_entries'));
  assert.ok(prompt.includes('2026-11-08 21:00'));
});
