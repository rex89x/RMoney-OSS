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

const ctx = loadTs(path.resolve(__dirname, '../src/features/ledger/split-context.ts'));
const editor = loadTs(path.resolve(__dirname, '../src/features/ledger/components/split-editor.tsx'));

const members = [
  { id: 'rex', name: 'Owner', household: true },
  { id: 'partner', name: '伴侶', household: true },
  { id: 'A', name: 'A' },
];

test('equal split in JPY keeps whole yen and converts each share to TWD', () => {
  const shares = editor.computeSplit({
    members, amount: 10000, currency: 'JPY', fxRate: 0.21,
    state: { payerId: 'rex', mode: 'equal', custom: {} },
  });
  assert.deepEqual(Object.values(shares).map((s) => s.amount), [3333, 3333, 3334]);
  assert.equal(Object.values(shares).reduce((s, v) => s + v.amount, 0), 10000);
  assert.equal(shares.rex.amountTWD, Math.round(3333 * 0.21));
});

test('custom shares are entered in the original currency and mismatch is detected in that currency', () => {
  const input = {
    members, amount: 90.5, currency: 'USD', fxRate: 32,
    state: { payerId: 'A', mode: 'custom', custom: { rex: '30', partner: '30.5', A: '30' } },
  };
  assert.equal(editor.splitMismatch(input), false);
  const shares = editor.computeSplit(input);
  assert.equal(shares.partner.amountTWD, Math.round(30.5 * 32));
  assert.equal(editor.splitMismatch({ ...input, state: { ...input.state, custom: { rex: '30', partner: '30', A: '30' } } }), true);
  const txShares = editor.toTxShares(shares, 'USD', ['rex', 'partner', 'A']);
  assert.deepEqual(txShares[1], { memberId: 'partner', amountTWD: 976, amount: 30.5 });
  // 台幣交易不帶 amount
  const twd = editor.toTxShares(editor.computeSplit({ ...input, currency: 'TWD', fxRate: 1, amount: 90 }), 'TWD', ['rex']);
  assert.equal('amount' in twd[0], false);
});

test('fund payer yields zero shares and ratio mode falls back to equal without ratios', () => {
  const fund = editor.computeSplit({
    members: members.slice(0, 2), amount: 1000, currency: 'TWD', fxRate: 1,
    state: { payerId: '__household_fund__', mode: 'ratio', custom: {} },
  });
  assert.deepEqual(Object.values(fund).map((s) => s.amountTWD), [0, 0]);
  const ratio = editor.computeSplit({
    members: members.slice(0, 2), amount: 1000, currency: 'TWD', fxRate: 1,
    state: { payerId: 'rex', mode: 'ratio', custom: {} }, ratio: { rex: 70, partner: 30 },
  });
  assert.deepEqual([ratio.rex.amountTWD, ratio.partner.amountTWD], [700, 300]);
  const noRatio = editor.computeSplit({
    members: members.slice(0, 2), amount: 1001, currency: 'TWD', fxRate: 1,
    state: { payerId: 'rex', mode: 'ratio', custom: {} },
  });
  assert.deepEqual([noRatio.rex.amountTWD, noRatio.partner.amountTWD], [501, 500]);
});

test('customFromTxShares restores original-currency inputs, converting legacy TWD-only shares', () => {
  const custom = editor.customFromTxShares(
    [{ memberId: 'rex', amountTWD: 640, amount: 20 }, { memberId: 'partner', amountTWD: 320 }],
    'USD', 32, ['rex', 'partner', 'A'],
  );
  assert.deepEqual(custom, { rex: '20', partner: '10', A: '' });
});

test('buildSplitContext unions trip members with household members and flags them', () => {
  const household = { id: 'h1', memberIds: ['rex', 'partner'], members: { rex: { displayName: 'Owner' }, partner: { displayName: '伴侶' } }, splitRatio: { rex: 50, partner: 50 } };
  const trip = { id: 't1', members: [{ uid: 'rex', name: 'Owner' }, { name: 'A' }] };
  const both = ctx.buildSplitContext({ trip, household, includeHousehold: true, fallback: { id: 'rex', name: 'Owner' } });
  assert.deepEqual(both.members.map((m) => [m.id, Boolean(m.household)]), [['rex', true], ['A', false], ['partner', true]]);
  assert.equal(both.allowFund, false, 'no fund payer when a trip is involved');
  assert.equal(both.showRatio, false, 'ratio only when every member is a household member');
  const hhOnly = ctx.buildSplitContext({ trip: null, household, includeHousehold: true, fallback: { id: 'rex', name: 'Owner' } });
  assert.equal(hhOnly.allowFund, true);
  assert.equal(hhOnly.showRatio, true);
  assert.deepEqual(hhOnly.ratio, { rex: 50, partner: 50 });
  assert.deepEqual(ctx.missingHouseholdTripMembers(trip, household).map((m) => m.uid), ['partner']);
});

