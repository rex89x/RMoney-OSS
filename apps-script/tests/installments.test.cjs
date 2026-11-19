// 信用卡分期入帳（apps-script/src/Installments.gs）
// - runInstallmentPlans 冪等：tx id inst_{planId}_{i}，重跑不重複入帳、不重複動餘額
// - 第一次跑補齊所有已到期期數（catch up）；取消 / 已繳完不處理
// - 金額與日期跟前端 features/installments/schedule.ts 同口徑（parity）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../src/Installments.gs'), 'utf8');
const WEB_SRC = path.resolve(__dirname, '../../apps/web/src');

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    alias: { '@': WEB_SRC } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const PLAN_NAME = 'projects/p/databases/(default)/documents/installment_plans/plan1';

function basePlan(extra = {}) {
  return {
    _name: PLAN_NAME,
    ownerId: 'owner',
    title: '筆電',
    totalAmountTWD: 10000,
    feeTWD: 0,
    periods: 3,
    perPeriodTWD: 3333,
    cardAccountId: 'card1',
    category: 'shopping',
    // 台北 2026-08-31 12:00 → 9/30、10/31（月底 clamp）
    startDate: new Date('2026-08-31T04:00:00Z'),
    paidPeriods: 0,
    status: 'active',
    ...extra,
  };
}

/** 用一份記憶體 Firestore 模擬 fsGetDoc_ / fsSetDoc_ / fsListAllDocs_ */
function makeContext(store, adjustments) {
  const context = vm.createContext({
    console, Date, Error, isNaN, JSON, Math, Number, String, Array, Object,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { sleep: () => {} },
    fsListAllDocs_: (col) => Object.keys(store)
      .filter((k) => k.startsWith(col + '/'))
      .map((k) => ({ ...store[k], _name: 'projects/p/databases/(default)/documents/' + k })),
    fsGetDoc_: (relPath) => (store[relPath] ? { ...store[relPath] } : null),
    fsSetDoc_: (relPath, data, merge) => {
      store[relPath] = merge ? { ...(store[relPath] || {}), ...data } : { ...data };
    },
    importAdjustAccount_: (accountId, currency, deltaNative, deltaTWD) => {
      adjustments.push({ accountId, currency, deltaNative, deltaTWD });
    },
    notifyError: () => {},
    notifyRecurringRun: () => {},
  });
  vm.runInContext(source, context);
  return context;
}

function withNow(context, iso) {
  const now = new Date(iso);
  const RealDate = Date;
  context.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  };
}

function seed(plan) {
  const { _name, ...data } = plan;
  void _name;
  return {
    'installment_plans/plan1': data,
    'accounts/card1': { name: '台新 Richart', type: 'credit_card', currency: 'TWD', balance: 0 },
  };
}

test('catch-up posts every due period once, last period absorbs rounding', () => {
  const store = seed(basePlan());
  const adjustments = [];
  const ctx = makeContext(store, adjustments);
  withNow(ctx, '2026-10-31T17:30:00Z'); // 台北 11/01 01:30 → 三期都到期
  const res = ctx.runInstallmentPlans();
  assert.equal(res.created, 3);
  assert.equal(res.completed, 1);
  const tx1 = store['transactions/inst_plan1_1'];
  const tx3 = store['transactions/inst_plan1_3'];
  assert.ok(tx1 && store['transactions/inst_plan1_2'] && tx3);
  assert.equal(tx1.amountTWD, 3333);
  assert.equal(tx3.amountTWD, 3334, 'last period absorbs the remainder');
  assert.equal(tx1.type, 'expense');
  assert.equal(tx1.fromAccountId, 'card1');
  assert.equal(tx1.note, '筆電 1/3');
  assert.deepEqual(JSON.parse(JSON.stringify(tx1.tags)), ['分期']);
  assert.equal(tx1.installmentPlanId, 'plan1');
  assert.equal(tx3.installmentIndex, 3);
  assert.equal(tx1.paymentMethod, '台新 Richart');
  // 8/31 → 9/30 → 10/31（從首期日推算，不是逐月累加）
  assert.equal(store['transactions/inst_plan1_2'].date.toISOString(), '2026-09-30T04:00:00.000Z');
  assert.equal(tx3.date.toISOString(), '2026-10-31T04:00:00.000Z');
  assert.equal(adjustments.length, 3);
  assert.deepEqual(adjustments.map((a) => a.deltaTWD), [-3333, -3333, -3334]);
  const plan = store['installment_plans/plan1'];
  assert.equal(plan.paidPeriods, 3);
  assert.equal(plan.status, 'completed');
});

