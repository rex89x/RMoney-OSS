const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react-dom', 'lucide-react'],
    alias: { '@': path.resolve(__dirname, '../src') } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const m = loadTs(path.resolve(__dirname, '../src/features/analytics/metrics.ts'));
const p = loadTs(path.resolve(__dirname, '../src/features/analytics/periods.ts'));
const forecast = loadTs(path.resolve(__dirname, '../src/features/analytics/forecast.ts'));
const chart = loadTs(path.resolve(__dirname, '../src/lib/chart-theme.ts'));
const tz = loadTs(path.resolve(__dirname, '../src/lib/tz.ts'));

/** 台北時間 yyyy-MM-ddTHH:mm → Date */
function tw(s) {
  return new Date(`${s}:00+08:00`);
}
function tx(overrides) {
  return { type: 'expense', category: 'food', amountTWD: 100, date: tw('2026-10-10T12:00'), note: null, ...overrides };
}
const amount = (t) => t.amountTWD;

test('consumption / earned definitions exclude transfers of value', () => {
  assert.equal(m.isConsumptionExpense(tx({})), true);
  for (const category of ['rental_purchase', 'adjustment', 'household_settlement']) {
    assert.equal(m.isConsumptionExpense(tx({ category })), false, category);
  }
  assert.equal(m.isConsumptionExpense(tx({ deletedAt: new Date() })), false);
  assert.equal(m.isConsumptionExpense(tx({ type: 'transfer' })), false);
  assert.equal(m.isEarnedIncome(tx({ type: 'income', category: 'salary' })), true);
  assert.equal(m.isEarnedIncome(tx({ type: 'income', category: 'adjustment_income' })), false);
  assert.equal(m.isEarnedIncome(tx({ type: 'income', category: 'household_settlement_income' })), false);
  // forecast 舊名指向同一份清單
  assert.deepEqual([...forecast.FORECAST_EXCLUDED_CATEGORIES], [...m.NON_CONSUMPTION_EXPENSE_CATEGORIES]);
});

test('summarizePeriod uses share for expenses and skips non-consumption rows', () => {
  const txs = [
    tx({ amountTWD: 300, myShare: 100 }),
    tx({ category: 'transport', amountTWD: 50 }),
    tx({ category: 'adjustment', amountTWD: 9999 }),
    tx({ type: 'income', category: 'salary', amountTWD: 1000 }),
    tx({ type: 'income', category: 'adjustment_income', amountTWD: 5000 }),
  ];
  const s = m.summarizePeriod(txs, (t) => t.myShare ?? t.amountTWD);
  assert.equal(s.expense, 150);
  assert.equal(s.income, 1000);
  assert.equal(s.net, 850);
  assert.equal(s.savingsRate, 0.85);
  assert.equal(s.expenseCount, 2);
  assert.equal(s.byCategory.get('food'), 100);
  assert.equal(s.byCategory.has('adjustment'), false);
  assert.equal(m.summarizePeriod([tx({})], amount).savingsRate, null);
});

test('percentChange / compareCategories / topWithOther', () => {
  assert.equal(m.percentChange(150, 100), 0.5);
  assert.equal(m.percentChange(10, 0), null);
  const d = m.compareCategories(new Map([['food', 300], ['fun', 50]]), new Map([['food', 100], ['fun', 80], ['gift', 40]]));
  assert.deepEqual(d.map((x) => [x.key, x.delta]), [['food', 200], ['fun', -30], ['gift', -40]]);
  const rows = [{ key: 'a', value: 5 }, { key: 'b', value: 9 }, { key: 'c', value: 1 }, { key: 'd', value: 2 }];
  assert.deepEqual(m.topWithOther(rows, 2), [{ key: 'b', value: 9 }, { key: 'a', value: 5 }, { key: m.OTHER_KEY, value: 3 }]);
  assert.equal(m.topWithOther(rows, 4).length, 4);
});

test('merchant ranking merges notes that differ only by trailing amount / spacing', () => {
  assert.equal(m.merchantKey('  星巴克   180 '), '星巴克');
  assert.equal(m.merchantKey('Uber Eats x2'), 'uber eats');
  const rows = m.merchantRanking([
    tx({ note: '星巴克', amountTWD: 180 }),
    tx({ note: '星巴克 150', amountTWD: 150 }),
    tx({ note: '全聯', amountTWD: 500, category: 'home' }),
    tx({ note: '', amountTWD: 999 }),
    tx({ note: '星巴克', amountTWD: 1, category: 'adjustment' }),
  ], amount);
  assert.deepEqual(rows.map((r) => [r.name, r.amount, r.count]), [['全聯', 500, 1], ['星巴克', 330, 2]]);
});