test('splitPatch writes creator share into myShareTWD and both payer fields when household + trip', () => {
  const input = {
    members, amount: 3000, currency: 'TWD', fxRate: 1,
    state: { payerId: 'rex', mode: 'equal', custom: {} },
  };
  const both = ctx.splitPatch({ creatorUid: 'rex', input, isHousehold: true, isTrip: true });
  assert.equal(both.payerId, 'rex');
  assert.equal(both.paidByUid, 'rex');
  assert.equal(both.shareType, 'custom');
  assert.equal(both.myShareTWD, 1000);
  assert.equal(both.customShares.length, 3);
  const tripOnly = ctx.splitPatch({ creatorUid: 'rex', input, isHousehold: false, isTrip: true });
  assert.equal(tripOnly.paidByUid, null);
  assert.equal(tripOnly.shareType, 'equal');
  // 建立者不在成員名單（夥伴改別人的旅程支出）→ 建立者那份 0
  const other = ctx.splitPatch({ creatorUid: 'ghost', input, isHousehold: false, isTrip: true });
  assert.equal(other.myShareTWD, null);
  const payerOnly = ctx.splitPatch({ creatorUid: 'partner', input: { ...input, state: { ...input.state, mode: 'payer' } }, isHousehold: true, isTrip: false });
  assert.equal(payerOnly.myShareTWD, 0, 'payer mode: non-payer creator bears nothing');
});

test('reconcileSplitState keeps user edits and only fixes an invalid payer', () => {
  const prev = { payerId: 'A', mode: 'custom', custom: { rex: '1', partner: '2', A: '3' } };
  assert.equal(ctx.reconcileSplitState(prev, ['rex', 'partner', 'A'], 'rex', 'equal'), prev);
  const next = ctx.reconcileSplitState(prev, ['rex', 'partner'], 'rex', 'equal');
  assert.deepEqual(next, { payerId: 'rex', mode: 'custom', custom: { rex: '1', partner: '2' } });
  assert.equal(ctx.reconcileSplitState({ payerId: '', mode: 'equal', custom: {} }, ['rex'], 'rex', 'ratio').mode, 'ratio');
});

// ---- 共同帳本記帳方式（2026-11）：預設公基金、各付一半、代墊 ----
const FUND = '__household_fund__';
const pair = [{ id: 'rex', name: 'Owner', household: true }, { id: 'partner', name: '伴侶', household: true }];

test('others mode: payer only advances, the other member bears the full amount', () => {
  const shares = editor.computeSplit({ members: pair, amount: 1200, currency: 'TWD', fxRate: 1, state: { payerId: 'rex', mode: 'others', custom: {} } });
  assert.equal(shares.rex.amountTWD, 0);
  assert.equal(shares.partner.amountTWD, 1200);
});

test('presetOfSplit maps state to the household recording presets', () => {
  assert.equal(editor.presetOfSplit({ payerId: FUND, mode: 'ratio', custom: {} }), 'fund');
  assert.equal(editor.presetOfSplit({ payerId: 'rex', mode: 'equal', custom: {} }), 'half');
  assert.equal(editor.presetOfSplit({ payerId: 'rex', mode: 'others', custom: {} }), 'advance');
  assert.equal(editor.presetOfSplit({ payerId: 'rex', mode: 'custom', custom: {} }), 'advanced');
});

test('splitPatch stores others as custom shares with the creator share', () => {
  const patch = ctx.splitPatch({
    creatorUid: 'rex',
    input: { members: pair, amount: 900, currency: 'TWD', fxRate: 1, state: { payerId: 'rex', mode: 'others', custom: {} } },
    isHousehold: true,
    isTrip: false,
  });
  assert.equal(patch.shareType, 'custom');
  assert.equal(patch.paidByUid, 'rex');
  assert.equal(patch.myShareTWD, 0);
  assert.deepEqual(patch.customShares.map((s) => s.amountTWD), [0, 900]);
});

test('initialSplitState restores half / advance presets from saved shares', () => {
  const base = { id: 't', userId: 'rex', type: 'expense', amount: 1000, currency: 'TWD', amountTWD: 1000, fxRate: 1, householdId: 'h1', paidByUid: 'rex' };
  const half = ctx.initialSplitState({ ...base, customShares: [{ memberId: 'rex', amountTWD: 500 }, { memberId: 'partner', amountTWD: 500 }] }, pair, 'TWD', 1);
  assert.equal(half.mode, 'equal');
  const advance = ctx.initialSplitState({ ...base, customShares: [{ memberId: 'rex', amountTWD: 0 }, { memberId: 'partner', amountTWD: 1000 }] }, pair, 'TWD', 1);
  assert.equal(advance.mode, 'others');
  const odd = ctx.initialSplitState({ ...base, customShares: [{ memberId: 'rex', amountTWD: 300 }, { memberId: 'partner', amountTWD: 700 }] }, pair, 'TWD', 1);
  assert.equal(odd.mode, 'custom');
});

test('reconcileSplitState defaults to the fund but drops it when the context cannot use it', () => {
  const ids = ['rex', 'partner'];
  const fresh = ctx.reconcileSplitState({ payerId: '', mode: 'ratio', custom: {} }, ids, FUND, 'ratio', true);
  assert.equal(fresh.payerId, FUND);
  const inTrip = ctx.reconcileSplitState({ payerId: FUND, mode: 'ratio', custom: {} }, ids, 'rex', 'ratio', false);
  assert.equal(inTrip.payerId, 'rex');
});
