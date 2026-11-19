// features/accounts/amortization.ts — 貸款攤還表（F3）
// 不可依賴主機時區：TZ=UTC / TZ=America/New_York node --test apps/web/tests/amortization.test.cjs
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

const a = loadTs(path.resolve(__dirname, '../src/features/accounts/amortization.ts'));
const START = new Date('2026-01-31T04:00:00Z'); // 台北 2026-01-31 12:00
const sum = (rows, key) => Math.round(rows.reduce((s, r) => s + r[key], 0) * 100) / 100;

test('annuity: 1,000,000 at 2% for 240 months ≈ 5,058.83 / month', () => {
  assert.equal(a.annuityPayment(1_000_000, 2, 240), 5058.83);
  const s = a.buildAmortizationSchedule({ principal: 1_000_000, annualRatePct: 2, termMonths: 240, startDate: START });
  assert.equal(s.error, null);
  assert.equal(s.termMonths, 240);
  assert.equal(s.firstPayment, 5058.83);
  assert.equal(s.rows[0].interest, 1666.67);
  assert.equal(s.rows[0].principal, 3392.16);
  const last = s.rows[239];
  assert.equal(last.remaining, 0);
  // 最後一期吸收尾差：與正常月付只差幾分錢
  assert.ok(Math.abs(last.payment - 5058.83) < 1, `last payment ${last.payment}`);
  assert.equal(sum(s.rows, 'principal'), 1_000_000);
  assert.ok(Math.abs(s.totalInterest - 214_119) < 5, `total interest ${s.totalInterest}`);
  assert.equal(s.totalPayment, Math.round((1_000_000 + s.totalInterest) * 100) / 100);
  assert.equal(s.payoffDate.toISOString(), '2045-12-31T04:00:00.000Z');
});

test('annuity driven by monthly payment derives the term', () => {
  assert.equal(a.termForPayment(1_000_000, 2, 5058.83), 240);
  const s = a.buildAmortizationSchedule({ principal: 1_000_000, annualRatePct: 2, monthlyPayment: 5058.83, startDate: START });
  assert.equal(s.termMonths, 240);
  assert.equal(s.rows[239].remaining, 0);
  // 月付付不出利息 → 錯誤而不是無限迴圈
  assert.equal(a.termForPayment(1_000_000, 2, 1000), null);
  const bad = a.buildAmortizationSchedule({ principal: 1_000_000, annualRatePct: 2, monthlyPayment: 1000, startDate: START });
  assert.equal(bad.rows.length, 0);
  assert.ok(bad.error);
});

test('0% rate: equal payments, no interest, rounding goes to the last period', () => {
  const s = a.buildAmortizationSchedule({ principal: 120_000, annualRatePct: 0, termMonths: 12, startDate: START });
  assert.equal(s.totalInterest, 0);
  assert.ok(s.rows.every((r) => r.payment === 10_000 && r.interest === 0));
  const odd = a.buildAmortizationSchedule({ principal: 100_000, annualRatePct: 0, termMonths: 3, startDate: START });
  assert.deepEqual(odd.rows.map((r) => r.payment), [33_333.33, 33_333.33, 33_333.34]);
  assert.equal(odd.rows[2].remaining, 0);
  assert.equal(a.termForPayment(100_000, 0, 30_000), 4);
});

test('equal principal: first / last payment', () => {
  const s = a.buildAmortizationSchedule({
    principal: 1_200_000, annualRatePct: 2.4, termMonths: 120, method: 'equal_principal', startDate: START,
  });
  assert.equal(s.termMonths, 120);
  assert.equal(s.firstPayment, 12_400); // 10,000 本金 + 1,200,000 × 0.2%
  assert.equal(s.lastPayment, 10_020); // 10,000 本金 + 10,000 × 0.2%
  assert.ok(s.rows.every((r) => r.principal === 10_000));
  // 利息總和 = 0.002 × 10,000 × (120 + 119 + … + 1)
  assert.equal(s.totalInterest, 145_200);
  const noTerm = a.buildAmortizationSchedule({ principal: 1_000, annualRatePct: 1, monthlyPayment: 100, method: 'equal_principal', startDate: START });
  assert.ok(noTerm.error);
});

