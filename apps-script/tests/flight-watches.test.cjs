const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/FlightWatches.gs'), 'utf8');
const context = vm.createContext({ console, Date, Error, isFinite, JSON, Math, Number, String, Array, Object });
vm.runInContext(source, context);

const watch = {
  selectedCabins: ['economy'],
  departureStart: new Date('2026-11-01T00:00:00+08:00'),
  departureEnd: new Date('2026-11-30T00:00:00+08:00'),
  minNights: 3,
  maxNights: 10,
  airlineFilter: 'all',
  airlineCodes: [],
  excludeLowCostCarriers: false,
  nonstopOnly: false,
};

function responseWith(candidate) {
  return JSON.stringify({ candidates: [candidate] });
}

test('parses grounded JSON without joining Gemini thought text into the payload', () => {
  const payload = {
    available: true,
    confidence: 'high',
    summary: '已查到公開票價',
    priceReason: '平日較便宜',
    cabinEstimates: [{
      cabin: 'economy',
      minPriceTWD: 12000,
      typicalPriceTWD: 16000,
      maxPriceTWD: 22000,
      bestAirline: 'BR 長榮航空',
    }],
    travelWindows: [{
      departureDate: '2026-11-04',
      returnDate: '2026-11-10',
      cabin: 'economy',
      priceTWD: 12000,
      airline: 'BR 長榮航空',
      stops: 0,
      reason: '平日出發',
    }],
  };
  const response = responseWith({
    content: { parts: [
      { thought: true, text: 'I should search several dates first.' },
      { text: `搜尋完成。\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` },
    ] },
    groundingMetadata: {
      groundingChunks: [{ web: { uri: 'https://example.com/fares', title: 'Fare source' } }],
    },
  });

  const estimate = context.parseFlightWatchResponse_(response, watch);
  assert.equal(estimate.minPriceTWD, 12000);
  assert.equal(estimate.travelWindows.length, 1);
  assert.equal(estimate.sources[0].url, 'https://example.com/fares');
  assert.equal(estimate.confidence, 'medium');
});

test('parses Claude web search responses: final text after the last search, citations as sources', () => {
  const payload = {
    available: true,
    confidence: 'medium',
    summary: '已查到公開票價',
    priceReason: '平日較便宜',
    cabinEstimates: [{ cabin: 'economy', minPriceTWD: 11000, typicalPriceTWD: 15000, maxPriceTWD: 21000, bestAirline: 'CI 中華航空' }],
    travelWindows: [],
  };
  const response = JSON.stringify({
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '我先搜尋 {not json} 幾組日期。' },
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'TPE NRT fares' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [
        { type: 'web_search_result', url: 'https://example.com/search-hit', title: 'Search hit' },
      ] },
      { type: 'text', text: JSON.stringify(payload), citations: [
        { type: 'web_search_result_location', url: 'https://example.com/cited', title: 'Cited fare' },
      ] },
    ],
  });
  const estimate = context.parseFlightWatchResponse_(response, watch);
  assert.equal(estimate.minPriceTWD, 11000);
  assert.equal(estimate.sources[0].url, 'https://example.com/cited');
  assert.equal(estimate.sources[1].url, 'https://example.com/search-hit');
});

test('Claude response without any web source is rejected', () => {
  const response = JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ available: true, cabinEstimates: [] }) }],
  });
  assert.throws(() => context.parseFlightWatchResponse_(response, watch), /沒有附上可驗證的公開來源/);
});

test('accepts official citation metadata as a verifiable source', () => {
  const response = responseWith({
    content: { parts: [{ text: JSON.stringify({
      available: 'true',
      minPriceTWD: 'NT$13,000',
      typicalPriceTWD: 17000,
      maxPriceTWD: 23000,
    }) }] },
    citationMetadata: {
      citations: [{ uri: 'https://airline.example/booking', title: 'Airline booking' }],
    },
  });

  const estimate = context.parseFlightWatchResponse_(response, watch);
  assert.equal(estimate.minPriceTWD, 13000);
  assert.equal(estimate.sources[0].url, 'https://airline.example/booking');
});

test('rejects a fare response that has no verifiable public source', () => {
  const response = responseWith({
    content: { parts: [{ text: JSON.stringify({
      available: true,
      minPriceTWD: 13000,
      typicalPriceTWD: 17000,
      maxPriceTWD: 23000,
    }) }] },
  });

  assert.throws(
    () => context.parseFlightWatchResponse_(response, watch),
    /沒有附上可驗證的公開來源/,
  );
});

