const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/**
 * 台指期每週檢討 → 調校提案 → owner 核准（TaifexTuning.gs 純函式 + TaifexReview.gs IO + MCP 寫入工具）。
 * Firestore 是記憶體 store；日 K 用黃金資料（480 根，到 2026-11-04），「今天」固定在 2026-11-08（週日）。
 */
const TODAY = '2026-11-08';
const GOLDEN_BARS = require('./fixtures/taifex-golden.json').input.bars;
const plain = (x) => JSON.parse(JSON.stringify(x));

function load(seed = {}) {
  const store = {};
  GOLDEN_BARS.forEach((b) => { store['taifex_daily/' + b.date.replace(/-/g, '')] = { ...b }; });
  Object.assign(store, seed);
  const cache = {};
  const sent = [];
  let seq = 0;
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const children = (col) => Object.keys(store)
    .filter((k) => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/'))
    .map((k) => ({ ...clone(store[k]), _name: 'docs/' + k }));
  const context = vm.createContext({ console: { ...console, error: () => {}, warn: () => {} }, Date, Error, isFinite, JSON, Math, Number, String, Array, Object, Infinity, RegExp });
  context.TZ = 'Asia/Taipei';
  context.TW_TZ = 'Asia/Taipei';
  context.CacheService = { getScriptCache: () => ({
    get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: (k) => { delete cache[k]; },
  }) };
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  context.Utilities = { formatDate: () => TODAY, getUuid: () => crypto.randomUUID() };
  context.fsGetDoc_ = (p) => (store[p] ? { ...clone(store[p]), _name: 'docs/' + p } : null);
  context.fsSetDoc_ = (p, data, merge) => { store[p] = merge ? { ...(store[p] || {}), ...clone(data) } : clone(data); return {}; };
  context.fsAddDoc_ = (col, data) => { store[`${col}/auto${++seq}`] = clone(data); return {}; };
  context.fsListAllDocs_ = (col) => children(col);
  context.fsRunQuery_ = (_parent, q) => children(q.from[0].collectionId);
  context.fsDocumentName_ = (p) => p;
  context.encodeFields_ = (obj) => obj;
  context.fsBatchWrite_ = (writes) => {
    writes.forEach((w) => {
      const next = clone(w.update.fields);
      store[w.update.name] = w.updateMask ? { ...(store[w.update.name] || {}), ...next } : next;
    });
    return {};
  };
  context.sendNotification_ = (key, message) => { sent.push({ key, message }); return { ok: true }; };
  for (const file of ['TaifexStrategy.gs', 'TaifexData.gs', 'TaifexLive.gs', 'TaifexTech.gs', 'TaifexTuning.gs', 'TaifexPaper.gs', 'TaifexTechRun.gs', 'TaifexReview.gs', 'HubTools.gs', 'HubWriteTools.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  return { c: context, store, cache, sent };
}

const CTX = { uid: 'owner-1', client: 'Claude' };
const AUTH = { uid: 'owner-1' };

function account(extra = {}) {
  return {
    equity: 1030000, initialCapital: 1000000, maxDrawdownPct: 2.1, tradeCount: 4, winCount: 2, epoch: 1, product: 'TMF',
    lastBarDate: '2026-11-04', lastClose: 22000, position: null, pending: null, halted: false,
    equityCurve: [
      { d: '2026-10-30', e: 1010000, p: 1, c: 21800 },
      { d: '2026-11-02', e: 1015000, p: 1, c: 21900 },
      { d: '2026-11-03', e: 1005000, p: 1, c: 21850 },
      { d: '2026-11-04', e: 1030000, p: 0, c: 22000 },
    ],
    ...extra,
  };
}

function seeded(extra = {}) {
  return load({
    'taifex_configs/default': { mode: 'auto', product: 'TMF', riskPerTradePct: 1.5, maxContracts: 5, strategyVariant: 'baseline' },
    'taifex_paper_accounts/default': account(),
    'taifex_paper_accounts/v_baseline': account({ variant: 'baseline' }),
    'taifex_paper_trades/t1': { accountId: 'default', epoch: 1, side: 'long', contracts: 2, openDate: '2026-10-28', closeDate: '2026-11-04', entryPrice: 21700, exitPrice: 22000, pnlPoints: 300, netPnl: 5800, costs: 200, exitReason: 'signal' },
    'taifex_paper_trades/t0': { accountId: 'default', epoch: 1, side: 'short', contracts: 1, openDate: '2026-10-20', closeDate: '2026-10-27', netPnl: -900, exitReason: 'stop' },
    'taifex_signals/2026-11-04': { date: '2026-11-04', close: 22000, composite: 0.41, factors: { trend: { raw: 1, score: 0.5 }, pcr: { raw: 1, score: null } }, desired: 'long' },
    ...extra,
  });
}

test('defaults mirror the frozen rules and a tuning doc with any out-of-range section falls back to null', () => {
  const { c } = load();
  const d = plain(c.tfTuningDefaults_());
  assert.deepEqual(d.params, plain(c.tfParams_({})));
  assert.deepEqual(d.weights, plain(c.TAIFEX_FACTOR_WEIGHTS));
  assert.equal(d.tech.entry, c.TAIFEX_TECH_RULES.entry);
  assert.deepEqual(plain(c.tfNormalizeTuningDoc_(null)), { version: 0, params: null, weights: null, tech: null, reviewId: null });
  const ok = c.tfNormalizeTuningDoc_({ version: 3, params: { ...d.params, entry: 0.3 }, weights: d.weights, tech: d.tech, reviewId: 'r' });
  assert.equal(ok.params.entry, 0.3);
  assert.equal(ok.version, 3);
  assert.ok(ok.weights && ok.tech);
  // 範圍外 / 缺 key / 權重總和不是 1 → 那一區整個不採用
  assert.equal(c.tfNormalizeTuningDoc_({ params: { ...d.params, entry: 0.9 } }).params, null);
  assert.equal(c.tfNormalizeTuningDoc_({ params: { entry: 0.3 } }).params, null);
  assert.equal(c.tfNormalizeTuningDoc_({ params: { ...d.params, exit: 0.3, entry: 0.3 } }).params, null);
  assert.equal(c.tfNormalizeTuningDoc_({ weights: { ...d.weights, trend: 0.5 } }).weights, null);
  assert.equal(c.tfNormalizeTuningDoc_({ tech: { ...d.tech, weights: { trend: 1 } } }).tech, null);
});

test('proposal merges partial changes, reports a diff, and rejects anything outside the bounds', () => {
  const { c } = load();
  const d = c.tfTuningDefaults_();
  const base = { params: d.params, weights: d.weights, risk: { riskPerTradePct: 1.5, maxContracts: 5, maxDrawdownPct: 20, allowShort: true }, tech: d.tech };
  const res = plain(c.tfProposeTuning_({
    params: { entry: 0.3, stopAtr: 2 },
    weights: { trend: 0.35, pcr: 0.05 },
    risk: { riskPerTradePct: 1.2, allowShort: false },
    tech: { entry: 0.45, weights: { trend: 0.4, rsi: 0.15 } },
  }, base));
  assert.deepEqual(res.errors, []);
  assert.equal(res.proposed.params.entry, 0.3);
  assert.equal(res.proposed.params.trailAtr, 3);
  assert.equal(res.proposed.weights.trend, 0.35);
  assert.equal(res.proposed.risk.maxContracts, 5);
  assert.equal(res.proposed.risk.allowShort, false);
  assert.equal(res.proposed.tech.weights.trend, 0.4);
  assert.equal(res.proposed.tech.stopAtr, 2);
  // stopAtr 與目前相同 → 不算變更
  assert.deepEqual(res.diff.map((x) => x.section + '.' + x.key).sort(), [
    'params.entry', 'risk.allowShort', 'risk.riskPerTradePct', 'tech.entry', 'tech.weights.rsi', 'tech.weights.trend', 'weights.pcr', 'weights.trend',
  ]);
  assert.deepEqual(plain(c.tfTuneSections_(res.diff)), ['params', 'weights', 'risk', 'tech']);
  assert.ok(c.tfTuneDiffLines_(res.diff).some((l) => l === '進場門檻：0.35 → 0.3'));

  const bad = (changes) => c.tfProposeTuning_(changes, base);
  assert.match(bad({ params: { entry: 0.9 } }).errors[0], /超出範圍/);
  assert.match(bad({ params: { warmup: 10 } }).errors[0], /不是可調整/);
  assert.match(bad({ params: { entry: '0.3' } }).errors[0], /必須是數字/);
  assert.match(bad({ params: { entry: 0.2, exit: 0.25 } }).errors[0], /exit 必須小於/);
  assert.match(bad({ weights: { trend: 0.4 } }).errors[0], /總和要等於 1/);
  assert.match(bad({ weights: { trend: 0.6, pcr: 0 } }).errors[0], /超出範圍/);
  assert.match(bad({ risk: { riskPerTradePct: 10 } }).errors[0], /超出範圍/);
  assert.match(bad({ risk: { initialCapital: 5 } }).errors[0], /不是可調整/);
  assert.match(bad({ tech: { weights: { macd: 0.9 } } }).errors[0], /超出範圍/);
  assert.match(bad({ sentiment: { weight: 1 } }).errors[0], /不認得的區塊/);
  assert.equal(bad({ params: { entry: 0.9 } }).proposed, null);
});

test('factor weights carried on params change the signal; default params leave it untouched', () => {
  const { c } = load();
  const series = c.tfPrepareSeries_(GOLDEN_BARS);
  const i = GOLDEN_BARS.length - 1;
  const def = c.tfSignalAt_(series, i, {});
  assert.deepEqual(plain(c.tfSignalAt_(series, i, { params: {} })), plain(def));
  assert.deepEqual(plain(c.tfSignalAt_(series, i, { params: { weights: c.TAIFEX_FACTOR_WEIGHTS } })), plain(def));
  const tilted = c.tfSignalAt_(series, i, { params: { weights: { trend: 0, breakout: 0, tsmom: 0, foreignFlow: 0.5, pcr: 0.5 } } });
  assert.notEqual(tilted.quantScore, def.quantScore);
  // 不完整的權重不採用
  assert.equal(c.tfParamWeights_({ weights: { trend: 1 } }), null);
  assert.deepEqual(plain(c.tfTunedParams_({ params: { entry: 0.3 }, weights: { trend: 1 } })), { entry: 0.3, weights: { trend: 1 } });
  assert.deepEqual(plain(c.tfVariantParams_('tuned', null, { entry: 0.3 })), { entry: 0.3 });
  assert.deepEqual(plain(c.tfVariantParams_('tuned', null, null)), {});
});

test('intraday rule overrides: thresholds and weights apply, defaults are the frozen object', () => {
  const { c } = load();
  assert.equal(c.tfTechRules_(null), c.TAIFEX_TECH_RULES);
  const r = c.tfTechRules_({ entry: 0.6, stopAtr: 3, weights: { trend: 0.25, macd: 0.25, rsi: 0.25, breakout: 0.25 }, minBars: 1 });
  assert.equal(r.entry, 0.6);
  assert.equal(r.stopAtr, 3);
  assert.equal(r.minBars, c.TAIFEX_TECH_RULES.minBars);
  assert.equal(r.weights.rsi, 0.25);
  const signal = { score: 0.5, close: 110, emaSlow: 100 };
  assert.equal(c.tfTechDecide_(signal, null, true, true).action, 'enter');
  assert.equal(c.tfTechDecide_(signal, null, true, true, r).action, 'hold');
});

test('week range, equity window and trade stats', () => {
  const { c } = load();
  assert.deepEqual(plain(c.tfWeekRange_('2026-11-08')), { start: '2026-11-02', end: '2026-11-08' });
  assert.deepEqual(plain(c.tfWeekRange_('2026-11-02')), { start: '2026-11-02', end: '2026-11-08' });
  assert.deepEqual(plain(c.tfWeekRange_('2026-11-09')), { start: '2026-11-09', end: '2026-11-15' });
  const win = c.tfCurveWindow_(account().equityCurve, '2026-11-02', '2026-11-08', 1000000);
  assert.equal(win.startEquity, 1010000);
  assert.equal(win.pnl, 20000);
  assert.equal(win.days, 3);
  assert.equal(win.pct, 1.98);
  assert.equal(win.maxDrawdownPct, 0.99);
  assert.equal(c.tfCurveWindow_([], '2026-11-02', '2026-11-08', 1000000).pnl, 0);
  const stats = c.tfTradeStats_([{ netPnl: 300, exitReason: 'signal' }, { netPnl: -100, exitReason: 'stop' }, { netPnl: -50, exitReason: 'stop' }]);
  assert.equal(stats.n, 3);
  assert.equal(stats.net, 150);
  assert.equal(stats.winRatePct, 33.3);
  assert.equal(stats.profitFactor, 2);
  assert.deepEqual(plain(stats.byReason), { signal: 1, stop: 2 });
  const tech = c.tfTechWeekStats_([
    { bot: 'm5', session: 'day', entryM: 10, exitTime: '2026-11-03 09:30', netPnl: 100 },
    { bot: 'm5', session: 'night', entryM: 500, exitTime: '2026-11-08 04:00', netPnl: -40 },
    { bot: 'm5', session: 'day', entryM: 10, exitTime: '2026-10-30 09:30', netPnl: 999 },
  ], '2026-11-02', '2026-11-08');
  assert.equal(tech.m5.all.n, 2);
  assert.equal(tech.m5.all.net, 60);
  assert.equal(tech.m5.night.n, 1);
  assert.equal(tech.m5.entryBuckets.d1.n, 1);
});

test('weekly review tool returns the week, the effective values and the bounds', () => {
  const env = seeded();
  const out = plain(env.c.hubRunTool_('taifex_weekly_review', {}));
  assert.deepEqual(out.week, { start: '2026-11-02', end: '2026-11-08' });
  assert.equal(out.main.week.pnl, 20000);
  assert.equal(out.main.weekTrades.length, 1);
  assert.equal(out.main.weekTradeStats.net, 5800);
  assert.equal(out.main.variant, 'baseline');
  assert.equal(out.main.params.entry, 0.35);
  assert.equal(out.signals[0].factors.trend, 0.5);
  assert.equal(out.variants.find((v) => v.key === 'baseline').weekPnl, 20000);
  assert.equal(out.variants.find((v) => v.key === 'tuned').missing, true);
  assert.deepEqual(out.tuning.bounds.params.entry, [0.15, 0.6]);
  assert.equal(out.tuning.current.risk.riskPerTradePct, 1.5);
  assert.ok(env.c.hubToolNames_().includes('taifex_weekly_review'));
  assert.match(env.c.hubRunTool_('taifex_weekly_review', { weekEnd: 'nope' }).error, /yyyy-MM-dd/);
  assert.ok(load().c.hubRunTool_('taifex_weekly_review', {}).error);
});

test('preview does not write; commit stores a proposal and changes no parameter', () => {
  const env = seeded();
  const { c, store, sent } = env;
  const args = {
    summary: '本週多單獲利出場，分數在 0.4 附近來回，盤整期訊號偏多但進場太晚。',
    findings: ['突破因子本週貢獻最大'],
    algorithmIdeas: ['加入夜盤漲跌作為隔日開盤的過濾條件'],
    prUrl: 'https://github.com/example/RMoney/pull/99',
    rationale: '近四週訊號多在 0.30–0.35 就反轉，降低門檻可以早一根進場；回測樣本外沒有變差。',
    changes: { params: { entry: 0.3 }, risk: { riskPerTradePct: 1.2 } },
  };
  const before = JSON.stringify(store);
  const preview = c.hubWriteRunTool_('preview_taifex_review', args, CTX);
  assert.equal(preview.error, undefined, JSON.stringify(preview));
  assert.equal(JSON.stringify(store), before);
  assert.deepEqual(plain(preview.changes), ['進場門檻：0.35 → 0.3', '每筆風險 %：1.5 → 1.2']);
  assert.equal(preview.switchesMainAccountToTunedVariant, true);
  assert.ok(preview.backtest.current.full && preview.backtest.proposed.outOfSample);
  assert.equal(preview.weekEnd, '2026-11-08');

  const committed = c.hubWriteRunTool_('commit_taifex_review', { previewId: preview.previewId }, CTX);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.status, 'proposed');
  const review = store['taifex_reviews/2026-11-08'];
  assert.equal(review.status, 'proposed');
  assert.equal(review.proposal.proposed.params.entry, 0.3);
  assert.equal(review.week.pnl, 20000);
  assert.equal(review.prUrl, args.prUrl);
  // 還沒核准：調校值與設定都沒動
  assert.equal(store['taifex_tuning/current'], undefined);
  assert.equal(store['taifex_configs/default'].riskPerTradePct, 1.5);
  assert.equal(store['taifex_configs/default'].strategyVariant, 'baseline');
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /調整提案（尚未生效）/);
  assert.ok(Object.keys(store).some((k) => k.startsWith('audit_logs/')));
  // previewId 只能用一次；別的連線拿不走
  assert.match(c.hubWriteRunTool_('commit_taifex_review', { previewId: preview.previewId }, CTX).error, /not found or expired/);
  const again = c.hubWriteRunTool_('preview_taifex_review', args, CTX);
  assert.match(c.hubWriteRunTool_('commit_taifex_review', { previewId: again.previewId }, { uid: 'someone-else' }).error, /another connection/);
});

test('preview validation: bad changes, missing rationale, bad PR url, no-change review', () => {
  const { c, store } = seeded();
  const summary = '本週沒有交易，訊號維持空手，沒有需要調整的地方。';
  const run = (args) => c.hubWriteRunTool_('preview_taifex_review', args, CTX);
  assert.match(run({ summary: '短' }).error, /summary is required/);
  assert.match(run({ summary, changes: { params: { entry: 0.9 } } }).error, /超出範圍/);
  assert.match(run({ summary, changes: { params: { entry: 0.3 } } }).error, /rationale is required/);
  assert.match(run({ summary, prUrl: 'https://evil.example/pull/1' }).error, /GitHub pull request/);
  assert.match(run({ summary, weekEnd: '2027-01-01' }).error, /not started/);
  const same = run({ summary, changes: { params: { entry: 0.35 } } });
  assert.equal(same.willSaveAs, '不調整的檢討');
  const none = run({ summary });
  const saved = c.hubWriteRunTool_('commit_taifex_review', { previewId: none.previewId }, CTX);
  assert.equal(saved.status, 'no_change');
  assert.equal(store['taifex_reviews/2026-11-08'].proposal, null);
});

test('owner applies a proposal: tuning + config + variant switch, then reverts it', () => {
  const env = seeded();
  const { c, store, cache } = env;
  const preview = c.hubWriteRunTool_('preview_taifex_review', {
    summary: '本週表現持平，建議小幅調整門檻、因子權重與盤中規則。',
    rationale: '外資部位因子近八週方向正確率最高；盤中 5 分頻率進場過於頻繁。',
    changes: { params: { entry: 0.3 }, weights: { foreignFlow: 0.25, pcr: 0.05 }, risk: { maxContracts: 3 }, tech: { entry: 0.5 } },
  }, CTX);
  assert.equal(preview.error, undefined, JSON.stringify(preview));
  c.hubWriteRunTool_('commit_taifex_review', { previewId: preview.previewId }, CTX);
  c.loadTaifexTuning_();
  assert.ok(cache['taifex-tuning-v1']);

  assert.equal(c.applyTaifexReview({ id: 'bad' }, AUTH).ok, false);
  assert.equal(c.applyTaifexReview({ id: '2026-11-01' }, AUTH).ok, false);
  const applied = c.applyTaifexReview({ id: '2026-11-08' }, AUTH);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.switchedVariant, true);
  const tuning = store['taifex_tuning/current'];
  assert.equal(tuning.version, 1);
  assert.equal(tuning.params.entry, 0.3);
  assert.equal(tuning.weights.foreignFlow, 0.25);
  assert.equal(tuning.tech.entry, 0.5);
  assert.equal(tuning.reviewId, '2026-11-08');
  assert.equal(store['taifex_configs/default'].strategyVariant, 'tuned');
  assert.equal(store['taifex_configs/default'].maxContracts, 3);
  assert.equal(store['taifex_configs/default'].product, 'TMF');
  assert.equal(store['taifex_reviews/2026-11-08'].status, 'applied');
  assert.equal(store['taifex_reviews/2026-11-08'].summary.length > 0, true);
  assert.equal(cache['taifex-tuning-v1'], undefined);
  // 生效：調校變體拿到新門檻與權重，盤中規則也換了
  const loaded = c.loadTaifexTuning_();
  assert.equal(c.tfVariantParams_('tuned', null, c.tfTunedParams_(loaded)).weights.pcr, 0.05);
  assert.equal(c.tfTechRules_(loaded.tech).entry, 0.5);
  // 已套用的不能再套用、不能被 MCP 取代
  assert.equal(c.applyTaifexReview({ id: '2026-11-08' }, AUTH).ok, false);
  assert.match(c.hubWriteRunTool_('preview_taifex_review', { summary: '想要覆蓋已經套用的那一份檢討內容。' }, CTX).error, /already been applied/);

  const reverted = c.revertTaifexTuning({ id: '2026-11-08' }, AUTH);
  assert.equal(reverted.ok, true, JSON.stringify(reverted));
  assert.equal(store['taifex_tuning/current'].params, null);
  assert.equal(store['taifex_tuning/current'].tech, null);
  assert.equal(store['taifex_tuning/current'].version, 2);
  assert.equal(store['taifex_configs/default'].strategyVariant, 'baseline');
  assert.equal(store['taifex_configs/default'].maxContracts, 5);
  assert.equal(store['taifex_reviews/2026-11-08'].status, 'reverted');
  assert.equal(c.revertTaifexTuning({ id: '2026-11-08' }, AUTH).ok, false);
});

