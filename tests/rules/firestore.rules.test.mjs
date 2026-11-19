// Firestore Security Rules 單元測試（firebase/firestore.rules）
// 需要 Firestore emulator：`npm run test:rules`（firebase emulators:exec 會啟動 emulator 再跑這支）。
// 不在 `npm test`（快速套件）裡，避免本機沒有 Java / emulator 時整包測試失敗。
import { after, before, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, setLogLevel, updateDoc } from 'firebase/firestore';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = 8085; // firebase.json emulators.firestore.port

/** @type {import('@firebase/rules-unit-testing').RulesTestEnvironment} */
let env;

const ADMIN = 'admin-uid';
const OWNER = 'owner-uid';
const MEMBER = 'member-uid'; // household 成員，canEditSettings = true
const MEMBER2 = 'member2-uid'; // household 成員，沒有 canEditSettings
const NEWBIE = 'newbie-uid'; // 剛用 Google 登入、還沒有 users/{uid}

const db = (uid) => env.authenticatedContext(uid, { email: `${uid}@example.com` }).firestore();
const anonDb = () => env.unauthenticatedContext().firestore();

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs_ = ctx.firestore();
    await setDoc(doc(fs_, 'users', ADMIN), { email: 'admin@example.com', role: 'admin' });
    await setDoc(doc(fs_, 'users', OWNER), { email: 'owner@example.com', role: 'owner' });
    await setDoc(doc(fs_, 'users', MEMBER), { email: 'member@example.com', role: 'member', displayName: 'M' });
    await setDoc(doc(fs_, 'users', MEMBER2), { email: 'member2@example.com', role: 'member' });

    await setDoc(doc(fs_, 'config', 'allowedEmails'), { emails: ['owner@example.com', 'member@example.com'] });
    await setDoc(doc(fs_, 'config', 'allowedEmailHashes'), { hashes: ['abc123'] });

    await setDoc(doc(fs_, 'households', 'hh1'), {
      name: '我們家',
      ownerId: OWNER,
      memberIds: [OWNER, MEMBER, MEMBER2],
      members: {
        [MEMBER]: { permissions: { canEditSettings: true } },
        [MEMBER2]: { permissions: { canEditSettings: false } },
      },
      inviteCode: 'ABC123',
      inviteCodeExpiresAt: null,
    });

    // owner 的私人旅程（沒分享）與分享給 MEMBER 的旅程
    await setDoc(doc(fs_, 'trips', 'trip-private'), { userId: OWNER, ownerId: OWNER, sharedWith: [], name: 'Private' });
    await setDoc(doc(fs_, 'trips', 'trip-shared'), { userId: OWNER, ownerId: OWNER, sharedWith: [MEMBER], name: 'Shared' });
  });
}

function txData(userId, extra = {}) {
  return {
    userId,
    type: 'expense',
    category: 'food',
    amount: 100,
    currency: 'TWD',
    amountTWD: 100,
    fxRate: 1,
    date: new Date('2026-11-09T04:00:00Z'),
    note: null,
    ...extra,
  };
}

before(async () => {
  // assertFails 會讓 SDK 對每個 PERMISSION_DENIED 印 warning，淹沒測試輸出
  setLogLevel('error');
  env = await initializeTestEnvironment({
    projectId: 'demo-rmoney',
    firestore: {
      rules: fs.readFileSync(path.join(ROOT, 'firebase/firestore.rules'), 'utf8'),
      host: EMULATOR_HOST,
      port: EMULATOR_PORT,
    },
  });
});

beforeEach(async () => {
  await env.clearFirestore();
  await seed();
});

after(async () => {
  await env?.cleanup();
});

