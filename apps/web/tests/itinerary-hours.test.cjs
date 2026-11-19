// features/itinerary/opening-hours.ts（營業時間）+ directions.ts（Google Maps 路線連結）
// 不依賴主機時區：本機驗證 TZ=America/New_York node --test apps/web/tests/itinerary-hours.test.cjs
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

const h = loadTs(path.resolve(__dirname, '../src/features/itinerary/opening-hours.ts'));
const d = loadTs(path.resolve(__dirname, '../src/features/itinerary/directions.ts'));

const P = (od, ot, cd, ct) => (cd == null ? { open: { day: od, time: ot } } : { open: { day: od, time: ot }, close: { day: cd, time: ct } });
// 週一到週五 09:00–17:00
const weekdays = [1, 2, 3, 4, 5].map((day) => P(day, '0900', day, '1700'));
// 居酒屋：每天 18:00 – 隔天 02:00（週六晚上跨到週日）
const izakaya = [0, 1, 2, 3, 4, 5, 6].map((day) => P(day, '1800', (day + 1) % 7, '0200'));
const allDay = [P(0, '0000')];
const JST = 540;

test('isOpenAt：用地點的 utc_offset 換算，不用台北 / 主機時區', () => {
  // 2026-11-09 是週一。東京 09:30 = UTC 00:30
  assert.equal(h.isOpenAt(weekdays, new Date('2026-11-09T00:30:00Z'), JST), true);
  // 東京 08:30（台北 07:30）還沒開
  assert.equal(h.isOpenAt(weekdays, new Date('2026-11-08T23:30:00Z'), JST), false);
  // 同一個瞬間若誤用台北時間（08:30 → 07:30）也不會變成開門；但 UTC 08:30 = 東京 17:30 已打烊、台北 16:30 仍營業
  const instant = new Date('2026-11-09T08:30:00Z');
  assert.equal(h.isOpenAt(weekdays, instant, JST), false);
  assert.equal(h.isOpenAt(weekdays, instant, 480), true);
  // 預設 offset = 台北
  assert.equal(h.isOpenAt(weekdays, instant), true);
  // 關門那一分鐘不算營業、開門那一分鐘算
  assert.equal(h.isOpenAt(weekdays, h.placeLocalInstant('2026-11-09', '17:00', JST), JST), false);
  assert.equal(h.isOpenAt(weekdays, h.placeLocalInstant('2026-11-09', '09:00', JST), JST), true);
  // 週六
  assert.equal(h.isOpenAt(weekdays, h.placeLocalInstant('2026-11-14', '12:00', JST), JST), false);
  // 負 offset（紐約 -300）
  assert.equal(h.isOpenAt(weekdays, h.placeLocalInstant('2026-11-09', '10:00', -300), -300), true);
  assert.equal(h.isOpenAt(weekdays, new Date('2026-11-09T13:00:00Z'), -300), false); // 紐約 08:00
});

test('isOpenAt：跨夜與跨週（週六 18:00 → 週日 02:00）', () => {
  // 週一 23:00、週二 01:30 營業；週二 03:00 打烊
  assert.equal(h.isOpenAt(izakaya, h.placeLocalInstant('2026-11-09', '23:00', JST), JST), true);
  assert.equal(h.isOpenAt(izakaya, h.placeLocalInstant('2026-11-10', '01:30', JST), JST), true);
  assert.equal(h.isOpenAt(izakaya, h.placeLocalInstant('2026-11-10', '03:00', JST), JST), false);
  // 週日 01:00 是從週六延續過來的（close.day 0 < open.day 6）
  const satOnly = [P(6, '1800', 0, '0200')];
  assert.equal(h.isOpenAt(satOnly, h.placeLocalInstant('2026-11-15', '01:00', JST), JST), true);
  assert.equal(h.isOpenAt(satOnly, h.placeLocalInstant('2026-11-14', '23:59', JST), JST), true);
  assert.equal(h.isOpenAt(satOnly, h.placeLocalInstant('2026-11-15', '02:00', JST), JST), false);
  assert.equal(h.isOpenAt(satOnly, h.placeLocalInstant('2026-11-14', '17:59', JST), JST), false);
});

test('isOpenAt：24 小時營業 / 沒有資料', () => {
  assert.equal(h.isOpenAt(allDay, new Date('2026-11-12T19:13:00Z'), JST), true);
  assert.equal(h.isAlwaysOpen(allDay), true);
  assert.equal(h.isOpenAt([], new Date()), null);
  assert.equal(h.isOpenAt(undefined, new Date()), null);
});

