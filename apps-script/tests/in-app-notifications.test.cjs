// App 內通知中心（2026-11 稽核 F1）：sendNotification_ 除了 Telegram 也寫 Firestore `notifications`。
// 載入真的 Notifications.gs + InAppNotifications.gs，stub 掉 Telegram / Firestore / CacheService。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SRC = path.join(__dirname, '../src');
const notificationsSource = fs.readFileSync(path.join(SRC, 'Notifications.gs'), 'utf8');
const inAppSource = fs.readFileSync(path.join(SRC, 'InAppNotifications.gs'), 'utf8');

function makeCache() {
  const store = new Map();
  return {
    store,
    get: (k) => (store.has(k) ? store.get(k) : null),
    put: (k, v) => { store.set(k, v); },
  };
}

function makeContext(overrides = {}) {
  const added = [];
  const telegram = [];
  const batches = [];
  const queries = [];
  const cache = makeCache();
  const props = { TG_NOTIFY_ENABLED: 'true', ...(overrides.props || {}) };
  const users = overrides.users || [
    { _name: 'projects/p/databases/(default)/documents/users/uid-owner', role: 'owner', preferences: { notifications: overrides.prefs || {} } },
  ];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date, Error, JSON, Math, Number, String, Array, Object, RegExp,
    PROP: { getProperty: (k) => (k in props ? props[k] : null) },
    CacheService: { getScriptCache: () => cache },
    Utilities: {
      base64Encode: (v) => Buffer.from(String(v)).toString('base64'),
      computeDigest: (_alg, v) => String(v),
      DigestAlgorithm: { MD5: 'MD5' },
      formatDate: () => '2026-11-09 21:00',
    },
    fsRunQuery_: (parent, q) => {
      queries.push({ parent, q });
      if (overrides.fsRunQuery_) return overrides.fsRunQuery_(parent, q);
      const filter = q.where && q.where.fieldFilter;
      if (q.from[0].collectionId === 'users') {
        return users.filter((u) => u.role === filter.value.stringValue).slice(0, 1);
      }
      return [];
    },
    fsAddDoc_: overrides.fsAddDoc_ || ((collectionPath, data) => { added.push({ collectionPath, data }); }),
    fsBatchWrite_: (writes) => { batches.push(writes); return {}; },
    sendTelegram: overrides.sendTelegram || ((message, parseMode) => { telegram.push({ message, parseMode }); return { ok: true }; }),
  });
  vm.runInContext(notificationsSource, context, { filename: 'Notifications.gs' });
  vm.runInContext(inAppSource, context, { filename: 'InAppNotifications.gs' });
  return { context, added, telegram, batches, queries, cache };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test('splitNotificationMessage_: strips [Personal Hub] prefix and separator lines', () => {
  const { context } = makeContext();
  const r = context.splitNotificationMessage_('[Personal Hub] 預算提醒\n--------------------\n月份: 2026-11\n  · 餐飲 85%\n');
  assert.deepEqual(plain(r), { title: '預算提醒', body: '月份: 2026-11\n  · 餐飲 85%' });

  const fx = context.splitNotificationMessage_('[匯率日報] 2026-11-09 21:00\n--------------------\n▲ USD/TWD 32.1000');
  assert.equal(fx.title, '[匯率日報] 2026-11-09 21:00');
  assert.equal(fx.body, '▲ USD/TWD 32.1000');

  const empty = context.splitNotificationMessage_('');
  assert.deepEqual(plain(empty), { title: '通知', body: '' });

  const leadingBlank = context.splitNotificationMessage_('\n\n【儲蓄目標進度】\n買房 40%');
  assert.deepEqual(plain(leadingBlank), { title: '【儲蓄目標進度】', body: '買房 40%' });
});

test('splitNotificationMessage_: truncates body to 2000 chars and strips HTML when parseMode=HTML', () => {
  const { context } = makeContext();
  const long = context.splitNotificationMessage_('Title\n' + 'x'.repeat(5000));
  assert.equal(long.body.length, 2000);
  assert.ok(long.body.endsWith('…'));

  const html = context.splitNotificationMessage_('<b>Hi</b>\nA &amp; B <i>c</i>', 'HTML');
  assert.deepEqual(plain(html), { title: 'Hi', body: 'A & B c' });
});

test('inAppNotificationLink_ / Severity_: known keys map to routes, unknown keys to null', () => {
  const { context } = makeContext();
  assert.equal(context.inAppNotificationLink_('weeklyReview'), '/inbox');
  assert.equal(context.inAppNotificationLink_('fxDaily'), '/fx');
  assert.equal(context.inAppNotificationLink_('tripCountdown'), '/trips');
  assert.equal(context.inAppNotificationLink_('weeklyBackup'), null);
  assert.equal(context.inAppNotificationLink_('toString'), null);
  assert.equal(context.inAppNotificationSeverity_('errors'), 'error');
  assert.equal(context.inAppNotificationSeverity_('budgetWarn'), 'warn');
  assert.equal(context.inAppNotificationSeverity_('ledgerDaily'), 'info');
});

