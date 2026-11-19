// lib/tz.ts — Asia/Taipei 日期工具（CLAUDE.md §11、pitfall #21 / #23）
// 這些測試不可依賴主機時區：CI 跑 UTC，開發機可能是 Asia/Taipei 或 America/New_York。
// 本機驗證：TZ=UTC / TZ=America/New_York node --test apps/web/tests/tz.test.cjs
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

const tz = loadTs(path.resolve(__dirname, '../src/lib/tz.ts'));

/** 台北時間 yyyy-MM-ddTHH:mm → Date */
function tw(s) {
  return new Date(`${s}:00+08:00`);
}
const iso = (d) => d.toISOString();

test('formatTWDateInput: 台北凌晨（UTC 前一天）不會往前一天 (pitfall #21)', () => {
  // 2026-05-01 00:30 台北 = 2026-04-30T16:30Z
  const d = new Date('2026-04-30T16:30:00.000Z');
  assert.equal(tz.formatTWDateInput(d), '2026-05-01');
  // 對照組：toISOString().slice(0, 10) 就是 pitfall #21 的錯誤寫法
  assert.equal(d.toISOString().slice(0, 10), '2026-04-30');
  // number / ISO string 輸入
  assert.equal(tz.formatTWDateInput(d.getTime()), '2026-05-01');
  assert.equal(tz.formatTWDateInput('2026-04-30T16:30:00.000Z'), '2026-05-01');
  // 台北 23:59:59.999 仍是當天，下一毫秒才換日
  assert.equal(tz.formatTWDateInput(new Date('2026-04-30T15:59:59.999Z')), '2026-04-30');
  assert.equal(tz.formatTWDateInput(new Date('2026-04-30T16:00:00.000Z')), '2026-05-01');
  // 跨年
  assert.equal(tz.formatTWDateInput(new Date('2026-12-31T16:00:00.000Z')), '2027-01-01');
  assert.equal(tz.formatTWMonthKey(new Date('2026-12-31T16:00:00.000Z')), '2027-01');
});

test('parseDateInput: 只接受合法 yyyy-MM-dd，回傳主機本地午夜的同一個日曆日', () => {
  const d = tz.parseDateInput('2026-05-01');
  assert.ok(d instanceof Date);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 4, 1, 0, 0]);
  const leap = tz.parseDateInput('2028-02-29');
  assert.deepEqual([leap.getFullYear(), leap.getMonth(), leap.getDate()], [2028, 1, 29]);

  for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2026-5-1', '2026/05/01',
    '2026-05-01T00:00', ' 2026-05-01', '', null, undefined]) {
    assert.equal(tz.parseDateInput(bad), null, String(bad));
  }
});

test('formatDateInput ↔ parseDateInput round trip（DatePicker 存值）', () => {
  for (const s of ['2026-01-01', '2026-03-08', '2026-05-01', '2026-11-01', '2026-12-31', '2028-02-29']) {
    assert.equal(tz.formatDateInput(tz.parseDateInput(s)), s, s);
  }
  // DatePicker 給的是本地日曆日的 Date，不做時區轉換
  assert.equal(tz.formatDateInput(new Date(2026, 4, 1, 23, 59)), '2026-05-01');
});

test('dateInputToTWDate: date-only 字串 → 台北午夜的 UTC instant', () => {
  assert.equal(iso(tz.dateInputToTWDate('2026-05-01')), '2026-04-30T16:00:00.000Z');
  assert.equal(iso(tz.dateInputToTWDate('2027-01-01')), '2026-12-31T16:00:00.000Z');
  assert.equal(iso(tz.dateInputToTWDate('2028-02-29')), '2028-02-28T16:00:00.000Z');
  assert.equal(tz.dateInputToTWDate('2026-02-30'), null);
  assert.equal(tz.dateInputToTWDate(''), null);
  assert.equal(tz.dateInputToTWDate(null), null);
});

