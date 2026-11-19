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

const ai = loadTs(path.resolve(__dirname, '../src/features/itinerary/ai-import.ts'));

test('extracts JSON from fenced chat replies and repairs smart quotes', () => {
  const fenced = '好的，以下是結果：\n```json\n{"stops":[{"title":"淺草寺","date":"2026-11-01","time":"9:00","place":"淺草寺"}]}\n```\n祝旅途愉快';
  const a = ai.extractProposalJson(fenced);
  assert.equal(a.repaired, false);
  assert.equal(a.data.stops[0].title, '淺草寺');

  const broken = '{“stops”: [{“title”: “築地”, “date”: “2026-11-02”, “place”: “築地”,}]}';
  const b = ai.extractProposalJson(broken);
  assert.equal(b.repaired, true);
  assert.equal(b.data.stops[0].title, '築地');

  assert.throws(() => ai.extractProposalJson(''), /請先貼上/);
  assert.throws(() => ai.extractProposalJson('完全不是 JSON'), /看不懂/);
});

test('normalizes stops: pads time, guesses type, keeps optional fields, drops invalid', () => {
  const proposal = ai.parseItineraryProposal({
    trip: { title: '東京', destination: '日本東京', startDate: '2026-11-05', endDate: '2026-11-01' },
    stops: [
      { title: '一蘭拉麵', date: '2026-11-01', time: '9:05', endTime: '10:00', place: '一蘭 淺草店', estimatedCost: '1,280', currency: 'jpy' },
      { title: '飯店入住', date: '2026-11-01', time: '15:00', type: 'accommodation', place: 'Richmond 淺草' },
      { title: '沒有日期', time: '10:00' },
      { title: '不存在的日子', date: '2026-02-30' },
      { title: '時間反了', date: '2026-11-02', time: '12:00', endTime: '11:00', type: 'bogus', place: '' },
    ],
    warnings: ['已假設 2026 年', 42],
  });
  assert.deepEqual(proposal.trip, { title: '東京', destination: '日本東京', startDate: '2026-11-01', endDate: '2026-11-05' });
  assert.equal(proposal.stops.length, 3);
  assert.equal(proposal.discarded, 2);
  assert.deepEqual(proposal.warnings, ['已假設 2026 年']);
  const [ramen, hotel, reversed] = proposal.stops;
  assert.equal(ramen.time, '09:05');
  assert.equal(ramen.endTime, '10:00');
  assert.equal(ramen.type, 'meal');
  assert.equal(ramen.estimatedCost, 1280);
  assert.equal(ramen.currency, 'JPY');
  assert.equal(hotel.type, 'accommodation');
  assert.equal(reversed.endTime, undefined);
  assert.equal(reversed.place, '時間反了');
  assert.equal(reversed.type, 'activity');
});

test('accepts only Google Maps links', () => {
  assert.equal(ai.sanitizeMapsUrl('https://maps.app.goo.gl/abc123'), 'https://maps.app.goo.gl/abc123');
  assert.ok(ai.sanitizeMapsUrl('https://www.google.com/maps/place/Senso-ji/@35.7148,139.7967,17z'));
  assert.ok(ai.sanitizeMapsUrl('https://maps.google.co.jp/?q=35.1,139.2'));
  assert.ok(ai.sanitizeMapsUrl('https://goo.gl/maps/xyz'));
  assert.equal(ai.sanitizeMapsUrl('https://evil.example.com/maps/place/x'), undefined);
  assert.equal(ai.sanitizeMapsUrl('https://www.google.com/search?q=x'), undefined);
  assert.equal(ai.sanitizeMapsUrl('javascript:alert(1)'), undefined);
  assert.equal(ai.sanitizeMapsUrl('https://goo.gl/abc'), undefined);
  const stop = ai.normalizeProposedStop({ title: 'x', date: '2026-01-01', mapsUrl: 'https://phish.example/maps' });
  assert.equal(stop.mapsUrl, undefined);
});

test('locate plan prefers link coords, then link resolve, then search; transport without link is skipped', () => {
  const base = { title: '淺草寺', date: '2026-11-01', type: 'activity', place: '淺草寺' };
  const coords = ai.locatePlanFor({ ...base, mapsUrl: 'https://www.google.com/maps/place/Senso-ji/@35.7148,139.7967,17z' });
  assert.equal(coords.kind, 'coords');
  assert.equal(coords.lat, 35.7148);
  assert.equal(ai.locatePlanFor({ ...base, mapsUrl: 'https://maps.app.goo.gl/abc' }).kind, 'resolve');
  assert.deepEqual(ai.locatePlanFor(base, '東京, 橫濱'), { kind: 'search', query: '淺草寺 東京' });
  assert.deepEqual(ai.locatePlanFor({ ...base, mapQuery: '浅草寺 台東区' }, '東京'), { kind: 'search', query: '浅草寺 台東区' });
  assert.equal(ai.locatePlanFor({ ...base, type: 'transport', place: '桃園機場 → 成田' }).kind, 'none');
  assert.equal(ai.locatePlanFor({ ...base, type: 'transport', mapsUrl: 'https://maps.app.goo.gl/x' }).kind, 'resolve');

  const summary = ai.summarizeLocate([
    { ...base, mapsUrl: 'https://maps.app.goo.gl/abc' },
    base,
    { ...base, type: 'transport' },
  ]);
  assert.deepEqual(summary, { link: 1, search: 1, none: 1 });
});

