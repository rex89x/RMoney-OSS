const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');

/**
 * 模擬 Telegram 匯入互動：ScriptCache、Telegram API、Firestore 都是記憶體假物件。
 * 只驗流程（預覽 → 套用付款方式 / 逐筆調整 → 確認），不碰網路。
 */
function load(store) {
  let seq = 0;
  const cache = new Map();
  const sent = [];
  const edits = [];
  const answers = [];
  const context = vm.createContext({
    console, Date, Math, Number, String, Array, Object, JSON, RegExp, parseFloat, parseInt, isFinite, isNaN,
    encodeURIComponent, unescape,
  });
  context.PROP = { getProperty: (k) => ({ TG_CHAT_ID: '777', TG_BOT_TOKEN: 'tok' }[k] || null) };
  context.CacheService = {
    getScriptCache: () => ({
      get: (k) => (cache.has(k) ? cache.get(k) : null),
      put: (k, v) => { cache.set(k, String(v)); },
      remove: (k) => { cache.delete(k); },
    }),
  };
  context.Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (_alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    getUuid: () => 'abcdefabcdefabcd' + (++seq),
    formatDate: () => '2026-10-24',
  };
  context.fsGetDoc_ = (p) => (store[p] ? JSON.parse(JSON.stringify(store[p])) : null);
  context.fsSetDoc_ = (p, data, merge) => { store[p] = merge ? { ...(store[p] || {}), ...data } : { ...data }; return {}; };
  context.fsAddDoc_ = (col, data) => { const id = 'auto' + (++seq); store[`${col}/${id}`] = { ...data }; return { name: `projects/x/databases/(default)/documents/${col}/${id}` }; };
  context.fsDeleteDoc_ = (p) => { delete store[p]; };
  context.fsRunQuery_ = () => [];
  context.refreshSymbol = () => ({ ok: true });
  context.getOwnerUid_ = () => 'rex';
  context.tgLoadEntryContext_ = () => ({
    categories: [
      { key: 'food', name: '餐飲', type: 'expense' }, { key: 'transport', name: '交通', type: 'expense' }, { key: 'other', name: '其他', type: 'expense' },
      { key: 'salary', name: '薪資', type: 'income' }, { key: 'other_income', name: '其他收入', type: 'income' },
    ],
    paymentMethods: [{ key: 'cube', name: '玉山 CUBE 卡', type: 'credit', last4: '1234' }],
    accounts: [
      { id: 'a1', name: '玉山銀行', type: 'bank', legacyPaymentMethod: '玉山' },
      { id: 'a2', name: '錢包', type: 'cash', legacyPaymentMethod: '現金' },
    ],
  });
  context.sendTelegram = (text) => { sent.push({ text, markup: null }); return { ok: true }; };
  context.sendTelegramWithMarkup_ = (text, markup) => { sent.push({ text, markup }); return { ok: true }; };
  context.tgEditMessage_ = (chatId, messageId, text, markup) => { edits.push({ text, markup }); return { ok: true }; };
  context.tgAnswerCallback_ = (id, text) => { answers.push(text); return { ok: true }; };
  context.tgApi_ = () => ({ ok: true, result: {} });
  context.jsonResponse_ = (o) => o;
  context.TG_REPLY_SENT_ = '__tg_reply_sent__';
  context.logErrorToFirestore_ = () => {};
  context.buildImportPrompt_ = () => 'PROMPT';
  context.parseImport = () => ({ ok: false, error: 'no claude in tests' });
  context.tgQuickEntry_ = () => '__quick_entry__';
  context.UrlFetchApp = { fetch: () => { throw new Error('no network in tests'); } };
  for (const f of ['Stocks.gs', 'ImportJson.gs', 'ImportApply.gs', 'ImportTelegram.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8'), context);
  }
  return { gs: context, cache, sent, edits, answers, store };
}

const baseStore = () => ({
  'accounts/a1': { name: '玉山銀行', type: 'bank', currency: 'TWD', balance: 10000, balanceTWD: 10000 },
  'accounts/a2': { name: '錢包', type: 'cash', currency: 'TWD', balance: 500, balanceTWD: 500 },
});

