// features/installments/schedule.ts — 分期金額切分 / 期數日期 / 未入帳金額
// 不可依賴主機時區：TZ=UTC / TZ=America/New_York node --test apps/web/tests/installments.test.cjs
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

const s = loadTs(path.resolve(__dirname, '../src/features/installments/schedule.ts'));

test('splitInstallmentAmounts: equal periods, last absorbs remainder, sum preserved', () => {
  assert.deepEqual(s.splitInstallmentAmounts(12000, 12), Array(12).fill(1000));
  assert.deepEqual(s.splitInstallmentAmounts(10000, 3), [3333, 3333, 3334]);
  const odd = s.splitInstallmentAmounts(39999, 24);
  assert.equal(odd.length, 24);
  assert.equal(odd.reduce((a, b) => a + b, 0), 39999);
  assert.ok(odd.slice(0, 23).every((v) => v === 1666));
  assert.equal(odd[23], 39999 - 1666 * 23);
  // 金額小於期數：前幾期 0，最後一期全額
  assert.deepEqual(s.splitInstallmentAmounts(5, 6), [0, 0, 0, 0, 0, 5]);
  assert.equal(s.installmentPerPeriodTWD(10000, 3), 3333);
});

test('installmentPeriodAmount includes the fee and handles legacy plans without perPeriodTWD', () => {
  const plan = { totalAmountTWD: 30000, feeTWD: 900, periods: 6, perPeriodTWD: 5150 };
  const amounts = [1, 2, 3, 4, 5, 6].map((i) => s.installmentPeriodAmount(plan, i));
  assert.equal(amounts.reduce((a, b) => a + b, 0), 30900);
  assert.deepEqual(amounts, [5150, 5150, 5150, 5150, 5150, 5150]);
  const legacy = { totalAmountTWD: 10000, feeTWD: 0, periods: 3, perPeriodTWD: -1 };
  assert.equal(s.installmentPeriodAmount(legacy, 1), 3333);
  assert.equal(s.installmentPeriodAmount(legacy, 3), 3334);
});

test('installmentPeriodDate: computed from the first period, month-end clamped (pitfall #23)', () => {
  const start = new Date('2026-01-31T04:00:00Z'); // 台北 1/31 12:00
  const iso = (i) => s.installmentPeriodDate(start, i).toISOString();
  assert.equal(iso(1), '2026-01-31T04:00:00.000Z');
  assert.equal(iso(2), '2026-02-28T04:00:00.000Z');
  assert.equal(iso(3), '2026-03-31T04:00:00.000Z', 'not 3/28: always derived from the start date');
  assert.equal(iso(14), '2027-02-28T04:00:00.000Z');
});

test('remaining / next date only for active plans', () => {
  const plan = {
    totalAmountTWD: 10000, feeTWD: 0, periods: 3, perPeriodTWD: 3333,
    paidPeriods: 1, status: 'active', startDate: new Date('2026-11-09T04:00:00Z'),
  };
  assert.equal(s.installmentRemainingTWD(plan), 6667);
  assert.equal(s.nextInstallmentDate(plan).toISOString(), '2026-12-09T04:00:00.000Z');
  assert.equal(s.lastInstallmentDate(plan).toISOString(), '2027-01-09T04:00:00.000Z');
  assert.equal(s.installmentRemainingTWD({ ...plan, status: 'cancelled' }), 0);
  assert.equal(s.nextInstallmentDate({ ...plan, status: 'cancelled' }), null);
  assert.equal(s.nextInstallmentDate({ ...plan, paidPeriods: 3 }), null);
  assert.equal(s.totalInstallmentRemainingTWD([plan, { ...plan, paidPeriods: 0 }, { ...plan, status: 'completed' }]), 6667 + 10000);
  const rows = s.installmentScheduleRows(plan);
  assert.deepEqual(rows.map((r) => [r.index, r.amountTWD, r.posted]), [[1, 3333, true], [2, 3333, false], [3, 3334, false]]);
});
