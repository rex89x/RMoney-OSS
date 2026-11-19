// 「消費支出 / 實際收入」口徑 parity（CLAUDE.md pitfall #26）：
// 前端 apps/web/src/features/analytics/metrics.ts 的 isConsumptionExpense / isEarnedIncome
// 必須與 GAS apps-script/src/Notifications.gs 的 isConsumptionExpense_ / isEarnedIncome_ 對每一筆交易給出相同結果。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const WEB_SRC = path.resolve(__dirname, '../../apps/web/src');

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react-dom', 'lucide-react'],
    alias: { '@': WEB_SRC } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const web = loadTs(path.join(WEB_SRC, 'features/analytics/metrics.ts'));

// Notifications.gs 的 top-level 只有 var 常數與 function 宣告，載入不會產生副作用；
// 其他 GAS 全域只在函式被呼叫時才會用到，這裡只呼叫兩個純函式。
const gasSource = fs.readFileSync(path.join(__dirname, '../src/Notifications.gs'), 'utf8');
const gas = vm.createContext({ console, Date, JSON, Math, Number, String, Array, Object, Error });
vm.runInContext(gasSource, gas, { filename: 'Notifications.gs' });

const d = new Date('2026-10-10T04:00:00Z');
function tx(overrides) {
  return { type: 'expense', category: 'food', amountTWD: 100, date: d, ...overrides };
}

// 每一列都要讓兩邊每個分支（deletedAt / type / 排除類別清單）至少走一次
const CASES = [
  // --- 一般支出 ---
  ['normal expense', tx({}), { consumption: true, earned: false }],
  ['expense without category', tx({ category: undefined }), { consumption: true, earned: false }],
  ['expense with empty category', tx({ category: '' }), { consumption: true, earned: false }],
  ['trip expense (tripId only filters, not extra source)', tx({ category: 'transport', tripId: 'trip1' }), { consumption: true, earned: false }],
  ['split household expense (myShare)', tx({ householdId: 'hh1', myShareTWD: 50, shareType: 'equal' }), { consumption: true, earned: false }],
  ['household fund-paid expense', tx({ householdId: 'hh1', paidByUid: '__household_fund__' }), { consumption: true, earned: false }],
  ['recurring subscription expense', tx({ category: 'subscription', recurringId: 'r1' }), { consumption: true, earned: false }],
  ['loan repayment expense', tx({ category: 'loan_repayment' }), { consumption: true, earned: false }],
  ['investment expense category', tx({ category: 'invest' }), { consumption: true, earned: false }],
  // --- 排除的支出類別 ---
  ['adjustment', tx({ category: 'adjustment' }), { consumption: false, earned: false }],
  ['rental purchase', tx({ category: 'rental_purchase' }), { consumption: false, earned: false }],
  ['household settlement', tx({ category: 'household_settlement', householdId: 'hh1' }), { consumption: false, earned: false }],
  // income 類別掛在 expense 上：仍是消費（只看 expense 清單）
  ['expense tagged adjustment_income', tx({ category: 'adjustment_income' }), { consumption: true, earned: false }],
  ['expense tagged household_settlement_income', tx({ category: 'household_settlement_income' }), { consumption: true, earned: false }],
  // --- 軟刪除 ---
  ['soft-deleted expense (Date)', tx({ deletedAt: d }), { consumption: false, earned: false }],
  ['soft-deleted expense (Firestore timestamp-ish object)', tx({ deletedAt: { seconds: 1, nanoseconds: 0 } }), { consumption: false, earned: false }],
  ['soft-deleted expense (ISO string from REST)', tx({ deletedAt: '2026-10-10T00:00:00Z' }), { consumption: false, earned: false }],
  ['deletedAt null', tx({ deletedAt: null }), { consumption: true, earned: false }],
  // --- 轉帳 ---
  ['transfer', tx({ type: 'transfer', category: 'transfer' }), { consumption: false, earned: false }],
  ['transfer with food category', tx({ type: 'transfer' }), { consumption: false, earned: false }],
  ['transfer adjustment', tx({ type: 'transfer', category: 'adjustment' }), { consumption: false, earned: false }],
  // --- 收入 ---
  ['salary income', tx({ type: 'income', category: 'salary' }), { consumption: false, earned: true }],
  ['invest return income', tx({ type: 'income', category: 'invest_return' }), { consumption: false, earned: true }],
  ['rental income', tx({ type: 'income', category: 'rental_income' }), { consumption: false, earned: true }],
  ['reimbursement income', tx({ type: 'income', category: 'reimbursement' }), { consumption: false, earned: true }],
  ['household fund reimbursement income', tx({ type: 'income', category: 'reimbursement', householdId: 'hh1' }), { consumption: false, earned: true }],
  ['loan received income', tx({ type: 'income', category: 'loan' }), { consumption: false, earned: true }],
  ['income without category', tx({ type: 'income', category: undefined }), { consumption: false, earned: true }],
  ['adjustment_income', tx({ type: 'income', category: 'adjustment_income' }), { consumption: false, earned: false }],
  ['household settlement income', tx({ type: 'income', category: 'household_settlement_income' }), { consumption: false, earned: false }],
  // expense 類別掛在 income 上：仍是實際收入（只看 income 清單）
  ['income tagged adjustment', tx({ type: 'income', category: 'adjustment' }), { consumption: false, earned: true }],
  ['income tagged rental_purchase', tx({ type: 'income', category: 'rental_purchase' }), { consumption: false, earned: true }],
  ['soft-deleted income', tx({ type: 'income', category: 'salary', deletedAt: d }), { consumption: false, earned: false }],
  // --- 異常資料 ---
  ['unknown type', tx({ type: 'refund' }), { consumption: false, earned: false }],
  ['type casing differs', tx({ type: 'Expense' }), { consumption: false, earned: false }],
  ['missing type', tx({ type: undefined }), { consumption: false, earned: false }],
];

test('excluded category lists are identical', () => {
  assert.deepEqual([...gas.NON_CONSUMPTION_EXPENSE_CATEGORIES_], [...web.NON_CONSUMPTION_EXPENSE_CATEGORIES]);
  assert.deepEqual([...gas.NON_EARNED_INCOME_CATEGORIES_], [...web.NON_EARNED_INCOME_CATEGORIES]);
  assert.deepEqual([...gas.FORECAST_EXCLUDED_CATEGORIES_], [...web.NON_CONSUMPTION_EXPENSE_CATEGORIES]);
});

for (const [name, t, expected] of CASES) {
  test(`parity: ${name}`, () => {
    const actual = {
      web: { consumption: web.isConsumptionExpense(t), earned: web.isEarnedIncome(t) },
      gas: { consumption: gas.isConsumptionExpense_(t), earned: gas.isEarnedIncome_(t) },
    };
    assert.deepEqual(actual.web, expected, 'web');
    assert.deepEqual(actual.gas, expected, 'gas');
    // 一筆交易不可能同時是消費支出與實際收入
    assert.ok(!(expected.consumption && expected.earned));
  });
}

// 唯一的實作差異：GAS 版先做 `!!t`，所以 null / undefined 回 false；
// 前端版型別上不接受 null（TS 擋住），傳進去會 TypeError。不是口徑差異，只記錄現況。
test('null / undefined input: GAS returns false, web throws (typed non-null)', () => {
  for (const v of [null, undefined]) {
    assert.equal(gas.isConsumptionExpense_(v), false);
    assert.equal(gas.isEarnedIncome_(v), false);
    assert.throws(() => web.isConsumptionExpense(v), TypeError);
    assert.throws(() => web.isEarnedIncome(v), TypeError);
  }
});