describe('users/{uid} create（稽核 S1：不能自封 admin / owner）', () => {
  const allowed = { email: 'newbie@example.com', displayName: 'N', photoURL: null, preferences: { theme: 'auto' }, createdAt: new Date() };

  test('role admin → denied', async () => {
    await assertFails(setDoc(doc(db(NEWBIE), 'users', NEWBIE), { ...allowed, role: 'admin' }));
  });
  test('role owner → denied', async () => {
    await assertFails(setDoc(doc(db(NEWBIE), 'users', NEWBIE), { ...allowed, role: 'owner' }));
  });
  test('role member + only allowed keys → allowed', async () => {
    await assertSucceeds(setDoc(doc(db(NEWBIE), 'users', NEWBIE), { ...allowed, role: 'member' }));
  });
  test('role viewer → allowed', async () => {
    await assertSucceeds(setDoc(doc(db(NEWBIE), 'users', NEWBIE), { ...allowed, role: 'viewer' }));
  });
  test('extra key → denied', async () => {
    await assertFails(setDoc(doc(db(NEWBIE), 'users', NEWBIE), { ...allowed, role: 'member', isSuperUser: true }));
  });
  test('missing role → denied', async () => {
    await assertFails(setDoc(doc(db(NEWBIE), 'users', NEWBIE), { ...allowed }));
  });
  test('creating users/{other} → denied', async () => {
    await assertFails(setDoc(doc(db(NEWBIE), 'users', 'someone-else'), { ...allowed, role: 'member' }));
  });
  test('unauthenticated → denied', async () => {
    await assertFails(setDoc(doc(anonDb(), 'users', NEWBIE), { ...allowed, role: 'member' }));
  });
});

describe('users/{uid} update / read', () => {
  test('self cannot update own role', async () => {
    await assertFails(updateDoc(doc(db(MEMBER), 'users', MEMBER), { role: 'owner' }));
    await assertFails(updateDoc(doc(db(MEMBER), 'users', MEMBER), { role: 'admin' }));
  });
  test('self can update non-role fields', async () => {
    await assertSucceeds(updateDoc(doc(db(MEMBER), 'users', MEMBER), { displayName: 'New name' }));
  });
  test('admin can update another user role', async () => {
    await assertSucceeds(updateDoc(doc(db(ADMIN), 'users', MEMBER), { role: 'owner' }));
  });
  test('owner (non-admin) cannot update another user role', async () => {
    await assertFails(updateDoc(doc(db(OWNER), 'users', MEMBER), { role: 'owner' }));
  });
  test('cannot read another user doc; admin can', async () => {
    await assertFails(getDoc(doc(db(MEMBER), 'users', OWNER)));
    await assertSucceeds(getDoc(doc(db(MEMBER), 'users', MEMBER)));
    await assertSucceeds(getDoc(doc(db(ADMIN), 'users', OWNER)));
  });
});

describe('config/*（稽核 S3：明文白名單只給 admin）', () => {
  test('allowedEmails: non-admin read denied', async () => {
    await assertFails(getDoc(doc(db(MEMBER), 'config', 'allowedEmails')));
    await assertFails(getDoc(doc(db(OWNER), 'config', 'allowedEmails')));
    await assertFails(getDoc(doc(db(NEWBIE), 'config', 'allowedEmails')));
  });
  test('allowedEmails: admin read allowed', async () => {
    await assertSucceeds(getDoc(doc(db(ADMIN), 'config', 'allowedEmails')));
  });
  test('allowedEmailHashes: any signed-in read allowed（含尚無 users doc 的新登入者）', async () => {
    await assertSucceeds(getDoc(doc(db(MEMBER), 'config', 'allowedEmailHashes')));
    await assertSucceeds(getDoc(doc(db(NEWBIE), 'config', 'allowedEmailHashes')));
  });
  test('unauthenticated read denied', async () => {
    await assertFails(getDoc(doc(anonDb(), 'config', 'allowedEmailHashes')));
    await assertFails(getDoc(doc(anonDb(), 'config', 'allowedEmails')));
  });
  test('write by non-admin denied; admin allowed', async () => {
    await assertFails(setDoc(doc(db(OWNER), 'config', 'allowedEmails'), { emails: ['x@example.com'] }));
    await assertFails(setDoc(doc(db(MEMBER), 'config', 'allowedEmailHashes'), { hashes: ['x'] }));
    await assertSucceeds(setDoc(doc(db(ADMIN), 'config', 'allowedEmails'), { emails: ['x@example.com'] }));
  });
});

