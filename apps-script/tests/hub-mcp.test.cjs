const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/**
 * HubTools.gs（唯讀資料工具）+ Mcp.gs（MCP JSON-RPC 端點）+ Claude.gs claudeAgentLoop_ +
 * ClaudeAnalysis.gs（Claude 自己查資料的分析流程）。Firestore / UrlFetchApp 都是假物件。
 */
function pad(n) { return String(n).padStart(2, '0'); }

function formatDate(date, tz, pattern) {
  const shifted = tz === 'UTC' ? new Date(date.getTime()) : new Date(date.getTime() + 8 * 3600000);
  return pattern
    .replace('yyyy', String(shifted.getUTCFullYear()))
    .replace('MM', pad(shifted.getUTCMonth() + 1))
    .replace('dd', pad(shifted.getUTCDate()))
    .replace('EEEE', 'Thursday')
    .replace(/\bM\b/, String(shifted.getUTCMonth() + 1));
}

const TOKEN = 'rmcp_' + 'a'.repeat(43);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function tw(dateStr) { return new Date(`${dateStr}T12:00:00+08:00`); }

function load(options = {}) {
  const props = { ANTHROPIC_API_KEY: 'sk-test', ...(options.props || {}) };
  const cacheStore = { 'ai-budget-owner-id': 'owner-1' };
  const docs = options.docs || {};
  const collections = options.collections || {};
  const txs = options.txs || [];
  const fetched = [];
  const responses = options.responses || [];
  const context = vm.createContext({ console: { ...console, error: () => {}, warn: () => {} }, Date, Math, Number, String, Array, Object, JSON, RegExp, isFinite, isNaN, Error, parseInt });
  context.TZ = 'Asia/Taipei';
  context.PROP = {
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = v; },
    setProperties: (obj) => Object.assign(props, obj),
    deleteProperty: (k) => { delete props[k]; },
  };
  context.CacheService = { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) };
  context.Utilities = {
    formatDate,
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (_alg, text) => Array.from(crypto.createHash('sha256').update(text).digest()).map((b) => (b > 127 ? b - 256 : b)),
  };
  context.ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
  };
  context.fsGetDoc_ = (p) => docs[p] || null;
  context.fsSetDoc_ = () => {};
  context.fsAddDoc_ = (col, data) => { (collections[col] = collections[col] || []).push(data); };
  context.fsListDocs_ = (p) => collections[p] || [];
  context.fsListAllDocs_ = (p) => collections[p] || [];
  context.fsRunQuery_ = (_parent, q) => {
    const col = q.from[0].collectionId;
    if (col === 'transactions') {
      const tripId = q.where && q.where.fieldFilter && q.where.fieldFilter.value.stringValue;
      return txs.filter((t) => t.tripId === tripId);
    }
    if (col === 'ai_usage_events') return [];
    return (collections[_parent ? `${_parent}/${col}` : col] || []).slice(0, q.limit || 1000);
  };
  context.queryTxsBetween_ = (start, end) => txs.filter((t) => t.date >= start && t.date <= end);
  context.isConsumptionExpense_ = (t) => !t.deletedAt && t.type === 'expense';
  context.isEarnedIncome_ = (t) => !t.deletedAt && t.type === 'income';
  context.getLatestSnapshot_ = () => options.snapshot || null;
  context.accountBalanceTWD_ = (a) => a.balance;
  context.sendNotification_ = () => {};
  context.importParseJsonLoosely_ = () => ({ ok: false });
  context.UrlFetchApp = {
    fetch: (url, req) => {
      fetched.push({ url, body: JSON.parse(req.payload) });
      const next = responses.shift();
      if (!next) throw new Error('unexpected Claude call');
      return { getResponseCode: () => next.code || 200, getContentText: () => JSON.stringify(next.body) };
    },
  };
  for (const file of ['FlightIngest.gs', 'FlightWatches.gs', 'Claude.gs', 'AiBudget.gs', 'Ask.gs', 'HubTools.gs', 'HubWriteTools.gs', 'Mcp.gs', 'ClaudeAnalysis.gs']) {
    // FlightIngest.gs 只需要它的 sha256 / safeEqual helper；FlightWatches.gs 提供機票工具用的航線 / 艙等 helper
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  return { context, props, fetched, cacheStore };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function post(context, rpc, { key, wrapped, gateway, urlKey } = {}) {
  // key / wrapped：bridge 的 { mcpToken, rpc }；gateway：閘道的 { gatewaySecret, rpc }；urlKey：已移除的 ?key= 模式
  const token = key || wrapped;
  const e = {
    parameter: urlKey ? { action: 'mcp', key: urlKey } : { action: 'mcp' },
    postData: { contents: JSON.stringify(gateway ? { gatewaySecret: gateway, rpc } : token ? { mcpToken: token, rpc } : rpc) },
  };
  const out = context.mcpEndpoint_(e, 'POST');
  return out.text === '' ? null : JSON.parse(out.text);
}

const SAMPLE = {
  props: { MCP_TOKEN_SHA256: sha256(TOKEN), MCP_TOKEN_UID: 'owner-1' },
  docs: {
    'trips/trip1': { name: '東京', destination: ['Tokyo'], startDate: tw('2026-12-20'), endDate: tw('2026-12-25'), budget: 80000, status: 'planning', userId: 'owner-1', members: [{ name: 'Owner', email: 'x@example.com' }] },
    'itineraries/trip1': { title: '東京五日', summary: '美食為主' },
    'stocks/2330': { name: '台積電', market: 'TW', currency: 'TWD', currentPrice: 1000, prevClose: 990 },
  },
  collections: {
    trips: [{ _name: 'projects/p/databases/(default)/documents/trips/trip1', name: '東京', destination: ['Tokyo'], startDate: tw('2026-12-20'), endDate: tw('2026-12-25'), budget: 80000, status: 'planning', userId: 'owner-1' }],
    'itineraries/trip1/days': [{ _name: 'x/days/2026-12-20', date: '2026-12-20', theme: '抵達' }],
    'itineraries/trip1/days/2026-12-20/items': [
      { order: 2, title: '晚餐', type: 'meal', startTime: '19:00', estimatedCost: 3000, placeId: 'secret-place' },
      { order: 1, title: '成田機場', type: 'transport', startTime: '14:00' },
    ],
    recurring: [
      { _name: 'x/recurring/r1', active: true, userId: 'owner-1', frequency: 'monthly', template: { amount: 390, note: 'Netflix' } },
      { _name: 'x/recurring/r2', active: false, frequency: 'monthly', template: { amount: 100, note: 'old' } },
    ],
    categories: [{ _name: 'x/categories/food', key: 'food', name: '餐飲' }],
  },
  txs: [
    { date: tw('2026-10-03'), type: 'expense', amountTWD: 390, category: 'food', note: 'Netflix', tripId: null },
    { date: tw('2026-09-03'), type: 'expense', amountTWD: 390, category: 'food', note: 'Netflix' },
    { date: tw('2026-10-10'), type: 'expense', amountTWD: 1200, category: 'food', note: '燒肉', tripId: 'trip1' },
    { date: tw('2026-10-11'), type: 'income', amountTWD: 50000, category: 'salary', note: '薪水' },
  ],
  snapshot: {
    date: '2026-11-11', totalValueTWD: 1000000, totalCostTWD: 800000,
    positions: [
      { symbol: '2330', market: 'TW', shares: 500, valueTWD: 600000, pnlTWD: 150000, pnlPct: 33.3 },
      { symbol: 'AAPL', market: 'US', shares: 30, valueTWD: 400000, pnlTWD: 50000, pnlPct: 14.2 },
    ],
  },
};

test('tool list: unique names, object schemas, every name is runnable', () => {
  const { context } = load(SAMPLE);
  const defs = plain(context.hubToolDefs_());
  const names = defs.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of defs) {
    assert.equal(t.input_schema.type, 'object');
    assert.ok(t.description.length > 5);
  }
  assert.ok(names.includes('hub_catalog') && names.includes('trip_itinerary') && names.includes('portfolio_positions'));
  assert.ok(names.includes('flight_watches') && names.includes('flight_price_history') && names.includes('flight_date_prices'));
  // 純唯讀：不該出現任何寫入動詞
  assert.equal(names.some((n) => /^(create|update|delete|set|add|write)_/.test(n)), false);
});