function buttons(markup) {
  return markup.inline_keyboard.flat().map((b) => b.text + '=' + (b.callback_data || b.url));
}
function callback(h, data, text) {
  const parts = data.split(':');
  return h.gs.tgHandleImportCallback_({ id: 'cq', data, message: { chat: { id: 777 }, message_id: 1, text: text || '' } }, parts, 1);
}

test('pasting curly-quoted JSON previews with import / payment / per-row buttons', () => {
  const h = load(baseStore());
  const reply = h.gs.tgImportFromText_('“{“items”: [{“kind”: “expense”, “date”: “2026-10-21”, “amount”: 120, “category”: “food”, “note”: “午餐”}, {“kind”: “expense”, “date”: “2026-10-21”, “amount”: 80, “category”: “transport”, “account”: “玉山”}]}”', null);
  assert.equal(reply, h.gs.TG_REPLY_SENT_);
  const msg = h.sent[0];
  assert.match(msg.text, /匯入預覽：2 筆/);
  assert.match(msg.text, /已自動修正/);
  assert.match(msg.text, /1 筆記帳沒指定付款方式/);
  const b = buttons(msg.markup);
  assert.ok(b.some((x) => x.startsWith('確認匯入 2 筆=imp:ok:')));
  assert.ok(b.some((x) => x.startsWith('付款方式套用（1 筆未指定）=imp:pm:')));
  assert.ok(b.some((x) => x.startsWith('逐筆調整=imp:row:')));
  assert.equal(h.gs.tgLooksLikeImportJson_('“{“items”: []}”'), true);
});

test('payment apply-to-all picks the unmatched rows only, then confirm writes with that payment method', () => {
  const h = load(baseStore());
  h.gs.tgImportFromText_('{"items":[{"kind":"expense","date":"2026-10-21","amount":120,"category":"food","note":"午餐"},{"kind":"expense","date":"2026-10-21","amount":80,"category":"transport","account":"玉山"}]}', null);
  const token = buttons(h.sent[0].markup).find((x) => x.includes('imp:pm:')).split('imp:pm:')[1];
  callback(h, 'imp:pm:' + token);
  const menu = h.edits.at(-1);
  assert.match(menu.text, /套用到 1 筆沒指定付款方式/);
  const cube = menu.markup.inline_keyboard.flat().find((b) => b.text.startsWith('玉山 CUBE 卡'));
  assert.ok(cube, 'custom credit card shows up in the dynamic list');
  assert.ok(Buffer.byteLength(cube.callback_data) <= 64);
  callback(h, cube.callback_data);
  assert.match(h.answers.at(-1), /已套用到 1 筆/);
  const pending = JSON.parse(h.cache.get('tgimp:' + token));
  assert.equal(pending.rows[0].resolved.paymentMethod, '玉山 CUBE 卡');
  assert.equal(pending.rows[0].resolved.paymentMatched, true);
  assert.equal(pending.rows[1].resolved.paymentMethod, '玉山', 'explicit account untouched');
  assert.ok(!h.edits.at(-1).text.includes('沒指定付款方式'));

  callback(h, 'imp:ok:' + token);
  const txs = Object.entries(h.store).filter(([k]) => k.startsWith('transactions/')).map(([, v]) => v);
  assert.equal(txs.length, 2);
  assert.equal(txs.find((t) => t.amount === 120).paymentMethod, '玉山 CUBE 卡');
  assert.equal(txs.find((t) => t.amount === 120).fromAccountId, null);
  assert.equal(txs.find((t) => t.amount === 80).fromAccountId, 'a1');
  assert.equal(h.store['accounts/a1'].balance, 10000 - 80);
  assert.equal(h.cache.has('tgimp:' + token), false, 'pending removed after apply');
});

