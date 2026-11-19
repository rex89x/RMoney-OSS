const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');

/** 模擬 Firestore：store[path] = data；collection add 給遞增 id */
function load(store) {
  let seq = 0;
  const context = vm.createContext({ console, Date, Math, Number, String, Array, Object, JSON, RegExp, parseFloat, parseInt, isFinite });
  context.Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (_alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    getUuid: () => 'uuid-' + (++seq),
  };
  context.fsGetDoc_ = (p) => (store[p] ? JSON.parse(JSON.stringify(store[p])) : null);
  context.fsSetDoc_ = (p, data, merge) => { store[p] = merge ? { ...(store[p] || {}), ...data } : { ...data }; return {}; };
  context.fsAddDoc_ = (col, data) => { const id = 'auto' + (++seq); store[`${col}/${id}`] = { ...data }; return { name: `projects/x/databases/(default)/documents/${col}/${id}` }; };
  context.fsDeleteDoc_ = (p) => { delete store[p]; };
  context.fsRunQuery_ = (_parent, q) => {
    const col = q.from[0].collectionId;
    return Object.entries(store).filter(([k]) => k.startsWith(col + '/')).map(([k, v]) => ({ ...v, _name: 'projects/x/databases/(default)/documents/' + k }));
  };
  context.tgLoadEntryContext_ = () => ({
    categories: [
      { key: 'food', name: '餐飲', type: 'expense' }, { key: 'other', name: '其他', type: 'expense' },
      { key: 'salary', name: '薪資', type: 'income' }, { key: 'other_income', name: '其他收入', type: 'income' },
    ],
    paymentMethods: [
      { key: 'cube', name: '玉山 CUBE 卡', type: 'credit', last4: '1234' },
      { key: 'linepay', name: 'LINE Pay', type: 'mobile' },
    ],
    accounts: [
      { id: 'a1', name: '玉山銀行', type: 'bank', legacyPaymentMethod: '玉山' },
      { id: 'a3', name: '元大交割戶', type: 'investment_cash', legacyPaymentMethod: null },
      { id: 'a4', name: 'LINE Pay 餘額', type: 'e_wallet_balance', legacyPaymentMethod: 'LINE Pay' },
    ],
  });
  context.refreshSymbol = () => ({ ok: true });
  for (const f of ['Stocks.gs', 'ImportJson.gs', 'ImportApply.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8'), context);
  }
  return context;
}

const baseStore = () => ({
  'fx_rates/USD_TWD': { base: 'USD', quote: 'TWD', rate: 32 },
  'fx_rates/JPY_TWD': { base: 'JPY', quote: 'TWD', rate: 0.21 },
  'accounts/a1': { name: '玉山銀行', type: 'bank', currency: 'TWD', balance: 10000, balanceTWD: 10000 },
  'accounts/a3': { name: '元大交割戶', type: 'investment_cash', currency: 'TWD', balance: 2000000, balanceTWD: 2000000 },
  'portfolio/p1': { userId: 'rex', symbol: 'AAPL', shares: 10, avgCost: 200, currency: 'USD', lots: [] },
});

function webKey(basis) {
  return 'ai_' + crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 40);
}

test('row ids match the web importRowKey basis exactly', () => {
  const gs = load(baseStore());
  const item = { kind: 'expense', date: '2026-10-21', amount: 120, currency: 'TWD', category: 'food', note: '午餐' };
  assert.equal(gs.importRowId_(item), webKey('ai:expense:2026-10-21:120:TWD:food:午餐'));
  assert.equal(gs.importRowId_({ ...item, id: 'INV-1' }), webKey('ai:id:expense:INV-1'));
  assert.equal(gs.importRowId_({ kind: 'trade', date: '2026-10-21', symbol: 'aapl', side: 'sell', shares: 5, price: 230 }), webKey('ai:trade:2026-10-21:aapl:sell:5:230'));
});

test('envelope parsing tolerates fences and drops only broken items', () => {
  const gs = load(baseStore());
  const parsed = gs.importParseEnvelope_('結果：\n```json\n{"version":1,"items":[{"kind":"expense","date":"2026-10-21","amount":"1,280","currency":"jpy","note":"一蘭"},{"kind":"expense","amount":5}]}\n```');
  assert.equal(parsed.error, null);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].amount, 1280);
  assert.equal(parsed.items[0].currency, 'JPY');
  assert.equal(parsed.rejected.length, 1);
  assert.match(gs.importParseEnvelope_('hello').error, /JSON/);
});