test('portfolio_positions filters by market and computes weights', () => {
  const { context } = load(SAMPLE);
  const out = plain(context.hubRunTool_('portfolio_positions', { market: 'US' }));
  assert.equal(out.positions.length, 1);
  assert.equal(out.positions[0].symbol, 'AAPL');
  assert.equal(out.positions[0].weightPct, 40);
});

test('trip tools: list → detail (spend from tx) → itinerary sorted, internal fields hidden', () => {
  const { context } = load(SAMPLE);
  const trips = plain(context.hubRunTool_('list_trips', { status: 'planning' }));
  assert.equal(trips.trips[0].tripId, 'trip1');
  assert.equal(trips.trips[0].startDate, '2026-12-20');
  const detail = plain(context.hubRunTool_('trip_detail', { tripId: 'trip1' }));
  assert.equal(detail.spentTWD, 1200);
  assert.deepEqual(detail.members, ['Owner']);
  assert.equal(JSON.stringify(detail).includes('example.com'), false);
  const itin = plain(context.hubRunTool_('trip_itinerary', { tripId: 'trip1' }));
  assert.deepEqual(itin.days[0].items.map((i) => i.title), ['成田機場', '晚餐']);
  assert.equal(JSON.stringify(itin).includes('secret-place'), false);
  assert.equal(plain(context.hubRunTool_('trip_detail', { tripId: '../users/x' })).error, 'bad tripId');
});

