const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const esbuild = require('esbuild');

globalThis.crypto ||= webcrypto;

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    alias: { '@': path.resolve(__dirname, '../src') } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const {
  parseChiaumingTrip, planChiaumingImport, guessItemType, itineraryItemIdFor,
  statusForDates, widenDateRange, matchTripByName, looksLikeChiaumingTrip,
} = loadTs(path.resolve(__dirname, '../src/features/trips/import-chiauming.ts'));

// 與巧明日常 buildRMoneyTripTransfer() 的輸出形狀一致。
function sample(patch = {}) {
  return {
    format: 'chiauming-trip',
    version: 1,
    trip: { sourceTripKey: 'trip-1', title: '東京五天', destination: '東京、橫濱', startDate: '2026-11-01', endDate: '2026-11-05' },
    stops: [
      { sourceId: 'chiauming-100:trip-1:s1', title: '桃園機場出發', date: '2026-11-01', time: '07:30', place: '桃園機場 第二航廈' },
      { sourceId: 'chiauming-100:trip-1:s2', title: '淺草寺', date: '2026-11-01', time: '14:00', place: '淺草寺', note: '雷門拍照', mapQuery: '淺草寺 東京' },
      { sourceId: 'chiauming-100:trip-1:s3', title: '一蘭拉麵', date: '2026-11-01', time: '12:00', place: '一蘭 淺草店' },
      { sourceId: 'chiauming-100:trip-1:s4', title: '自由活動', date: '2026-11-02' },
    ],
    ...patch,
  };
}

test('parses the portable trip and plans days chronologically', () => {
  const text = JSON.stringify(sample());
  assert.equal(looksLikeChiaumingTrip(text), true);
  const plan = planChiaumingImport(parseChiaumingTrip(text));
  assert.equal(plan.name, '東京五天');
  assert.deepEqual(plan.destination, ['東京', '橫濱']);
  assert.equal(plan.startDate, '2026-11-01');
  assert.equal(plan.endDate, '2026-11-05');
  assert.equal(plan.stopCount, 4);
  assert.deepEqual(plan.days.map((day) => day.date), ['2026-11-01', '2026-11-02']);
  const [first, second, third] = plan.days[0].items;
  assert.deepEqual([first.title, second.title, third.title], ['桃園機場出發', '一蘭拉麵', '淺草寺']);
  assert.deepEqual(plan.days[0].items.map((item) => item.order), [1, 2, 3]);
  assert.equal(first.type, 'transport');
  assert.equal(first.skipGeocode, true);
  assert.equal(second.type, 'meal');
  assert.equal(third.type, 'activity');
  assert.equal(third.notes, '雷門拍照');
  assert.equal(third.placeQuery, '淺草寺 東京');
  assert.equal(third.mapsUrl, `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('淺草寺 東京')}`);
  const free = plan.days[1].items[0];
  assert.equal(free.startTime, undefined);
  assert.equal(free.placeQuery, '');
  assert.equal(free.skipGeocode, true);
});

test('widens trip dates to cover stops and works without trip dates', () => {
  const outside = sample({ stops: [{ sourceId: 'chiauming-100:trip-1:x', title: '提早出發', date: '2026-10-31' }] });
  const plan = planChiaumingImport(parseChiaumingTrip(JSON.stringify(outside)));
  assert.equal(plan.startDate, '2026-10-31');
  assert.equal(plan.endDate, '2026-11-05');

  const noDates = sample({ trip: { sourceTripKey: 'trip-1', title: '沒日期' } });
  const plan2 = planChiaumingImport(parseChiaumingTrip(JSON.stringify(noDates)));
  assert.equal(plan2.startDate, '2026-11-01');
  assert.equal(plan2.endDate, '2026-11-02');
  assert.deepEqual(plan2.destination, []);
});

test('rejects expense JSON, wrong versions, unknown fields and inconsistent data', () => {
  assert.throws(() => parseChiaumingTrip('not json'), /完整內容/);
  assert.throws(() => parseChiaumingTrip(JSON.stringify({ format: 'chiauming-expenses', version: 1 })), /貼上匯入/);
  assert.throws(() => parseChiaumingTrip(JSON.stringify(sample({ version: 2 }))), /格式或版本/);
  assert.throws(() => parseChiaumingTrip(JSON.stringify(sample({ extra: true }))), /格式或版本/);
  const bad = sample();
  bad.stops[0] = { ...bad.stops[0], date: '2026-02-30' };
  assert.throws(() => parseChiaumingTrip(JSON.stringify(bad)), /日期不正確/);
  const otherTrip = sample();
  otherTrip.stops[0] = { ...otherTrip.stops[0], sourceId: 'chiauming-100:trip-2:s1' };
  assert.throws(() => parseChiaumingTrip(JSON.stringify(otherTrip)), /來源 ID/);
  const dup = sample();
  dup.stops[1] = { ...dup.stops[1], sourceId: dup.stops[0].sourceId };
  assert.throws(() => parseChiaumingTrip(JSON.stringify(dup)), /重複/);
  assert.throws(() => parseChiaumingTrip(JSON.stringify(sample({ trip: { sourceTripKey: 'trip-1', title: 'x', startDate: '2026-11-05', endDate: '2026-11-01' } }))), /早於/);
  assert.throws(() => parseChiaumingTrip(JSON.stringify(sample({ trip: { sourceTripKey: 'trip-1', title: 'x' }, stops: [] }))), /沒有日期/);
  const badTime = sample();
  badTime.stops[0] = { ...badTime.stops[0], time: '7:30' };
  assert.throws(() => parseChiaumingTrip(JSON.stringify(badTime)), /格式或版本/);
});

test('derives stable item IDs from source IDs', async () => {
  const id = await itineraryItemIdFor('chiauming-100:trip-1:s1');
  assert.match(id, /^cm100_[0-9a-f]{40}$/);
  assert.equal(id, await itineraryItemIdFor('chiauming-100:trip-1:s1'));
  assert.notEqual(id, await itineraryItemIdFor('chiauming-100:trip-1:s2'));
});

test('guesses item types, status, date widening and name matching', () => {
  assert.equal(guessItemType({ title: '入住 APA 飯店' }), 'accommodation');
  assert.equal(guessItemType({ title: '逛 outlet' }), 'shopping');
  assert.equal(guessItemType({ title: '晴空塔', place: '' }), 'activity');
  assert.equal(statusForDates('2026-11-01', '2026-11-05', '2026-10-08'), 'planning');
  assert.equal(statusForDates('2026-10-01', '2026-10-10', '2026-10-08'), 'active');
  assert.equal(statusForDates('2026-09-01', '2026-09-05', '2026-10-08'), 'done');
  assert.deepEqual(
    widenDateRange({ startDate: '2026-11-01', endDate: '2026-11-06' }, { startDate: '2026-10-31', endDate: '2026-11-05' }),
    { startDate: '2026-10-31', endDate: '2026-11-06' },
  );
  const trips = [{ id: 'a', name: '東京 五天' }, { id: 'b', name: '大阪' }, { id: 'c', name: '大阪' }];
  assert.equal(matchTripByName('東京五天', trips)?.id, 'a');
  assert.equal(matchTripByName('大阪', trips), undefined);
  assert.equal(matchTripByName('', trips), undefined);
});
