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

const d = loadTs(path.resolve(__dirname, '../src/features/stock-radar/dashboard.ts'));
const t = loadTs(path.resolve(__dirname, '../src/features/stock-radar/types.ts'));
const tr = loadTs(path.resolve(__dirname, '../src/features/stock-radar/track-record.ts'));
const cs = loadTs(path.resolve(__dirname, '../src/features/stock-radar/claude-schedule.ts'));

function item(symbol, action, composite, extra = {}) {
  return t.parseStockRadarItem({ symbol, action, composite, coverage: 1, held: ['add', 'hold', 'trim', 'exit'].includes(action), ...extra });
}

function run(runDate, market, items) {
  return t.parseStockRadarRun(`${runDate}_${market}`, { runDate, market, items, regime: 'risk_on', status: 'ok' });
}

test('parses Apps Script run documents defensively', () => {
  const parsed = t.parseStockRadarRun('2026-10-29_US', {
    runDate: '2026-10-29',
    market: 'US',
    regime: 'bogus',
    items: [
      { symbol: 'AAPL', action: 'add', composite: 0.4, factors: { tsmom: { raw: 0.2, score: 0.5 }, other: { score: 1 } } },
      { action: 'buy' },
      { symbol: 'MSFT', action: 'sell-everything', composite: 'x' },
    ],
  });
  assert.equal(parsed.market, 'US');
  assert.equal(parsed.regime, 'unknown');
  assert.equal(parsed.benchmark.symbol, 'SPY');
  assert.equal(parsed.items.length, 2);
  assert.deepEqual(Object.keys(parsed.items[0].factors), ['tsmom']);
  assert.equal(parsed.items[1].action, 'insufficient');
  assert.equal(parsed.items[1].composite, null);
});

test('latestRunByMarket picks the newest run per market', () => {
  const runs = [run('2026-10-28', 'TW', []), run('2026-10-29', 'TW', []), run('2026-10-27', 'US', [])];
  const latest = d.latestRunByMarket(runs);
  assert.equal(latest.TW.runDate, '2026-10-29');
  assert.equal(latest.US.runDate, '2026-10-27');
});

test('groups actions with risk first and sorts weakest exits first', () => {
  const groups = d.groupByAction([
    item('A', 'hold', 0.1), item('B', 'exit', -0.5), item('C', 'exit', -0.9), item('D', 'buy', 0.6), item('E', 'add', 0.4),
  ]);
  assert.deepEqual(groups.map((g) => g.action), ['exit', 'add', 'buy', 'hold']);
  assert.deepEqual(groups[0].items.map((i) => i.symbol), ['C', 'B']);
});

test('overview weights holding scores by position size', () => {
  const overview = d.buildOverview([
    item('A', 'hold', 0.5, { weightPct: 75 }),
    item('B', 'trim', -0.5, { weightPct: 25 }),
    item('C', 'buy', 0.6),
  ]);
  assert.equal(overview.held, 2);
  assert.equal(overview.needsAction, 1);
  assert.equal(overview.buyCandidates, 1);
  assert.equal(overview.weightedScore, 0.25);
  assert.equal(overview.weakWeightPct, 25);
});

test('symbol history and action changes compare consecutive runs of one market', () => {
  const runs = [
    run('2026-10-29', 'TW', [{ symbol: '2330', action: 'trim', composite: -0.2, close: 1000 }]),
    run('2026-10-28', 'TW', [{ symbol: '2330', action: 'hold', composite: 0.1, close: 1050 }]),
    run('2026-10-29', 'US', [{ symbol: '2330', action: 'add', composite: 0.9 }]),
  ];
  const history = d.symbolHistory(runs, 'TW', '2330');
  assert.deepEqual(history.map((p) => p.date), ['2026-10-28', '2026-10-29']);
  assert.deepEqual(d.changedActions(runs, 'TW'), [{ symbol: '2330', from: 'hold', to: 'trim' }]);
});

test('parses sentiment and drops non-https sources', () => {
  const parsed = t.parseStockRadarItem({
    symbol: '2330', action: 'add', composite: 0.5, quantScore: 0.4, sentimentAdj: 0.1, eventRisk: true,
    sentiment: {
      score: 0.4, confidence: 1, summary: 's', catalysts: ['a', 3],
      riskEvents: [{ type: 'earnings', date: '2026-11-01' }, { type: 'bogus' }],
      earningsSurprise: 'beat',
      sources: [{ title: 'ok', url: 'https://a.com' }, { url: 'javascript:alert(1)' }],
    },
  });
  assert.equal(parsed.quantScore, 0.4);
  assert.equal(parsed.eventRisk, true);
  assert.deepEqual(parsed.sentiment.catalysts, ['a']);
  assert.equal(parsed.sentiment.riskEvents.length, 1);
  assert.deepEqual(parsed.sentiment.sources, [{ title: 'ok', url: 'https://a.com' }]);
  // 舊版 run 沒有 quantScore → 用 composite
  assert.equal(t.parseStockRadarItem({ symbol: 'X', composite: 0.2 }).quantScore, 0.2);
  const runDoc = t.parseStockRadarRun('2026-10-29_TW', { market: 'TW', regime: 'risk_on', effectiveRegime: 'neutral' });
  assert.equal(runDoc.effectiveRegime, 'neutral');
  assert.equal(t.parseStockRadarRun('2026-10-29_TW', { market: 'TW', regime: 'risk_off' }).effectiveRegime, 'risk_off');
});

function outcome(runDate, market, returns, benchmark) {
  return t.parseStockRadarOutcome(`${runDate}_${market}`, { runDate, market, modelVersion: 'v', returns, benchmark });
}