test('list_records: active filter, hidden fields stripped, unknown dataset rejected', () => {
  const { context } = load(SAMPLE);
  const out = plain(context.hubRunTool_('list_records', { dataset: 'recurring' }));
  assert.equal(out.count, 1);
  assert.equal(out.records[0].id, 'r1');
  assert.equal(out.records[0].userId, undefined);
  assert.equal(out.records[0].template.note, 'Netflix');
  assert.equal(plain(context.hubRunTool_('list_records', { dataset: 'recurring', activeOnly: false })).count, 2);
  assert.match(plain(context.hubRunTool_('list_records', { dataset: 'users' })).error, /unknown dataset/);
});

const FLIGHT_WINDOW = { cabin: 'economy', airline: 'JL', stops: 0 };
const FLIGHT_SAMPLE = {
  ...SAMPLE,
  docs: {
    ...SAMPLE.docs,
    'flight_watches/w1': { origin: 'TPE', destination: 'NRT', segmentLabel: '寒假', userId: 'owner-1', departureStart: tw('2099-01-20'), departureEnd: tw('2099-02-10'),
      minNights: 4, maxNights: 6, adults: 2, selectedCabins: ['economy', 'business'], scanProvider: 'claude', maxPriceTWD: 20000, bestPriceTWD: 21000 },
  },
  collections: {
    ...SAMPLE.collections,
    flight_watches: [
      { _name: 'x/flight_watches/w1', origin: 'TPE', destination: 'NRT', segmentLabel: '寒假', userId: 'owner-1', sharedWith: ['u2'], departureStart: tw('2099-01-20'), departureEnd: tw('2099-02-10'),
        minNights: 4, maxNights: 6, adults: 2, selectedCabins: ['economy', 'business'], scanProvider: 'claude', maxPriceTWD: 20000, bestPriceTWD: 21000, lastCheckedAt: tw('2026-11-10'),
        latestEstimate: { checkedAt: tw('2026-11-10'), minPriceTWD: 22000, typicalPriceTWD: 26000, maxPriceTWD: 31000, confidence: 'medium', advice: 'watch',
          cabinEstimates: [{ cabin: 'economy', minPriceTWD: 22000, typicalPriceTWD: 26000, maxPriceTWD: 31000, bestAirline: 'JL' }], sources: [{ url: 'https://example.com' }] } },
      { _name: 'x/flight_watches/w2', origin: 'TPE', destination: 'KIX', enabled: false, departureStart: tw('2099-03-01'), departureEnd: tw('2099-03-10'), scanProvider: 'claude' },
    ],
    // 新到舊（orderBy checkedAt desc）
    'flight_watches/w1/snapshots': [
      { checkedAt: tw('2026-11-10'), minPriceTWD: 22000, typicalPriceTWD: 26000, maxPriceTWD: 31000, confidence: 'medium',
        cabinEstimates: [{ cabin: 'economy', minPriceTWD: 22000, typicalPriceTWD: 26000, maxPriceTWD: 31000 }, { cabin: 'business', minPriceTWD: 80000, typicalPriceTWD: 90000, maxPriceTWD: 99000 }],
        travelWindows: [{ ...FLIGHT_WINDOW, departureDate: '2099-01-22', returnDate: '2099-01-27', priceTWD: 22000 }, { ...FLIGHT_WINDOW, departureDate: '2099-02-01', returnDate: '2099-02-06', priceTWD: 25000 }] },
      { checkedAt: new Date('2026-11-09T20:00:00+08:00'), minPriceTWD: 21000, typicalPriceTWD: 25000, maxPriceTWD: 30000, confidence: 'low',
        cabinEstimates: [{ cabin: 'economy', minPriceTWD: 21000, typicalPriceTWD: 25000, maxPriceTWD: 30000 }],
        travelWindows: [{ ...FLIGHT_WINDOW, departureDate: '2099-01-22', returnDate: '2099-01-27', priceTWD: 21000 }, { ...FLIGHT_WINDOW, departureDate: '2020-01-05', returnDate: '2020-01-09', priceTWD: 9000 }] },
      { checkedAt: new Date('2026-11-09T09:00:00+08:00'), minPriceTWD: 23000, typicalPriceTWD: 25000, maxPriceTWD: 30000, confidence: 'medium', cabinEstimates: [], travelWindows: [] },
      { checkedAt: tw('2026-11-08'), minPriceTWD: 26000, typicalPriceTWD: 28000, maxPriceTWD: 33000, confidence: 'medium', cabinEstimates: [],
        travelWindows: [{ ...FLIGHT_WINDOW, departureDate: '2099-01-22', returnDate: '2099-01-27', priceTWD: 26000 }] },
    ],
  },
};

