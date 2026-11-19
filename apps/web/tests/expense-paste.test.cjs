const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const esbuild = require('esbuild');

globalThis.crypto ||= webcrypto;
const entry = path.resolve(__dirname, '../src/features/ledger/paste-transfer-format.ts');
const bundled = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = new Module(entry, module);
loaded.filename = entry;
loaded.paths = module.paths;
loaded._compile(bundled, entry);
const { parsePasteTransfer, verifyTransferItem, importedTransactionId, sha256Hex } = loaded.exports;

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    alias: { '@': path.resolve(__dirname, '../src') } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

async function sampleItem() {
  const content = {
    sourceId: 'chiauming-100:trip-1:expense-1', date: '2026-07-10', note: '火車票', amount: 320,
    currency: 'TWD', categoryHint: 'transport', paidByHint: 'ming',
    splitHint: { participants: ['ming', 'chiau'], shares: [] },
    target: { kind: 'trip', sourceTripKey: 'trip-1', nameHint: '北海岸' },
  };
  const stable = { ...content, target: { kind: 'trip', sourceTripKey: 'trip-1' } };
  return { ...content, sourceHash: await sha256Hex(JSON.stringify(stable)) };
}

test('accepts the portable batch and keeps a stable transaction ID', async () => {
  const item = await sampleItem();
  assert.equal(item.sourceHash, '9af9efcfa53e1dffc5d5c72e554db2bcd29b5c54e97cc185820a97cb5fcb4e3d');
  const parsed = parsePasteTransfer(JSON.stringify({ format: 'chiauming-expenses', version: 1, batchId: 'batch-1', items: [item] }));
  await verifyTransferItem(parsed.items[0]);
  const id = await importedTransactionId(item.sourceId);
  assert.match(id, /^cm100_[0-9a-f]{40}$/);
  assert.equal(id, await importedTransactionId(item.sourceId));
});

test('rejects tampered data, invalid date, duplicate IDs and unknown fields', async () => {
  const item = await sampleItem();
  await assert.rejects(() => verifyTransferItem({ ...item, amount: 321 }), /摘要不符/);
  const batch = { format: 'chiauming-expenses', version: 1, batchId: 'batch-1', items: [item] };
  assert.throws(() => parsePasteTransfer(JSON.stringify({ ...batch, items: [item, item] })), /重複/);
  assert.throws(() => parsePasteTransfer(JSON.stringify({ ...batch, items: [{ ...item, date: '2026-02-30' }] })), /日期/);
  assert.throws(() => parsePasteTransfer(JSON.stringify({ ...batch, items: [{ ...item, accountId: 'forged' }] })), /格式/);
});

test('counts trip plus household expense once and leaves its debt to household settlement', () => {
  const { computeSettlement } = loadTs(path.resolve(__dirname, '../src/features/trips/settlement.ts'));
  const members = [{ uid: 'rex', name: 'Owner' }, { uid: 'chiau', name: '巧' }];
  const tx = { id: 'one', type: 'expense', amountTWD: 320, date: new Date(), category: 'transport',
    payerId: 'rex', shareType: 'custom', householdId: 'household-1',
    customShares: [{ memberId: 'rex', amountTWD: 160 }, { memberId: 'chiau', amountTWD: 160 }] };
  const householdOnly = computeSettlement(members, [tx]);
  assert.equal(householdOnly.totalSpent, 320);
  assert.deepEqual(householdOnly.transfers, []);
  const tripOnly = computeSettlement(members, [{ ...tx, householdId: null, shareType: 'equal' }]);
  assert.equal(tripOnly.totalSpent, 320);
  assert.equal(tripOnly.transfers.length, 1);
  assert.equal(tripOnly.transfers[0].amount, 160);
});

