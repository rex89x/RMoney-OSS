const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const esbuild = require('esbuild');

globalThis.crypto ||= webcrypto;

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react-dom', 'lucide-react'],
    alias: { '@': path.resolve(__dirname, '../src') } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const schema = loadTs(path.resolve(__dirname, '../src/features/import/schema.ts'));
const normalize = loadTs(path.resolve(__dirname, '../src/features/import/normalize.ts'));
const prompt = loadTs(path.resolve(__dirname, '../src/features/import/prompt.ts'));
const companions = loadTs(path.resolve(__dirname, '../src/features/trips/companions.ts'));

const categories = [
  { id: 'food', key: 'food', name: '餐飲', type: 'expense', icon: 'x', color: '#000', order: 1 },
  { id: 'transport', key: 'transport', name: '交通', type: 'expense', icon: 'x', color: '#000', order: 2 },
  { id: 'other', key: 'other', name: '其他', type: 'expense', icon: 'x', color: '#000', order: 9 },
  { id: 'salary', key: 'salary', name: '薪資', type: 'income', icon: 'x', color: '#000', order: 1 },
];
const accounts = [
  { id: 'a1', name: '玉山銀行', type: 'bank', currency: 'TWD', ownerId: 'rex', active: true, legacyPaymentMethod: '玉山' },
  { id: 'a2', name: '信用卡', type: 'credit_card', currency: 'TWD', ownerId: 'rex', active: true },
  { id: 'a3', name: '元大交割戶', type: 'investment_cash', currency: 'TWD', ownerId: 'rex', active: true },
  { id: 'a4', name: 'LINE Pay 餘額', type: 'e_wallet_balance', currency: 'TWD', ownerId: 'rex', active: true, legacyPaymentMethod: 'LINE Pay' },
];
const paymentMethods = [
  { id: 'cube', key: 'cube', name: '玉山 CUBE 卡', type: 'credit', last4: '1234' },
  { id: 'linepay', key: 'linepay', name: 'LINE Pay', type: 'mobile' },
];
const fxRates = [{ id: 'USD_TWD', base: 'USD', quote: 'TWD', rate: 32, updatedAt: null }, { id: 'JPY_TWD', base: 'JPY', quote: 'TWD', rate: 0.21, updatedAt: null }];
const positions = [{ id: 'p1', userId: 'rex', symbol: 'AAPL', shares: 10, avgCost: 200, currency: 'USD', lots: [] }];
const ctx = { categories, accounts, paymentMethods, fxRates, positions, defaultTradeAccountId: 'a3' };

test('parseImportEnvelope accepts fenced JSON, bare arrays and drops only the broken items', () => {
  const fenced = '這是結果：\n```json\n{"version":1,"source":"chatgpt","items":[{"kind":"expense","date":"2026-10-21","amount":120,"note":"午餐"},{"kind":"expense","amount":5}]}\n```';
  const r = schema.parseImportEnvelope(fenced);
  assert.equal(r.error, null);
  assert.equal(r.envelope.items.length, 1);
  assert.equal(r.envelope.items[0].currency, 'TWD', 'currency defaults to TWD');
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].message, /date/);

  const bare = schema.parseImportEnvelope('[{"kind":"trade","date":"2026-10-21","symbol":"2330","side":"buy","shares":"1000","price":"1050"}]');
  assert.equal(bare.error, null);
  assert.equal(bare.envelope.items[0].shares, 1000, 'numbers may arrive as strings');

  assert.match(schema.parseImportEnvelope('hello').error, /JSON/);
  assert.match(schema.parseImportEnvelope('{"foo":1}').error, /items/);
  assert.equal(r.repaired, false);
});

test('parseImportEnvelope repairs the quote mistakes LLMs and chat apps make', () => {
  const curly = schema.parseImportEnvelope('“{“version”: 1, “items”: [{“kind”: “expense”, “date”: “2026-10-21”, “amount”: 120, “note”: “午餐”}]}”');
  assert.equal(curly.error, null);
  assert.equal(curly.repaired, true);
  assert.equal(curly.envelope.items[0].note, '午餐');

  const python = schema.parseImportEnvelope("{'items': [{'kind': 'expense', 'date': '2026-10-21', 'amount': 120, 'note': \"7-Eleven's\", 'tags': None, 'account': null}]}");
  assert.equal(python.error, null);
  assert.equal(python.envelope.items[0].note, "7-Eleven's");
  assert.equal(python.envelope.items[0].tags, undefined, 'null optional fields are accepted');

  const inner = schema.parseImportEnvelope('{"items":[{"kind":"expense","date":"2026-10-21","amount":1,280,"note":"買 "可樂" 兩瓶",},]}');
  assert.equal(inner.error, null);
  assert.equal(inner.envelope.items[0].amount, 1280, 'thousands separator');
  assert.equal(inner.envelope.items[0].note, '買 "可樂" 兩瓶', 'unescaped inner quotes');

  const fullwidth = schema.parseImportEnvelope('｛"items"：［｛"kind"："income"，"date"："2026-10-21"，"amount"："NT$ 1,000"｝］｝');
  assert.equal(fullwidth.error, null);
  assert.equal(fullwidth.envelope.items[0].amount, 1000);

  const loose = schema.parseImportEnvelope('// 結果\n{items: [{kind: expense, date: "2026-10-21", amount: +50, currency: TWD, note: "a\nb"}]}');
  assert.equal(loose.error, null);
  assert.equal(loose.envelope.items[0].currency, 'TWD');
  assert.equal(loose.envelope.items[0].note, 'a b');

  const cut = schema.parseImportEnvelope('```json\n{"version":1,"items":[{"kind":"expense","date":"2026-10-21","amount":120,"note":"ok"},{"kind":"expense","date":"2026-10-22","amount":9');
  assert.equal(cut.error, null);
  assert.equal(cut.truncated, true);
  assert.equal(cut.envelope.items.length, 1, 'the half item at the cut is dropped');
  assert.match(cut.rejected[0].message, /截斷/);

  const prose = schema.parseImportEnvelope('{"items":[{"kind":"expense","date":"2026-10-21","amount":5}]}\n希望這有幫助！');
  assert.equal(prose.error, null);
  assert.equal(prose.repaired, false, 'trailing prose is cut without counting as a repair');
});