test('flight tools: watch list hides paused / internal fields and carries the latest prices', () => {
  const { context } = load(FLIGHT_SAMPLE);
  const list = plain(context.hubRunTool_('flight_watches', {}));
  assert.equal(list.count, 1);
  const w = list.watches[0];
  assert.deepEqual([w.watchId, w.route, w.segmentLabel, w.targetPriceTWD, w.bestPriceTWD], ['w1', 'TPE → NRT', '寒假', 20000, 21000]);
  assert.deepEqual(w.nights, [4, 6]);
  assert.equal(w.latest.minPriceTWD, 22000);
  assert.equal(w.latest.cabins[0].bestAirline, 'JL');
  assert.equal(JSON.stringify(list).includes('owner-1') || JSON.stringify(list).includes('u2'), false);
  assert.equal(plain(context.hubRunTool_('flight_watches', { includePaused: true })).count, 2);
  // list_records 的啟用判斷用 enabled（不是 active）
  assert.equal(plain(context.hubRunTool_('list_records', { dataset: 'flight_watches' })).count, 1);
});

test('flight_price_history: one point per day (last scan), stats, cabin and date filters', () => {
  const { context } = load(FLIGHT_SAMPLE);
  const h = plain(context.hubRunTool_('flight_price_history', { watchId: 'w1' }));
  assert.equal(h.scans, 4);
  assert.deepEqual(h.points.map((p) => [p.date, p.minPriceTWD]), [['2026-11-08', 26000], ['2026-11-09', 21000], ['2026-11-10', 22000]]);
  assert.equal(h.points[1].lowConfidence, true);
  assert.deepEqual([h.stats.lowestMinTWD, h.stats.lowestDate, h.stats.highestMinTWD, h.stats.latestMinTWD, h.stats.averageMinTWD], [21000, '2026-11-09', 26000, 22000, 23000]);
  assert.equal(h.stats.changeSinceFirstPct, -15.4);
  assert.equal(h.stats.cheaperDaysPct, 33);
  const biz = plain(context.hubRunTool_('flight_price_history', { watchId: 'w1', cabin: 'business' }));
  assert.deepEqual(biz.points.map((p) => p.minPriceTWD), [80000]);
  const ranged = plain(context.hubRunTool_('flight_price_history', { watchId: 'w1', start: '2026-11-10', end: '2026-11-30' }));
  assert.equal(ranged.days, 1);
  assert.deepEqual(plain(context.hubRunTool_('flight_price_history', { watchId: 'w1', start: '2027-01-01' })).points, []);
  assert.ok(context.hubRunTool_('flight_price_history', { watchId: '../x' }).error);
  assert.ok(context.hubRunTool_('flight_price_history', { watchId: 'nope' }).error);
  assert.ok(context.hubRunTool_('flight_price_history', { watchId: 'w1', start: 'yesterday' }).error);
});

