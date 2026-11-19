const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function load(store) {
  const context = vm.createContext({ console, Date, Math, Number, String, Array, Object, JSON });
  for (const f of ['HouseholdInvest.gs', 'HouseholdTelegram.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8'), context);
  }
  context.fsGetDoc_ = (p) => (store[p] ? JSON.parse(JSON.stringify(store[p]), (k, v) => (k.endsWith('At') && v ? new Date(v) : v)) : null);
  context.fsSetDoc_ = (p, data, merge) => { store[p] = merge ? { ...(store[p] || {}), ...data } : { ...data }; };
  context.fsDeleteDoc_ = (p) => { delete store[p]; };
  context.fsListDocs_ = () => [];
  context.fsListAllDocs_ = () => [];
  context.logErrorToFirestore_ = () => {};
  return context;
}

const TOKEN = 'a'.repeat(40);
const household = { name: '我們家', ownerId: 'rex', memberIds: ['rex', 'partner'], members: { partner: { displayName: '伴侶' } } };

test('start token links a chat once and mirrors link state', () => {
  const store = {
    'households/h1': household,
    [`telegram_link_tokens/${TOKEN}`]: { uid: 'partner', householdId: 'h1', expiresAt: new Date(Date.now() + 60000).toISOString() },
  };
  const gs = load(store);
  const reply = gs.hhTgHandleStart_('555', TOKEN, { username: 'qiaoshu' });
  assert.match(reply, /已連結 RMoney/);
  assert.equal(store['telegram_links/partner'].chatId, '555');
  assert.equal(store['telegram_chats/555'].uid, 'partner');
  assert.equal(store['households/h1'].telegramLinked.partner, true);
  assert.equal(store[`telegram_link_tokens/${TOKEN}`], undefined);
  // 單次使用
  assert.match(gs.hhTgHandleStart_('777', TOKEN, {}), /已經用過/);
  assert.equal(store['telegram_chats/777'], undefined);
});

test('expired, malformed, or non-member tokens are rejected', () => {
  const store = {
    'households/h1': household,
    [`telegram_link_tokens/${TOKEN}`]: { uid: 'partner', householdId: 'h1', expiresAt: new Date(Date.now() - 1000).toISOString() },
    [`telegram_link_tokens/${'b'.repeat(40)}`]: { uid: 'stranger', householdId: 'h1', expiresAt: new Date(Date.now() + 60000).toISOString() },
  };
  const gs = load(store);
  assert.match(gs.hhTgHandleStart_('1', TOKEN, {}), /過期/);
  assert.match(gs.hhTgHandleStart_('1', 'not-a-token', {}), /無效/);
  assert.match(gs.hhTgHandleStart_('1', 'b'.repeat(40), {}), /不在這個共同帳本/);
  assert.equal(store['telegram_chats/1'], undefined);
});

test('unlinked chats get no reply; linked members only get household commands', () => {
  const store = { 'telegram_chats/555': { uid: 'partner', householdId: 'h1' }, 'telegram_links/partner': { chatId: '555', householdId: 'h1' }, 'households/h1': household };
  const gs = load(store);
  assert.equal(gs.hhTgHandleMemberMessage_('999', '/balance'), null);
  assert.match(gs.hhTgHandleMemberMessage_('555', '/balance'), /只能查看共同帳本/);
  assert.match(gs.hhTgHandleMemberMessage_('555', '午餐 150'), /只能查看共同帳本/);
  assert.match(gs.hhTgHandleMemberMessage_('555', '/unlink'), /已解除/);
  assert.equal(store['telegram_chats/555'], undefined);
  assert.equal(store['telegram_links/partner'], undefined);
});

test('report schedule honours frequency', () => {
  const gs = load({});
  gs.TZ = 'Asia/Taipei';
  gs.Utilities = { formatDate: (_d, _tz, fmt) => (fmt === 'u' ? '7' : '1') };
  assert.equal(gs.hhReportDue_('daily', new Date()), true);
  assert.equal(gs.hhReportDue_('weekly', new Date()), true);
  assert.equal(gs.hhReportDue_('monthly', new Date()), true);
  gs.Utilities = { formatDate: (_d, _tz, fmt) => (fmt === 'u' ? '3' : '15') };
  assert.equal(gs.hhReportDue_('weekly', new Date()), false);
  assert.equal(gs.hhReportDue_('monthly', new Date()), false);
});

test('hhSharesOfTx_ matches the web rule: members only, payer-only fallback', () => {
  const gs = load({});
  const cs = [
    { memberId: 'rex', amountTWD: 1000 }, { memberId: 'partner', amountTWD: 1000 }, { memberId: 'A', amountTWD: 2000 },
  ];
  // vm context 的物件原型不同，比較前先 JSON round-trip
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(gs.hhSharesOfTx_({ customShares: cs }, ['rex', 'partner'], 4000)), { rex: 1000, partner: 1000 });
  // settledAmountTWD 縮放：總額 2000 → 每份減半
  assert.deepEqual(plain(gs.hhSharesOfTx_({ customShares: cs }, ['rex', 'partner'], 2000)), { rex: 500, partner: 500 });
  assert.deepEqual(plain(gs.hhSharesOfTx_({ paidByUid: 'partner', userId: 'rex' }, ['rex', 'partner'], 300)), { rex: 0, partner: 300 });
  assert.deepEqual(plain(gs.hhSharesOfTx_({ payerId: 'A', userId: 'rex' }, ['rex', 'partner'], 300)), { rex: 0, partner: 0 });
});