test('resolvePayment: accounts → custom payment methods (name / type / last4) → presets → unmatched', async () => {
  const rows = await normalize.normalizeImport([
    { kind: 'expense', date: '2026-10-21', amount: 100, currency: 'TWD', category: 'food', account: 'CUBE' },
    { kind: 'expense', date: '2026-10-21', amount: 101, currency: 'TWD', category: 'food', account: '信用卡' },
    { kind: 'expense', date: '2026-10-21', amount: 102, currency: 'TWD', category: 'food', paymentMethod: '卡末四碼 1234' },
    { kind: 'expense', date: '2026-10-21', amount: 103, currency: 'TWD', category: 'food', account: 'LINE Pay' },
    { kind: 'expense', date: '2026-10-21', amount: 104, currency: 'TWD', category: 'food', account: '街口' },
    { kind: 'expense', date: '2026-10-21', amount: 105, currency: 'TWD', category: 'food', account: '不存在' },
    { kind: 'expense', date: '2026-10-21', amount: 106, currency: 'TWD', category: 'food' },
  ], ctx);
  assert.equal(rows[0].resolved.paymentMethod, '玉山 CUBE 卡');
  assert.equal(rows[0].resolved.accountId, null, 'credit card payment method without a linked account');
  assert.equal(rows[0].resolved.paymentMatched, true);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[1].resolved.paymentMethod, '信用卡', 'an account literally named 信用卡 wins over the type name');
  assert.equal(rows[1].resolved.accountId, 'a2');
  assert.equal(rows[2].resolved.paymentMethod, '玉山 CUBE 卡', 'last4');
  assert.equal(rows[3].resolved.paymentMethod, 'LINE Pay');
  assert.equal(rows[3].resolved.accountId, 'a4', 'payment method linked to the e-wallet account by legacyPaymentMethod');
  assert.equal(rows[4].resolved.paymentMethod, '街口', 'preset list');
  assert.equal(rows[5].status, 'warn');
  assert.equal(rows[5].resolved.paymentMatched, false);
  assert.match(rows[5].messages.join(''), /付款方式/);
  assert.equal(rows[6].resolved.paymentMethod, '現金');
  assert.equal(rows[6].status, 'ready', 'no payment given is not a warning');

  const fixed = normalize.patchRow(rows[5], { paymentMethod: '玉山 CUBE 卡', accountId: null }, ctx);
  assert.equal(fixed.status, 'ready');
  assert.equal(fixed.resolved.paymentMatched, true);
  assert.deepEqual(fixed.messages, []);
});

test('normalizeImport resolves categories fuzzily, accounts by name or legacy method, converts currency', async () => {
  const rows = await normalize.normalizeImport([
    { kind: 'expense', date: '2026-10-21', amount: 1280, currency: 'JPY', category: '餐飲', note: '一蘭', account: '信用卡' },
    { kind: 'expense', date: '2026-10-21', amount: 100, currency: 'TWD', category: 'transp', account: '玉山' },
    { kind: 'expense', date: '2026-10-21', amount: 50, currency: 'TWD', category: '不存在', account: '不存在的帳戶' },
    { kind: 'income', date: '2026-10-21', amount: 50000, currency: 'TWD', category: 'salary', account: '玉山銀行' },
  ], ctx);
  assert.equal(rows[0].resolved.categoryKey, 'food');
  assert.equal(rows[0].resolved.accountId, 'a2');
  assert.equal(rows[0].resolved.amountTWD, 268.8);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[1].resolved.categoryKey, 'transport', 'partial key match');
  assert.equal(rows[1].resolved.accountId, 'a1', 'legacy payment method match');
  assert.equal(rows[1].resolved.paymentMethod, '玉山');
  assert.equal(rows[2].resolved.categoryKey, 'other');
  assert.equal(rows[2].status, 'warn');
  assert.equal(rows[2].resolved.accountId, null);
  assert.equal(rows[3].resolved.accountId, 'a1');
  assert.equal(rows[3].resolved.kind, 'income');
});

