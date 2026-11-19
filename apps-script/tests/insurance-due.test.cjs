// F9 保單提醒 / 淨值口徑：GAS（Notifications.gs insuranceDueItems_、NetWorth.gs insuranceCashValueTWD_）
// 與前端（features/accounts/insurance.ts insuranceReminders、insuranceCashValueTWD）必須給出相同結果。
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
    alias: { '@': WEB_SRC } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const web = loadTs(path.join(WEB_SRC, 'features/accounts/insurance.ts'));

function makeContext(overrides = {}) {
  const sent = [];
  const context = vm.createContext({
    console, Date, JSON, Math, Number, String, Array, Object, Error, isFinite, isNaN,
    Utilities: {
      // GAS 的專案時區是 Asia/Taipei；測試主機可能是 UTC，所以手動 +8 小時
      formatDate: (date, _tz, pattern) => {
        const twd = new Date(date.getTime() + 8 * 3600 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        if (pattern === 'yyyy') return String(twd.getUTCFullYear());
        if (pattern === 'M') return String(twd.getUTCMonth() + 1);
        if (pattern === 'd') return String(twd.getUTCDate());
        if (pattern === 'MM/dd') return `${pad(twd.getUTCMonth() + 1)}/${pad(twd.getUTCDate())}`;
        throw new Error(`unexpected pattern ${pattern}`);
      },
    },
    sendNotification_: (key, message) => { sent.push({ key, message }); return { ok: true }; },
    ...overrides,
  });
  for (const file of ['Notifications.gs', 'NetWorth.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context, { filename: file });
  }
  // runInContext 會用檔案裡的定義覆蓋同名 stub，測試要攔截送出就重新指定
  if (overrides.sendNotification_ === undefined) context.sendNotification_ = (key, message) => { sent.push({ key, message }); return { ok: true }; };
  return { context, sent };
}

const tw = (s) => new Date(`${s}T00:00:00+08:00`);
// Firestore REST 轉出來的日期在 GAS 是 Date / ISO 字串都有可能
const iso = (s) => tw(s).toISOString();

function fixtureAccounts() {
  const base = { type: 'insurance', active: true, archivedAt: null };
  return [
    { ...base, id: 'a', name: '壽險', insurance: { insurer: '國泰', premiumTWD: 3000, premiumFrequency: 'annual', nextPremiumDate: tw('2026-11-23') } },
    { ...base, id: 'b', name: '醫療', insurance: { insurer: '富邦', premiumTWD: 1000, premiumFrequency: 'monthly', nextPremiumDate: tw('2026-11-24') } },
    { ...base, id: 'c', name: '逾期', insurance: { insurer: '', premiumTWD: 500, premiumFrequency: 'monthly', nextPremiumDate: tw('2026-11-01') } },
    { ...base, id: 'd', name: '滿期', insurance: { insurer: '南山', premiumTWD: 0, premiumFrequency: 'annual', nextPremiumDate: tw('2026-11-10'), maturityDate: tw('2026-12-09') } },
    { ...base, id: 'e', name: '滿期太遠', insurance: { premiumTWD: 0, premiumFrequency: 'annual', nextPremiumDate: tw('2027-11-10'), maturityDate: tw('2026-12-10') } },
    { ...base, id: 'f', name: '已滿期', insurance: { premiumTWD: 0, premiumFrequency: 'annual', nextPremiumDate: tw('2027-11-10'), maturityDate: tw('2026-11-08') } },
    { ...base, id: 'g', name: '停用', active: false, insurance: { premiumTWD: 100, premiumFrequency: 'monthly', nextPremiumDate: tw('2026-11-09') } },
    { ...base, id: 'h', name: '封存', archivedAt: tw('2026-10-01'), insurance: { premiumTWD: 100, premiumFrequency: 'monthly', nextPremiumDate: tw('2026-11-09') } },
    { ...base, id: 'j', name: '今天', insurance: { premiumTWD: 800, premiumFrequency: 'quarterly', nextPremiumDate: tw('2026-11-09') } },
    { id: 'i', name: '銀行', type: 'bank', active: true },
  ];
}

test('insuranceDueItems_ 與前端 insuranceReminders 同規則（保費 14 天 / 逾期、滿期 0–30 天）', () => {
  const { context } = makeContext();
  const now = new Date('2026-11-09T03:00:00Z'); // 台北 11:00
  const accounts = fixtureAccounts();
  // vm context 的陣列是另一個 realm，deepEqual 前先轉成本 realm 的字串陣列
  const gasRows = JSON.parse(JSON.stringify(context.insuranceDueItems_(accounts, context.startOfDayTW_(now))
    .map((r) => `${r.name}:${r.kind}:${r.days}`)));
  const webRows = web.insuranceReminders(accounts, now)
    .map((r) => `${r.accountName}:${r.kind}:${r.days}`);
  assert.deepEqual(gasRows, ['逾期:premium:-8', '今天:premium:0', '壽險:premium:14', '滿期:maturity:30']);
  assert.deepEqual(webRows, gasRows);
});

test('insuranceDueItems_ 接受 ISO 字串日期（Firestore REST 轉出來的格式）', () => {
  const { context } = makeContext();
  const accounts = [{ id: 'x', name: '字串', type: 'insurance', insurance: { premiumTWD: 100, nextPremiumDate: iso('2026-11-12'), maturityDate: 'not-a-date' } }];
  const rows = context.insuranceDueItems_(accounts, context.startOfDayTW_(new Date('2026-11-09T03:00:00Z')));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].days, 3);
});