test('normalize + apply ledger: deterministic id, account balance, idempotent second run', () => {
  const store = baseStore();
  const gs = load(store);
  const ctx = gs.importLoadContext_('rex');
  const rows = gs.importNormalize_([
    { kind: 'expense', date: '2026-10-21', amount: 1280, currency: 'JPY', category: '餐飲', note: '一蘭', account: '玉山' },
    { kind: 'income', date: '2026-10-21', amount: 500, currency: 'TWD', category: '不存在', account: '沒有這個帳戶' },
  ], ctx);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].resolved.categoryKey, 'food');
  assert.equal(rows[0].resolved.accountId, 'a1');
  assert.equal(rows[0].resolved.amountTWD, 268.8);
  assert.equal(rows[1].status, 'warn');
  assert.equal(rows[1].resolved.categoryKey, 'other_income');

  const results = gs.importApply_(rows, 'rex');
  assert.equal(results.map((r) => r.outcome).join(','), 'created,created');
  const tx = store['transactions/' + rows[0].id];
  assert.equal(tx.userId, 'rex');
  assert.equal(tx.fromAccountId, 'a1');
  assert.equal(tx.amountTWD, 268.8);
  assert.ok(tx.tags.includes('ai-import'));
  assert.equal(Math.round(store['accounts/a1'].balance * 10) / 10, 10000 - 268.8);

  const again = gs.importApply_(rows, 'rex');
  assert.equal(again.map((r) => r.outcome).join(','), 'skipped,skipped');
  assert.equal(Math.round(store['accounts/a1'].balance * 10) / 10, 10000 - 268.8, 'no double charge');
});

test('trades: buy creates a position with fees in cost, sell books a realized lot and charges the account', () => {
  const store = baseStore();
  const gs = load(store);
  const ctx = gs.importLoadContext_('rex');
  const rows = gs.importNormalize_([
    { kind: 'trade', date: '2026-10-21', symbol: '2330', side: 'buy', shares: 1000, price: 1050, fee: 150 },
    { kind: 'trade', date: '2026-10-21', symbol: 'AAPL', side: 'sell', shares: 4, price: 230, fee: 1, account: '元大交割戶' },
    { kind: 'trade', date: '2026-10-21', symbol: 'AAPL', side: 'sell', shares: 99, price: 230 },
  ], ctx);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].resolved.accountId, 'a3', 'default settlement account');
  assert.equal(rows[2].status, 'error');

  const results = gs.importApply_(rows, 'rex');
  assert.equal(results.map((r) => r.outcome).join(','), 'created,created');
  const tsmc = Object.entries(store).find(([k, v]) => k.startsWith('portfolio/') && v.symbol === '2330')[1];
  assert.equal(tsmc.shares, 1000);
  assert.equal(tsmc.avgCost, (1000 * 1050 + 150) / 1000);
  assert.equal(tsmc.lots.length, 1);
  assert.equal(store['portfolio/p1'].shares, 6);
  const lot = Object.entries(store).find(([k]) => k.startsWith('realized_lots/'))[1];
  assert.equal(lot.symbol, 'AAPL');
  assert.equal(lot.proceedsTWD, (4 * 230 - 1) * 32);
  assert.equal(lot.costTWD, 200 * 4 * 32);
  // 帳戶：扣 1,050,150（買）+ 收 (920 − 1) × 32（賣，USD 換 TWD）
  const expected = 2000000 - 1050150 + (4 * 230 - 1) * 32;
  assert.equal(Math.round(store['accounts/a3'].balance), Math.round(expected));
});

test('repair: curly quotes, single quotes, inner quotes, trailing commas, fullwidth punctuation, truncation', () => {
  const gs = load(baseStore());
  const curly = gs.importParseEnvelope_('{“version”: 1, “items”: [{“kind”: “expense”, “date”: “2026-10-21”, “amount”: 120, “note”: “午餐”}]}');
  assert.equal(curly.error, null);
  assert.equal(curly.repaired, true);
  assert.equal(curly.items[0].note, '午餐');

  const python = gs.importParseEnvelope_("{'items': [{'kind': 'expense', 'date': '2026-10-21', 'amount': 120, 'note': \"7-Eleven's\", 'tags': None}]}");
  assert.equal(python.error, null);
  assert.equal(python.items[0].note, "7-Eleven's");

  const inner = gs.importParseEnvelope_('{"items":[{"kind":"expense","date":"2026-10-21","amount":1,280,"note":"買 "可樂" 兩瓶",},]}');
  assert.equal(inner.error, null);
  assert.equal(inner.items[0].amount, 1280);
  assert.equal(inner.items[0].note, '買 "可樂" 兩瓶');

  const fullwidth = gs.importParseEnvelope_('｛"items"：［｛"kind"："income"，"date"："2026-10-21"，"amount"："NT$ 1,000"｝］｝');
  assert.equal(fullwidth.error, null);
  assert.equal(fullwidth.items[0].amount, 1000);

  const cut = gs.importParseEnvelope_('```json\n{"version":1,"items":[{"kind":"expense","date":"2026-10-21","amount":120,"note":"ok"},{"kind":"expense","date":"2026-10-22","amount":9');
  assert.equal(cut.truncated, true);
  assert.equal(cut.items.length, 1, 'the half item is dropped');
  assert.match(cut.rejected[0].message, /截斷/);

  const prose = gs.importParseEnvelope_('{"items":[{"kind":"expense","date":"2026-10-21","amount":5}]}\n希望這有幫助！');
  assert.equal(prose.error, null);
  assert.equal(prose.repaired, false);

  assert.equal(gs.importLooksLikeJsonStart_('“{"items": []}”'), true);
  assert.equal(gs.importLooksLikeJsonStart_('｛"a":1｝'), true);
  assert.equal(gs.importLooksLikeJsonStart_('午餐 150'), false);
});