test('dates step from the first period with month-end clamping (Jan 31 → Feb 28 → Mar 31)', () => {
  const s = a.buildAmortizationSchedule({ principal: 30_000, annualRatePct: 0, termMonths: 14, startDate: START });
  const iso = (i) => s.rows[i].date.toISOString();
  assert.equal(iso(0), '2026-01-31T04:00:00.000Z');
  assert.equal(iso(1), '2026-02-28T04:00:00.000Z');
  assert.equal(iso(2), '2026-03-31T04:00:00.000Z');
  assert.equal(iso(3), '2026-04-30T04:00:00.000Z');
  assert.equal(iso(13), '2027-02-28T04:00:00.000Z');
});

test('remainingPrincipalAt follows the schedule', () => {
  const s = a.buildAmortizationSchedule({ principal: 120_000, annualRatePct: 0, termMonths: 12, startDate: START });
  assert.equal(a.remainingPrincipalAt(s, new Date('2026-01-01T00:00:00Z')), 120_000);
  assert.equal(a.remainingPrincipalAt(s, START), 110_000, 'the payment on that day counts');
  assert.equal(a.remainingPrincipalAt(s, new Date('2026-03-15T00:00:00Z')), 100_000);
  assert.equal(a.remainingPrincipalAt(s, new Date('2030-01-01T00:00:00Z')), 0);
});

test('early repayment: shorten term keeps the payment, reduce payment keeps the term', () => {
  const base = { principal: 1_000_000, annualRatePct: 2, termMonths: 240, startDate: START, atPeriod: 12, extraAmount: 200_000 };
  const shorten = a.simulateEarlyRepayment({ ...base, mode: 'shorten_term' });
  assert.equal(shorten.error, null);
  assert.equal(shorten.newPayment, 5058.83);
  assert.ok(shorten.monthsSaved > 50 && shorten.monthsSaved < 70, `monthsSaved ${shorten.monthsSaved}`);
  assert.ok(shorten.interestSaved > 0);
  assert.equal(shorten.after.rows[11].extra, 200_000);
  assert.equal(shorten.after.rows[shorten.after.rows.length - 1].remaining, 0);

  const reduce = a.simulateEarlyRepayment({ ...base, mode: 'reduce_payment' });
  assert.equal(reduce.error, null);
  assert.equal(reduce.monthsSaved, 0);
  assert.equal(reduce.after.termMonths, 240);
  const remainingAfter = reduce.after.rows[11].remaining;
  assert.equal(reduce.newPayment, a.annuityPayment(remainingAfter, 2, 228));
  assert.ok(reduce.newPayment < 5058.83);
  // 縮短期數省的利息比降低月付多
  assert.ok(shorten.interestSaved > reduce.interestSaved);

  // 本金平均 + 降低月付：剩餘本金平均分到剩下的期數
  const ep = a.simulateEarlyRepayment({
    principal: 1_200_000, annualRatePct: 2.4, termMonths: 120, method: 'equal_principal', startDate: START,
    atPeriod: 10, extraAmount: 110_000, mode: 'reduce_payment',
  });
  assert.equal(ep.after.termMonths, 120);
  assert.equal(ep.after.rows[10].principal, 9_000); // (1,100,000 − 110,000) / 110

  // 提前還款超過剩餘本金 → 當期還清
  const payoff = a.simulateEarlyRepayment({ ...base, extraAmount: 5_000_000, mode: 'shorten_term' });
  assert.equal(payoff.after.termMonths, 12);
  assert.equal(payoff.monthsSaved, 228);

  assert.ok(a.simulateEarlyRepayment({ ...base, atPeriod: 240, mode: 'shorten_term' }).error);
  assert.ok(a.simulateEarlyRepayment({ ...base, extraAmount: 0, mode: 'shorten_term' }).error);
});

test('downsampleRows keeps at most maxPoints and always the last row', () => {
  const rows = Array.from({ length: 1201 }, (_, i) => i);
  const out = a.downsampleRows(rows, 500);
  assert.ok(out.length <= 501);
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 1], 1200);
  assert.deepEqual(a.downsampleRows([1, 2, 3], 500), [1, 2, 3]);
});
