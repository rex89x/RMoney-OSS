const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/**
 * HubWriteTools.gs（MCP 寫入工具：記帳 / 股票成交 / 旅程行程）+ Mcp.gs 的寫入權限閘門。
 * Firestore 是記憶體 store；寫入邏輯本身（ImportApply.gs）是真的。
 */
const TOKEN = 'rmcp_' + 'a'.repeat(43);
const GATEWAY = 'rmgw_' + 'g'.repeat(43);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
const DOC_PREFIX = 'projects/p/databases/(default)/documents/';

function formatDate(date, _tz, pattern) {
  const shifted = new Date(date.getTime() + 8 * 3600000);
  return pattern.replace('yyyy', String(shifted.getUTCFullYear())).replace('MM', pad(shifted.getUTCMonth() + 1)).replace('dd', pad(shifted.getUTCDate()));
}

function load(seed = {}, props = {}) {
  const store = {
    'fx_rates/JPY_TWD': { rate: 0.21 },
    'fx_rates/USD_TWD': { rate: 32 },
    'accounts/a1': { name: '玉山銀行', type: 'bank', currency: 'TWD', balance: 100000 },
    'accounts/a3': { name: '元大交割戶', type: 'investment_cash', currency: 'TWD', balance: 2000000 },
    'mcp_gateway/secret': { value: GATEWAY },
    ...seed,
  };
  const scriptProps = { MCP_TOKEN_SHA256: sha256(TOKEN), MCP_TOKEN_UID: 'owner-1', ...props };
  const cache = {};
  let seq = 0;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const revive = (doc) => {
    // JSON clone 會把 Date 變字串；測試只在乎值，日期欄位還原成 Date 讓 hubDateStr_ 正常運作
    for (const k of ['date', 'startDate', 'endDate', 'deletedAt']) {
      if (typeof doc[k] === 'string' && /T\d\d:/.test(doc[k])) doc[k] = new Date(doc[k]);
    }
    return doc;
  };
  const children = (col) => Object.keys(store)
    .filter((k) => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/'))
    .map((k) => ({ ...revive(clone(store[k])), _name: DOC_PREFIX + k }));
  const context = vm.createContext({ console: { ...console, error: () => {}, warn: () => {} }, Date, Math, Number, String, Array, Object, JSON, RegExp, isFinite, isNaN, Error, parseInt, parseFloat, encodeURIComponent });
  context.TZ = 'Asia/Taipei';
  context.PROP = {
    getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
    setProperty: (k, v) => { scriptProps[k] = v; },
    setProperties: (obj) => Object.assign(scriptProps, obj),
    deleteProperty: (k) => { delete scriptProps[k]; },
  };
  context.CacheService = { getScriptCache: () => ({
    get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: (k) => { delete cache[k]; },
  }) };
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  context.Utilities = {
    formatDate,
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (_alg, text) => Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    getUuid: () => crypto.randomUUID(),
  };
  context.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ text, setMimeType() { return this; } }) };
  context.fsGetDoc_ = (p) => (store[p] ? { ...revive(clone(store[p])), _name: DOC_PREFIX + p } : null);
  context.fsSetDoc_ = (p, data, merge) => { store[p] = merge ? { ...(store[p] || {}), ...data } : { ...data }; return {}; };
  context.fsAddDoc_ = (col, data) => { const id = 'auto' + (++seq); store[`${col}/${id}`] = { ...data }; return { name: `${DOC_PREFIX}${col}/${id}` }; };
  context.fsDeleteDoc_ = (p) => { delete store[p]; };
  context.fsListDocs_ = (col) => children(col);
  context.fsListAllDocs_ = (col) => children(col);
  context.fsRunQuery_ = (_parent, q) => children(q.from[0].collectionId);
  context.fsDocumentName_ = (p) => p;
  context.encodeFields_ = (obj) => obj;
  context.fsBatchWrite_ = (writes) => { writes.forEach((w) => { store[w.update.name] = { ...w.update.fields }; }); return {}; };
  context.refreshSymbol = () => ({ ok: true });
  context.queryTxsBetween_ = () => [];
  context.isConsumptionExpense_ = () => false;
  context.isEarnedIncome_ = () => false;
  context.getLatestSnapshot_ = () => null;
  context.accountBalanceTWD_ = (a) => a.balance;
  for (const file of ['Stocks.gs', 'ImportJson.gs', 'ImportApply.gs', 'FlightIngest.gs', 'FlightWatches.gs', 'Ask.gs', 'HubTools.gs', 'HubWriteTools.gs', 'Mcp.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  // TelegramBot.gs 的兩個 helper（整支檔案依賴太多，這裡只放寫入工具用到的）
  vm.runInContext(`
    function tgAdjustTxAccount_(tx, sign) {
      if (!tx || tx.type === 'transfer') return;
      var accountId = tx.type === 'income' ? tx.toAccountId : tx.fromAccountId;
      if (!accountId) return;
      var dir = tx.type === 'income' ? 1 : -1;
      importAdjustAccount_(accountId, tx.currency || 'TWD', sign * dir * (Number(tx.amount) || 0), sign * dir * (Number(tx.amountTWD) || Number(tx.amount) || 0));
    }
    function getOwnerUid_() { return 'owner-1'; }
    function tgLoadEntryContext_() {
      return {
        categories: [
          { key: 'food', name: '餐飲', type: 'expense' }, { key: 'other', name: '其他', type: 'expense' },
          { key: 'salary', name: '薪資', type: 'income' }, { key: 'other_income', name: '其他收入', type: 'income' },
        ],
        paymentMethods: [{ key: 'cube', name: '玉山 CUBE 卡', type: 'credit' }],
        accounts: [
          { id: 'a1', name: '玉山銀行', type: 'bank', legacyPaymentMethod: '玉山' },
          { id: 'a3', name: '元大交割戶', type: 'investment_cash', legacyPaymentMethod: null },
        ],
      };
    }`, context);
  return { context, store, cache, scriptProps };
}

/** 經過完整的 MCP 端點（含驗證與寫入權限判斷）呼叫工具 */
function rpc(env, method, params, { gateway, write, uid = 'owner-1' } = {}) {
  const body = gateway
    ? { gatewaySecret: GATEWAY, rpc: { jsonrpc: '2.0', id: 1, method, params }, uid, write, client: 'Claude' }
    : { mcpToken: TOKEN, rpc: { jsonrpc: '2.0', id: 1, method, params } };
  const out = env.context.mcpEndpoint_({ parameter: { action: 'mcp' }, postData: { contents: JSON.stringify(body) } }, 'POST');
  return JSON.parse(out.text);
}

function call(env, name, args, opts = { gateway: true, write: true }) {
  const res = rpc(env, 'tools/call', { name, arguments: args }, opts);
  assert.ok(res.result, JSON.stringify(res));
  return { isError: res.result.isError, data: JSON.parse(res.result.content[0].text) };
}

const WRITE_TOOLS = ['entry_options', 'preview_entries', 'commit_entries', 'undo_entry', 'preview_itinerary', 'commit_itinerary', 'preview_taifex_review', 'commit_taifex_review'];

test('write tools are hidden and refused unless the connection has write access', () => {
  const env = load();
  const names = (opts) => rpc(env, 'tools/list', {}, opts).result.tools.map((t) => t.name);
  for (const opts of [{}, { gateway: true }, { gateway: true, write: false }, { gateway: true, write: 'true' }]) {
    assert.equal(names(opts).some((n) => WRITE_TOOLS.includes(n)), false);
    const refused = call(env, 'preview_entries', { items: [{ kind: 'expense', date: '2026-11-13', amount: 100 }] }, opts);
    assert.equal(refused.isError, true);
    assert.match(refused.data.error, /read-only/);
  }
  assert.equal(Object.keys(env.cache).some((k) => k.startsWith('mcp-preview-')), false);

  const tools = rpc(env, 'tools/list', {}, { gateway: true, write: true }).result.tools;
  for (const name of WRITE_TOOLS) assert.ok(tools.find((t) => t.name === name), name);
  assert.equal(tools.find((t) => t.name === 'commit_entries').annotations.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === 'preview_entries').annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === 'list_trips').annotations.readOnlyHint, true);
  assert.match(rpc(env, 'initialize', {}, { gateway: true, write: true }).result.instructions, /commit_entries/);
  assert.match(rpc(env, 'initialize', {}, { gateway: true }).result.instructions, /唯讀/);
});