test('flight_date_prices: latest / lowest per date pair, cheapest first, past departures hidden by default', () => {
  const { context } = load(FLIGHT_SAMPLE);
  const d = plain(context.hubRunTool_('flight_date_prices', { watchId: 'w1' }));
  assert.equal(d.matched, 2);
  const first = d.dates[0];
  assert.deepEqual([first.departureDate, first.returnDate, first.latestPriceTWD, first.latestSeen, first.lowestPriceTWD, first.lowestSeen, first.highestPriceTWD, first.timesSeen],
    ['2099-01-22', '2099-01-27', 22000, '2026-11-10', 21000, '2026-11-09', 26000, 3]);
  assert.equal(d.dates[1].departureDate, '2099-02-01');
  assert.equal(plain(context.hubRunTool_('flight_date_prices', { watchId: 'w1', upcomingOnly: false })).dates[0].departureDate, '2020-01-05');
  assert.equal(plain(context.hubRunTool_('flight_date_prices', { watchId: 'w1', cabin: 'business' })).matched, 0);
});

test('spend_by_merchant groups by note across months; list_transactions pages', () => {
  const { context } = load(SAMPLE);
  const out = plain(context.hubRunTool_('spend_by_merchant', { start: '2026-09-01', end: '2026-10-31', minMonths: 2 }));
  assert.equal(out.merchants.length, 1);
  assert.equal(out.merchants[0].monthsSeen, 2);
  assert.equal(out.merchants[0].totalTWD, 780);
  const page = plain(context.hubRunTool_('list_transactions', { start: '2026-09-01', end: '2026-10-31', type: 'expense', limit: 1, offset: 1 }));
  assert.equal(page.count, 3);
  assert.equal(page.transactions.length, 1);
  assert.equal(page.transactions[0].note, 'Netflix');
});

test('hubCallTool_: unknown tool and thrown errors come back as isError text', () => {
  const { context } = load(SAMPLE);
  assert.equal(context.hubCallTool_('drop_database', {}).isError, true);
  const ok = context.hubCallTool_('hub_catalog', {});
  assert.equal(ok.isError, false);
  assert.ok(JSON.parse(ok.text).areas.length >= 4);
});

test('mcp: closed without a token, and wrong / malformed tokens get the same error', () => {
  const closed = load({ ...SAMPLE, props: {} });
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
  assert.equal(post(closed.context, init, { key: TOKEN }).error.message, 'unauthorized');
  const { context } = load(SAMPLE);
  assert.equal(post(context, init).error.message, 'unauthorized');
  assert.equal(post(context, init, { key: 'rmcp_' + 'b'.repeat(43) }).error.message, 'unauthorized');
  assert.equal(post(context, init, { key: 'nope' }).error.message, 'unauthorized');
  const get = JSON.parse(context.mcpEndpoint_({ parameter: { key: TOKEN } }, 'GET').text);
  assert.match(get.error.message, /POST only/);
});