describe('households/{hid} update（稽核 S4：邀請碼只有 owner 能改）', () => {
  test('member with canEditSettings cannot change inviteCode', async () => {
    await assertFails(updateDoc(doc(db(MEMBER), 'households', 'hh1'), { inviteCode: 'HACKED' }));
    await assertFails(updateDoc(doc(db(MEMBER), 'households', 'hh1'), { inviteCodeExpiresAt: new Date('2030-01-01') }));
  });
  test('member with canEditSettings can change name', async () => {
    await assertSucceeds(updateDoc(doc(db(MEMBER), 'households', 'hh1'), { name: '新名字' }));
  });
  test('member without canEditSettings cannot change name', async () => {
    await assertFails(updateDoc(doc(db(MEMBER2), 'households', 'hh1'), { name: '新名字' }));
  });
  test('member cannot change memberIds or ownerId', async () => {
    await assertFails(updateDoc(doc(db(MEMBER), 'households', 'hh1'), { memberIds: [OWNER, MEMBER, MEMBER2, 'outsider'] }));
    await assertFails(updateDoc(doc(db(MEMBER), 'households', 'hh1'), { ownerId: MEMBER }));
  });
  test('household owner can change inviteCode', async () => {
    await assertSucceeds(updateDoc(doc(db(OWNER), 'households', 'hh1'), { inviteCode: 'NEW999' }));
  });
  test('non-member cannot read or update', async () => {
    await assertFails(getDoc(doc(db(NEWBIE), 'households', 'hh1')));
    await assertFails(updateDoc(doc(db(NEWBIE), 'households', 'hh1'), { name: 'x' }));
  });
});

describe('transactions create（稽核 S12：member 只能掛在看得到的 trip）', () => {
  test('member + tripId of a trip they cannot read → denied', async () => {
    await assertFails(setDoc(doc(db(MEMBER), 'transactions', 'tx-1'), txData(MEMBER, { tripId: 'trip-private' })));
  });
  test('member + tripId of a non-existent trip → denied', async () => {
    await assertFails(setDoc(doc(db(MEMBER), 'transactions', 'tx-1'), txData(MEMBER, { tripId: 'no-such-trip' })));
  });
  test('member + tripId of a trip shared with them → allowed', async () => {
    await assertSucceeds(setDoc(doc(db(MEMBER), 'transactions', 'tx-1'), txData(MEMBER, { tripId: 'trip-shared' })));
  });
  test('member personal tx without tripId → allowed', async () => {
    await assertSucceeds(setDoc(doc(db(MEMBER), 'transactions', 'tx-1'), txData(MEMBER)));
  });
  test('member cannot create a tx for someone else', async () => {
    await assertFails(setDoc(doc(db(MEMBER), 'transactions', 'tx-1'), txData(OWNER)));
  });
  test('owner + any tripId → allowed', async () => {
    await assertSucceeds(setDoc(doc(db(OWNER), 'transactions', 'tx-1'), txData(OWNER, { tripId: 'trip-private' })));
    await assertSucceeds(setDoc(doc(db(OWNER), 'transactions', 'tx-2'), txData(OWNER, { tripId: 'someone-elses-trip' })));
  });
  test('get on a not-yet-existing tx is allowed (createTransaction idempotency read)', async () => {
    await assertSucceeds(getDoc(doc(db(MEMBER), 'transactions', 'does-not-exist')));
  });
});

describe('trips/{tripId}/packing（F8 行李清單：旅伴只能勾選 / 指派）', () => {
  const item = (extra = {}) => ({
    name: '護照', category: 'documents', packed: false, quantity: 1, assignee: null, order: 1,
    createdAt: new Date(), updatedAt: new Date(), ...extra,
  });
  async function seedItem(tripId) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'trips', tripId, 'packing', 'p1'), item());
    });
  }

  test('owner can create / rename / delete', async () => {
    const ref = doc(db(OWNER), 'trips', 'trip-shared', 'packing', 'p-new');
    await assertSucceeds(setDoc(ref, item()));
    await assertSucceeds(updateDoc(ref, { name: '護照（正本）', quantity: 2, updatedAt: new Date() }));
    await assertSucceeds(deleteDoc(ref));
  });
  test('shared member can read and toggle packed / assignee', async () => {
    await seedItem('trip-shared');
    const ref = doc(db(MEMBER), 'trips', 'trip-shared', 'packing', 'p1');
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(updateDoc(ref, { packed: true, updatedAt: new Date() }));
    await assertSucceeds(updateDoc(ref, { assignee: MEMBER, updatedAt: new Date() }));
    await assertSucceeds(updateDoc(ref, { assignee: null, updatedAt: new Date() }));
  });
  test('shared member cannot rename, create or delete', async () => {
    await seedItem('trip-shared');
    const ref = doc(db(MEMBER), 'trips', 'trip-shared', 'packing', 'p1');
    await assertFails(updateDoc(ref, { name: '改名', updatedAt: new Date() }));
    await assertFails(updateDoc(ref, { packed: true, quantity: 5 }));
    await assertFails(updateDoc(ref, { packed: 'yes' }));
    await assertFails(setDoc(doc(db(MEMBER), 'trips', 'trip-shared', 'packing', 'p2'), item()));
    await assertFails(deleteDoc(ref));
  });
  test('outsider (not shared) is denied read and toggle', async () => {
    await seedItem('trip-private');
    const ref = doc(db(MEMBER), 'trips', 'trip-private', 'packing', 'p1');
    await assertFails(getDoc(ref));
    await assertFails(updateDoc(ref, { packed: true, updatedAt: new Date() }));
    await assertFails(setDoc(doc(db(MEMBER), 'trips', 'trip-private', 'packing', 'p2'), item()));
  });
  test('unauthenticated denied', async () => {
    await seedItem('trip-shared');
    await assertFails(getDoc(doc(anonDb(), 'trips', 'trip-shared', 'packing', 'p1')));
  });
});