test('in-app AI tools (Ask / analysis) never include write tools', () => {
  const env = load();
  const readNames = env.context.hubToolNames_();
  for (const name of WRITE_TOOLS) assert.equal(readNames.includes(name), false);
  assert.equal(env.context.hubCallTool_('commit_entries', { previewId: 'x' }).isError, true);
});

test('bridge token write switch: off by default, owner toggles, rotation resets it', () => {
  const env = load();
  const { context } = env;
  assert.equal(context.getMcpStatus().writeEnabled, false);
  assert.equal(context.getMcpStatus().writeToolCount, WRITE_TOOLS.length);
  assert.equal(context.setMcpWriteAccess({ enabled: true }, {}).ok, false);
  assert.equal(context.setMcpWriteAccess({ enabled: true }, { uid: 'owner-1' }).writeEnabled, true);
  assert.equal(call(env, 'entry_options', {}, {}).isError, false);
  // 換 token → 回到唯讀
  context.setMcpToken({ tokenHash: sha256(TOKEN) }, { uid: 'owner-1' });
  assert.equal(context.getMcpStatus().writeEnabled, false);
  assert.equal(call(env, 'entry_options', {}, {}).isError, true);
  context.revokeMcpToken({}, { uid: 'owner-1' });
  assert.equal(context.setMcpWriteAccess({ enabled: true }, { uid: 'owner-1' }).ok, false);
});