test('sendNotification_: sends Telegram then writes an in-app notification for the owner', () => {
  const { context, added, telegram } = makeContext();
  const r = context.sendNotification_('budgetWarn', '[Personal Hub] 預算提醒\n-----\n餐飲 85%');
  assert.equal(r.ok, true);
  assert.equal(telegram.length, 1);
  assert.equal(added.length, 1);
  assert.equal(added[0].collectionPath, 'notifications');
  const doc = added[0].data;
  assert.equal(doc.userId, 'uid-owner');
  assert.equal(doc.key, 'budgetWarn');
  assert.equal(doc.title, '預算提醒');
  assert.equal(doc.body, '餐飲 85%');
  assert.equal(doc.readAt, null);
  assert.equal(doc.link, '/settings?tab=budget');
  assert.equal(doc.severity, 'warn');
  assert.equal(doc.telegramOk, true);
  assert.ok(doc.createdAt instanceof Date);
});

test('sendNotification_: per-key toggle off skips both Telegram and in-app; global switch off too', () => {
  const off = makeContext({ prefs: { ledgerDaily: false } });
  const r = off.context.sendNotification_('ledgerDaily', 'x');
  assert.equal(r.skipped, true);
  assert.equal(off.telegram.length, 0);
  assert.equal(off.added.length, 0);

  const globalOff = makeContext({ props: { TG_NOTIFY_ENABLED: 'false' } });
  globalOff.context.sendNotification_('ledgerDaily', 'x');
  assert.equal(globalOff.added.length, 0);
});

test('sendNotification_: Telegram failure still records in-app (telegramOk=false); Telegram throw re-throws after recording', () => {
  const failed = makeContext({ sendTelegram: () => ({ ok: false, error: 'telegram-400' }) });
  const r = failed.context.sendNotification_('fxDaily', '[匯率日報]\nUSD');
  assert.equal(r.ok, false);
  assert.equal(failed.added.length, 1);
  assert.equal(failed.added[0].data.telegramOk, false);

  const thrown = makeContext({ sendTelegram: () => { throw new Error('boom'); } });
  assert.throws(() => thrown.context.sendNotification_('fxDaily', 'x'), /boom/);
  assert.equal(thrown.added.length, 1);
});

test('sendNotification_: in-app write failure never breaks Telegram result', () => {
  const { context, telegram } = makeContext({ fsAddDoc_: () => { throw new Error('firestore down'); } });
  const r = context.sendNotification_('ledgerDaily', 'hello');
  assert.equal(r.ok, true);
  assert.equal(telegram.length, 1);
});

test('getOwnerUid_: falls back to admin, caches the uid, and returns null when nobody matches', () => {
  const admin = makeContext({ users: [{ _name: 'x/users/uid-admin', role: 'admin' }] });
  assert.equal(admin.context.getOwnerUid_(), 'uid-admin');
  const queriesAfterFirst = admin.queries.length;
  assert.equal(admin.context.getOwnerUid_(), 'uid-admin');
  assert.equal(admin.queries.length, queriesAfterFirst, 'second call is served from cache');

  const nobody = makeContext({ users: [] });
  assert.equal(nobody.context.getOwnerUid_(), null);
  const r = nobody.context.sendNotification_('ledgerDaily', 'hello');
  assert.equal(r.ok, true);
  assert.equal(nobody.added.length, 0);
});

test('notifyError: severity error with scope title; deduped repeats write nothing', () => {
  const { context, added, telegram } = makeContext();
  context.notifyError('fxDaily', new Error('API down'));
  assert.equal(added.length, 1);
  assert.equal(added[0].data.severity, 'error');
  assert.equal(added[0].data.title, '錯誤：fxDaily');
  assert.equal(added[0].data.link, '/settings?tab=data');
  const again = context.notifyError('fxDaily', new Error('API down'));
  assert.equal(again.deduped, true);
  assert.equal(added.length, 1);
  assert.equal(telegram.length, 1);
});

test('cleanupOldNotifications_: deletes docs older than 60 days in one batch (limit 300)', () => {
  const now = new Date('2026-11-09T00:00:00Z');
  const { context, batches, queries } = makeContext({
    fsRunQuery_: (_parent, q) => {
      if (q.from[0].collectionId !== 'notifications') return [];
      return [{ _name: 'n/1' }, { _name: 'n/2' }, { noName: true }];
    },
  });
  const r = context.cleanupOldNotifications_(now);
  assert.deepEqual(plain(r), { ok: true, deleted: 2 });
  assert.deepEqual(plain(batches), [[{ delete: 'n/1' }, { delete: 'n/2' }]]);
  const q = queries.find((x) => x.q.from[0].collectionId === 'notifications').q;
  assert.equal(q.limit, 300);
  assert.equal(q.where.fieldFilter.op, 'LESS_THAN');
  assert.equal(q.where.fieldFilter.value.timestampValue, '2026-09-10T00:00:00.000Z');
});