test('placeLocalInstant / dayOfWeekForDateInput / weekdayHoursText', () => {
  assert.equal(h.placeLocalInstant('2026-11-09', '09:00', JST).toISOString(), '2026-11-09T00:00:00.000Z');
  assert.equal(h.placeLocalInstant('2026-11-09', '09:00').toISOString(), '2026-11-09T01:00:00.000Z');
  assert.equal(h.placeLocalInstant('2026-11-09', '9am', JST), null);
  assert.equal(h.placeLocalInstant('2026/11/09', '09:00', JST), null);
  assert.equal(h.dayOfWeekForDateInput('2026-11-09'), 1);
  assert.equal(h.dayOfWeekForDateInput('2026-11-15'), 0);
  const text = ['星期一: 09:00 – 17:00', '星期二: 09:00 – 17:00', '星期三: 休息', '', '', '', 'Sunday: Closed'];
  assert.equal(h.weekdayHoursText(text, 1), '09:00 – 17:00');
  assert.equal(h.weekdayHoursText(text, 3), '休息');
  assert.equal(h.weekdayHoursText(text, 0), 'Closed');
  assert.equal(h.weekdayHoursText(text, 4), null);
  assert.equal(h.weekdayHoursText(['星期一：11:30–14:00, 17:00–21:00'], 1), '11:30–14:00, 17:00–21:00');
});

const hours = (extra = {}) => ({
  weekdayText: ['星期一: 09:00 – 17:00', '星期二: 09:00 – 17:00', '星期三: 09:00 – 17:00', '星期四: 09:00 – 17:00', '星期五: 09:00 – 17:00', '星期六: 休息', '星期日: 休息'],
  periods: weekdays,
  utcOffsetMinutes: JST,
  businessStatus: 'OPERATIONAL',
  fetchedAt: new Date('2026-11-01T00:00:00Z'),
  ...extra,
});

test('evaluateItemHours：營業 / 時間外 / 公休 / 結束前打烊 / 歇業', () => {
  assert.deepEqual(h.evaluateItemHours(hours(), '2026-11-09', '10:00', '12:00'),
    { status: 'open', dayText: '09:00 – 17:00', warning: null });
  assert.equal(h.evaluateItemHours(hours(), '2026-11-09', '08:00').status, 'closed-at-time');
  assert.match(h.evaluateItemHours(hours(), '2026-11-09', '08:00').warning, /08:00/);
  assert.equal(h.evaluateItemHours(hours(), '2026-11-09', '16:00', '18:00').status, 'closes-before-end');
  assert.equal(h.evaluateItemHours(hours(), '2026-11-09', '16:00', '17:00').status, 'open');
  const sat = h.evaluateItemHours(hours(), '2026-11-14', '10:00');
  assert.equal(sat.status, 'closed-all-day');
  assert.equal(sat.dayText, '休息');
  assert.match(sat.warning, /週六公休/);
  // 沒排時間：只看當天有沒有開
  assert.equal(h.evaluateItemHours(hours(), '2026-11-09').status, 'open');
  assert.equal(h.evaluateItemHours(hours({ businessStatus: 'CLOSED_TEMPORARILY' }), '2026-11-09', '10:00').status, 'temporarily-closed');
  assert.equal(h.evaluateItemHours(hours({ businessStatus: 'CLOSED_PERMANENTLY' }), '2026-11-09', '10:00').status, 'permanently-closed');
  assert.equal(h.evaluateItemHours(hours({ periods: [] }), '2026-11-09', '10:00').status, 'unknown');
  assert.equal(h.evaluateItemHours(undefined, '2026-11-09', '10:00').status, 'unknown');
  // 跨午夜的行程（22:00 – 01:00）在居酒屋營業時間內
  assert.equal(h.evaluateItemHours(hours({ periods: izakaya }), '2026-11-09', '22:00', '01:00').status, 'open');
  assert.equal(h.evaluateItemHours(hours({ periods: izakaya }), '2026-11-09', '23:00', '03:00').status, 'closes-before-end');
});

test('needsOpeningHoursFetch：沒抓過、換地點、超過 14 天才重抓', () => {
  const now = new Date('2026-11-09T00:00:00Z');
  assert.equal(h.needsOpeningHoursFetch({}, now), false);
  assert.equal(h.needsOpeningHoursFetch({ placeId: 'A' }, now), true);
  assert.equal(h.needsOpeningHoursFetch({ placeId: 'A', openingHours: hours({ placeId: 'A' }) }, now), false);
  assert.equal(h.needsOpeningHoursFetch({ placeId: 'B', openingHours: hours({ placeId: 'A' }) }, now), true);
  assert.equal(h.needsOpeningHoursFetch({ placeId: 'A', openingHours: hours({ fetchedAt: new Date('2026-10-20T00:00:00Z') }) }, now), true);
});