test('track record joins runs with outcomes and scores direction', () => {
  const runs = [
    run('2026-10-27', 'TW', [
      { symbol: 'A', action: 'buy', composite: 0.6, quantScore: 0.5, sentimentAdj: 0.1, sentiment: { score: 1, confidence: 0.4 } },
      { symbol: 'B', action: 'exit', composite: -0.6 },
      { symbol: 'C', action: 'hold', composite: 0.1 },
      { symbol: 'D', action: 'insufficient', composite: null },
    ]),
    run('2026-10-28', 'TW', [
      { symbol: 'A', action: 'add', composite: 0.5 },
      { symbol: 'B', action: 'trim', composite: -0.2 },
      { symbol: 'C', action: 'hold', composite: 0.0 },
    ]),
  ];
  const outcomes = [
    outcome('2026-10-27', 'TW', { A: { fwd5: 0.05 }, B: { fwd5: -0.03 }, C: { fwd5: 0.01 }, D: { fwd5: 0.2 } }, { fwd5: 0.01 }),
    outcome('2026-10-28', 'TW', { A: { fwd5: -0.02 }, B: { fwd5: 0.04 }, C: { fwd5: 0.0 } }, { fwd5: 0 }),
  ];
  const rows = tr.joinTrackRecord(runs, outcomes);
  assert.equal(rows.length, 6);
  assert.equal(Math.round(rows[0].excess[5] * 1000) / 1000, 0.04);
  assert.equal(rows[0].excess[1], null);
  const summary = tr.summarizeTrackRecord(rows, 5);
  assert.equal(summary.samples, 6);
  assert.equal(summary.directionalSamples, 4);
  assert.equal(summary.hitRate, 0.5);
  assert.equal(summary.icSeries.length, 2);
  assert.equal(summary.icSeries[0].ic, 1);
  assert.equal(summary.icSeries[1].ic, -1);
  assert.equal(summary.meanIC, 0);
  assert.equal(summary.sentimentLift.periods, 1);
  const buy = summary.actions.find((a) => a.action === 'buy');
  assert.equal(buy.hitRate, 1);
  assert.equal(summary.actions.find((a) => a.action === 'hold').hitRate, null);
  assert.equal(tr.summarizeTrackRecord(rows, 20).samples, 0);
});

test('spearman matches Apps Script implementation on ties', () => {
  assert.equal(tr.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(tr.spearman([1, 1, 1], [1, 2, 3]), null);
  assert.equal(Math.round(tr.spearman([1, 2, 2, 3], [1, 3, 2, 4]) * 1000) / 1000, 0.949);
});

test('prompt sync state and diff', () => {
  assert.equal(cs.promptSyncState([], ['A']), 'empty');
  assert.equal(cs.promptSyncState(['A'], undefined), 'new');
  assert.equal(cs.promptSyncState(['B', 'A'], ['A', 'B']), 'synced');
  assert.equal(cs.promptSyncState(['A', 'C'], ['A', 'B']), 'stale');
  assert.deepEqual(cs.promptSymbolDiff(['A', 'C'], ['A', 'B']), { added: ['C'], removed: ['B'] });
});

test('prompt contains symbols, endpoint and no holdings data', () => {
  const prompt = cs.buildStockRadarPrompt('TW', [{ symbol: '2330', name: '台積電' }, { symbol: '0050', name: '0050' }], new Date('2026-10-29T00:00:00Z'));
  assert.match(prompt, /- 2330 台積電/);
  assert.match(prompt, /- 0050\n/);
  assert.match(prompt, /https:\/\/script\.example\/exec\?action=ingestStockSentiment/);
  assert.match(prompt, /RMONEY_STOCK_INGEST_TOKEN/);
  assert.doesNotMatch(prompt, /股數|成本價|avgCost/);
});

test('parses pasted Claude output with fences, smart quotes and stray token', () => {
  const text = '結果如下：\n```json\n{\u201cmarket\u201d: \u201cUS\u201d, \u201citems\u201d: [{\u201csymbol\u201d: \u201cAAPL\u201d, \u201csentiment\u201d: 0.2, \u201cconfidence\u201d: 0.5, \u201cingestToken\u201d: \u201csecret\u201d}],}\n```\n完成';
  const parsed = cs.parseStockSentimentPaste(text);
  assert.equal(parsed.market, 'US');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].ingestToken, undefined);
  assert.throws(() => cs.parseStockSentimentPaste('沒有 JSON'), /找不到 JSON/);
  assert.throws(() => cs.parseStockSentimentPaste('{"market":"TW","items":[]}'), /沒有 items/);
});

test('prompt universe uses live holdings + watchlist, same rules as Apps Script', () => {
  const positions = [
    { symbol: '2330', shares: 100 },
    { symbol: '2330', shares: 50 },
    { symbol: '2317', shares: 0 }, // 已賣光不算
    { symbol: 'aapl', shares: 3 },
  ];
  const watchlist = [{ symbol: '00878' }, { symbol: 'NVDA' }, { symbol: '2454.TW' }];
  const stocks = [{ symbol: '2330', name: '台積電', market: 'TW' }, { symbol: 'AAPL', name: 'Apple', market: 'US' }];
  const tw = cs.buildPromptUniverse('TW', positions, watchlist, stocks, { 2454: '聯發科' });
  assert.deepEqual(tw, [
    { symbol: '00878', name: '00878' },
    { symbol: '2330', name: '台積電' },
    { symbol: '2454', name: '聯發科' },
  ]);
  const us = cs.buildPromptUniverse('US', positions, watchlist, stocks);
  assert.deepEqual(us.map((s) => s.symbol), ['AAPL', 'NVDA']);
  assert.deepEqual(cs.buildPromptUniverse('TW', [], [], []), []);
});