test('notifyInsuranceDue: 有事件才推播、key = insuranceDue；沒有就 skipped', () => {
  // notifyInsuranceDue 用真正的現在時間，fixture 相對於現在建立
  const soon = new Date(Date.now() + 3 * 86400000);
  const { context, sent } = makeContext({
    fsListAllDocs_: () => [
      { id: 'p', name: '壽險', type: 'insurance', insurance: { insurer: '國泰', premiumTWD: 12000, nextPremiumDate: soon } },
      { id: 'q', name: '遠期', type: 'insurance', insurance: { premiumTWD: 1, nextPremiumDate: new Date(Date.now() + 60 * 86400000) } },
    ],
  });
  const result = context.notifyInsuranceDue();
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, 'insuranceDue');
  assert.match(sent[0].message, /保單提醒/);
  assert.match(sent[0].message, /壽險（國泰） NT\$12,000 — 3 天後/);
  assert.doesNotMatch(sent[0].message, /遠期/);

  const empty = makeContext({ fsListAllDocs_: () => [] });
  assert.deepEqual(JSON.parse(JSON.stringify(empty.context.notifyInsuranceDue())), { ok: true, skipped: true });
  assert.equal(empty.sent.length, 0);

  const broken = makeContext({ console: { ...console, warn: () => {} }, fsListAllDocs_: () => { throw new Error('boom'); } });
  assert.deepEqual(JSON.parse(JSON.stringify(broken.context.notifyInsuranceDue())), { ok: true, skipped: true });
});

test('淨值口徑 parity：保單只計 cashValueTWD', () => {
  const { context } = makeContext();
  const cases = [
    { type: 'insurance', insurance: { cashValueTWD: 250000 } },
    { type: 'insurance', insurance: { premiumTWD: 30000 } },
    { type: 'insurance', insurance: { cashValueTWD: -1 } },
    { type: 'insurance' },
    { type: 'bank', insurance: { cashValueTWD: 999 } },
  ];
  for (const account of cases) {
    assert.equal(context.insuranceCashValueTWD_(account), web.insuranceCashValueTWD(account), JSON.stringify(account));
  }
  assert.equal(context.insuranceCashValueTWD_(cases[0]), 250000);
});

test('isRetirementPlan_：旗標優先、舊資料退回名稱比對（與前端 retirement.ts 同規則）', () => {
  const { context } = makeContext();
  assert.equal(context.isRetirementPlan_({ name: '買房', isRetirement: true }), true);
  assert.equal(context.isRetirementPlan_({ name: '退休金', isRetirement: false }), false);
  assert.equal(context.isRetirementPlan_({ name: '退休準備金' }), true);
  assert.equal(context.isRetirementPlan_({ name: '教育基金' }), false);
});
