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

const ex = loadTs(path.resolve(__dirname, '../src/features/trips/export-chiauming.ts'));
const { computeSettlement } = loadTs(path.resolve(__dirname, '../src/features/trips/settlement.ts'));

const TW = (date) => new Date(`${date}T12:00:00+08:00`);

test('itinerary items become stops with maps links, coords and origin ids', () => {
  const stops = ex.buildStops('trip1', [
    { dayId: '2026-11-01', items: [
      { id: 'a', order: 1, title: '淺草寺', startTime: '10:00', endTime: '11:00', type: 'activity', placeName: '淺草寺', lat: 35.71, lng: 139.79,
        mapsUrl: 'https://www.google.com/maps/search/?api=1&query=%E6%B7%BA%E8%8D%89%E5%AF%BA', sourcePlaceQuery: '淺草寺 東京', estimatedCost: 500, currency: 'JPY' },
      { id: 'b', order: 2, title: '晚餐', mapsUrl: 'https://maps.app.goo.gl/xyz', notes: '要訂位' },
      { id: 'cm100_x', order: 3, title: '飯店', sourceId: 'chiauming-100:trip-9:stop-3' },
      { id: 'c', order: 4, title: '跳過的', status: 'skipped' },
    ] },
    { dayId: 'day-2', date: '2026-11-02', items: [{ id: 'd', order: 1, title: '築地' }] },
    { dayId: 'day-3', items: [{ id: 'e', order: 1, title: '沒日期' }] },
  ]);
  assert.equal(stops.length, 4);
  const [temple, dinner, hotel, market] = stops;
  assert.equal(temple.sourceId, 'rmoney:trip1:a');
  assert.equal(temple.mapsUrl, 'https://www.google.com/maps/search/?api=1&query=35.71,139.79');
  assert.equal(temple.mapQuery, '淺草寺 東京');
  assert.deepEqual([temple.lat, temple.lng, temple.estimatedCost, temple.currency], [35.71, 139.79, 500, 'JPY']);
  assert.equal(dinner.mapsUrl, 'https://maps.app.goo.gl/xyz');
  assert.equal(dinner.note, '要訂位');
  assert.equal(hotel.originId, 'stop-3');
  assert.equal(market.date, '2026-11-02');
  assert.equal(ex.commonChiaumingTripKey([{ sourceId: 'chiauming-100:trip-9:s1' }, { sourceId: 'chiauming-100:trip-9:s2' }, {}]), 'trip-9');
  assert.equal(ex.commonChiaumingTripKey([{ sourceId: 'chiauming-100:trip-9:s1' }, { sourceId: 'chiauming-100:trip-8:s2' }]), undefined);
});

test('maps people: me = 明, household partner = 巧, others excluded', () => {
  assert.equal(ex.defaultPersonChoice({ id: 'u-me', name: 'Owner' }, 'u-me', ['u-p']), 'ming');
  assert.equal(ex.defaultPersonChoice({ id: 'u-p', name: '書' }, 'u-me', ['u-p']), 'chiau');
  assert.equal(ex.defaultPersonChoice({ id: '小巧', name: '小巧' }, 'u-me', []), 'chiau');
  assert.equal(ex.defaultPersonChoice({ id: 'Amy', name: 'Amy' }, 'u-me', ['u-p']), 'other');
});