test('dateInputToTWBoundary: 台北當天 00:00:00.000 ~ 23:59:59.999', () => {
  assert.equal(iso(tz.dateInputToTWBoundary('2026-05-01', 'start')), '2026-04-30T16:00:00.000Z');
  assert.equal(iso(tz.dateInputToTWBoundary('2026-05-01', 'end')), '2026-05-01T15:59:59.999Z');
  assert.equal(iso(tz.dateInputToTWBoundary('2026-12-31', 'end')), '2026-12-31T15:59:59.999Z');
  // 美國 DST 切換日（主機若在 America/New_York 這兩天只有 23 / 25 小時）不影響台北邊界
  assert.equal(iso(tz.dateInputToTWBoundary('2026-03-08', 'start')), '2026-03-07T16:00:00.000Z');
  assert.equal(iso(tz.dateInputToTWBoundary('2026-03-08', 'end')), '2026-03-08T15:59:59.999Z');
  assert.equal(iso(tz.dateInputToTWBoundary('2026-11-01', 'start')), '2026-10-31T16:00:00.000Z');
  assert.equal(iso(tz.dateInputToTWBoundary('2026-11-01', 'end')), '2026-11-01T15:59:59.999Z');
  assert.equal(tz.dateInputToTWBoundary('nope', 'start'), null);
});

test('date-only → TW instant → date-only round trip 不會漂移一天', () => {
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 800; i += 1) {
    const s = new Date(start + i * 86400000).toISOString().slice(0, 10); // 純 UTC 日曆，只用來列舉日期
    assert.equal(tz.formatTWDateInput(tz.dateInputToTWDate(s)), s, s);
    assert.equal(tz.formatTWDateInput(tz.dateInputToTWBoundary(s, 'end')), s, `${s} end`);
  }
});

test('startOfTWDay: 回傳台北當天 00:00 的 instant', () => {
  assert.equal(iso(tz.startOfTWDay(new Date('2026-04-30T16:30:00.000Z'))), '2026-04-30T16:00:00.000Z');
  assert.equal(iso(tz.startOfTWDay(tw('2026-05-01T23:59'))), '2026-04-30T16:00:00.000Z');
  assert.equal(iso(tz.startOfTWDay(new Date('2026-04-30T16:00:00.000Z'))), '2026-04-30T16:00:00.000Z');
  assert.equal(iso(tz.startOfTWDay(new Date('2026-04-30T15:59:59.999Z'))), '2026-04-29T16:00:00.000Z');
  // string / number
  assert.equal(iso(tz.startOfTWDay('2026-05-01T12:00:00+08:00')), '2026-04-30T16:00:00.000Z');
  assert.equal(iso(tz.startOfTWDay(tw('2026-05-01T12:00').getTime())), '2026-04-30T16:00:00.000Z');
  // 與 dateInputToTWBoundary start 一致
  assert.equal(iso(tz.startOfTWDay(tw('2026-03-08T12:00'))), iso(tz.dateInputToTWBoundary('2026-03-08', 'start')));
});

test('daysBetweenTWDates: 以台北日曆日計算，不看實際經過時數', () => {
  // 只差 1.5 小時但跨了台北午夜 → 1 天
  assert.equal(tz.daysBetweenTWDates(tw('2026-01-31T23:00'), tw('2026-02-01T00:30')), 1);
  // 同一個台北日（UTC 是不同日）→ 0
  assert.equal(tz.daysBetweenTWDates(tw('2026-05-01T00:30'), tw('2026-05-01T23:30')), 0);
  // 跨月：1/25 → 3/5（1 月 31 天、2026 年 2 月 28 天）
  assert.equal(tz.daysBetweenTWDates(tw('2026-01-25T09:00'), tw('2026-03-05T08:00')), 39);
  assert.equal(tz.daysBetweenTWDates(tw('2026-03-05T08:00'), tw('2026-01-25T09:00')), -39);
  // 閏年 2 月
  assert.equal(tz.daysBetweenTWDates(tw('2028-02-28T12:00'), tw('2028-03-01T12:00')), 2);
  // 跨年
  assert.equal(tz.daysBetweenTWDates('2026-12-31T23:59:00+08:00', '2027-01-01T00:00:00+08:00'), 1);
  // 跨美國 DST 切換（主機在 New York 時也不能變 1.96 / 2.04）
  assert.equal(tz.daysBetweenTWDates(tw('2026-03-07T12:00'), tw('2026-03-09T12:00')), 2);
  assert.equal(tz.daysBetweenTWDates(tw('2026-10-31T12:00'), tw('2026-11-02T12:00')), 2);
});