test('mcp: initialize / tools/list / tools/call via ?key= and via bridge body', () => {
  const { context, props } = load(SAMPLE);
  const init = post(context, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { key: TOKEN });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'personal-hub');
  assert.ok(init.result.capabilities.tools);
  const unknownVersion = post(context, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, { key: TOKEN });
  assert.equal(unknownVersion.result.protocolVersion, '2025-11-25');
  // notification → 沒有 body
  assert.equal(post(context, { jsonrpc: '2.0', method: 'notifications/initialized' }, { key: TOKEN }), null);
  const list = post(context, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { wrapped: TOKEN });
  assert.ok(list.result.tools.length >= 15);
  assert.equal(list.result.tools[0].inputSchema.type, 'object');
  assert.equal(list.result.tools[0].annotations.readOnlyHint, true);
  const call = post(context, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stock_quotes', arguments: { symbols: ['2330'] } } }, { wrapped: TOKEN });
  assert.equal(call.result.isError, false);
  assert.equal(JSON.parse(call.result.content[0].text).quotes[0].price, 1000);
  assert.equal(post(context, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }, { key: TOKEN }).error.code, -32602);
  assert.equal(post(context, { jsonrpc: '2.0', id: 6, method: 'sampling/createMessage' }, { key: TOKEN }).error.code, -32601);
  const batch = post(context, [{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }], { key: TOKEN });
  assert.equal(batch.length, 1);
  assert.ok(props.MCP_TOKEN_LAST_USED_AT);
});

test('mcp: token in the URL is no longer accepted; gateway secret from Firestore is', () => {
  const GW = 'rmgw_' + 'g'.repeat(43);
  const { context, cacheStore } = load({ ...SAMPLE, props: {}, docs: { ...SAMPLE.docs, 'mcp_gateway/secret': { value: GW } } });
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal(post(context, ping, { urlKey: TOKEN }).error.message, 'unauthorized');
  assert.equal(post(context, ping, { gateway: 'rmgw_' + 'x'.repeat(43) }).error.message, 'unauthorized');
  assert.equal(post(context, ping, { gateway: 'not-a-secret' }).error.message, 'unauthorized');
  // 沒有 bridge token 也能用（兩種授權互相獨立）
  assert.deepEqual(post(context, ping, { gateway: GW }).result, {});
  assert.equal(cacheStore['mcp-gateway-secret-hash'], sha256(GW));
  const list = post(context, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { gateway: GW });
  assert.ok(list.result.tools.length >= 15);
  // Firestore 沒有密鑰 doc（閘道還沒部署）→ 關閉
  const closed = load({ ...SAMPLE, props: {} });
  assert.equal(post(closed.context, ping, { gateway: GW }).error.message, 'unauthorized');
});