test('weekday / daily totals bucket by Taipei date, not UTC', () => {
  // 2026-10-26 00:30 台北（週一）= 2026-10-25 16:30 UTC（週日）
  const t = tx({ date: tw('2026-10-26T00:30'), amountTWD: 70 });
  const w = m.weekdayTotals([t], amount);
  assert.equal(w[0], 70);
  assert.equal(w[6], 0);
  assert.equal(m.dailyTotals([t], amount).get('2026-10-26'), 70);
});

test('spendBuckets picks granularity and sums into Taipei-day buckets', () => {
  const txs = [
    tx({ date: tw('2026-10-02T00:30'), amountTWD: 10 }),
    tx({ date: tw('2026-10-02T23:59'), amountTWD: 5 }),
    tx({ date: tw('2026-10-31T10:00'), amountTWD: 1 }),
  ];
  const day = m.spendBuckets(txs, amount, '2026-10-01', '2026-10-31');
  assert.equal(day.unit, 'day');
  assert.equal(day.buckets.length, 31);
  assert.equal(day.buckets[1].value, 15);
  assert.equal(day.buckets[1].label, '10/02');
  assert.equal(day.buckets[30].value, 1);

  const week = m.spendBuckets(txs, amount, '2026-08-03', '2026-10-31');
  assert.equal(week.unit, 'week');
  // 2026-08-03 是週一 → 每個 bucket 都是週一到週日
  assert.equal(week.buckets[0].startKey, '2026-08-03');
  assert.equal(week.buckets[0].endKey, '2026-08-09');
  assert.equal(week.buckets.reduce((s, b) => s + b.value, 0), 16);

  const month = m.spendBuckets(txs, amount, '2026-01-01', '2026-12-31');
  assert.equal(month.unit, 'month');
  assert.equal(month.buckets.length, 12);
  assert.equal(month.buckets[9].label, '2026/10');
  assert.equal(month.buckets[9].endKey, '2026-10-31');
  assert.equal(month.buckets[9].value, 16);
});

test('monthlyCategorySeries keeps top N and folds the rest into other', () => {
  const txs = [
    tx({ category: 'food', amountTWD: 500, date: tw('2026-09-05T12:00') }),
    tx({ category: 'fun', amountTWD: 300, date: tw('2026-10-05T12:00') }),
    tx({ category: 'gift', amountTWD: 20, date: tw('2026-10-06T12:00') }),
    tx({ category: 'food', amountTWD: 100, date: tw('2026-08-01T12:00') }), // 不在範圍
  ];
  const s = m.monthlyCategorySeries(txs, amount, ['2026-09', '2026-10'], 2);
  assert.deepEqual(s.keys, ['food', 'fun', m.OTHER_KEY]);
  assert.deepEqual(s.rows[0], { month: '2026-09', food: 500, fun: 0, [m.OTHER_KEY]: 0, total: 500 });
  assert.deepEqual(s.rows[1], { month: '2026-10', food: 0, fun: 300, [m.OTHER_KEY]: 20, total: 320 });
});

test('fixed expense matcher and split', () => {
  const isFixed = m.buildFixedExpenseMatcher(['Netflix', null, '房租', 'x']);
  assert.equal(isFixed({ note: 'netflix 月費' }), true);
  assert.equal(isFixed({ note: '十月房租' }), true);
  assert.equal(isFixed({ note: 'xbox' }), false); // 單字元關鍵字忽略
  assert.equal(isFixed({ note: null, recurringId: 'r1' }), true);
  const split = m.splitFixedVariable([
    tx({ note: 'Netflix', amountTWD: 390 }),
    tx({ note: '午餐', amountTWD: 120 }),
    tx({ note: 'Netflix', amountTWD: 1, category: 'adjustment' }),
  ], amount, isFixed);
  assert.equal(split.fixed, 390);
  assert.equal(split.variable, 120);
  assert.deepEqual(split.fixedItems, [{ name: 'Netflix', amount: 390 }]);
});

test('category budget pace flags over and ahead-of-schedule categories', () => {
  const rows = m.categoryBudgetPace(new Map([['food', 6000], ['fun', 900], ['home', 100]]), { food: 5000, fun: 1000, home: 1000, zero: 0 }, 0.5);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.status]));
  assert.deepEqual(byKey, { food: 'over', fun: 'ahead', home: 'ok' });
  assert.equal(rows[0].key, 'food');
});

