const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/**
 * Claude.gs + AiBudget.gs：request body、計價、計費週期（23 號重置）、用量彙總、HTTP 呼叫流程。
 * UrlFetchApp / Firestore 都是假物件，不碰網路。
 */
function pad(n) { return String(n).padStart(2, '0'); }

/** 只實作測試用到的格式（Asia/Taipei 固定 +8，無 DST） */
function formatDate(date, tz, pattern) {
  const shifted = tz === 'UTC' ? new Date(date.getTime()) : new Date(date.getTime() + 8 * 3600000);
  const y = shifted.getUTCFullYear();
  const M = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  return pattern
    .replace('yyyy', String(y))
    .replace('MM', pad(M))
    .replace('dd', pad(d))
    .replace(/\bM\b/, String(M))
    .replace(/\bd\b/, String(d));
}

function load(options = {}) {
  const store = options.store || {};
  const fetched = [];
  const context = vm.createContext({ console, Date, Math, Number, String, Array, Object, JSON, RegExp, isFinite, isNaN, Error });
  context.TZ = 'Asia/Taipei';
  context.PROP = { getProperty: (k) => ({ ANTHROPIC_API_KEY: options.apiKey === undefined ? 'sk-test' : options.apiKey }[k] || null) };
  context.CacheService = { getScriptCache: () => ({ get: () => 'owner-1', put: () => {} }) };
  context.Utilities = { formatDate };
  context.fsGetDoc_ = (p) => store[p] || null;
  context.fsSetDoc_ = (p, data) => { store[p] = { ...(store[p] || {}), ...data }; };
  context.fsAddDoc_ = (col, data) => { (store[col] = store[col] || []).push(data); };
  context.fsRunQuery_ = () => store.ai_usage_events || [];
  context.sendNotification_ = (key, msg) => { (store.notifications = store.notifications || []).push({ key, msg }); };
  context.importParseJsonLoosely_ = (text) => {
    try { return { ok: true, data: JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')), repaired: false }; }
    catch (e) { return { ok: false }; }
  };
  context.UrlFetchApp = {
    fetch: (url, req) => {
      fetched.push({ url, req, body: JSON.parse(req.payload) });
      const next = options.responses.shift();
      return { getResponseCode: () => next.code || 200, getContentText: () => JSON.stringify(next.body) };
    },
  };
  for (const file of ['Claude.gs', 'AiBudget.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  return { context, store, fetched };
}

test('payload: no sampling params, images before text, fallbacks only on supported models', () => {
  const { context } = load({ responses: [] });
  const body = context.claudeBuildPayload_({
    model: 'claude-opus-5-5', prompt: '看收據', effort: 'low', maxTokens: 4000,
    images: [{ mediaType: 'image/webp', data: 'AAAA' }],
  });
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_tokens, 4000);
  assert.deepEqual(JSON.parse(JSON.stringify(body.output_config)), { effort: 'low' });
  assert.equal(body.messages[0].content[0].type, 'image');
  assert.equal(body.messages[0].content[1].text, '看收據');
  assert.equal(body.fallbacks, 'default');
  const haiku = context.claudeBuildPayload_({ model: 'claude-haiku-5-5', prompt: 'x', webSearchMaxUses: 3 });
  assert.equal(haiku.fallbacks, undefined);
  assert.equal(haiku.tools[0].type, 'web_search_20260209');
  assert.equal(haiku.tools[0].max_uses, 3);
});

test('headers: version 2026-10-21, fallback beta only when fallbacks are sent', () => {
  const { context } = load({ responses: [] });
  const withFallback = context.claudeHeaders_({ fallbacks: 'default' });
  assert.equal(withFallback['anthropic-version'], '2026-10-21');
  assert.equal(withFallback['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(context.claudeHeaders_({})['anthropic-beta'], undefined);
});

test('cost: tokens priced per model, web search $0.01 each, haiku long-context tier', () => {
  const { context } = load({ responses: [] });
  const usage = { inputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100000, webSearchRequests: 3 };
  assert.ok(Math.abs(context.aiEstimateClaudeCostUSD_('claude-opus-5-5', usage) - (4 + 2 + 0.03)) < 1e-9);
  const small = { inputTokens: 50000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000, webSearchRequests: 0 };
  assert.ok(Math.abs(context.aiEstimateClaudeCostUSD_('claude-haiku-5-5', small) - (0.005 + 0.0005)) < 1e-9);
  const big = { inputTokens: 200000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000, webSearchRequests: 0 };
  assert.ok(Math.abs(context.aiEstimateClaudeCostUSD_('claude-haiku-5-5', big) - (0.1 + 0.0025)) < 1e-9);
});

test('billing cycle resets on the 23rd (Asia/Taipei)', () => {
  const { context } = load({ responses: [] });
  // 台北 2026-11-12 → 本期 10/23 ~ 11/23
  let b = context.aiCycleBounds_(new Date('2026-11-12T04:00:00Z'), 23, 0);
  assert.equal(b.start.toISOString(), '2026-10-22T16:00:00.000Z');
  assert.equal(b.end.toISOString(), '2026-11-22T16:00:00.000Z');
  // 台北 11/23 00:30（UTC 11/22 16:30）已進入新的一期
  b = context.aiCycleBounds_(new Date('2026-11-22T16:30:00Z'), 23, 0);
  assert.equal(b.start.toISOString(), '2026-11-22T16:00:00.000Z');
  // 上一期 + 跨年
  b = context.aiCycleBounds_(new Date('2027-01-05T04:00:00Z'), 23, -1);
  assert.equal(b.start.toISOString(), '2026-11-22T16:00:00.000Z');
  assert.equal(b.end.toISOString(), '2026-12-22T16:00:00.000Z');
});

test('summary counts only Anthropic events of the owner', () => {
  const { context } = load({ responses: [] });
  const s = context.aiSummarizeEvents_([
    { userId: 'u', provider: 'anthropic', feature: 'financeAsk', model: 'claude-opus-5-5', totalTokens: 100, costUSD: 0.5, occurredDateTW: '2026-11-01' },
    { userId: 'u', provider: 'anthropic', feature: 'receiptOcr', model: 'claude-opus-5-5', totalTokens: 50, costUSD: 0.25, occurredDateTW: '2026-11-01' },
    { userId: 'u', feature: 'financeAsk', model: 'gemini-3.8-flash', tokenCostUSD: 9 },
    { userId: 'other', provider: 'anthropic', costUSD: 9 },
  ], 'u');
  assert.equal(s.totals.requests, 2);
  assert.equal(s.totals.costUSD, 0.75);
  assert.equal(s.byFeature.financeAsk.requests, 1);
  assert.equal(s.byDay['2026-11-01'], 0.75);
});

test('callClaude_ records usage, joins text blocks, and continues pause_turn', () => {
  const { context, store, fetched } = load({
    store: { 'ai_budget_configs/owner-1': { defaultModel: 'claude-sonnet-5-5' } },
    responses: [
      { body: { model: 'claude-sonnet-5-5', stop_reason: 'pause_turn', content: [{ type: 'text', text: 'searching' }],
        usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 2 } } } },
      { body: { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":1}' }],
        usage: { input_tokens: 200, output_tokens: 20 } } },
    ],
  });
  const res = context.callClaudeJson_({ feature: 'test', prompt: 'hi', webSearchMaxUses: 2 });
  assert.equal(res.json.a, 1);
  assert.equal(fetched.length, 2);
  assert.equal(fetched[0].body.model, 'claude-sonnet-5-5');
  assert.equal(fetched[1].body.messages.length, 2);
  assert.equal(fetched[0].req.headers['x-api-key'], 'sk-test');
  assert.equal(store.ai_usage_events.length, 2);
  assert.equal(store.ai_usage_events[0].provider, 'anthropic');
  assert.equal(store.ai_usage_events[0].webSearchRequests, 2);
});

test('hard stop blocks calls once the cycle credit is spent', () => {
  const now = new Date();
  const { context, fetched } = load({
    store: {
      'ai_budget_configs/owner-1': { hardStopEnabled: true, monthlyCreditUSD: 1 },
      ai_usage_events: [{ userId: 'owner-1', provider: 'anthropic', costUSD: 1.2, occurredAt: now }],
    },
    responses: [],
  });
  assert.throws(() => context.callClaude_({ feature: 'x', prompt: 'hi' }), /本期額度已用完/);
  assert.equal(fetched.length, 0);
});

test('missing key and HTTP errors surface readable messages', () => {
  const noKey = load({ apiKey: '', responses: [] });
  assert.throws(() => noKey.context.callClaude_({ prompt: 'x' }), /ANTHROPIC_API_KEY/);
  const unauthorized = load({ responses: [{ code: 401, body: { error: { message: 'bad key' } } }] });
  assert.throws(() => unauthorized.context.callClaude_({ prompt: 'x' }), /API key 無效/);
  const refused = load({ responses: [{ body: { model: 'claude-opus-5-5', stop_reason: 'refusal', content: [], usage: { input_tokens: 5 } } }] });
  assert.throws(() => refused.context.callClaude_({ prompt: 'x' }), /拒絕/);
});
