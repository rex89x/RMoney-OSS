// Itinerary.gs placeDetails（營業時間）：快取、欄位、正規化
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/Itinerary.gs'), 'utf8');

function makeContext({ response, status = 200, key = 'test-key' }) {
  const store = new Map();
  const fetches = [];
  const puts = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date, Error, JSON, Math, Number, String, Array, Object, Boolean, RegExp, encodeURIComponent, decodeURIComponent,
    PROP: { getProperty: (k) => (k === 'GOOGLE_MAPS_API_KEY' ? key : null) },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (store.has(k) ? store.get(k) : null),
        put: (k, v, ttl) => { store.set(k, v); puts.push({ k, ttl }); },
      }),
    },
    UrlFetchApp: {
      fetch: (url) => {
        fetches.push(url);
        return { getResponseCode: () => status, getContentText: () => JSON.stringify(response) };
      },
    },
  });
  vm.runInContext(source, context);
  return { context, fetches, puts, store };
}

const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const okResponse = {
  status: 'OK',
  result: {
    place_id: PLACE_ID,
    business_status: 'OPERATIONAL',
    utc_offset_minutes: 540,
    url: 'https://maps.google.com/?cid=123',
    opening_hours: {
      open_now: true,
      periods: [
        { open: { day: 1, time: '0900' }, close: { day: 1, time: '1700' } },
        { open: { day: 5, time: '1800' }, close: { day: 6, time: '0200' } },
        { open: { day: 9, time: '0900' } },
        { open: { day: 2, time: '9am' } },
      ],
      weekday_text: ['星期一: 09:00 – 17:00', '星期二: 休息'],
    },
  },
};

test('placeDetails：只要營業時間相關欄位、zh-TW、結果快取 6 小時', () => {
  const { context, fetches, puts } = makeContext({ response: okResponse });
  const r1 = context.placeDetails({ placeId: PLACE_ID });
  assert.equal(r1.ok, true);
  assert.equal(r1.cached, false);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0], /place\/details\/json/);
  assert.match(fetches[0], /fields=place_id%2Copening_hours%2Cutc_offset_minutes%2Cbusiness_status%2Curl/);
  assert.match(fetches[0], /language=zh-TW/);
  assert.equal(puts[0].ttl, 21600);

  const r = JSON.parse(JSON.stringify(r1.result));
  assert.deepEqual(r, {
    placeId: PLACE_ID,
    businessStatus: 'OPERATIONAL',
    utcOffsetMinutes: 540,
    url: 'https://maps.google.com/?cid=123',
    weekdayText: ['星期一: 09:00 – 17:00', '星期二: 休息'],
    // 壞資料（day 9、time 9am）被濾掉
    periods: [
      { open: { day: 1, time: '0900' }, close: { day: 1, time: '1700' } },
      { open: { day: 5, time: '1800' }, close: { day: 6, time: '0200' } },
    ],
    hasHours: true,
  });

  const r2 = context.placeDetails({ placeId: PLACE_ID });
  assert.equal(r2.cached, true);
  assert.equal(fetches.length, 1, 'second call served from cache');
});

test('placeDetails：沒有 opening_hours 的地點、24 小時（只有 open 沒有 close）', () => {
  const { context } = makeContext({ response: { status: 'OK', result: { place_id: PLACE_ID, business_status: 'CLOSED_TEMPORARILY' } } });
  const r = context.placeDetails({ placeId: PLACE_ID }).result;
  assert.equal(r.hasHours, false);
  assert.equal(r.businessStatus, 'CLOSED_TEMPORARILY');
  assert.equal(r.utcOffsetMinutes, null);
  assert.equal(r.periods.length, 0);

  const allDay = makeContext({
    response: { status: 'OK', result: { opening_hours: { periods: [{ open: { day: 0, time: '0000' } }] } } },
  });
  const r24 = allDay.context.placeDetails({ placeId: PLACE_ID }).result;
  assert.deepEqual(JSON.parse(JSON.stringify(r24.periods)), [{ open: { day: 0, time: '0000' } }]);
  assert.equal(r24.placeId, PLACE_ID);
});

test('placeDetails：錯誤處理', () => {
  const { context, fetches } = makeContext({ response: okResponse });
  assert.equal(context.placeDetails({}).ok, false);
  assert.equal(context.placeDetails({ placeId: 'bad id with spaces' }).ok, false);
  assert.equal(context.placeDetails({ placeId: 'x&key=evil' }).ok, false);
  assert.equal(fetches.length, 0);

  const denied = makeContext({ response: { status: 'REQUEST_DENIED', error_message: 'API not enabled' } });
  const r = denied.context.placeDetails({ placeId: PLACE_ID });
  assert.equal(r.ok, false);
  assert.match(r.error, /REQUEST_DENIED/);
  assert.equal(denied.store.size, 0, 'errors are not cached');

  const http = makeContext({ response: {}, status: 500 });
  assert.equal(http.context.placeDetails({ placeId: PLACE_ID }).error, 'http 500');

  const noKey = makeContext({ response: okResponse, key: null });
  assert.equal(noKey.context.placeDetails({ placeId: PLACE_ID }).error, 'maps key missing');
});
