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

const analytics = loadTs(path.resolve(__dirname, '../src/features/household/analytics.ts'));
const fundPlan = loadTs(path.resolve(__dirname, '../src/features/household/fund-plan.ts'));
const FUND = '__household_fund__';
const members = ['rex', 'partner'];

function tx(over) {
  return {
    id: over.id ?? Math.random().toString(36).slice(2), userId: 'rex', type: 'expense', amount: 1000, currency: 'TWD',
    amountTWD: 1000, fxRate: 1, category: 'food', paymentMethod: '現金', householdId: 'h1', paidByUid: 'rex',
    customShares: [{ memberId: 'rex', amountTWD: 500 }, { memberId: 'partner', amountTWD: 500 }],
    date: new Date('2026-10-10T04:00:00Z'), createdAt: new Date(), updatedAt: new Date(), tags: [], ...over,
  };
}

const oct = { key: '2026-10', label: '26/10', start: new Date('2026-09-30T16:00:00Z'), end: new Date('2026-10-31T15:59:59.999Z') };
const nov = { key: '2026-11', label: '26/11', start: new Date('2026-10-31T16:00:00Z'), end: new Date('2026-11-30T15:59:59.999Z') };

test('monthly rows split by Taipei month, skip deleted, track fund spend and moving average', () => {
  const txs = [
    tx({ amountTWD: 1000 }),
    // 台北 11/1 00:30 = UTC 10/31 16:30 → 算 11 月
    tx({ amountTWD: 3000, category: 'rent', paidByUid: FUND, date: new Date('2026-10-31T16:30:00Z') }),
    tx({ amountTWD: 9999, deletedAt: new Date() }),
  ];
  const rows = analytics.buildMonthlyRows(txs, members, [oct, nov]);
  assert.equal(rows[0].totalTWD, 1000);
  assert.equal(rows[1].totalTWD, 3000);
  assert.equal(rows[1].fundTWD, 3000);
  assert.equal(rows[1].movingAvgTWD, 2000);
  assert.deepEqual(rows[1].byCategory, { rent: 3000 });
});

test('period KPIs compare against the previous period', () => {
  const current = [{ totalTWD: 6000, fundTWD: 3000, count: 3 }, { totalTWD: 4000, fundTWD: 0, count: 2 }];
  const previous = [{ totalTWD: 5000, fundTWD: 0, count: 1 }, { totalTWD: 3000, fundTWD: 0, count: 1 }];
  const kpis = analytics.buildPeriodKpis(current, previous, 5000);
  assert.equal(kpis.totalTWD, 10000);
  assert.equal(Math.round(kpis.changePct), 25);
  assert.equal(kpis.monthlyAvgTWD, 5000);
  assert.equal(kpis.avgTicketTWD, 2000);
  assert.equal(kpis.fundShare, 0.3);
  assert.equal(kpis.monthsWithinBudget, 1);
});

test('paid vs share ignores fund-paid shares and counts deposits', () => {
  const txs = [
    tx({ amountTWD: 1000, paidByUid: 'rex' }),
    tx({ amountTWD: 2000, paidByUid: FUND, customShares: [{ memberId: 'rex', amountTWD: 1000 }, { memberId: 'partner', amountTWD: 1000 }] }),
  ];
  const entries = [{ id: 'e1', amountTWD: 5000, contributorUid: 'partner', date: new Date('2026-10-05T04:00:00Z') }];
  const rows = analytics.buildPaidVsShare(txs, entries, members, oct.start, oct.end);
  const rex = rows.find((r) => r.uid === 'rex');
  const partner = rows.find((r) => r.uid === 'partner');
  assert.equal(rex.paidTWD, 1000);
  assert.equal(rex.shareTWD, 500);
  assert.equal(partner.shareTWD, 500);
  assert.equal(partner.contributedTWD, 5000);
});

test('fund month rows carry the running balance from earlier records', () => {
  const entries = [
    { id: 'old', amountTWD: 10000, contributorUid: 'rex', date: new Date('2026-08-01T04:00:00Z') },
    { id: 'n1', amountTWD: 2000, contributorUid: 'partner', date: new Date('2026-11-02T04:00:00Z') },
  ];
  const txs = [tx({ amountTWD: 3000, paidByUid: FUND, date: new Date('2026-10-20T04:00:00Z') })];
  const rows = analytics.buildFundMonthRows(entries, txs, [oct, nov]);
  assert.deepEqual(rows.map((r) => r.balanceTWD), [7000, 9000]);
  assert.equal(rows[0].spentTWD, 3000);
  assert.equal(rows[1].contributedTWD, 2000);
});

test('category budgets flag warn at 80% and over above 100%', () => {
  const rows = analytics.buildCategoryBudgetRows(
    [{ key: 'food', totalTWD: 8500 }, { key: 'fun', totalTWD: 1200 }],
    { food: 10000, fun: 1000, rent: 20000 },
  );
  assert.deepEqual(rows.map((r) => [r.key, r.state]), [['fun', 'over'], ['food', 'warn'], ['rent', 'ok']]);
});

test('category stack folds the tail into other', () => {
  const rows = [{ label: 'a', byCategory: { food: 5, rent: 10, fun: 1 } }];
  const stack = analytics.buildCategoryStack(rows, ['rent', 'food']);
  assert.deepEqual(stack[0], { label: 'a', rent: 10, food: 5, __other__: 1 });
});

test('fund plan shares keep the total exact', () => {
  const shares = fundPlan.fundPlanShares(1001, members, { rex: 60, partner: 40 });
  assert.equal(shares.reduce((s, r) => s + r.amountTWD, 0), 1001);
  assert.equal(fundPlan.fundPlanExpenseTxId('h1', 'rent', '2026-11'), 'fundplan_h1_rent_202611');
  assert.equal(fundPlan.fundPlanDueDay(31, 2026, 2), 28);
});