test('addTWCalendarMonths: 月底 clamp，不 rollover 到下個月 (pitfall #23)', () => {
  assert.equal(iso(tz.addTWCalendarMonths(tw('2026-01-31T10:15'), 1)), iso(tw('2026-02-28T10:15')));
  assert.equal(iso(tz.addTWCalendarMonths(tw('2028-01-31T10:15'), 1)), iso(tw('2028-02-29T10:15')));
  assert.equal(iso(tz.addTWCalendarMonths(tw('2026-03-31T10:15'), 1)), iso(tw('2026-04-30T10:15')));
  assert.equal(iso(tz.addTWCalendarMonths(tw('2026-03-31T10:15'), -1)), iso(tw('2026-02-28T10:15')));
  assert.equal(iso(tz.addTWCalendarMonths(tw('2026-12-15T10:15'), 1)), iso(tw('2027-01-15T10:15')));
  assert.equal(iso(tz.addTWCalendarMonths(tw('2026-01-31T10:15'), 13)), iso(tw('2027-02-28T10:15')));
  assert.equal(iso(tz.addTWCalendarMonths(tw('2026-05-10T10:15'), 0)), iso(tw('2026-05-10T10:15')));
  // 台北 1/31 01:00 在 UTC 還是 1/30 → 要以台北日曆日 clamp
  assert.equal(iso(tz.addTWCalendarMonths(tw('2026-01-31T01:00'), 1)), iso(tw('2026-02-28T01:00')));
  // 毫秒保留
  const withMs = new Date('2026-01-31T02:00:00.123Z');
  assert.equal(iso(tz.addTWCalendarMonths(withMs, 1)), '2026-02-28T02:00:00.123Z');
});

test('addTWCalendarYears: 2/29 + 1 年 → 2/28，+4 年 → 2/29', () => {
  assert.equal(iso(tz.addTWCalendarYears(tw('2028-02-29T09:00'), 1)), iso(tw('2029-02-28T09:00')));
  assert.equal(iso(tz.addTWCalendarYears(tw('2028-02-29T09:00'), 4)), iso(tw('2032-02-29T09:00')));
  assert.equal(iso(tz.addTWCalendarYears(tw('2028-02-29T09:00'), -1)), iso(tw('2027-02-28T09:00')));
  assert.equal(iso(tz.addTWCalendarYears(tw('2026-11-09T18:45'), 1)), iso(tw('2027-11-09T18:45')));
  // 台北 1/1 凌晨（UTC 還在前一年）
  assert.equal(iso(tz.addTWCalendarYears(tw('2027-01-01T00:30'), 1)), iso(tw('2028-01-01T00:30')));
});

// 回歸測試：addTWCalendarMonths / addTWCalendarYears 以前用主機本地時區暫存台北牆上時間，
// 主機在 DST 時區（如 America/New_York）時，落在跳躍缺口的時間會多一小時。現已改用 UTC 欄位運算。
test('addTWCalendarMonths 在主機 DST 缺口的牆上時間不應位移', () => {
  assert.equal(iso(tz.addTWCalendarMonths(tw('2026-02-08T02:30'), 1)), iso(tw('2026-03-08T02:30')));
  assert.equal(iso(tz.addTWCalendarYears(tw('2025-03-09T02:30'), 1)), iso(tw('2026-03-09T02:30')));
});
