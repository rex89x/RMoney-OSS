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

const balance = loadTs(path.resolve(__dirname, '../src/features/household/balance.ts'));
const entries = loadTs(path.resolve(__dirname, '../src/features/household/entries.ts'));
const analytics = loadTs(path.resolve(__dirname, '../src/features/household/analytics.ts'));
const ctx = loadTs(path.resolve(__dirname, '../src/features/ledger/split-context.ts'));
const FUND = '__household_fund__';
const pair = [{ id: 'rex', name: 'Owner', household: true }, { id: 'partner', name: '伴侶', household: true }];

const household = {
  id: 'h1', name: '我們家', ownerId: 'rex', memberIds: ['rex', 'partner'],
  members: { rex: { uid: 'rex', displayName: 'Owner' }, partner: { uid: 'partner', displayName: '伴侶' } },
  pendingInvites: [], splitRatio: { rex: 50, partner: 50 }, createdAt: new Date(), updatedAt: new Date(),
};

function tx(over) {
  return {
    id: over.id ?? 't', userId: 'rex', type: 'expense', amount: 1000, currency: 'TWD', amountTWD: 1000, fxRate: 1,
    category: 'food', paymentMethod: '公基金', householdId: 'h1', paidByUid: FUND, customShares: [],
    date: new Date('2026-11-05T04:00:00Z'), createdAt: new Date(), updatedAt: new Date(), tags: [], ...over,
  };
}
function entry(over) {
  return { id: over.id ?? 'e', type: 'contribution', amountTWD: 10000, contributorUid: 'rex', note: null,
    date: new Date('2026-11-01T04:00:00Z'), createdBy: over.contributorUid ?? 'rex', createdAt: new Date(), ...over };
}

test('fronted fund expenses become what the fund owes; reimbursements settle it without moving the book balance', () => {
  const fundEntries = [
    entry({ id: 'c1', amountTWD: 10000, contributorUid: 'rex' }),
    entry({ id: 'c2', amountTWD: 10000, contributorUid: 'partner' }),
    entry({ id: 'r1', type: 'reimbursement', amountTWD: 1500, contributorUid: 'partner', createdBy: 'rex' }),
  ];
  const txs = [
    tx({ id: 'a', amountTWD: 3000, fundAdvancedBy: 'partner' }),
    tx({ id: 'b', amountTWD: 2000 }), // 公基金直接付
    tx({ id: 'c', amountTWD: 500, fundAdvancedBy: 'rex' }),
    tx({ id: 'd', amountTWD: 9999, fundAdvancedBy: 'partner', deletedAt: new Date() }),
  ];
  const fund = balance.summarizeHouseholdFund(fundEntries, txs);
  assert.equal(fund.contributionsTWD, 20000, 'reimbursement is not a contribution');
  assert.equal(fund.expensesTWD, 5500);
  assert.equal(fund.balanceTWD, 14500, 'book balance ignores the reimbursement');
  assert.deepEqual(fund.owedToMember, { partner: 1500, rex: 500 });
  assert.equal(fund.outstandingTWD, 2000);
  assert.equal(fund.cashTWD, 16500, 'cash = book + still-owed advances');
  assert.deepEqual(fund.byContributor, { rex: 10000, partner: 10000 });
});

test('over-reimbursing shows as negative owed and lowers cash', () => {
  const fund = balance.summarizeHouseholdFund(
    [entry({ amountTWD: 5000 }), entry({ id: 'r', type: 'reimbursement', amountTWD: 1200, contributorUid: 'partner' })],
    [tx({ amountTWD: 1000, fundAdvancedBy: 'partner' })],
  );
  assert.equal(fund.owedToMember.partner, -200);
  assert.equal(fund.outstandingTWD, 0);
  assert.equal(fund.cashTWD, 3800);
});

test('timeline lists reimbursements as their own kind, fund → member', () => {
  const rows = entries.buildHouseholdEntries({
    household, myUid: 'rex', txs: [], settlements: [],
    fundEntries: [entry({ id: 'c' }), entry({ id: 'r', type: 'reimbursement', amountTWD: 800, contributorUid: 'partner' })],
  });
  const reimb = rows.find((r) => r.kind === 'reimbursement');
  assert.equal(reimb.fromUid, FUND);
  assert.equal(reimb.toUid, 'partner');
  assert.equal(rows.filter((r) => r.kind === 'contribution').length, 1);
});

test('fund month rows and paid-vs-share ignore reimbursements', () => {
  const month = { key: '2026-11', label: '26/11', start: new Date('2026-10-31T16:00:00Z'), end: new Date('2026-11-30T15:59:59Z') };
  const fundEntries = [entry({ amountTWD: 5000 }), entry({ id: 'r', type: 'reimbursement', amountTWD: 1000, contributorUid: 'partner' })];
  const txs = [tx({ amountTWD: 1000, fundAdvancedBy: 'partner' })];
  const [row] = analytics.buildFundMonthRows(fundEntries, txs, [month]);
  assert.equal(row.contributedTWD, 5000);
  assert.equal(row.balanceTWD, 4000);
  const paid = analytics.buildPaidVsShare(txs, fundEntries, ['rex', 'partner'], month.start, month.end);
  assert.equal(paid.find((p) => p.uid === 'partner').contributedTWD, 0);
});