test('placeDetailsToOpeningHours：Apps Script 結果 → item.openingHours', () => {
  const now = new Date('2026-11-09T00:00:00Z');
  const out = h.placeDetailsToOpeningHours({
    placeId: 'A', businessStatus: 'CLOSED_TEMPORARILY', utcOffsetMinutes: 540, url: 'https://maps.google.com/?cid=1',
    weekdayText: ['星期一: 休息'], periods: weekdays, hasHours: true,
  }, 'A', now);
  assert.deepEqual(out, {
    placeId: 'A', weekdayText: ['星期一: 休息'], periods: weekdays, fetchedAt: now,
    utcOffsetMinutes: 540, businessStatus: 'CLOSED_TEMPORARILY', url: 'https://maps.google.com/?cid=1',
  });
  const none = h.placeDetailsToOpeningHours({ businessStatus: 'WEIRD', utcOffsetMinutes: null, hasHours: false }, 'B', now);
  assert.deepEqual(none, { placeId: 'B', weekdayText: [], periods: [], fetchedAt: now, noHours: true });
  assert.equal(h.needsOpeningHoursFetch({ placeId: 'B', openingHours: none }, now), false);
});

// ---- directions ----

function params(url) {
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.google.com/maps/dir/');
  return Object.fromEntries(u.searchParams.entries());
}

test('itemsToRouteStops：placeId 用地名、沒有的用座標，無位置略過，連續重複合併', () => {
  const stops = d.itemsToRouteStops([
    { title: '飯店', placeId: 'P_HOTEL', placeName: 'Hotel A', lat: 35.1, lng: 139.1 },
    { title: '自由活動' },
    { title: '淺草寺', lat: 35.7148, lng: 139.7967 },
    { title: '晚餐', address: '東京都台東区1-2-3' },
    { title: '回飯店', placeId: 'P_HOTEL', placeName: 'Hotel A' },
    { title: '回飯店休息', placeId: 'P_HOTEL', placeName: 'Hotel A' },
  ]);
  assert.deepEqual(stops, [
    { label: 'Hotel A', query: 'Hotel A', placeId: 'P_HOTEL' },
    { label: '淺草寺', query: '35.7148,139.7967' },
    { label: '晚餐', query: '東京都台東区1-2-3' },
    { label: 'Hotel A', query: 'Hotel A', placeId: 'P_HOTEL' },
  ]);
});

const mk = (n, withPlaceId = true) => Array.from({ length: n }, (_, i) => ({
  label: `S${i}`, query: `${i},${i}`, ...(withPlaceId ? { placeId: `P${i}` } : {}),
}));

test('buildDirectionsLinks：一個連結最多 9 個 waypoints，place_id 一一對應', () => {
  assert.deepEqual(d.buildDirectionsLinks([], 'walking'), []);
  assert.deepEqual(d.buildDirectionsLinks(mk(1), 'walking'), []);

  const two = d.buildDirectionsLinks(mk(2), 'driving');
  assert.equal(two.length, 1);
  assert.deepEqual(params(two[0].url), {
    api: '1', origin: '0,0', origin_place_id: 'P0', destination: '1,1', destination_place_id: 'P1', travelmode: 'driving',
  });

  const eleven = d.buildDirectionsLinks(mk(11), 'walking');
  assert.equal(eleven.length, 1);
  const p11 = params(eleven[0].url);
  assert.equal(p11.waypoints.split('|').length, 9);
  assert.equal(p11.waypoint_place_ids, 'P1|P2|P3|P4|P5|P6|P7|P8|P9');
  assert.equal(p11.destination_place_id, 'P10');
  assert.match(eleven[0].url, /waypoints=1%2C1%7C2%2C2/);

  // 12 個點 → 兩段，第二段從第一段終點出發
  const twelve = d.buildDirectionsLinks(mk(12), 'walking');
  assert.equal(twelve.length, 2);
  assert.deepEqual([twelve[0].from, twelve[0].to, twelve[1].from, twelve[1].to], ['S0', 'S10', 'S10', 'S11']);
  assert.equal(params(twelve[1].url).waypoints, undefined);
  assert.equal(twelve[0].stopCount + twelve[1].stopCount, 13);
});

test('buildDirectionsLinks：手機 3 個 waypoints、transit 不帶 waypoints、place_id 不齊就不帶 waypoint_place_ids', () => {
  const mobile = d.buildDirectionsLinks(mk(9), 'driving', d.MOBILE_URL_WAYPOINTS);
  assert.deepEqual(mobile.map((l) => [l.from, l.to]), [['S0', 'S4'], ['S4', 'S8']]);
  assert.equal(params(mobile[0].url).waypoints.split('|').length, 3);

  const transit = d.buildDirectionsLinks(mk(4), 'transit');
  assert.equal(transit.length, 3);
  for (const l of transit) assert.equal(params(l.url).waypoints, undefined);
  assert.equal(params(transit[0].url).travelmode, 'transit');

  const mixed = [...mk(1), { label: 'X', query: '9,9' }, ...mk(2).slice(1)];
  const pm = params(d.buildDirectionsLinks(mixed, 'walking')[0].url);
  assert.equal(pm.waypoints, '9,9');
  assert.equal(pm.waypoint_place_ids, undefined);

  // maxWaypoints 超過 9 仍以 9 為上限
  assert.equal(d.buildDirectionsLinks(mk(20), 'walking', 50).length, 2);
});
