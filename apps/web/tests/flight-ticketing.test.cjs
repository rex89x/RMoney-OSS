const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    alias: { '@': path.resolve(__dirname, '../src') },
    // env.ts 讀 import.meta.env；測試不需要真的值
    define: { 'import.meta.env': '{}' } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const dashboard = loadTs(path.resolve(__dirname, '../src/features/flight-watches/dashboard.ts'));
const types = loadTs(path.resolve(__dirname, '../src/features/flight-watches/types.ts'));

function watch(over) {
  return {
    id: 'w', userId: 'u', segmentLabel: '', tripType: 'openjaw', claudeGroup: '', origin: 'TPE', destination: 'NRT',
    returnOrigin: 'KIX', returnDestination: 'TPE', ticketSearch: null,
    departureStart: new Date('2026-11-01T00:00:00+08:00'), departureEnd: new Date('2026-11-30T00:00:00+08:00'),
    minNights: 3, maxNights: 7, adults: 1, cabin: 'economy', selectedCabins: ['economy'], nonstopOnly: false,
    excludeLowCostCarriers: false, airlineFilter: 'all', airlineCodes: [], scanProvider: 'claude', geminiModel: 'gemini-3.8-flash',
    scanFrequency: 'daily', weeklyDay: 0, notifyOnDeal: true, notifyOnEveryScan: false, priceDropPercent: 5, maxPriceTWD: null,
    enabled: true, latestEstimate: null, bestPriceTWD: null, lastError: null, lastCheckedAt: null, claudePromptKey: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  };
}

test('flightTicketSearch defaults per trip type', () => {
  assert.equal(types.flightTicketSearch(watch({})), 'both');
  assert.equal(types.flightTicketSearch(watch({ tripType: 'roundtrip' })), 'single');
  assert.equal(types.flightTicketSearch(watch({ tripType: 'oneway', ticketSearch: 'separate' })), 'single');
  assert.equal(types.flightTicketSearch(watch({ ticketSearch: 'separate' })), 'separate');
});

test('compareTicketing finds the cheapest single ticket and separate combination', () => {
  const windows = [
    { departureDate: '2026-11-04', returnDate: '2026-11-10', cabin: 'economy', priceTWD: 14000, airline: 'BR', stops: 0, reason: '' },
    { departureDate: '2026-11-04', returnDate: '2026-11-10', cabin: 'economy', priceTWD: 9900, airline: 'IT', stops: 0, reason: '',
      ticketing: 'separate', outboundPriceTWD: 4800, returnPriceTWD: 5100, returnAirline: 'MM' },
    { departureDate: '2026-11-05', returnDate: '2026-11-11', cabin: 'economy', priceTWD: 12500, airline: 'CI', stops: 0, reason: '', ticketing: 'single' },
  ];
  const result = dashboard.compareTicketing(watch({ latestEstimate: { travelWindows: windows } }));
  assert.equal(result.single.priceTWD, 12500);
  assert.equal(result.separate.priceTWD, 9900);
  assert.equal(result.savingTWD, 2600);
  assert.equal(dashboard.ticketingOf(windows[0]), 'single');
});

test('parseFlightPriceEstimate keeps separate-ticket leg prices', () => {
  const estimate = types.parseFlightPriceEstimate({
    minPriceTWD: 9900, typicalPriceTWD: 12000, maxPriceTWD: 15000, checkedAt: new Date(),
    travelWindows: [{ departureDate: '2026-11-04', returnDate: '2026-11-10', cabin: 'economy', priceTWD: 9900, airline: 'IT', stops: 0,
      ticketing: 'separate', outboundPriceTWD: 4800, returnPriceTWD: 5100, returnAirline: 'MM' }],
  });
  const [window] = estimate.travelWindows;
  assert.equal(window.ticketing, 'separate');
  assert.equal(window.outboundPriceTWD, 4800);
  assert.equal(window.returnAirline, 'MM');
});

test('criteriaKey only changes when the ticket search differs from the trip default', async () => {
  const schedule = loadTs(path.resolve(__dirname, '../src/features/flight-watches/claude-schedule.ts'));
  const base = await schedule.flightCriteriaKey(watch({ ticketSearch: null }));
  assert.equal(await schedule.flightCriteriaKey(watch({ ticketSearch: 'both' })), base, 'explicit default keeps old prompts valid');
  assert.notEqual(await schedule.flightCriteriaKey(watch({ ticketSearch: 'separate' })), base);
  const roundtrip = await schedule.flightCriteriaKey(watch({ tripType: 'roundtrip', ticketSearch: null }));
  assert.equal(await schedule.flightCriteriaKey(watch({ tripType: 'roundtrip', ticketSearch: 'single' })), roundtrip);
});

const sharing = loadTs(path.resolve(__dirname, '../src/features/flight-watches/sharing.ts'));

test('my flight watches follow the current household members; others\' watches are never touched', () => {
  const w = (id, userId, sharedWith) => ({ id, userId, sharedWith });
  const watches = [
    w('legacy', 'rex', []),           // 開放前建立：補分享
    w('ok', 'rex', ['partner']),           // 已同步
    w('hers', 'partner', ['rex']),         // 別人的：我不能改
    w('stale', 'rex', ['partner', 'ex']),  // 成員被移除：收回
  ];
  assert.deepEqual(sharing.flightSharingDrift(watches, 'rex', ['partner']), [
    { id: 'legacy', sharedWith: ['partner'] },
    { id: 'stale', sharedWith: ['partner'] },
  ]);
  assert.deepEqual(sharing.flightSharingDrift([w('a', 'rex', ['partner'])], 'rex', []), [{ id: 'a', sharedWith: [] }],
    'no household partner any more → stop sharing');
});