test('import plan: auto mapping and per-row decisions follow the source split', async () => {
  const plan = loadTs(path.resolve(__dirname, '../src/features/ledger/paste-import-plan.ts'));
  const categories = [{ key: 'food', name: '餐飲' }, { key: 'trip_food', name: '旅遊餐飲' }, { key: 'trip_hotel', name: '住宿' }];
  assert.equal(plan.autoCategoryKey('food', 'trip', categories), 'trip_food');
  assert.equal(plan.autoCategoryKey('food', 'general', categories), 'food');
  assert.equal(plan.autoCategoryKey('stay', 'general', categories), 'trip_hotel');
  assert.equal(plan.autoCategoryKey('shopping', 'general', categories), '');

  const trips = [{ id: 't1', name: '北海岸 ', members: [{ uid: 'rex', name: 'Owner' }, { name: '巧' }] }, { id: 't2', name: '東京' }];
  assert.equal(plan.autoTripId('北海岸', trips), 't1');
  assert.equal(plan.autoTripId('大阪', trips), '');
  assert.deepEqual(plan.autoMemberMap(trips[0], 'rex'), { ming: 'rex', chiau: '巧' });

  assert.deepEqual(plan.sourceShares({ amount: 301, paidByHint: 'chiau', splitHint: { participants: ['ming', 'chiau'], shares: [] } }), { ming: 150, chiau: 151 });
  assert.deepEqual(plan.sourceShares({ amount: 300, paidByHint: 'ming', splitHint: { participants: ['ming', 'chiau'], shares: [{ personId: 'ming', amount: 100 }, { personId: 'chiau', amount: 200 }] } }), { ming: 100, chiau: 200 });
  assert.throws(() => plan.sourceShares({ amount: 300, paidByHint: 'ming', splitHint: { participants: ['ming'], shares: [{ personId: 'ming', amount: 1 }] } }));

  const item = await sampleItem();
  const household = { id: 'h1', memberIds: ['rex', 'partner'] };
  const account = { id: 'acc', name: '玉山', legacyPaymentMethod: null };
  const base = { uid: 'rex', targetKind: 'trip', account, categoryKey: 'trip_food', trip: trips[0], memberMap: { ming: 'rex', chiau: '巧' }, household, date: new Date('2026-07-09T16:00:00Z') };

  const mineHousehold = plan.planRow(item, { ...base, mode: 'household' });
  assert.equal(mineHousehold.ok, true);
  assert.equal(mineHousehold.input.fromAccountId, 'acc');
  assert.equal(mineHousehold.input.paidByUid, 'rex');
  assert.equal(mineHousehold.input.tripId, 't1');
  assert.deepEqual(mineHousehold.input.customShares, [{ memberId: 'rex', amountTWD: 160 }, { memberId: 'partner', amountTWD: 160 }]);
  assert.equal(mineHousehold.chargedTWD, 320);

  const partnerRow = { ...item, paidByHint: 'chiau' };
  const partnerHousehold = plan.planRow(partnerRow, { ...base, mode: 'household', account: null });
  assert.equal(partnerHousehold.ok, true);
  assert.equal(partnerHousehold.input.fromAccountId, null);
  assert.equal(partnerHousehold.input.paidByUid, 'partner');
  assert.equal(partnerHousehold.chargedTWD, 0);
  assert.equal(partnerHousehold.myShareTWD, 160);

  assert.equal(plan.planRow(item, { ...base, mode: 'loan', counterpartyName: '巧', account: null }).ok, false);
  assert.equal(plan.planRow(item, { ...base, mode: 'loan', counterpartyName: '巧', trip: null }).ok, false);
  assert.equal(plan.planRow(item, { ...base, mode: 'household', categoryKey: '' }).ok, false);
});