test('reject leaves everything untouched; apply re-validates a tampered proposal', () => {
  const { c, store } = seeded();
  const make = () => {
    const p = c.hubWriteRunTool_('preview_taifex_review', {
      summary: '本週停損兩次，建議把初始停損放寬一點。', rationale: '兩次停損後價格都回到進場方向，停損距離過近。', changes: { params: { stopAtr: 2.5 } },
    }, CTX);
    c.hubWriteRunTool_('commit_taifex_review', { previewId: p.previewId }, CTX);
  };
  make();
  assert.equal(c.rejectTaifexReview({ id: '2026-11-08' }, AUTH).ok, true);
  assert.equal(store['taifex_reviews/2026-11-08'].status, 'rejected');
  assert.equal(store['taifex_tuning/current'], undefined);
  assert.equal(c.applyTaifexReview({ id: '2026-11-08' }, AUTH).ok, false);
  // 被退回的那一週可以重新提案
  make();
  assert.equal(store['taifex_reviews/2026-11-08'].status, 'proposed');
  store['taifex_reviews/2026-11-08'].proposal.proposed.params.stopAtr = 40;
  const res = c.applyTaifexReview({ id: '2026-11-08' }, AUTH);
  assert.equal(res.ok, false);
  assert.match(res.error, /超出範圍/);
  assert.equal(store['taifex_tuning/current'], undefined);
});