test('payment: accounts, custom payment methods (name / type / last4), presets, unmatched', () => {
  const gs = load(baseStore());
  const ctx = gs.importLoadContext_('rex');
  const rows = gs.importNormalize_([
    { kind: 'expense', date: '2026-10-21', amount: 100, currency: 'TWD', category: 'food', account: 'CUBE' },
    { kind: 'expense', date: '2026-10-21', amount: 101, currency: 'TWD', category: 'food', account: '信用卡' },
    { kind: 'expense', date: '2026-10-21', amount: 102, currency: 'TWD', category: 'food', paymentMethod: '卡號末四碼 1234' },
    { kind: 'expense', date: '2026-10-21', amount: 103, currency: 'TWD', category: 'food', account: 'LINE Pay' },
    { kind: 'expense', date: '2026-10-21', amount: 104, currency: 'TWD', category: 'food', account: '街口' },
    { kind: 'expense', date: '2026-10-21', amount: 105, currency: 'TWD', category: 'food', account: '不存在' },
    { kind: 'expense', date: '2026-10-21', amount: 106, currency: 'TWD', category: 'food' },
  ], ctx);
  assert.equal(rows[0].resolved.paymentMethod, '玉山 CUBE 卡');
  assert.equal(rows[0].resolved.accountId, null, 'credit card payment method without a linked account');
  assert.equal(rows[0].resolved.paymentMatched, true);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[1].resolved.paymentMethod, '玉山 CUBE 卡', 'only one credit card → type name resolves');
  assert.equal(rows[2].resolved.paymentMethod, '玉山 CUBE 卡', 'last4');
  assert.equal(rows[3].resolved.paymentMethod, 'LINE Pay');
  assert.equal(rows[3].resolved.accountId, 'a4', 'payment method linked to the e-wallet account');
  assert.equal(rows[4].resolved.paymentMethod, '街口', 'preset list');
  assert.equal(rows[4].resolved.accountId, null);
  assert.equal(rows[5].status, 'warn');
  assert.equal(rows[5].resolved.paymentMatched, false);
  assert.match(rows[5].messages.join(''), /付款方式/);
  assert.equal(rows[6].resolved.paymentMethod, '現金');
  assert.equal(rows[6].resolved.paymentMatched, false);
  assert.equal(rows[6].status, 'ready', 'no payment given is not a warning');

  const options = gs.importPaymentOptions_(ctx, 'expense');
  const labels = options.map((o) => o.paymentMethod);
  assert.ok(labels.includes('玉山') && labels.includes('玉山 CUBE 卡') && labels.includes('LINE Pay') && labels.includes('現金'));
  assert.equal(options.filter((o) => o.paymentMethod === 'LINE Pay').length, 1, 'account + payment method with the same name collapse');
  const income = gs.importPaymentOptions_(ctx, 'income');
  assert.ok(!income.some((o) => o.paymentMethod === '玉山 CUBE 卡'), 'income never goes to a credit card');
  assert.ok(gs.importPaymentOptions_(ctx, 'trade').every((o) => o.accountId));

  // 套用付款方式 / 改類別 / 排除 → status 重算；匯入時排除的不寫
  const cube = options.find((o) => o.paymentMethod === '玉山 CUBE 卡');
  assert.equal(gs.importSetRowPayment_(rows[5], cube), true);
  assert.equal(rows[5].status, 'ready');
  assert.equal(rows[5].resolved.paymentMethod, '玉山 CUBE 卡');
  assert.equal(gs.importSetRowCategory_(rows[6], 'salary', ctx), false, 'income category cannot go on an expense');
  assert.equal(gs.importSetRowCategory_(rows[6], 'other', ctx), true);
  rows[6].excluded = true;
  const results = gs.importApply_(rows, 'rex');
  assert.equal(results.length, 6);
});

test('trade rows: picking a settlement account later clears the error, hard errors stay', () => {
  const store = baseStore();
  const gs = load(store);
  const ctx = gs.importLoadContext_('rex');
  ctx.defaultTradeAccountId = null;
  const rows = gs.importNormalize_([
    { kind: 'trade', date: '2026-10-21', symbol: '2330', side: 'buy', shares: 1, price: 1000, account: '不存在的券商' },
    { kind: 'trade', date: '2026-10-21', symbol: 'TSLA', side: 'sell', shares: 1, price: 230, account: '元大交割戶' },
  ], ctx);
  assert.equal(rows[0].status, 'error');
  assert.equal(rows[0].hard, false);
  const acc = gs.importPaymentOptions_(ctx, 'trade').find((o) => o.accountId === 'a3');
  assert.equal(gs.importSetRowPayment_(rows[0], acc), true);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[1].hard, true, 'no position to sell');
  gs.importSetRowPayment_(rows[1], acc);
  assert.equal(rows[1].status, 'error');
});