test('mcp: daily quota and token rotate / revoke', () => {
  const { context, cacheStore, props } = load(SAMPLE);
  cacheStore['mcp-calls-' + formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd')] = '1500';
  assert.equal(post(context, { jsonrpc: '2.0', id: 1, method: 'ping' }, { key: TOKEN }).error.code, -32002);
  assert.equal(context.setMcpToken({ tokenHash: 'xyz' }, { uid: 'owner-1' }).ok, false);
  const next = 'rmcp_' + 'c'.repeat(43);
  assert.equal(context.setMcpToken({ tokenHash: sha256(next) }, { uid: 'owner-1' }).ok, true);
  assert.equal(context.mcpAuthorized_(TOKEN), false);
  assert.equal(context.mcpAuthorized_(next), true);
  assert.equal(context.getMcpStatus().configured, true);
  context.revokeMcpToken({}, { uid: 'owner-1' });
  assert.equal(context.mcpAuthorized_(next), false);
  assert.equal(props.MCP_TOKEN_SHA256, undefined);
});

function toolUse(id, name, input) { return { type: 'tool_use', id, name, input }; }
function reply(content, stop, usage) {
  return { body: { model: 'claude-opus-5-5', content, stop_reason: stop, usage: usage || { input_tokens: 1000, output_tokens: 100 } } };
}

test('agent loop: runs requested tools in one user turn, then returns the final text', () => {
  const { context, fetched } = load({ ...SAMPLE, responses: [
    reply([{ type: 'thinking', thinking: '', signature: 's' }, toolUse('t1', 'list_trips', {}), toolUse('t2', 'portfolio_latest', {})], 'tool_use'),
    reply([{ type: 'text', text: '## 報告' }], 'end_turn'),
  ] });
  const res = context.runClaudeAnalysis({ kind: 'tripReview', confirmed: true, focus: '預算夠嗎' });
  assert.equal(res.ok, true);
  assert.equal(res.markdown, '## 報告');
  assert.equal(res.rounds, 1);
  assert.deepEqual(plain(res.toolCalls).map((c) => c.name), ['list_trips', 'portfolio_latest']);
  assert.equal(res.inputTokens, 2000);
  // 第一個 request：只有任務、沒有預先塞資料；有工具、有自動快取
  const first = fetched[0].body;
  assert.equal(first.messages.length, 1);
  assert.match(first.messages[0].content, /預算夠嗎/);
  assert.equal(first.messages[0].content.includes('東京'), false);
  assert.ok(first.tools.length >= 15);
  assert.deepEqual(first.cache_control, { type: 'ephemeral' });
  assert.equal(first.tool_choice, undefined);
  // 第二個 request：assistant content 原封不動（含 thinking），兩個 tool_result 在同一則 user message
  const second = fetched[1].body;
  assert.equal(second.messages[1].content[0].type, 'thinking');
  const results = second.messages[2].content;
  assert.deepEqual(results.map((b) => b.type), ['tool_result', 'tool_result']);
  assert.equal(results[0].tool_use_id, 't1');
  assert.match(results[0].content, /trip1/);
});

test('agent loop: hitting the round cap forces a final answer with tool_choice none', () => {
  const responses = [];
  for (let i = 0; i < 6; i++) responses.push(reply([toolUse('t' + i, 'hub_catalog', {})], 'tool_use'));
  responses.push(reply([{ type: 'text', text: '結論' }], 'end_turn'));
  const { context, fetched } = load({ ...SAMPLE, responses });
  const res = context.runClaudeAnalysis({ kind: 'monthlyReview', month: '2026-10', confirmed: true });
  assert.equal(res.ok, true);
  assert.equal(res.rounds, 6);
  assert.equal(fetched.length, 7);
  assert.deepEqual(fetched[6].body.tool_choice, { type: 'none' });
  const last = fetched[6].body.messages.at(-1).content;
  assert.equal(last.at(-1).type, 'text');
  assert.equal(fetched[5].body.tool_choice, undefined);
});

test('analysis: requires confirmation, rejects unknown kinds, estimate gives a range', () => {
  const { context } = load({ ...SAMPLE, responses: [{ body: { input_tokens: 4000 } }] });
  assert.equal(context.runClaudeAnalysis({ kind: 'monthlyReview' }).ok, false);
  assert.equal(context.runClaudeAnalysis({ kind: 'nope', confirmed: true }).ok, false);
  const est = plain(context.estimateClaudeAnalysis({ kind: 'portfolioReview' }));
  assert.equal(est.ok, true);
  assert.equal(est.inputTokens, 4000);
  assert.ok(est.inputTokensRange[0] >= 4000 * 3 && est.inputTokensRange[1] > est.inputTokensRange[0]);
  assert.ok(est.costUSDRange[0] > 0 && est.costUSDRange[1] > est.costUSDRange[0]);
  assert.ok(est.maxCostUSD > est.costUSDRange[1]);
});

test('askFinance uses the shared hub tools', () => {
  const { context, fetched } = load({ ...SAMPLE, responses: [
    reply([toolUse('a1', 'trip_detail', { tripId: 'trip1' })], 'tool_use'),
    reply([{ type: 'text', text: '已花 NT$1,200' }], 'end_turn'),
  ] });
  const res = context.askFinance({ question: '東京花了多少' });
  assert.equal(res.ok, true);
  assert.equal(res.answer, '已花 NT$1,200');
  assert.equal(plain(res.toolCalls)[0].name, 'trip_detail');
  assert.ok(fetched[0].body.tools.some((t) => t.name === 'trip_itinerary'));
});