test('trades: symbol → market/currency, fee+tax, sell checks the position, default settlement account', async () => {
  const rows = await normalize.normalizeImport([
    { kind: 'trade', date: '2026-10-21', symbol: '2330', side: 'buy', shares: 1000, price: 1050, fee: 150 },
    { kind: 'trade', date: '2026-10-21', symbol: 'aapl', side: 'sell', shares: 5, price: 230, fee: 1, tax: 0.5 },
    { kind: 'trade', date: '2026-10-21', symbol: 'AAPL', side: 'sell', shares: 50, price: 230 },
    { kind: 'trade', date: '2026-10-21', symbol: 'TSLA', side: 'sell', shares: 1, price: 230 },
    { kind: 'trade', date: '2026-10-21', symbol: '123', side: 'buy', shares: 1, price: 1 },
  ], ctx);
  assert.equal(rows[0].resolved.market, 'TW');
  assert.equal(rows[0].resolved.currency, 'TWD');
  assert.equal(rows[0].resolved.accountId, 'a3');
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[1].resolved.symbol, 'AAPL');
  assert.equal(rows[1].resolved.currency, 'USD');
  assert.equal(rows[1].resolved.fee, 1.5);
  assert.equal(rows[1].resolved.existingPositionId, 'p1');
  assert.equal(rows[1].resolved.grossTWD, Math.round(5 * 230 * 32));
  assert.equal(rows[2].status, 'error', 'selling more than held');
  assert.equal(rows[3].status, 'error', 'no position');
  assert.equal(rows[4].status, 'error', 'bad TW symbol');
  assert.equal(rows[2].selected, false);
});

test('row keys are deterministic and duplicates inside one batch are flagged', async () => {
  const item = { kind: 'expense', date: '2026-10-21', amount: 120, currency: 'TWD', category: 'food', note: '午餐' };
  const k1 = await normalize.importRowKey(item);
  const k2 = await normalize.importRowKey({ ...item });
  assert.equal(k1, k2);
  assert.match(k1, /^ai_[0-9a-f]{40}$/);
  const withId = await normalize.importRowKey({ ...item, id: 'INV-1' });
  assert.notEqual(withId, k1);
  const rows = await normalize.normalizeImport([item, { ...item }], ctx);
  assert.equal(rows[1].status, 'error');
  assert.match(rows[1].messages.join(''), /重複/);
});

test('patchRow lets the user fix category / account and clears the related warnings', async () => {
  const [row] = await normalize.normalizeImport([
    { kind: 'expense', date: '2026-10-21', amount: 50, currency: 'TWD', category: '不存在', account: '不存在的帳戶' },
  ], ctx);
  const fixed = normalize.patchRow(row, { categoryKey: 'food', accountId: 'a1' }, ctx);
  assert.equal(fixed.status, 'ready');
  assert.equal(fixed.resolved.paymentMethod, '玉山');
  assert.deepEqual(fixed.messages, []);
});

test('prompt lists the user categories, accounts and payment methods, and nails down the quote rules', () => {
  const text = prompt.buildImportPrompt({ categories, accounts, paymentMethods, today: new Date('2026-10-23T04:00:00Z') });
  assert.match(text, /food = 餐飲/);
  assert.match(text, /salary = 薪資/);
  assert.match(text, /玉山銀行、玉山、信用卡/);
  assert.match(text, /玉山 CUBE 卡/);
  assert.match(text, /元大交割戶/);
  assert.match(text, /2026-10-23/);
  assert.match(text, /"kind":"trade"/);
  assert.match(text, /半形直的雙引號/);
  assert.match(text, /```json 圍欄/);
  const builtin = prompt.buildImportPrompt({ categories, accounts, fenced: false });
  assert.match(builtin, /不要 Markdown 圍欄/);
  assert.ok(!builtin.includes('```json 圍欄'));
});

test('known companions: household members first with uid, then past trip members by frequency', () => {
  const household = { memberIds: ['rex', 'partner'], members: { rex: { displayName: 'Owner' }, partner: { displayName: '伴侶', email: 'partner@x.com', color: '#f00' } } };
  const trips = [
    { id: 't1', name: '東京', startDate: new Date('2026-01-01'), members: [{ uid: 'rex', name: 'Owner' }, { name: 'A' }, { name: 'B' }] },
    { id: 't2', name: '首爾', startDate: new Date('2026-06-01'), members: [{ name: 'A' }, { uid: 'partner', name: '伴侶' }] },
  ];
  const list = companions.collectKnownCompanions({ trips, household, myUid: 'rex' });
  assert.deepEqual(list.map((c) => c.id), ['partner', 'A', 'B']);
  assert.equal(list[0].source, 'household');
  assert.equal(list[0].uid, 'partner');
  assert.equal(list[0].tripCount, 1);
  assert.equal(list[1].tripCount, 2);
  assert.equal(list[1].lastTripName, '首爾');
  const added = companions.householdTripMembers(household, [{ uid: 'rex', name: 'Owner' }]);
  assert.deepEqual(added.map((m) => m.uid), ['partner']);
  assert.equal(added[0].email, 'partner@x.com');
});
