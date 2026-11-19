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
const settlement = loadTs(path.resolve(__dirname, '../src/features/trips/settlement.ts'));
const ledgerTypes = loadTs(path.resolve(__dirname, '../src/features/ledger/types.ts'));

const household = {
  id: 'h1', name: '我們家', ownerId: 'rex', memberIds: ['rex', 'partner'],
  members: { rex: { uid: 'rex', displayName: 'Owner' }, partner: { uid: 'partner', displayName: '伴侶' } },
  pendingInvites: [], splitRatio: { rex: 50, partner: 50 }, createdAt: new Date(), updatedAt: new Date(),
};
const tripMembers = [
  { uid: 'rex', name: 'Owner' }, { uid: 'partner', name: '伴侶' }, { name: 'A' }, { name: 'B' },
];

function tx(over) {
  return {
    id: 't1', userId: 'rex', type: 'expense', amount: 4000, currency: 'TWD', amountTWD: 4000, fxRate: 1,
    category: 'food', paymentMethod: '現金', date: new Date('2026-10-01T04:00:00Z'),
    createdAt: new Date(), updatedAt: new Date(), tags: [], ...over,
  };
}

const fourWay = [
  { memberId: 'rex', amountTWD: 1000 }, { memberId: 'partner', amountTWD: 1000 },
  { memberId: 'A', amountTWD: 1000 }, { memberId: 'B', amountTWD: 1000 },
];

test('household balance only counts household members and the trip portion the payer fronted', () => {
  const t = tx({ tripId: 'trip1', householdId: 'h1', paidByUid: 'rex', payerId: 'rex', shareType: 'custom', customShares: fourWay, myShareTWD: 1000 });
  assert.deepEqual(balance.sharesOfTx(t, household.memberIds), { rex: 1000, partner: 1000 });
  assert.equal(balance.householdPortionTWD(t, household.memberIds), 2000);
  const balances = balance.computeBalances(household, [t], []);
  assert.equal(balances.rex.paidTWD, 2000);
  assert.equal(balances.rex.netTWD, 1000);
  assert.equal(balances.partner.netTWD, -1000);
  assert.equal(Object.keys(balances).length, 2, 'external trip members never show up in household balances');
  assert.equal(ledgerTypes.personalShareTWD(t), 1000);
});

test('trip settlement merges household members into the payer and keeps external debts', () => {
  const t = tx({ tripId: 'trip1', householdId: 'h1', paidByUid: 'rex', payerId: 'rex', shareType: 'custom', customShares: fourWay });
  const result = settlement.computeSettlement(tripMembers, [t], { householdMemberIds: household.memberIds });
  const net = Object.fromEntries(result.balances.map((b) => [b.id, b.net]));
  assert.equal(net.rex, 2000);
  assert.equal(net.partner, 0);
  assert.equal(net.A, -1000);
  assert.equal(net.B, -1000);
  assert.equal(result.totalSpent, 4000);
  // 舊呼叫端（沒給名單）維持「只算總額、不算欠款」
  const legacy = settlement.computeSettlement(tripMembers, [t]);
  assert.equal(legacy.balances.find((b) => b.id === 'rex').net, 0);
  assert.equal(legacy.totalSpent, 4000);
});

test('external payer: household owes nothing internally, trip settlement collects from the couple', () => {
  const t = tx({ tripId: 'trip1', householdId: 'h1', paidByUid: 'A', payerId: 'A', shareType: 'custom', customShares: fourWay, myShareTWD: 1000 });
  const balances = balance.computeBalances(household, [t], []);
  assert.equal(balances.rex.netTWD, 0);
  assert.equal(balances.partner.netTWD, 0);
  const result = settlement.computeSettlement(tripMembers, [t], { householdMemberIds: household.memberIds });
  const net = Object.fromEntries(result.balances.map((b) => [b.id, b.net]));
  assert.equal(net.A, 3000);
  assert.equal(net.rex, -1000, 'external payer: each household member settles their own share in the trip');
  assert.equal(net.partner, -1000);
  assert.equal(net.B, -1000);
});

test('plain household expense still counts in full and ignores foreign share ids', () => {
  const t = tx({ householdId: 'h1', paidByUid: 'partner', shareType: 'custom', customShares: [
    { memberId: 'rex', amountTWD: 2500 }, { memberId: 'partner', amountTWD: 1500 }, { memberId: 'ghost', amountTWD: 999 },
  ] });
  // 沒歸入旅程 → 整筆都算共同帳本；多出來的 ghost 份只會在 sharesOfTx 被忽略
  assert.equal(balance.householdPortionTWD(t, household.memberIds), 4000);
  const shares = balance.sharesOfTx(t, household.memberIds);
  assert.deepEqual(Object.keys(shares).sort(), ['partner', 'rex']);
  const balances = balance.computeBalances(household, [t], []);
  assert.equal(Object.keys(balances).length, 2);
  assert.equal(balances.partner.paidTWD, 4000);
  const summary = balance.summarizeHouseholdTxs([t], household.memberIds);
  assert.equal(summary.totalTWD, 4000);
});

test('summary counts only the household portion of trip expenses', () => {
  const t = tx({ tripId: 'trip1', householdId: 'h1', paidByUid: 'rex', shareType: 'custom', customShares: fourWay });
  assert.equal(balance.summarizeHouseholdTxs([t], household.memberIds).totalTWD, 2000);
  assert.equal(balance.summarizeHouseholdTxs([t]).totalTWD, 4000);
});

test('txPayerId and personalShareTWD prefer explicit split data', () => {
  assert.equal(ledgerTypes.txPayerId({ paidByUid: null, payerId: 'A', userId: 'rex' }), 'A');
  assert.equal(ledgerTypes.txPayerId({ paidByUid: 'partner', payerId: 'A', userId: 'rex' }), 'partner');
  assert.equal(ledgerTypes.personalShareTWD(tx({ tripId: 'trip1', myShareTWD: 250 })), 250);
  assert.equal(ledgerTypes.personalShareTWD(tx({ tripId: 'trip1', myShareTWD: null })), 4000);
  assert.equal(ledgerTypes.personalShareTWD(tx({ myShareTWD: 10 })), 4000, 'no split context → full amount');
});