test('per-row editing: category, payment, exclude; excluded rows are not imported', () => {
  const h = load(baseStore());
  h.gs.tgImportFromText_('[{"kind":"expense","date":"2026-10-21","amount":120,"category":"不存在","note":"午餐"},{"kind":"expense","date":"2026-10-21","amount":80,"category":"transport"}]', null);
  const token = buttons(h.sent[0].markup).find((x) => x.includes('imp:row:')).split('imp:row:')[1].split(':')[0];
  callback(h, 'imp:row:' + token + ':0');
  let view = h.edits.at(-1);
  assert.match(view.text, /逐筆調整 1 \/ 2/);
  assert.ok(buttons(view.markup).includes('下一筆 ›=imp:row:' + token + ':1'));
  callback(h, 'imp:rc:' + token + ':0');
  const food = h.edits.at(-1).markup.inline_keyboard.flat().find((b) => b.text === '餐飲');
  callback(h, food.callback_data);
  view = h.edits.at(-1);
  assert.match(view.text, /類別：餐飲/);
  assert.ok(!view.text.includes('類別「不存在」'));
  callback(h, 'imp:rp:' + token + ':0');
  const wallet = h.edits.at(-1).markup.inline_keyboard.flat().find((b) => b.text.startsWith('錢包'));
  callback(h, wallet.callback_data);
  assert.match(h.edits.at(-1).text, /付款方式：現金，扣 \/ 入帳戶 錢包/);
  callback(h, 'imp:row:' + token + ':1');
  callback(h, 'imp:rt:' + token + ':1');
  assert.match(h.edits.at(-1).text, /已排除/);
  callback(h, 'imp:pv:' + token);
  assert.match(h.edits.at(-1).text, /○ 已排除 1/);
  assert.ok(buttons(h.edits.at(-1).markup).some((x) => x.startsWith('確認匯入 1 筆=')));
  callback(h, 'imp:ok:' + token);
  const txs = Object.values(h.store).filter((v) => v.userId === 'rex');
  assert.equal(txs.length, 1);
  assert.equal(txs[0].category, 'food');
  assert.equal(txs[0].fromAccountId, 'a2');
  assert.equal(h.store['accounts/a2'].balance, 500 - 120);
});

test('a JSON cut by Telegram waits for the next part and stitches it back together', () => {
  const h = load(baseStore());
  const full = '{"items":[{"kind":"expense","date":"2026-10-21","amount":120,"category":"food"},{"kind":"expense","date":"2026-10-21","amount":80,"category":"transport"}]}';
  const first = full.slice(0, 90);
  const second = full.slice(90);
  assert.equal(h.gs.tgImportFromText_(first, null), h.gs.TG_REPLY_SENT_);
  assert.match(h.sent.at(-1).text, /還沒結束/);
  assert.equal(h.gs.tgImportHasPartial_(), true);
  assert.ok(buttons(h.sent.at(-1).markup).includes('就用目前這 1 筆=imp:part:ok'));
  assert.equal(h.gs.tgImportContinuePartial_(second), h.gs.TG_REPLY_SENT_);
  assert.match(h.sent.at(-1).text, /匯入預覽（分段貼上）：2 筆/);
  assert.equal(h.gs.tgImportHasPartial_(), false);
  assert.match(h.gs.tgImportCancelPartial_(), /沒有進行中/);
});

test('multi-line free text gets a choice menu instead of a single quick entry', () => {
  const h = load(baseStore());
  assert.equal(h.gs.tgLooksLikeBulkText_('午餐 150'), false);
  assert.equal(h.gs.tgLooksLikeBulkText_('昨天 星巴克 180 刷玉山'), false);
  assert.equal(h.gs.tgLooksLikeBulkText_('10/21 全家 55\n10/21 捷運 30'), true);
  assert.equal(h.gs.tgLooksLikeBulkText_('第一行\n第二行\n第三行'), true);
  assert.equal(h.gs.tgOfferImportChoice_('10/21 全家 55\n10/21 捷運 30'), h.gs.TG_REPLY_SENT_);
  const b = buttons(h.sent.at(-1).markup);
  assert.ok(b.some((x) => x.startsWith('Claude 轉匯入=imp:ai:')));
  assert.ok(b.some((x) => x.startsWith('產生提示詞=imp:pr:')));
  const qe = b.find((x) => x.startsWith('當一筆記帳=imp:qe:')).split('=')[1];
  callback(h, qe);
  assert.equal(h.sent.at(-1).text, '__quick_entry__');
});