test('re-running is idempotent: no duplicate tx and no extra balance adjustment', () => {
  const store = seed(basePlan());
  const adjustments = [];
  const ctx = makeContext(store, adjustments);
  withNow(ctx, '2026-09-30T17:30:00Z'); // 台北 10/01 01:30 → 第 1、2 期到期
  assert.equal(ctx.runInstallmentPlans().created, 2);
  assert.equal(ctx.runInstallmentPlans().created, 0);
  assert.equal(adjustments.length, 2);
  assert.equal(store['installment_plans/plan1'].paidPeriods, 2);
  assert.equal(store['installment_plans/plan1'].status, 'active');
  assert.equal(store['transactions/inst_plan1_3'], undefined, 'future period not posted');
});

test('tx written but plan update lost: next run only advances paidPeriods', () => {
  const store = seed(basePlan());
  // 上次寫了第 1 期的 tx（且使用者軟刪了它），但 paidPeriods 沒推進
  store['transactions/inst_plan1_1'] = { amountTWD: 3333, deletedAt: new Date() };
  const adjustments = [];
  const ctx = makeContext(store, adjustments);
  withNow(ctx, '2026-09-01T17:30:00Z'); // 台北 9/2 → 只有第 1 期到期
  const res = ctx.runInstallmentPlans();
  assert.equal(res.created, 0);
  assert.equal(adjustments.length, 0);
  assert.ok(store['transactions/inst_plan1_1'].deletedAt, 'soft-deleted tx is not resurrected');
  assert.equal(store['installment_plans/plan1'].paidPeriods, 1);
});

test('cancelled / completed plans and future start dates are skipped', () => {
  for (const extra of [{ status: 'cancelled' }, { status: 'completed', paidPeriods: 3 }, { startDate: new Date('2027-01-05T04:00:00Z') }]) {
    const store = seed(basePlan(extra));
    const adjustments = [];
    const ctx = makeContext(store, adjustments);
    withNow(ctx, '2026-11-10T17:30:00Z');
    assert.equal(ctx.runInstallmentPlans().created, 0, JSON.stringify(extra));
    assert.equal(adjustments.length, 0);
  }
});

test('fee is spread into periods and remaining excludes posted periods', () => {
  const store = seed(basePlan({ totalAmountTWD: 12000, feeTWD: 600, periods: 12, perPeriodTWD: 1050, paidPeriods: 4 }));
  const ctx = makeContext(store, []);
  const plan = { ...store['installment_plans/plan1'] };
  assert.equal(ctx.installmentRemainingTWD_(plan), 1050 * 8);
  assert.equal(ctx.installmentRemainingTWD_({ ...plan, status: 'cancelled' }), 0);
});

test('parity with web features/installments/schedule.ts', () => {
  const web = loadTs(path.join(WEB_SRC, 'features/installments/schedule.ts'));
  const ctx = makeContext({}, []);
  const cases = [
    { totalAmountTWD: 10000, feeTWD: 0, periods: 3 },
    { totalAmountTWD: 39900, feeTWD: 1234, periods: 24 },
    { totalAmountTWD: 7, feeTWD: 0, periods: 6 },
    { totalAmountTWD: 120000, feeTWD: 0, periods: 12 },
  ];
  for (const c of cases) {
    const plan = { ...c, perPeriodTWD: web.installmentPerPeriodTWD(c.totalAmountTWD + c.feeTWD, c.periods), paidPeriods: 1, status: 'active' };
    for (let i = 1; i <= c.periods; i++) {
      assert.equal(ctx.installmentPeriodAmount_(plan, i), web.installmentPeriodAmount(plan, i), `amount ${JSON.stringify(c)} #${i}`);
    }
    assert.equal(ctx.installmentRemainingTWD_(plan), web.installmentRemainingTWD(plan));
    // 舊資料沒有 perPeriodTWD：兩邊都現算
    const legacy = { ...plan, perPeriodTWD: -1 };
    assert.equal(ctx.installmentPeriodAmount_(legacy, c.periods), web.installmentPeriodAmount(legacy, c.periods));
  }
  const start = new Date('2026-01-31T04:00:00Z');
  for (let i = 1; i <= 14; i++) {
    assert.equal(ctx.installmentPeriodDate_(start, i).toISOString(), web.installmentPeriodDate(start, i).toISOString(), `date #${i}`);
  }
});
