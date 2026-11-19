const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/HouseholdFundPlan.gs'), 'utf8');

function makeContext(overrides = {}) {
  const writes = [];
  const added = [];
  const context = vm.createContext({
    console, Date, Error, isFinite, JSON, Math, Number, String, Array, Object,
    HOUSEHOLD_FUND_PAYER_ID_: '__household_fund__',
    Utilities: {
      formatDate: (date, _tz, pattern) => {
        // 測試一律用台北時間 UTC+8
        const tw = new Date(date.getTime() + 8 * 3600 * 1000);
        if (pattern === 'yyyy') return String(tw.getUTCFullYear());
        if (pattern === 'M') return String(tw.getUTCMonth() + 1);
        if (pattern === 'd') return String(tw.getUTCDate());
        throw new Error(`unexpected pattern ${pattern}`);
      },
    },
    fsGetDoc_: () => null,
    fsSetDoc_: (relPath, data, merge) => { writes.push({ relPath, data, merge }); },
    fsAddDoc_: (collectionPath, data) => { added.push({ collectionPath, data }); },
    fsRunQuery_: () => [],
    notifyError: () => {},
    // 生產碼改用 fsListAllDocs_（自動翻頁）；測試用同一個 stub
    fsListAllDocs_: overrides.fsListDocs_ || (() => []),
    ...overrides,
  });
  vm.runInContext(source, context);
  return { context, writes, added };
}

test('due day clamps to month end and respects start month', () => {
  const { context } = makeContext();
  assert.equal(context.fundPlanDueDay_(31, 2026, 2), 28);
  assert.equal(context.fundPlanDueDay_(31, 2028, 2), 29);
  assert.equal(context.fundPlanDueDay_(5, 2026, 11), 5);
  const plan = { startMonth: '2026-12' };
  assert.equal(context.fundPlanIsDue_(plan, 5, { year: 2026, month: 11, day: 20 }), false);
  assert.equal(context.fundPlanIsDue_({ startMonth: '2026-11' }, 5, { year: 2026, month: 11, day: 4 }), false);
  assert.equal(context.fundPlanIsDue_({ startMonth: '2026-11' }, 5, { year: 2026, month: 11, day: 5 }), true);
});

test('fund-paid shares follow split ratio and give the remainder to the last member', () => {
  const { context } = makeContext();
  const shares = context.fundPlanShares_(1001, ['a', 'b'], { a: 60, b: 40 });
  assert.deepEqual(JSON.parse(JSON.stringify(shares)), [
    { memberId: 'a', amountTWD: 601 },
    { memberId: 'b', amountTWD: 400 },
  ]);
  const equal = context.fundPlanShares_(1000, ['a', 'b'], {});
  assert.equal(equal[0].amountTWD + equal[1].amountTWD, 1000);
});

test('creates due fixed expense with deterministic id and skips existing ones', () => {
  const now = new Date('2026-11-10T17:30:00Z'); // 台北 11/11 01:30
  const household = {
    _name: 'projects/p/databases/(default)/documents/households/hh1',
    ownerId: 'owner',
    memberIds: ['owner', 'partner'],
    splitRatio: { owner: 50, partner: 50 },
    fundPlan: {
      enabled: true,
      dayOfMonth: 5,
      startMonth: '2026-11',
      autoRecord: false,
      contributions: { owner: 10000, partner: 10000 },
      fixedExpenses: [
        { id: 'rent', name: '房租', amountTWD: 18000, categoryKey: 'housing', dayOfMonth: 1, enabled: true },
        { id: 'net', name: '網路', amountTWD: 999, categoryKey: 'utilities', dayOfMonth: 25, enabled: true },
        { id: 'old', name: '停用', amountTWD: 500, categoryKey: 'other', dayOfMonth: 1, enabled: false },
      ],
    },
  };
  const { context, writes, added } = makeContext({
    fsListDocs_: () => [household],
  });
  const RealDate = Date;
  context.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  };
  const result = context.runHouseholdFundPlans();
  assert.equal(result.expenses, 1);
  assert.equal(result.contributions, 0, 'autoRecord off → no automatic deposits');
  assert.equal(added.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].relPath, 'transactions/fundplan_hh1_rent_202611');
  const tx = writes[0].data;
  assert.equal(tx.paidByUid, '__household_fund__');
  assert.equal(tx.householdId, 'hh1');
  assert.equal(tx.userId, 'owner');
  assert.equal(tx.myShareTWD, 0);
  assert.equal(tx.amountTWD, 18000);
  assert.equal(tx.date.toISOString(), '2026-11-01T04:00:00.000Z');
});

test('auto-record deposits each member once per month', () => {
  const now = new Date('2026-11-10T17:30:00Z');
  const household = {
    _name: 'projects/p/databases/(default)/documents/households/hh1',
    ownerId: 'owner',
    memberIds: ['owner', 'partner'],
    splitRatio: {},
    fundPlanRuns: { 'c:partner': '2026-11' },
    fundPlan: {
      enabled: true, dayOfMonth: 5, startMonth: '2026-10', autoRecord: true,
      contributions: { owner: 10000, partner: 8000 }, fixedExpenses: [],
    },
  };
  const { context, writes, added } = makeContext({ fsListDocs_: () => [household] });
  const RealDate = Date;
  context.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  };
  const result = context.runHouseholdFundPlans();
  // partner 這個月已處理過（可能被手動刪掉），不再補；owner 補一筆
  assert.equal(result.contributions, 1);
  assert.equal(added[0].collectionPath, 'households/hh1/fund_entries');
  assert.equal(added[0].data.contributorUid, 'owner');
  assert.equal(added[0].data.createdBy, 'owner');
  assert.equal(added[0].data.planMonth, '2026-11');
  assert.equal(added[0].data.amountTWD, 10000);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].data.fundPlanRuns)), { 'c:partner': '2026-11', 'c:owner': '2026-11' });
});
