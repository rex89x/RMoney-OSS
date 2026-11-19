// features/ledger/tx-window.ts — 交易共用視窗的切片邏輯
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

const { sliceTxWindow, txWindowCoverageFloor, txWindowStartTW, txSliceKey } =
  loadTs(path.resolve(__dirname, '../src/features/ledger/tx-window.ts'));

const day = (s) => new Date(`${s}T00:00:00Z`);
const tx = (id, date, extra = {}) => ({ id, date: day(date), type: 'expense', category: 'food', ...extra });
const WINDOW_START = day('2025-11-01');
// date desc，跟 Firestore 回傳順序一樣
const ROWS = [
  tx('e', '2026-11-10'),
  tx('d', '2026-11-02', { type: 'income', category: 'salary' }),
  tx('c', '2026-10-20', { scope: 'household' }),
  tx('b', '2026-06-01', { category: 'transport' }),
  tx('a', '2025-11-05'),
];
const full = WINDOW_START.getTime();
const ids = (rows) => rows.map((r) => r.id);

test('txWindowStartTW：12 個月前那個月的 1 號，跨年正確', () => {
  const s = txWindowStartTW(new Date(2026, 0, 15));
  assert.deepEqual([s.getFullYear(), s.getMonth(), s.getDate()], [2025, 0, 1]);
  const s2 = txWindowStartTW(new Date(2026, 10, 30));
  assert.deepEqual([s2.getFullYear(), s2.getMonth(), s2.getDate()], [2025, 10, 1]);
});

test('區間在視窗內：依日期（含邊界）切片', () => {
  const out = sliceTxWindow(ROWS, { startDate: day('2026-10-20'), endDate: day('2026-11-02'), limit: 100 }, WINDOW_START, full);
  assert.deepEqual(ids(out), ['d', 'c']);
});

test('沒有 endDate：包含未來 / 今天之後的資料', () => {
  const out = sliceTxWindow(ROWS, { startDate: day('2026-11-01'), limit: 100 }, WINDOW_START, full);
  assert.deepEqual(ids(out), ['e', 'd']);
});

test('category / type / scope 在前端過濾；scope 未填視為 personal', () => {
  assert.deepEqual(ids(sliceTxWindow(ROWS, { startDate: WINDOW_START, type: 'income', limit: 100 }, WINDOW_START, full)), ['d']);
  assert.deepEqual(ids(sliceTxWindow(ROWS, { startDate: WINDOW_START, category: 'transport', limit: 100 }, WINDOW_START, full)), ['b']);
  assert.deepEqual(ids(sliceTxWindow(ROWS, { startDate: WINDOW_START, scope: 'household', limit: 100 }, WINDOW_START, full)), ['c']);
  assert.deepEqual(ids(sliceTxWindow(ROWS, { startDate: WINDOW_START, scope: 'personal', limit: 100 }, WINDOW_START, full)), ['e', 'd', 'b', 'a']);
});

test('limit 取最新的 N 筆；未指定時預設 200', () => {
  assert.deepEqual(ids(sliceTxWindow(ROWS, { startDate: WINDOW_START, limit: 2 }, WINDOW_START, full)), ['e', 'd']);
  assert.equal(sliceTxWindow(ROWS, { startDate: WINDOW_START }, WINDOW_START, full).length, 5);
});

test('起始日早於視窗 → null（改打 Firestore）', () => {
  assert.equal(sliceTxWindow(ROWS, { startDate: day('2025-10-31'), limit: 100 }, WINDOW_START, full), null);
});

test('tripId 查詢一律不走視窗', () => {
  assert.equal(sliceTxWindow(ROWS, { tripId: 't1', startDate: day('2026-11-01') }, WINDOW_START, full), null);
});

test('視窗被 limit 截斷：只回答晚於最舊一筆的區間', () => {
  const floor = txWindowCoverageFloor(WINDOW_START, 5, day('2025-11-05'), 5);
  assert.equal(floor, day('2025-11-05').getTime());
  assert.equal(sliceTxWindow(ROWS, { startDate: day('2025-11-05'), limit: 100 }, WINDOW_START, floor), null);
  assert.equal(sliceTxWindow(ROWS, { startDate: WINDOW_START, limit: 100 }, WINDOW_START, floor), null);
  assert.deepEqual(ids(sliceTxWindow(ROWS, { startDate: day('2025-11-06'), limit: 100 }, WINDOW_START, floor)), ['e', 'd', 'c', 'b']);
});

test('沒讀滿 limit：整個視窗都算完整', () => {
  assert.equal(txWindowCoverageFloor(WINDOW_START, 4, day('2025-11-05'), 5), full);
  assert.equal(txWindowCoverageFloor(WINDOW_START, 0, null, 5), full);
});

test('沒有起始日（最近 N 筆）：湊得滿才回答', () => {
  assert.deepEqual(ids(sliceTxWindow(ROWS, { limit: 3 }, WINDOW_START, full)), ['e', 'd', 'c']);
  assert.equal(sliceTxWindow(ROWS, { limit: 10 }, WINDOW_START, full), null);
  assert.equal(sliceTxWindow(ROWS, { category: 'transport', limit: 2 }, WINDOW_START, full), null);
});

test('txSliceKey：內容相同的 filters 產生相同 key', () => {
  const a = { startDate: day('2026-11-01'), endDate: day('2026-11-30'), limit: 5000 };
  const b = { startDate: day('2026-11-01'), endDate: day('2026-11-30'), limit: 5000 };
  assert.equal(txSliceKey(a), txSliceKey(b));
  assert.notEqual(txSliceKey(a), txSliceKey({ ...b, type: 'expense' }));
});