test('entry_options lists categories, accounts and payment methods', () => {
  const { data } = call(load(), 'entry_options', {});
  assert.equal(data.today.length, 10);
  assert.deepEqual(data.categories[0], { key: 'food', name: '餐飲', type: 'expense' });
  assert.deepEqual(data.accounts[0], { name: '玉山銀行', type: 'bank', paymentMethodName: '玉山' });
  assert.ok(data.paymentMethods.includes('玉山 CUBE 卡'));
  assert.ok(data.paymentMethods.includes('現金'));
  assert.equal(data.defaultTradeAccount, '元大交割戶');
});

test('ledger: preview writes nothing; commit creates the tx, adjusts the account, logs audit; previewId is single-use', () => {
  const env = load({ 'trips/trip1': { name: '東京' } });
  const items = [
    { kind: 'expense', date: '2026-11-13', amount: 150, category: '餐飲', note: '午餐', account: '玉山銀行' },
    { kind: 'expense', date: '2026-11-13', amount: 1280, currency: 'JPY', category: 'food', note: '一蘭', tripId: 'trip1' },
    { kind: 'income', date: '2026-11-10', amount: 50000, category: 'salary', account: '玉山' },
    { kind: 'expense', date: 'yesterday', amount: 10 },
  ];
  const before = Object.keys(env.store).length;
  const preview = call(env, 'preview_entries', { items });
  assert.equal(preview.isError, false);
  assert.equal(Object.keys(env.store).length, before);
  assert.equal(preview.data.willWrite, 3);
  assert.deepEqual(preview.data.rejected, [{ index: 3, message: 'date: 日期要是 yyyy-MM-dd' }]);
  assert.equal(preview.data.rows[0].category, '餐飲');
  assert.equal(preview.data.rows[0].account, '玉山銀行');
  assert.equal(preview.data.rows[1].amountTWD, 268.8);
  assert.equal(preview.data.rows[1].trip, '東京');
  assert.match(preview.data.previewId, /^pv_[a-f0-9]{20}$/);

  const commit = call(env, 'commit_entries', { previewId: preview.data.previewId });
  assert.equal(commit.data.created, 3);
  const txId = commit.data.results[0].transactionId;
  const tx = env.store['transactions/' + txId];
  assert.equal(tx.type, 'expense');
  assert.equal(tx.amountTWD, 150);
  assert.equal(tx.fromAccountId, 'a1');
  assert.equal(tx.source, 'mcp');
  assert.equal(tx.userId, 'owner-1');
  assert.equal(env.store['transactions/' + commit.data.results[1].transactionId].tripId, 'trip1');
  assert.equal(env.store['accounts/a1'].balance, 100000 - 150 + 50000);
  const audits = Object.entries(env.store).filter(([k]) => k.startsWith('audit_logs/')).map(([, v]) => v);
  assert.equal(audits.length, 1);
  assert.match(audits[0].summary, /^MCP（Claude）· 寫入 3 筆/);

  // 同一個 previewId 不能再用（重試不會重複寫）
  const again = call(env, 'commit_entries', { previewId: preview.data.previewId });
  assert.equal(again.isError, true);
  assert.equal(env.store['accounts/a1'].balance, 100000 - 150 + 50000);
  // 重新預覽同一筆 → 標示已存在，不能再確認
  const dup = call(env, 'preview_entries', { items: [items[0]] });
  assert.equal(dup.data.willWrite, 0);
  assert.equal(dup.data.previewId, undefined);
  assert.match(dup.data.rows[0].messages.join(), /內容完全相同/);
});

