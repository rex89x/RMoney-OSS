// F9 保險 / 退休：繳費日推進、淨值貢獻、提醒視窗、退休試算、退休規劃判定
// 不依賴主機時區：日期一律用台北時間字串建立（CI 跑 UTC）。
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

const insurance = loadTs(path.resolve(__dirname, '../src/features/accounts/insurance.ts'));
const pension = loadTs(path.resolve(__dirname, '../src/features/accounts/pension.ts'));
const valuation = loadTs(path.resolve(__dirname, '../src/features/accounts/valuation.ts'));
const retirement = loadTs(path.resolve(__dirname, '../src/features/investments/retirement.ts'));

const tw = (s) => new Date(`${s}T00:00:00+08:00`);
const twIso = (d) => new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 測試用：轉回台北日期字串

test('advancePremiumDate: 依頻率前進，月底 clamp (pitfall #23)', () => {
  assert.equal(twIso(insurance.advancePremiumDate(tw('2026-01-15'), 'monthly')), '2026-02-15');
  assert.equal(twIso(insurance.advancePremiumDate(tw('2026-01-31'), 'monthly')), '2026-02-28');
  assert.equal(twIso(insurance.advancePremiumDate(tw('2026-11-30'), 'quarterly')), '2027-02-28');
  assert.equal(twIso(insurance.advancePremiumDate(tw('2026-08-31'), 'semiannual')), '2027-02-28');
  assert.equal(twIso(insurance.advancePremiumDate(tw('2028-02-29'), 'annual')), '2029-02-28');
  // 台北 00:00 = UTC 前一天 16:00，不會因主機時區往前一天
  assert.equal(twIso(insurance.advancePremiumDate(tw('2026-03-01'), 'monthly')), '2026-04-01');
});

test('annualPremiumTWD: 換算年化保費', () => {
  assert.equal(insurance.annualPremiumTWD({ premiumTWD: 1000, premiumFrequency: 'monthly' }), 12000);
  assert.equal(insurance.annualPremiumTWD({ premiumTWD: 3000, premiumFrequency: 'quarterly' }), 12000);
  assert.equal(insurance.annualPremiumTWD({ premiumTWD: 6000, premiumFrequency: 'semiannual' }), 12000);
  assert.equal(insurance.annualPremiumTWD({ premiumTWD: 12000, premiumFrequency: 'annual' }), 12000);
});

test('淨值：保單只計 cashValueTWD、純保障 = 0；退休帳戶以餘額計；封存不計', () => {
  const policy = { type: 'insurance', currency: 'TWD', balance: 999999, balanceTWD: 999999, insurance: { cashValueTWD: 250000 } };
  const protection = { type: 'insurance', currency: 'TWD', balance: 0, balanceTWD: 0, insurance: { premiumTWD: 30000 } };
  const negative = { type: 'insurance', currency: 'TWD', balance: 0, balanceTWD: 0, insurance: { cashValueTWD: -5 } };
  const pensionAcc = { type: 'pension', currency: 'TWD', balance: 800000, balanceTWD: 800000 };
  const usdPension = { type: 'pension', currency: 'USD', balance: 1000, balanceTWD: 30000 };
  const bank = { type: 'bank', currency: 'TWD', balance: 50000, balanceTWD: 50000 };
  const rates = [{ id: 'USD_TWD', base: 'USD', quote: 'TWD', rate: 32 }];

  assert.equal(insurance.insuranceCashValueTWD(policy), 250000);
  assert.equal(insurance.insuranceCashValueTWD(protection), 0);
  assert.equal(insurance.insuranceCashValueTWD(negative), 0);
  assert.equal(valuation.longTermAccountValueTWD(policy, rates), 250000);
  assert.equal(valuation.longTermAccountValueTWD(protection, rates), 0);
  assert.equal(valuation.longTermAccountValueTWD(pensionAcc, rates), 800000);
  assert.equal(valuation.longTermAccountValueTWD(usdPension, rates), 32000);
  assert.equal(valuation.longTermAccountValueTWD(bank, rates), 0, '一般帳戶走 liquid，不在這裡重複計');
  assert.equal(
    valuation.totalInsurancePensionTWD([
      policy, protection, pensionAcc, bank,
      { ...pensionAcc, active: false },
      { ...policy, archivedAt: new Date() },
    ], rates),
    1050000,
  );
});