test('open-jaw watch flies into destination and returns from returnOrigin', () => {
  const openJaw = { ...watch, tripType: 'openjaw', origin: 'TPE', destination: 'NRT', returnOrigin: 'kix', returnDestination: 'TPE' };
  assert.equal(context.flightTripType_(openJaw), 'openjaw');
  assert.deepEqual({ ...context.flightReturnLeg_(openJaw) }, { from: 'KIX', to: 'TPE' });
  assert.equal(context.flightRouteText_(openJaw), 'TPE → NRT ／ KIX → TPE');
  assert.equal(context.flightTripTypeLabel_(openJaw), '多點進出');

  const request = context.flightDuffelRequest_('token', { ...openJaw, adults: 1 }, 'economy', {
    departure: '2026-11-04',
    returning: '2026-11-10',
  });
  const slices = JSON.parse(request.payload).data.slices;
  assert.deepEqual(slices, [
    { origin: 'TPE', destination: 'NRT', departure_date: '2026-11-04' },
    { origin: 'KIX', destination: 'TPE', departure_date: '2026-11-10' },
  ]);
});

test('roundtrip and oneway return legs are unchanged', () => {
  const roundtrip = { ...watch, origin: 'TPE', destination: 'NRT' };
  assert.deepEqual({ ...context.flightReturnLeg_(roundtrip) }, { from: 'NRT', to: 'TPE' });
  assert.equal(context.flightReturnLeg_({ ...roundtrip, tripType: 'oneway' }), null);
  // 舊資料在 openjaw 缺回程機場時，退回來回的機場而不是送出空字串
  assert.deepEqual({ ...context.flightReturnLeg_({ ...roundtrip, tripType: 'openjaw' }) }, { from: 'NRT', to: 'TPE' });
});

test('open-jaw travel windows still require nights within range', () => {
  const openJaw = { ...watch, tripType: 'openjaw', origin: 'TPE', destination: 'NRT', returnOrigin: 'KIX', returnDestination: 'TPE' };
  const ok = context.parseFlightTravelWindow_({
    departureDate: '2026-11-04', returnDate: '2026-11-10', cabin: 'economy', priceTWD: 15000, airline: 'BR', stops: 0,
  }, ['economy'], openJaw);
  assert.equal(ok.returnDate, '2026-11-10');
  const tooShort = context.parseFlightTravelWindow_({
    departureDate: '2026-11-04', returnDate: '2026-11-05', cabin: 'economy', priceTWD: 15000, airline: 'BR', stops: 0,
  }, ['economy'], openJaw);
  assert.equal(tooShort, null);
});

// ---- 拼單程（separate one-way tickets） ----
const openJawBase = { ...watch, tripType: 'openjaw', origin: 'TPE', destination: 'NRT', returnOrigin: 'KIX', returnDestination: 'TPE' };

test('ticket search defaults: open-jaw compares both, round-trip stays single', () => {
  assert.equal(context.flightTicketSearch_(openJawBase), 'both');
  assert.equal(context.flightTicketSearch_({ ...watch, origin: 'TPE', destination: 'NRT' }), 'single');
  assert.equal(context.flightTicketSearch_({ ...watch, tripType: 'oneway', ticketSearch: 'both' }), 'single');
  assert.equal(context.flightTicketSearch_({ ...openJawBase, ticketSearch: 'separate' }), 'separate');
});

test('Duffel leg requests only carry their own slice', () => {
  const window = { departure: '2026-11-04', returning: '2026-11-10' };
  const out = JSON.parse(context.flightDuffelRequest_('t', { ...openJawBase, adults: 1 }, 'economy', window, 'outbound').payload).data.slices;
  const ret = JSON.parse(context.flightDuffelRequest_('t', { ...openJawBase, adults: 1 }, 'economy', window, 'return').payload).data.slices;
  assert.deepEqual(out, [{ origin: 'TPE', destination: 'NRT', departure_date: '2026-11-04' }]);
  assert.deepEqual(ret, [{ origin: 'KIX', destination: 'TPE', departure_date: '2026-11-10' }]);
});