test('ledger: excludeIndexes, unknown trip, foreign preview and bad ids are refused', () => {
  const env = load();
  const preview = call(env, 'preview_entries', { items: [
    { kind: 'expense', date: '2026-11-13', amount: 100, note: 'A' },
    { kind: 'expense', date: '2026-11-13', amount: 200, note: 'B' },
    { kind: 'expense', date: '2026-11-13', amount: 300, note: 'C', tripId: 'nope' },
  ] });
  assert.equal(preview.data.rows[2].status, 'error');
  assert.equal(preview.data.willWrite, 2);
  // 另一個使用者的連線拿不到這份預覽
  const stolen = call(env, 'commit_entries', { previewId: preview.data.previewId }, { gateway: true, write: true, uid: 'someone-else' });
  assert.match(stolen.data.error, /another connection/);
  assert.equal(call(env, 'commit_entries', { previewId: '../x' }).isError, true);
  assert.equal(call(env, 'commit_itinerary', { previewId: preview.data.previewId }).isError, true);

  const next = call(env, 'preview_entries', { items: [
    { kind: 'expense', date: '2026-11-13', amount: 100, note: 'A' },
    { kind: 'expense', date: '2026-11-13', amount: 200, note: 'B' },
  ] });
  const commit = call(env, 'commit_entries', { previewId: next.data.previewId, excludeIndexes: [1] });
  assert.equal(commit.data.created, 1);
  assert.equal(commit.data.notWritten, 1);
  assert.equal(Object.keys(env.store).filter((k) => k.startsWith('transactions/')).length, 1);
  assert.equal(call(env, 'preview_entries', { items: [] }).isError, true);
  assert.equal(call(env, 'preview_entries', { items: Array.from({ length: 41 }, () => ({ kind: 'expense', date: '2026-11-13', amount: 1 })) }).isError, true);
});

test('undo_entry only soft-deletes MCP-written entries and restores the balance', () => {
  const env = load({ 'transactions/manual1': { type: 'expense', amount: 99, amountTWD: 99, fromAccountId: 'a1', source: 'web', deletedAt: null } });
  const preview = call(env, 'preview_entries', { items: [{ kind: 'expense', date: '2026-11-13', amount: 150, note: '午餐', account: '玉山銀行' }] });
  const txId = call(env, 'commit_entries', { previewId: preview.data.previewId }).data.results[0].transactionId;
  assert.equal(env.store['accounts/a1'].balance, 99850);

  assert.match(call(env, 'undo_entry', { transactionId: 'manual1' }).data.error, /only entries written through MCP/);
  assert.equal(env.store['transactions/manual1'].deletedAt, null);
  assert.equal(call(env, 'undo_entry', { transactionId: 'missing' }).isError, true);

  const undone = call(env, 'undo_entry', { transactionId: txId });
  assert.equal(undone.data.ok, true);
  assert.ok(env.store['transactions/' + txId].deletedAt);
  assert.equal(env.store['accounts/a1'].balance, 100000);
  assert.match(call(env, 'undo_entry', { transactionId: txId }).data.error, /already deleted/);
  assert.equal(env.store['accounts/a1'].balance, 100000);
});

test('trades: buy creates a position and debits the settlement account; overselling is blocked at preview', () => {
  const env = load();
  const buy = call(env, 'preview_entries', { items: [{ kind: 'trade', date: '2026-11-13', symbol: '2330', side: 'buy', shares: 1000, price: 1050, fee: 150 }] });
  assert.equal(buy.data.rows[0].account, '元大交割戶');
  assert.equal(buy.data.rows[0].grossTWD, 1050000);
  const done = call(env, 'commit_entries', { previewId: buy.data.previewId });
  assert.equal(done.data.created, 1);
  assert.equal(done.data.results[0].transactionId, undefined);
  const position = Object.entries(env.store).find(([k]) => k.startsWith('portfolio/'))[1];
  assert.equal(position.symbol, '2330');
  assert.equal(position.shares, 1000);
  assert.equal(position.avgCost, 1050.15);
  assert.equal(env.store['accounts/a3'].balance, 2000000 - 1050150);

  const oversell = call(env, 'preview_entries', { items: [{ kind: 'trade', date: '2026-11-14', symbol: '2330', side: 'sell', shares: 2000, price: 1100 }] });
  assert.equal(oversell.data.willWrite, 0);
  assert.equal(oversell.data.rows[0].status, 'error');
  assert.equal(oversell.data.previewId, undefined);

  const sell = call(env, 'preview_entries', { items: [{ kind: 'trade', date: '2026-11-14', symbol: '2330', side: 'sell', shares: 400, price: 1100, fee: 100, tax: 1320 }] });
  call(env, 'commit_entries', { previewId: sell.data.previewId });
  assert.equal(Object.entries(env.store).find(([k]) => k.startsWith('portfolio/'))[1].shares, 600);
  const lot = Object.entries(env.store).find(([k]) => k.startsWith('realized_lots/'))[1];
  assert.equal(lot.realizedPnlTWD, 400 * 1100 - 1420 - 400 * 1050.15);
});

