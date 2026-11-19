// features/notifications/utils.ts — App 內通知中心的純函式（2026-11 稽核 F1）
// 不可依賴主機時區：本機驗證 TZ=UTC / TZ=America/New_York node --test apps/web/tests/notifications.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    alias: { '@': path.resolve(__dirname, '../src') } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const n = loadTs(path.resolve(__dirname, '../src/features/notifications/utils.ts'));

/** 台北時間 yyyy-MM-ddTHH:mm → Date */
function tw(s) {
  return new Date(`${s}:00+08:00`);
}

test('countUnread / formatUnreadBadge', () => {
  assert.equal(n.countUnread([]), 0);
  assert.equal(n.countUnread([{ readAt: null }, { readAt: new Date() }, { readAt: null }]), 2);
  assert.equal(n.formatUnreadBadge(0), '');
  assert.equal(n.formatUnreadBadge(-1), '');
  assert.equal(n.formatUnreadBadge(7), '7');
  assert.equal(n.formatUnreadBadge(99), '99');
  assert.equal(n.formatUnreadBadge(100), '99+');
  assert.equal(n.NOTIFICATIONS_LIMIT, 50);
});

test('safeNotificationLink: only in-app absolute paths', () => {
  assert.equal(n.safeNotificationLink('/ledger'), '/ledger');
  assert.equal(n.safeNotificationLink('/settings?tab=bills'), '/settings?tab=bills');
  assert.equal(n.safeNotificationLink('  /inbox '), '/inbox');
  assert.equal(n.safeNotificationLink(null), null);
  assert.equal(n.safeNotificationLink(undefined), null);
  assert.equal(n.safeNotificationLink(''), null);
  assert.equal(n.safeNotificationLink('ledger'), null);
  assert.equal(n.safeNotificationLink('//evil.com'), null);
  assert.equal(n.safeNotificationLink('/\\evil.com'), null);
  assert.equal(n.safeNotificationLink('https://evil.com'), null);
  assert.equal(n.safeNotificationLink('javascript:alert(1)'), null);
  assert.equal(n.safeNotificationLink('/a b'), null);
});

test('formatNotificationTime: relative within the same Taipei day', () => {
  const now = tw('2026-11-09T21:30');
  assert.equal(n.formatNotificationTime(tw('2026-11-09T21:30'), now), '剛剛');
  assert.equal(n.formatNotificationTime(new Date(now.getTime() - 59_000), now), '剛剛');
  assert.equal(n.formatNotificationTime(tw('2026-11-09T21:25'), now), '5 分鐘前');
  assert.equal(n.formatNotificationTime(tw('2026-11-09T18:00'), now), '3 小時前');
  assert.equal(n.formatNotificationTime(tw('2026-11-09T00:10'), now), '21 小時前');
});

test('formatNotificationTime: 昨天 uses the Taipei calendar day, not UTC', () => {
  // 台北 11/10 00:30 = UTC 11/09 16:30；通知在台北 11/09 23:00（UTC 同一天）→ 仍是「昨天」
  const now = tw('2026-11-10T00:30');
  assert.equal(n.formatNotificationTime(tw('2026-11-09T23:00'), now), '昨天 23:00');
  // 台北 11/09 07:00 = UTC 11/08 23:00；UTC 看是前一天，但台北是今天 → 不是「昨天」
  const morning = tw('2026-11-09T09:00');
  assert.equal(n.formatNotificationTime(tw('2026-11-09T07:00'), morning), '2 小時前');
});

test('formatNotificationTime: older dates', () => {
  const now = tw('2026-11-09T12:00');
  assert.equal(n.formatNotificationTime(tw('2026-11-01T09:05'), now), '11/01 09:05');
  assert.equal(n.formatNotificationTime(tw('2025-12-31T23:59'), now), '2025/12/31');
  // 台北 2026-01-01 00:30（UTC 還是 2025）→ 屬於今年
  assert.equal(n.formatNotificationTime(tw('2026-01-01T00:30'), now), '01/01 00:30');
});