test('import plan: 代墊 mode imports both payers and only counts my share', async () => {
  const plan = loadTs(path.resolve(__dirname, '../src/features/ledger/paste-import-plan.ts'));
  const item = await sampleItem();
  const account = { id: 'acc', name: '玉山', legacyPaymentMethod: null };
  const trip = { id: 't1', name: '北海岸', members: [] };
  const base = { uid: 'rex', mode: 'loan', targetKind: 'trip', account, categoryKey: 'trip_food', trip, memberMap: { ming: '', chiau: '' }, household: null, counterpartyName: '巧', date: new Date('2026-07-09T16:00:00Z') };

  assert.equal(plan.defaultImportMode(false), 'loan');
  assert.equal(plan.defaultImportMode(true), 'household');
  // 只剩會把分攤費用減半的方式；舊的「全部算我的」「旅程成員分攤」會記全額，已移除。
  assert.deepEqual(plan.availableModes(false), ['loan']);
  assert.deepEqual(plan.availableModes(true), ['household', 'loan']);

  const mine = plan.planRow(item, base);
  assert.equal(mine.ok, true);
  assert.equal(mine.input.splitMode, 'i-paid-others');
  assert.equal(mine.input.myShareTWD, 160);
  assert.equal(mine.input.fromAccountId, 'acc');
  assert.equal(mine.input.counterpartyName, '巧');
  assert.equal(mine.input.shareType, 'payer');
  assert.equal(mine.chargedTWD, 320);

  // 巧先付：不扣帳戶、我欠巧我那份，但我那份仍算進我的支出。
  const theirs = plan.planRow({ ...item, paidByHint: 'chiau' }, { ...base, account: null });
  assert.equal(theirs.ok, true);
  assert.equal(theirs.input.splitMode, 'they-paid-mine');
  assert.equal(theirs.input.fromAccountId, null);
  assert.equal(theirs.input.myShareTWD, 160);
  assert.equal(theirs.myShareTWD, 160);
  assert.equal(theirs.chargedTWD, 0);

  const onlyHers = plan.planRow({ ...item, paidByHint: 'chiau', splitHint: { participants: ['chiau'], shares: [] } }, base);
  assert.equal(onlyHers.ok, false);
  assert.equal(onlyHers.skipped, true);

  const onlyMine = plan.planRow({ ...item, splitHint: { participants: ['ming'], shares: [] } }, base);
  assert.equal(onlyMine.input.splitMode, undefined);
  assert.equal(onlyMine.myShareTWD, 320);

  assert.equal(plan.planRow(item, { ...base, counterpartyName: ' ' }).ok, false);
  // 不歸屬旅程：旅程支出也能匯，tripId = null。
  const noTrip = plan.planRow(item, { ...base, trip: null, noTrip: true });
  assert.equal(noTrip.ok, true);
  assert.equal(noTrip.input.tripId, null);
  assert.equal(plan.planRow(item, { ...base, trip: null }).ok, false);
  // 奇數金額：巧先付時零頭歸付款人，我記一半取整。
  const odd = plan.planRow({ ...item, amount: 301, paidByHint: 'chiau' }, { ...base, account: null });
  assert.equal(odd.myShareTWD, 150);
  assert.equal(odd.input.myShareTWD, 150);
  assert.deepEqual(plan.dateRangeOf([{ date: '2026-07-12' }, { date: '2026-07-10' }]), { start: '2026-07-10', end: '2026-07-12' });
});

test('accepts a batch spanning several source trips', async () => {
  const a = await sampleItem();
  const contentB = { ...a, sourceId: 'chiauming-100:trip-2:expense-2', target: { kind: 'trip', sourceTripKey: 'trip-2', nameHint: '東京' } };
  delete contentB.sourceHash;
  const b = { ...contentB, sourceHash: await sha256Hex(JSON.stringify({ ...contentB, target: { kind: 'trip', sourceTripKey: 'trip-2' } })) };
  const parsed = parsePasteTransfer(JSON.stringify({ format: 'chiauming-expenses', version: 1, batchId: 'b', items: [a, b] }));
  assert.equal(parsed.items.length, 2);
  for (const item of parsed.items) await verifyTransferItem(item);
});

test('imported shared rows count half in RMoney spending, whoever paid first', async () => {
  const plan = loadTs(path.resolve(__dirname, '../src/features/ledger/paste-import-plan.ts'));
  const { myExpenseShareTWD, personalShareTWD, loanDeltaTWD } = loadTs(path.resolve(__dirname, '../src/features/ledger/types.ts'));
  const item = await sampleItem();
  const ctx = { uid: 'rex', mode: 'loan', targetKind: 'trip', account: { id: 'acc', name: '玉山' }, categoryKey: 'trip_food',
    trip: { id: 't1', name: '北海岸', members: [] }, memberMap: { ming: '', chiau: '' }, household: null, counterpartyName: '巧', date: new Date() };
  const asTx = (input) => ({ ...input, id: 'x', createdAt: new Date(), updatedAt: new Date(), deletedAt: null });

  const mine = asTx(plan.planRow(item, ctx).input);
  assert.equal(personalShareTWD(mine), 160);
  assert.equal(myExpenseShareTWD(mine, 'rex', []), 160);
  assert.equal(loanDeltaTWD(mine), 160); // 巧欠我一半

  const hers = asTx(plan.planRow({ ...item, paidByHint: 'chiau' }, { ...ctx, account: null }).input);
  assert.equal(personalShareTWD(hers), 160);
  assert.equal(myExpenseShareTWD(hers, 'rex', []), 160);
  assert.equal(loanDeltaTWD(hers), -160); // 我欠巧一半
});