test('classifies duplicates before conflicts before out-of-range', () => {
  const stops = [
    { title: '淺草寺', date: '2026-11-01', time: '10:00', type: 'activity', place: 'a' },
    { title: '晴空塔', date: '2026-11-01', time: '14:00', type: 'activity', place: 'b' },
    { title: '晴空塔！', date: '2026-11-01', time: '15:00', type: 'activity', place: 'b' },
    { title: '迪士尼', date: '2026-11-09', time: '09:00', type: 'activity', place: 'c' },
    { title: '築地', date: '2026-11-02', type: 'meal', place: 'd' },
  ];
  const result = ai.classifyProposedStops(stops, {
    existingStops: [{ date: '2026-11-01', time: '10:00', title: ' 淺草 寺 ' }, { date: '2026-11-01', time: '14:00', title: '午餐' }],
    tripRange: { startDate: '2026-11-01', endDate: '2026-11-05' },
  });
  assert.deepEqual(result.map((stop) => stop.status), ['duplicate', 'conflict', 'duplicate', 'out-of-range', 'new']);
  assert.match(result[1].reason, /午餐/);
  assert.equal(ai.defaultSelected('duplicate'), false);
  assert.equal(ai.defaultSelected('conflict'), true);
});

test('plans days chronologically with maps urls and stable ids', async () => {
  const stops = [
    { title: '晚餐', date: '2026-11-01', time: '19:00', type: 'meal', place: '敘敘苑' },
    { title: '自由活動', date: '2026-11-01', type: 'activity', place: '上野' },
    { title: '早餐', date: '2026-11-01', time: '08:00', type: 'meal', place: '築地', mapsUrl: 'https://maps.app.goo.gl/q' },
    { title: '出發', date: '2026-10-31', time: '07:00', type: 'transport', place: '桃園機場' },
  ];
  const days = ai.planAiImport(stops, '東京');
  assert.deepEqual(days.map((day) => day.date), ['2026-10-31', '2026-11-01']);
  assert.deepEqual(days[1].items.map((item) => item.stop.title), ['早餐', '晚餐', '自由活動']);
  assert.equal(days[1].items[0].mapsUrl, 'https://maps.app.goo.gl/q');
  assert.equal(days[1].items[1].mapsUrl, `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('敘敘苑 東京')}`);
  assert.equal(days[0].items[0].locate.kind, 'none');

  const a = await ai.aiItemIdFor({ date: '2026-11-01', time: '08:00', title: '早餐' });
  const b = await ai.aiItemIdFor({ date: '2026-11-01', time: '08:00', title: ' 早 餐 ' });
  const c = await ai.aiItemIdFor({ date: '2026-11-02', time: '08:00', title: '早餐' });
  assert.match(a, /^ai_[0-9a-f]{40}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('prompts: external asks for verified maps links, built-in Claude does not; trip context and existing stops included', () => {
  const context = {
    today: '2026-11-06',
    trip: { title: '東京', destination: '東京', startDate: '2026-11-01', endDate: '2026-11-05' },
    existingStops: [{ date: '2026-11-01', time: '10:00', title: '淺草寺' }],
  };
  const external = ai.buildExternalPrompt({ ...context, sourceText: '第一天去晴空塔' });
  assert.match(external, /mapsUrl/);
  assert.match(external, /絕對不要自己編造連結/);
  assert.match(external, /```json/);
  assert.match(external, /2026-11-01 10:00 淺草寺/);
  assert.match(external, /第一天去晴空塔$/);
  assert.doesNotMatch(external, /"trip"/);

  const builtin = ai.buildBuiltinInstruction({ today: '2026-11-06' });
  assert.doesNotMatch(builtin, /mapsUrl/);
  assert.match(builtin, /"trip"/);
  assert.match(builtin, /今天是 2026-11-06/);
});

test('widens trip range only outward and falls back to stop dates', () => {
  assert.deepEqual(ai.widenRange({ startDate: '2026-11-02', endDate: '2026-11-04' }, ['2026-11-01', '2026-11-03']),
    { startDate: '2026-11-01', endDate: '2026-11-04' });
  const proposal = ai.parseItineraryProposal({ stops: [
    { title: 'a', date: '2026-11-03' }, { title: 'b', date: '2026-11-01' },
  ] });
  assert.deepEqual(ai.fallbackTrip(proposal), { title: '11/01 的旅程', destination: '', startDate: '2026-11-01', endDate: '2026-11-03' });
  assert.equal(ai.validateSourceText('短'), '請至少貼上 10 個字的行程描述。');
});