test('month headline and budget impact copy', () => {
  assert.equal(
    m.buildMonthHeadline({ spent: 11200, prevSpent: 10000, topIncrease: { name: '餐飲', delta: 3200 }, topDecrease: null, budget: 20000, projected: 21500 }),
    '比上月同期多花 12%，主要是餐飲 +3,200，照目前速度月底會超支 1,500',
  );
  assert.equal(
    m.buildMonthHeadline({ spent: 8000, prevSpent: 10000, topIncrease: null, topDecrease: { name: '購物', delta: -1500 }, budget: null, projected: null }),
    '比上月同期少花 20%，購物省最多 -1,500',
  );
  assert.equal(m.buildMonthHeadline({ spent: 0, prevSpent: 0, topIncrease: null, topDecrease: null, budget: null, projected: null }), '本月還沒有支出');

  assert.equal(
    m.budgetImpactMessage({ monthSpentBefore: 10000, categorySpentBefore: 3900, amount: 200, categoryName: '餐飲', categoryLimit: 5000, monthBudget: 20000, daysLeft: 3 }),
    '餐飲本月已用 82% · 今日起每天可花 3,267',
  );
  assert.equal(
    m.budgetImpactMessage({ monthSpentBefore: 19900, categorySpentBefore: 5000, amount: 300, categoryName: '餐飲', categoryLimit: 5000, monthBudget: 20000, daysLeft: 3 }),
    '餐飲已超出預算 300 · 本月總預算已超支 200',
  );
  assert.equal(m.budgetImpactMessage({ monthSpentBefore: 0, categorySpentBefore: 0, amount: 1, categoryName: 'x', categoryLimit: null, monthBudget: null, daysLeft: 1 }), null);
});

test('periodRange matches monthTWRange so card queries share one cache key', () => {
  const today = p.twDateFromKey('2026-10-29');
  const r = p.periodRange('thisMonth', today);
  const ref = tz.monthTWRange(2026, 10);
  assert.equal(r.start.toISOString(), ref.start.toISOString());
  assert.equal(r.end.toISOString(), ref.end.toISOString());
  assert.equal(r.start.toISOString(), '2026-09-30T16:00:00.000Z');
  assert.equal(r.startKey, '2026-10-01');
  assert.equal(r.endKey, '2026-10-31');
  // 同一天重算結果相同（避免 query key 每次 render 改變）
  assert.equal(p.periodRange('last30d', today).end.toISOString(), p.periodRange('last30d', p.twDateFromKey('2026-10-29')).end.toISOString());
  assert.equal(p.periodRange('last30d', today).startKey, '2026-09-30');
  assert.equal(p.periodRange('last90d', today).startKey, '2026-08-01');
  assert.equal(p.periodRange('thisQuarter', today).endKey, '2026-12-31');
  assert.equal(p.periodRange('lastMonth', p.twDateFromKey('2026-01-15')).startKey, '2025-12-01');
});

test('comparisonRange compares the same elapsed period and clamps month ends', () => {
  const c1 = p.comparisonRange('thisMonth', p.twDateFromKey('2026-03-31'));
  assert.equal(c1.startKey, '2026-02-01');
  assert.equal(c1.cutoffKey, '2026-02-28');
  const c2 = p.comparisonRange('thisMonth', p.twDateFromKey('2026-10-29'));
  assert.equal(c2.cutoffKey, '2026-09-29');
  const c3 = p.comparisonRange('ytd', p.twDateFromKey('2024-02-29'));
  assert.equal(c3.startKey, '2023-01-01');
  assert.equal(c3.cutoffKey, '2023-02-28');
  const c4 = p.comparisonRange('last30d', p.twDateFromKey('2026-10-29'));
  assert.equal(c4.startKey, '2026-08-31');
  assert.equal(c4.endKey, '2026-09-29');
  const c5 = p.comparisonRange('thisQuarter', p.twDateFromKey('2026-11-15'));
  assert.equal(c5.startKey, '2026-07-01');
  assert.equal(c5.cutoffKey, '2026-08-15');
  const c6 = p.comparisonRange('lastMonth', p.twDateFromKey('2026-01-10'));
  assert.equal(c6.startKey, '2025-11-01');
  assert.equal(c6.cutoffKey, '2025-11-30');
});

test('elapsedDays / pastMonthsRange / recentMonthKeys', () => {
  const today = p.twDateFromKey('2026-10-29');
  assert.equal(p.elapsedDays(p.periodRange('thisMonth', today), today), 29);
  assert.equal(p.elapsedDays(p.periodRange('lastMonth', today), today), 30);
  const past = p.pastMonthsRange(today, 6);
  assert.equal(past.startKey, '2026-04-01');
  assert.equal(past.endKey, '2026-09-30');
  assert.deepEqual(p.recentMonthKeys(p.twDateFromKey('2026-02-10'), 3), ['2025-12', '2026-01', '2026-02']);
  assert.deepEqual(m.filterUntilKey([tx({ date: tw('2026-09-29T23:00') }), tx({ date: tw('2026-09-30T00:10') })], '2026-09-29').length, 1);
});

test('formatAxisTWD compacts amounts', () => {
  assert.equal(chart.formatAxisTWD(950), '950');
  assert.equal(chart.formatAxisTWD(1234), '1.2K');
  assert.equal(chart.formatAxisTWD(25000), '25K');
  assert.equal(chart.formatAxisTWD(150000), '150K');
  assert.equal(chart.formatAxisTWD(1250000), '1.3M');
  assert.equal(chart.formatAxisTWD(-3000), '-3K');
});