test('insuranceReminders: 保費 14 天內 / 逾期、滿期 0–30 天、略過停用 / 封存 / 無保費', () => {
  const today = tw('2026-11-09');
  const base = { type: 'insurance', active: true, archivedAt: null };
  const accounts = [
    { ...base, id: 'a', name: '壽險', insurance: { premiumTWD: 3000, premiumFrequency: 'annual', nextPremiumDate: tw('2026-11-23') } },
    { ...base, id: 'b', name: '醫療', insurance: { premiumTWD: 1000, premiumFrequency: 'monthly', nextPremiumDate: tw('2026-11-24') } },
    { ...base, id: 'c', name: '逾期', insurance: { premiumTWD: 500, premiumFrequency: 'monthly', nextPremiumDate: tw('2026-11-01') } },
    { ...base, id: 'd', name: '滿期', insurance: { premiumTWD: 0, premiumFrequency: 'annual', nextPremiumDate: tw('2026-11-10'), maturityDate: tw('2026-12-09') } },
    { ...base, id: 'e', name: '滿期太遠', insurance: { premiumTWD: 0, premiumFrequency: 'annual', nextPremiumDate: tw('2027-11-10'), maturityDate: tw('2026-12-10') } },
    { ...base, id: 'f', name: '已滿期', insurance: { premiumTWD: 0, premiumFrequency: 'annual', nextPremiumDate: tw('2027-11-10'), maturityDate: tw('2026-11-08') } },
    { ...base, id: 'g', name: '停用', active: false, insurance: { premiumTWD: 100, premiumFrequency: 'monthly', nextPremiumDate: tw('2026-11-09') } },
    { ...base, id: 'h', name: '封存', archivedAt: new Date(), insurance: { premiumTWD: 100, premiumFrequency: 'monthly', nextPremiumDate: tw('2026-11-09') } },
    { id: 'i', name: '銀行', type: 'bank', active: true },
  ];
  const rows = insurance.insuranceReminders(accounts, today);
  assert.deepEqual(rows.map((r) => `${r.accountId}:${r.kind}:${r.days}`), ['c:premium:-8', 'a:premium:14', 'd:maturity:30']);
  assert.equal(rows[1].premiumTWD, 3000);
  // 今天台北 23:59 呼叫也一樣（daysBetweenTWDates 以台北日曆天計）
  const late = insurance.insuranceReminders(accounts, new Date('2026-11-09T15:59:00Z'));
  assert.deepEqual(late.map((r) => r.accountId), ['c', 'a', 'd']);
});

test('pension: 月提繳 = 工資 × (雇主 + 自提)%', () => {
  assert.equal(pension.pensionMonthlyContributionTWD({ provider: 'x', monthlySalaryTWD: 50000, employerContributionPct: 6, selfContributionPct: 6 }), 6000);
  assert.equal(pension.pensionMonthlyContributionTWD({ provider: 'x', employerContributionPct: 6 }), 0);
  assert.equal(pension.pensionMonthlyContributionTWD({ provider: 'x', monthlySalaryTWD: 50000 }), 0);
});

test('pension: 終值公式（0 報酬 = 線性；有報酬 = 期末年金）', () => {
  assert.equal(pension.futureValueWithContributions(100000, 1000, 0, 12), 112000);
  // 年化 12% → 月 1%，12 期：100000 × 1.01^12 + 1000 × (1.01^12 − 1) / 0.01
  const growth = Math.pow(1.01, 12);
  const expected = 100000 * growth + 1000 * ((growth - 1) / 0.01);
  assert.ok(Math.abs(pension.futureValueWithContributions(100000, 1000, 12, 12) - expected) < 1e-6);
  assert.equal(pension.futureValueWithContributions(5000, 100, 5, 0), 5000);
  assert.equal(pension.futureValueWithContributions(5000, 100, 5, -3), 5000, '負期數視為 0');
});

test('pension: 剩餘月數與試算', () => {
  // 1990 出生、65 歲退休 → 2055-01；2026-11 起算 = 29 年 × 12 − 10 = 338
  assert.equal(pension.monthsUntilRetirement(1990, 65, 2026, 11), 338);
  assert.equal(pension.monthsUntilRetirement(1950, 65, 2026, 11), 0);
  assert.equal(pension.projectPension(100000, undefined, { twYear: 2026, twMonth: 11 }), null);
  assert.equal(pension.projectPension(100000, { provider: 'x' }, { twYear: 2026, twMonth: 11 }), null, '缺出生年無法試算');
  const p = pension.projectPension(100000, { provider: 'x', birthYear: 1990, monthlySalaryTWD: 50000, employerContributionPct: 6 }, { twYear: 2026, twMonth: 11 });
  assert.equal(p.retirementYear, 2055);
  assert.equal(p.monthsLeft, 338);
  assert.equal(p.monthlyContributionTWD, 3000);
  assert.equal(p.expectedReturnPct, pension.DEFAULT_PENSION_RETURN_PCT);
  assert.ok(Math.abs(p.projectedTWD - pension.futureValueWithContributions(100000, 3000, 3, 338)) < 1e-6);
});

test('isRetirementPlan / hasRetirementSetup: 旗標優先、舊資料退回名稱、pension 帳戶也算', () => {
  assert.equal(retirement.isRetirementPlan({ name: '買房', isRetirement: true }), true);
  assert.equal(retirement.isRetirementPlan({ name: '退休金', isRetirement: false }), false, '明確取消就不算');
  assert.equal(retirement.isRetirementPlan({ name: '退休準備金' }), true, '舊資料名稱 fallback');
  assert.equal(retirement.isRetirementPlan({ name: 'Early Retirement' }), true);
  assert.equal(retirement.isRetirementPlan({ name: '教育基金' }), false);
  assert.equal(retirement.hasRetirementSetup([{ name: '教育基金' }], [{ type: 'pension', active: true }]), true);
  assert.equal(retirement.hasRetirementSetup([{ name: '教育基金' }], [{ type: 'pension', active: false }]), false);
  assert.equal(retirement.hasRetirementSetup([], [{ type: 'bank', active: true }]), false);
});