describe('installment_plans（F2：owner-only）', () => {
  const plan = {
    ownerId: OWNER, title: '筆電', totalAmountTWD: 36000, periods: 12, perPeriodTWD: 3000, feeTWD: 0,
    cardAccountId: 'card-1', category: 'shopping', startDate: new Date('2026-11-09T04:00:00Z'),
    paidPeriods: 0, status: 'active',
  };
  test('owner can create / read / update', async () => {
    await assertSucceeds(setDoc(doc(db(OWNER), 'installment_plans', 'p1'), plan));
    await assertSucceeds(getDoc(doc(db(OWNER), 'installment_plans', 'p1')));
    await assertSucceeds(updateDoc(doc(db(OWNER), 'installment_plans', 'p1'), { status: 'cancelled' }));
  });
  test('household member cannot read or write', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'installment_plans', 'p1'), plan);
    });
    await assertFails(getDoc(doc(db(MEMBER), 'installment_plans', 'p1')));
    await assertFails(setDoc(doc(db(MEMBER), 'installment_plans', 'p2'), { ...plan, ownerId: MEMBER }));
    await assertFails(updateDoc(doc(db(MEMBER), 'installment_plans', 'p1'), { status: 'cancelled' }));
  });
});

describe('taifex_*（台指期虛擬交易：績效只能由 Apps Script 寫入）', () => {
  const GAS_ONLY = [
    'taifex_daily', 'taifex_signals', 'taifex_sentiment', 'taifex_paper_accounts',
    'taifex_paper_trades', 'taifex_backtests', 'taifex_live', 'taifex_optimizations', 'taifex_reviews', 'taifex_tuning',
  ];
  test('owner can read but not write any GAS-only collection', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const admin = ctx.firestore();
      for (const col of GAS_ONLY) await setDoc(doc(admin, col, 'x'), { equity: 1 });
    });
    // 同一個 test 裡重複呼叫 authenticatedContext().firestore() 會重設已啟動的 instance → 建一次重用
    const owner = db(OWNER);
    for (const col of GAS_ONLY) {
      await assertSucceeds(getDoc(doc(owner, col, 'x')));
      await assertFails(setDoc(doc(owner, col, 'y'), { equity: 999999 }));
      await assertFails(updateDoc(doc(owner, col, 'x'), { equity: 999999 }));
      await assertFails(deleteDoc(doc(owner, col, 'x')));
    }
  });
  test('household member cannot read taifex data', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'taifex_paper_accounts', 'default'), { equity: 1 });
    });
    await assertFails(getDoc(doc(db(MEMBER), 'taifex_paper_accounts', 'default')));
    await assertFails(getDoc(doc(db(MEMBER), 'taifex_live', 'current')));
  });
  test('owner can read / write taifex_configs; member cannot', async () => {
    await assertSucceeds(setDoc(doc(db(OWNER), 'taifex_configs', 'default'), { mode: 'auto', strategyVariant: 'baseline' }));
    await assertSucceeds(getDoc(doc(db(OWNER), 'taifex_configs', 'default')));
    await assertFails(setDoc(doc(db(MEMBER), 'taifex_configs', 'default'), { mode: 'manual' }));
  });
});

describe('default deny', () => {
  test('unknown collection: read / write denied even for admin', async () => {
    await assertFails(getDoc(doc(db(ADMIN), 'unknown_collection', 'x')));
    await assertFails(setDoc(doc(db(ADMIN), 'unknown_collection', 'x'), { a: 1 }));
    await assertFails(setDoc(doc(db(MEMBER), 'unknown_collection', 'x'), { a: 1 }));
    await assertFails(getDoc(doc(anonDb(), 'unknown_collection', 'x')));
  });
});