test('separate one-ways combine the cheapest outbound and return per cabin', () => {
  const window = { departure: '2026-11-04', returning: '2026-11-10' };
  const legRows = [
    { leg: 'outbound', cabin: 'economy', priceTWD: 6000, airline: 'BR', stops: 0, details: { departureTime: '08:00' } },
    { leg: 'outbound', cabin: 'economy', priceTWD: 4800, airline: 'IT', stops: 0, details: { departureTime: '06:30' } },
    { leg: 'return', cabin: 'economy', priceTWD: 5100, airline: 'MM', stops: 1, details: { departureTime: '19:10' } },
  ];
  const [row] = context.combineDuffelSeparateRows_(openJawBase, window, legRows);
  assert.equal(row.ticketing, 'separate');
  assert.equal(row.priceTWD, 9900);
  assert.equal(row.outboundPriceTWD, 4800);
  assert.equal(row.returnPriceTWD, 5100);
  assert.equal(row.airline, 'IT');
  assert.equal(row.returnAirline, 'MM');
  assert.equal(row.stops, 1);
  assert.equal(row.departureTime, '06:30');
  assert.equal(row.returnDepartureTime, '19:10');
});

test('separate travel windows from Gemini / Claude are validated and re-summed', () => {
  const base = { departureDate: '2026-11-04', returnDate: '2026-11-10', cabin: 'economy', airline: 'IT', stops: 0 };
  const ok = context.parseFlightTravelWindow_(
    { ...base, ticketing: 'separate', priceTWD: 10000, outboundPriceTWD: 4800, returnPriceTWD: 5100, returnAirline: 'MM' },
    ['economy'], openJawBase,
  );
  assert.equal(ok.ticketing, 'separate');
  assert.equal(ok.priceTWD, 9900, 'total recomputed from the legs');
  assert.equal(ok.returnAirline, 'MM');
  // 總價跟兩段差太多 → 捨棄
  assert.equal(context.parseFlightTravelWindow_(
    { ...base, ticketing: 'separate', priceTWD: 15000, outboundPriceTWD: 4800, returnPriceTWD: 5100 }, ['economy'], openJawBase), null);
  // 缺一段價格 → 捨棄
  assert.equal(context.parseFlightTravelWindow_(
    { ...base, ticketing: 'separate', priceTWD: 9900, outboundPriceTWD: 4800 }, ['economy'], openJawBase), null);
  // 只要一張票的航線收到拼單程 → 捨棄
  assert.equal(context.parseFlightTravelWindow_(
    { ...base, ticketing: 'separate', priceTWD: 9900, outboundPriceTWD: 4800, returnPriceTWD: 5100 },
    ['economy'], { ...openJawBase, ticketSearch: 'single' }), null);
  // 舊格式沒有 ticketing → 視為一張票，照常接受
  const legacy = context.parseFlightTravelWindow_({ ...base, priceTWD: 12000 }, ['economy'], openJawBase);
  assert.equal(legacy.priceTWD, 12000);
  assert.equal(legacy.ticketing, undefined);
});

test('flight alerts go to the subscriber: owner channel for the owner, the partner\'s own Telegram for a member', () => {
  const sent = [];
  const docs = {
    'users/rex': { role: 'owner' },
    'users/partner': { role: 'member' },
    'telegram_links/partner': { chatId: -123 },
    'users/nolink': { role: 'member' },
  };
  context.fsGetDoc_ = (p) => docs[p] || null;
  context.sendTelegramToChat_ = (chatId, msg) => { sent.push({ to: chatId, msg }); return { ok: true }; };
  context.sendNotification_ = (key, msg) => { sent.push({ to: `owner:${key}`, msg }); return { ok: true }; };
  context.flightRouteText_ = () => 'TPE→NRT';
  context.flightTripTypeLabel_ = () => '來回';
  const estimate = { minPriceTWD: 9000, typicalPriceTWD: 12000, cabinEstimates: [], travelWindows: [], sources: [], summary: 's' };
  const item = (userId) => ({ watch: { userId }, estimate, isDeal: true });

  context.notifyFlightPrices_([item('rex'), item('partner'), item('partner'), item('nolink')]);
  assert.equal(sent.length, 2, 'unlinked member gets nothing, and never lands in the owner chat');
  assert.equal(sent[0].to, 'owner:flightDeals');
  assert.equal(sent[1].to, '-123', 'chatId is passed as a string (pitfall #18)');
  assert.equal(sent[1].msg.split('TPE→NRT').length - 1, 2, 'both of her watches in one message');
});