test('expenses keep only the couple share, skip friend-paid and chiauming-origin transactions', () => {
  const members = [{ uid: 'u-me', name: 'Owner' }, { uid: 'u-p', name: '伴侶' }, { name: 'Amy' }];
  const base = { userId: 'u-me', type: 'expense', currency: 'TWD', fxRate: 1, paymentMethod: 'cash', createdAt: TW('2026-11-01'), updatedAt: TW('2026-11-01'), tripId: 't' };
  const txs = [
    { ...base, id: 'tx1', amount: 900, amountTWD: 900, category: 'trip_food', note: '燒肉', date: TW('2026-11-01'), payerId: 'u-me', shareType: 'equal' },
    { ...base, id: 'tx2', amount: 3000, amountTWD: 650, currency: 'JPY', category: 'trip_ticket', note: '門票', date: TW('2026-11-02'), payerId: 'u-p', shareType: 'custom',
      customShares: [{ memberId: 'u-me', amountTWD: 325 }, { memberId: 'u-p', amountTWD: 325 }] },
    { ...base, id: 'tx3', amount: 600, amountTWD: 600, category: 'trip_food', note: 'Amy 請', date: TW('2026-11-02'), payerId: 'Amy' },
    { ...base, id: 'tx4', amount: 200, amountTWD: 200, category: 'transport', note: '計程車', date: TW('2026-11-03'), payerId: 'u-me', importSourceId: 'chiauming-100:trip-1:e1' },
    { ...base, id: 'tx5', amount: 300, amountTWD: 300, category: 'trip_souvenir', note: 'Amy 自己的', date: TW('2026-11-03'), payerId: 'u-me', shareType: 'custom',
      customShares: [{ memberId: 'Amy', amountTWD: 300 }] },
  ];
  const input = ex.settlementInputs({ members, txs, myUid: 'u-me', partnerUids: ['u-p'] });
  const details = computeSettlement(input.members, input.txs, { householdMemberIds: [] }).transactionDetails;
  const people = ex.peopleInDetails(details);
  const choices = Object.fromEntries(people.map((p) => [p.id, ex.defaultPersonChoice(p, 'u-me', ['u-p'])]));
  const { expenses, skipped } = ex.buildExpenses({ details, txById: new Map(txs.map((tx) => [tx.id, tx])), choices, categories: [] });

  assert.equal(expenses.length, 2);
  const [bbq, ticket] = expenses;
  assert.deepEqual(bbq, {
    sourceId: 'rmoney:tx:tx1', date: '2026-11-01', title: '燒肉', amount: 600, currency: 'TWD', category: 'food',
    paidBy: 'ming', participants: ['ming', 'chiau'], shares: [{ personId: 'ming', amount: 300 }, { personId: 'chiau', amount: 300 }],
  });
  assert.equal(ticket.paidBy, 'chiau');
  assert.equal(ticket.amount, 650);
  assert.equal(ticket.category, 'ticket');
  assert.deepEqual([ticket.originalAmount, ticket.originalCurrency], [3000, 'JPY']);
  assert.deepEqual(skipped.map((s) => s.txId).sort(), ['tx3', 'tx4', 'tx5']);
  assert.match(skipped.find((s) => s.txId === 'tx3').reason, /不是巧或明/);
});

test('trip without members still splits household custom shares', () => {
  const tx = { id: 'h1', userId: 'u-me', type: 'expense', amount: 1000, amountTWD: 1000, currency: 'TWD', fxRate: 1, category: 'trip_hotel', paymentMethod: 'card',
    date: TW('2026-11-01'), createdAt: TW('2026-11-01'), updatedAt: TW('2026-11-01'), tripId: 't', householdId: 'hh', paidByUid: 'u-me',
    customShares: [{ memberId: 'u-me', amountTWD: 400 }, { memberId: 'u-p', amountTWD: 600 }] };
  const input = ex.settlementInputs({ members: [], txs: [tx], myUid: 'u-me', partnerUids: ['u-p'] });
  const details = computeSettlement(input.members, input.txs, { householdMemberIds: [] }).transactionDetails;
  const { expenses } = ex.buildExpenses({ details, txById: new Map([[tx.id, tx]]), choices: { 'u-me': 'ming', 'u-p': 'chiau' }, categories: [] });
  assert.deepEqual(expenses[0].shares, [{ personId: 'ming', amount: 400 }, { personId: 'chiau', amount: 600 }]);
  assert.equal(expenses[0].category, 'stay');
});

test('bundle shape', () => {
  const bundle = ex.buildRMoneyTripBundle({
    trip: { id: 't1', name: '東京', destination: ['東京', '橫濱'], startDate: TW('2026-11-01'), endDate: TW('2026-11-05') },
    stops: [], expenses: [], chiaumingTripKey: 'trip-9',
  });
  assert.deepEqual(bundle, {
    format: 'rmoney-trip', version: 1,
    trip: { sourceTripKey: 't1', title: '東京', destination: '東京、橫濱', startDate: '2026-11-01', endDate: '2026-11-05', chiaumingTripKey: 'trip-9' },
    stops: [], expenses: [],
  });
  assert.equal(ex.chiaumingCategoryFor('custom_x', [{ key: 'custom_x', name: '機票' }]), 'transport');
  assert.equal(ex.chiaumingCategoryFor('custom_y', [{ key: 'custom_y', name: '雜支' }]), 'other');
});