test('daily write limit stops further commits', () => {
  const env = load();
  env.cache['mcp-writes-' + formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd')] = '200';
  const preview = call(env, 'preview_entries', { items: [{ kind: 'expense', date: '2026-11-13', amount: 100 }] });
  const commit = call(env, 'commit_entries', { previewId: preview.data.previewId });
  assert.match(commit.data.error, /daily MCP write limit/);
  assert.equal(Object.keys(env.store).some((k) => k.startsWith('transactions/')), false);
});

test('itinerary: new trip is created with days and items; item ids match the web importer', () => {
  const env = load();
  const stops = [
    { date: '2026-12-21', title: '築地市場 早餐', time: '8:30', place: '築地場外市場', estimatedCost: 3000, currency: 'jpy' },
    { date: '2026-12-20', title: '成田機場 → 上野', time: '14:00', endTime: '15:30' },
    { date: '2026-12-20', title: '入住飯店', time: '16:00', mapsUrl: 'https://maps.app.goo.gl/abc123', note: '可寄放行李' },
    { date: '2026-12-20', title: '阿美橫町', mapsUrl: 'https://evil.example/maps' },
    { date: '2026-13-40', title: '壞日期' },
    { date: '2026-12-20', title: ' 入住飯店 ', time: '16:00' },
  ];
  const before = Object.keys(env.store).length;
  const preview = call(env, 'preview_itinerary', { trip: { title: '東京五日', destination: '東京, 橫濱', startDate: '2026-12-20', endDate: '2026-12-24' }, stops });
  assert.equal(preview.isError, false);
  assert.equal(Object.keys(env.store).length, before);
  assert.equal(preview.data.trip.action, 'create');
  assert.equal(preview.data.willCreate, 4);
  assert.equal(preview.data.rejected.length, 2);
  assert.deepEqual(preview.data.days.map((d) => d.date), ['2026-12-20', '2026-12-21']);
  assert.deepEqual(preview.data.days[0].items.map((i) => i.type), ['transport', 'accommodation', 'activity']);

  const done = call(env, 'commit_itinerary', { previewId: preview.data.previewId });
  assert.equal(done.data.tripCreated, true);
  assert.equal(done.data.created, 4);
  const tripId = done.data.tripId;
  const trip = env.store['trips/' + tripId];
  assert.equal(trip.name, '東京五日');
  assert.deepEqual(Array.from(trip.destination), ['東京', '橫濱']); // vm 另一個 realm 的陣列
  assert.equal(trip.userId, 'owner-1');
  assert.equal(trip.status, 'planning');
  // 台北 12/20 00:00 = UTC 12/19 16:00
  assert.equal(new Date(trip.startDate).toISOString(), '2026-12-19T16:00:00.000Z');
  assert.equal(env.store['itineraries/' + tripId].title, '東京五日');
  assert.deepEqual({ ...env.store[`itineraries/${tripId}/days/2026-12-20`] }, { date: '2026-12-20' });

  // 與 web aiItemIdFor 相同的 id：ai_ + sha256(`date|time|normalizedTitle`).slice(0, 40)
  const hotelId = 'ai_' + sha256('2026-12-20|16:00|入住飯店').slice(0, 40);
  const hotel = env.store[`itineraries/${tripId}/days/2026-12-20/items/${hotelId}`];
  assert.equal(hotel.type, 'accommodation');
  assert.equal(hotel.mapsUrl, 'https://maps.app.goo.gl/abc123');
  assert.equal(hotel.notes, '可寄放行李');
  assert.equal(hotel.status, 'planned');
  assert.equal(hotel.order, 2);
  const market = env.store[`itineraries/${tripId}/days/2026-12-21/items/${'ai_' + sha256('2026-12-21|08:30|築地市場早餐').slice(0, 40)}`];
  assert.equal(market.startTime, '08:30');
  assert.equal(market.estimatedCost, 3000);
  assert.equal(market.currency, 'JPY');
  assert.equal(market.sourcePlaceQuery, '築地場外市場 東京');
  // 非 Google 地圖的連結被丟掉，改成搜尋連結
  const ameyoko = Object.entries(env.store).find(([k, v]) => k.includes('/items/') && v.title === '阿美橫町')[1];
  assert.match(ameyoko.mapsUrl, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.equal(call(env, 'commit_itinerary', { previewId: preview.data.previewId }).isError, true);
});

test('itinerary: importing into an existing trip updates in place, keeps app-side fields and widens dates', () => {
  const itemId = 'ai_' + sha256('2026-12-20|16:00|入住飯店').slice(0, 40);
  const env = load({
    'trips/trip1': { name: '東京', destination: ['東京'], startDate: new Date('2026-12-19T16:00:00Z'), endDate: new Date('2026-12-23T16:00:00Z'), userId: 'owner-1' },
    'itineraries/trip1': { title: '東京', tripId: 'trip1', startDate: '2026-12-20', endDate: '2026-12-24' },
    'itineraries/trip1/days/2026-12-20': { date: '2026-12-20', theme: '抵達' },
    [`itineraries/trip1/days/2026-12-20/items/${itemId}`]: { order: 3, title: '入住飯店', startTime: '16:00', status: 'done', actualCost: 12000, linkedTxId: 'tx9',
      placeName: '入住飯店', sourcePlaceQuery: '入住飯店 東京', lat: 35.7, lng: 139.7, placeId: 'p1', mapsUrl: 'https://maps.google.com/?cid=1' },
    'itineraries/trip1/days/2026-12-20/items/manual1': { order: 5, title: '手動加的', status: 'planned' },
  });
  const preview = call(env, 'preview_itinerary', { tripId: 'trip1', stops: [
    { date: '2026-12-20', title: '入住飯店', time: '16:00', note: '改成 16:00 後入住' },
    { date: '2026-12-20', title: '晚餐 燒肉', time: '19:00' },
    { date: '2026-12-26', title: '回程班機', time: '10:00' },
  ] });
  assert.equal(preview.data.trip.action, 'existing');
  assert.equal(preview.data.willUpdate, 1);
  assert.equal(preview.data.willCreate, 2);
  assert.deepEqual(preview.data.trip.datesWillWidenTo, { startDate: '2026-12-20', endDate: '2026-12-26' });
  assert.equal(preview.data.days[1].outsideCurrentTripDates, true);

  const done = call(env, 'commit_itinerary', { previewId: preview.data.previewId });
  assert.deepEqual([done.data.created, done.data.updated, done.data.tripCreated], [2, 1, false]);
  const hotel = env.store[`itineraries/trip1/days/2026-12-20/items/${itemId}`];
  assert.equal(hotel.notes, '改成 16:00 後入住');
  assert.deepEqual([hotel.status, hotel.actualCost, hotel.linkedTxId, hotel.order], ['done', 12000, 'tx9', 3]);
  // 地點沒變 → 座標與連結保留
  assert.deepEqual([hotel.lat, hotel.placeId, hotel.mapsUrl], [35.7, 'p1', 'https://maps.google.com/?cid=1']);
  assert.equal(env.store['itineraries/trip1/days/2026-12-20/items/manual1'].title, '手動加的');
  assert.equal(env.store['itineraries/trip1/days/2026-12-20'].theme, '抵達');
  const dinner = Object.entries(env.store).find(([k, v]) => k.includes('/items/') && v.title === '晚餐 燒肉')[1];
  assert.equal(dinner.order, 6);
  assert.equal(dinner.type, 'meal');
  assert.equal(new Date(env.store['trips/trip1'].endDate).toISOString(), '2026-12-25T16:00:00.000Z');
  assert.equal(new Date(env.store['trips/trip1'].startDate).toISOString(), '2026-12-19T16:00:00.000Z');
  assert.equal(env.store['itineraries/trip1'].endDate, '2026-12-26');
  assert.equal(env.store['itineraries/trip1'].title, '東京');

  assert.match(call(env, 'preview_itinerary', { tripId: 'missing', stops: [{ date: '2026-12-20', title: 'x' }] }).data.error, /trip not found/);
  assert.equal(call(env, 'preview_itinerary', { stops: [{ date: '2026-12-20', title: 'x' }] }).isError, true);
});
