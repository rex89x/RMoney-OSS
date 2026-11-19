// lib/market-hours.ts — TW 09:00–13:30 Asia/Taipei；US 09:30–16:00 America/New_York（含 DST，pitfall #2）
// 不依賴主機時區：所有時間點都用帶 offset 的 ISO 字串建立。
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

const mh = loadTs(path.resolve(__dirname, '../src/lib/market-hours.ts'));

/** 台北時間 yyyy-MM-ddTHH:mm[:ss] → Date */
function tw(s) {
  return new Date(`${s.length === 16 ? `${s}:00` : s}+08:00`);
}

// 2026-11-09 是週一；2026-11-14 週六；2026-11-15 週日
test('TW: 週一~五 09:00–13:30 台北時間（含 13:30 那一分鐘）', () => {
  assert.equal(mh.isTwMarketOpen(tw('2026-11-09T08:59')), false);
  assert.equal(mh.isTwMarketOpen(tw('2026-11-09T08:59:59')), false);
  assert.equal(mh.isTwMarketOpen(tw('2026-11-09T09:00')), true);
  assert.equal(mh.isTwMarketOpen(tw('2026-11-09T11:15')), true);
  assert.equal(mh.isTwMarketOpen(tw('2026-11-09T13:30')), true);
  assert.equal(mh.isTwMarketOpen(tw('2026-11-09T13:31')), false);
  assert.equal(mh.isTwMarketOpen(tw('2026-11-13T10:00')), true); // 週五
  assert.equal(mh.isTwMarketOpen(tw('2026-11-14T10:00')), false); // 週六
  assert.equal(mh.isTwMarketOpen(tw('2026-11-15T10:00')), false); // 週日
});

test('TW: 用台北日曆判斷星期（UTC 還在週日時台北已是週一）', () => {
  // 台北週一 09:30 = UTC 週一 01:30；台北週六 09:30 = UTC 週六 01:30
  assert.equal(mh.isTwMarketOpen(new Date('2026-11-09T01:30:00Z')), true);
  assert.equal(mh.isTwMarketOpen(new Date('2026-11-14T01:30:00Z')), false);
  // UTC 週一 08:00 = 台北週一 16:00 → 已收盤
  assert.equal(mh.isTwMarketOpen(new Date('2026-11-09T08:00:00Z')), false);
});

test('US 冬令 (EST, UTC-5)：台北 22:30 開盤、隔天 05:00 收盤', () => {
  // 2026-01-12 週一
  assert.equal(mh.isUsMarketOpen(tw('2026-01-12T21:30')), false);
  assert.equal(mh.isUsMarketOpen(tw('2026-01-12T22:29')), false);
  assert.equal(mh.isUsMarketOpen(tw('2026-01-12T22:30')), true);
  assert.equal(mh.isUsMarketOpen(tw('2026-01-13T04:59')), true);
  assert.equal(mh.isUsMarketOpen(tw('2026-01-13T05:00')), false); // 16:00 NY 收盤（不含）
});

test('US 夏令 (EDT, UTC-4)：台北 21:30 開盤、隔天 04:00 收盤', () => {
  // 2026-07-13 週一
  assert.equal(mh.isUsMarketOpen(tw('2026-07-13T21:29')), false);
  assert.equal(mh.isUsMarketOpen(tw('2026-07-13T21:30')), true);
  assert.equal(mh.isUsMarketOpen(tw('2026-07-13T22:30')), true);
  assert.equal(mh.isUsMarketOpen(tw('2026-07-14T03:59')), true);
  assert.equal(mh.isUsMarketOpen(tw('2026-07-14T04:00')), false);
  // 同一個台北 21:45：7 月開盤中、1 月還沒開
  assert.equal(mh.isUsMarketOpen(tw('2026-07-13T21:45')), true);
  assert.equal(mh.isUsMarketOpen(tw('2026-01-12T21:45')), false);
});

test('US DST 切換週：2026-03-08（日）起改 EDT', () => {
  // 週五 3/6 仍是 EST：台北 21:30 未開、22:30 開
  assert.equal(mh.isUsMarketOpen(tw('2026-03-06T21:30')), false);
  assert.equal(mh.isUsMarketOpen(tw('2026-03-06T22:30')), true);
  // 週一 3/9 已是 EDT：台北 21:30 開
  assert.equal(mh.isUsMarketOpen(tw('2026-03-09T21:30')), true);
  // 11/1（日）切回 EST：週一 11/2 台北 21:30 未開、22:30 開
  assert.equal(mh.isUsMarketOpen(tw('2026-11-02T21:30')), false);
  assert.equal(mh.isUsMarketOpen(tw('2026-11-02T22:30')), true);
});

test('US: 用紐約日曆判斷星期', () => {
  // 台北週六 03:00 = 紐約週五 14:00（EST）→ 開盤中
  assert.equal(mh.isUsMarketOpen(tw('2026-01-17T03:00')), true);
  // 台北週六 22:30 = 紐約週六 09:30 → 休市
  assert.equal(mh.isUsMarketOpen(tw('2026-01-17T22:30')), false);
  // 台北週一 03:00 = 紐約週日 14:00 → 休市
  assert.equal(mh.isUsMarketOpen(tw('2026-01-19T03:00')), false);
});

test('marketStatus 依 market 分派', () => {
  const twOpen = tw('2026-11-09T10:00');
  assert.deepEqual(mh.marketStatus('2330', 'TW', twOpen), { symbol: '2330', market: 'TW', isOpen: true });
  assert.deepEqual(mh.marketStatus('AAPL', 'US', twOpen), { symbol: 'AAPL', market: 'US', isOpen: false });
  const usOpen = tw('2026-11-09T23:00');
  assert.deepEqual(mh.marketStatus('2330', 'TW', usOpen), { symbol: '2330', market: 'TW', isOpen: false });
  assert.deepEqual(mh.marketStatus('AAPL', 'US', usOpen), { symbol: 'AAPL', market: 'US', isOpen: true });
});