test('splitPatch keeps fundAdvancedBy only for fund-paid expenses with a valid member', () => {
  const base = { members: pair, amount: 1000, currency: 'TWD', fxRate: 1 };
  const fund = ctx.splitPatch({ creatorUid: 'rex', isHousehold: true, isTrip: false,
    input: { ...base, state: { payerId: FUND, mode: 'ratio', custom: {}, fundAdvancedBy: 'partner' } } });
  assert.equal(fund.fundAdvancedBy, 'partner');
  assert.equal(fund.paidByUid, FUND);
  assert.equal(fund.myShareTWD, 0);
  const direct = ctx.splitPatch({ creatorUid: 'rex', isHousehold: true, isTrip: false,
    input: { ...base, state: { payerId: FUND, mode: 'ratio', custom: {}, fundAdvancedBy: '' } } });
  assert.equal(direct.fundAdvancedBy, null);
  const half = ctx.splitPatch({ creatorUid: 'rex', isHousehold: true, isTrip: false,
    input: { ...base, state: { payerId: 'rex', mode: 'equal', custom: {}, fundAdvancedBy: 'partner' } } });
  assert.equal(half.fundAdvancedBy, null, 'switching away from the fund clears the advancer');
  const restored = ctx.initialSplitState(tx({ fundAdvancedBy: 'partner' }), pair, 'TWD', 1);
  assert.equal(restored.fundAdvancedBy, 'partner');
});

const types = loadTs(path.resolve(__dirname, '../src/features/household/types.ts'));

test('canManageFund defaults on for members and can be turned off by the owner', () => {
  assert.equal(types.memberCan(household, 'partner', 'canManageFund'), true);
  const restricted = { ...household, members: { ...household.members, partner: { uid: 'partner', displayName: '伴侶', permissions: { canManageFund: false } } } };
  assert.equal(types.memberCan(restricted, 'partner', 'canManageFund'), false);
  assert.equal(types.memberCan(restricted, 'rex', 'canManageFund'), true, 'owner is always allowed');
});

test('fundKeeperUid is read only when it points at a member', () => {
  const snap = (data) => ({ id: 'h1', data: () => data });
  const base = { name: '我們家', ownerId: 'rex', memberIds: ['rex', 'partner'], members: {} };
  assert.equal(types.householdConverter.fromFirestore(snap({ ...base, fundKeeperUid: 'partner' })).fundKeeperUid, 'partner');
  assert.equal(types.householdConverter.fromFirestore(snap({ ...base, fundKeeperUid: 'stranger' })).fundKeeperUid, null);
  assert.equal(types.householdConverter.fromFirestore(snap(base)).fundKeeperUid, null);
});

test('a reimbursement mis-recorded as a contribution inflates the fund; converting it fixes the balance', () => {
  // 伴侶先墊 270 的早餐（公基金負擔），之後公基金把 270 轉給她
  const expense = tx({ id: 'breakfast', amount: 270, amountTWD: 270, fundAdvancedBy: null });
  const seed = entry({ id: 'seed', amountTWD: 10000, contributorUid: 'rex' });
  const wrong = balance.summarizeHouseholdFund([seed, entry({ id: 'oops', amountTWD: 270, contributorUid: 'partner' })], [expense]);
  assert.equal(wrong.balanceTWD, 10000, 'recorded as a deposit the refund cancels the expense out');
  assert.equal(wrong.cashTWD, 10000);

  // 改成撥還 + 把那筆支出標成伴侶先墊
  const fixed = balance.summarizeHouseholdFund(
    [seed, entry({ id: 'r', type: 'reimbursement', amountTWD: 270, contributorUid: 'partner' })],
    [{ ...expense, fundAdvancedBy: 'partner' }],
  );
  assert.equal(fixed.balanceTWD, 9730, 'the fund paid for breakfast');
  assert.equal(fixed.cashTWD, 9730, 'and the cash really left the fund account');
  assert.equal(fixed.owedToMember.partner, 0);
  assert.equal(fixed.outstandingTWD, 0);
  assert.equal(fixed.byContributor.partner, undefined, 'a refund is not counted as her deposit');
});

test('reimbursement candidates are recent fund-borne expenses without an advancer', () => {
  const day = (d) => new Date(`2026-11-${String(d).padStart(2, '0')}T04:00:00Z`);
  const txs = [
    tx({ id: 'a', amountTWD: 1000, date: day(1) }),
    tx({ id: 'b', amountTWD: 418, date: day(3) }),
    tx({ id: 'c', amountTWD: 130, date: day(4) }),
    tx({ id: 'advanced', amountTWD: 500, date: day(2), fundAdvancedBy: 'rex' }),
    tx({ id: 'personal', amountTWD: 270, date: day(2), paidByUid: 'partner' }),
    tx({ id: 'deleted', amountTWD: 270, date: day(2), deletedAt: day(3) }),
    tx({ id: 'later', amountTWD: 270, date: day(20) }),
  ];
  const list = balance.reimbursementCandidateTxs(txs, day(4));
  assert.deepEqual(list.map((t) => t.id), ['c', 'b', 'a']);
  assert.deepEqual(balance.findExactExpenseMatch(list, 1418).sort(), ['a', 'b']);
  assert.deepEqual(balance.findExactExpenseMatch(list, 130), ['c']);
  assert.deepEqual(balance.findExactExpenseMatch(list, 999), []);
  assert.deepEqual(balance.findExactExpenseMatch(list, 0), []);
});
