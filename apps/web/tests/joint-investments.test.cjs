const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
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

const calc = loadTs(path.resolve(__dirname, '../src/features/joint-investments/calc.ts'));

// Apps Script 端同一套計算（HouseholdInvest.gs），確保兩邊結果一致
const gsSource = fs.readFileSync(path.resolve(__dirname, '../../../apps-script/src/HouseholdInvest.gs'), 'utf8');
const gs = vm.createContext({ console, Date, Math, Number, String, Array, Object, JSON });
vm.runInContext(gsSource, gs);

const d = (s) => new Date(`${s}T00:00:00+08:00`);

test('summarizeLots uses average cost and books realized P&L on sells', () => {
  const lots = [
    { side: 'buy', date: d('2026-01-02'), shares: 1000, price: 100, fee: 100 },
    { side: 'buy', date: d('2026-02-02'), shares: 1000, price: 120, fee: 100 },
    { side: 'sell', date: d('2026-03-02'), shares: 500, price: 150, fee: 50 },
  ];
  const s = calc.summarizeLots(lots);
  // 成本 220200 / 2000 股 = 110.1；賣 500 股：75000 - 50 - 55050 = 19900
  assert.equal(s.shares, 1500);
  assert.ok(Math.abs(s.avgCost - 110.1) < 1e-9);
  assert.ok(Math.abs(s.realizedNative - 19900) < 1e-6);
  assert.ok(Math.abs(s.costNative - 165150) < 1e-6);

  const g = gs.hhSummarizeLots_(lots);
  assert.equal(g.shares, s.shares);
  assert.ok(Math.abs(g.costNative - s.costNative) < 1e-6);
  assert.ok(Math.abs(g.realizedNative - s.realizedNative) < 1e-6);
});

test('summarizeLots ignores overselling and sorts by date', () => {
  const s = calc.summarizeLots([
    { side: 'sell', date: d('2026-03-01'), shares: 10, price: 50, fee: 0 },
    { side: 'buy', date: d('2026-01-01'), shares: 5, price: 40, fee: 0 },
  ]);
  assert.equal(s.shares, 0);
  assert.equal(s.costNative, 0);
  assert.equal(s.realizedNative, 50);
});

test('holdingAttribution splits joint by jointShares, falls back to splitRatio', () => {
  const members = ['rex', 'partner'];
  assert.deepEqual(calc.holdingAttribution({ bucket: 'personal', ownerUid: 'partner', jointShares: null }, members, {}), { partner: 1 });
  assert.deepEqual(calc.holdingAttribution({ bucket: 'joint', ownerUid: null, jointShares: null }, members, { rex: 60, partner: 40 }), { rex: 0.6, partner: 0.4 });
  assert.deepEqual(calc.holdingAttribution({ bucket: 'joint', ownerUid: null, jointShares: { rex: 1, partner: 3 } }, members, { rex: 60, partner: 40 }), { rex: 0.25, partner: 0.75 });
  assert.deepEqual(calc.holdingAttribution({ bucket: 'joint', ownerUid: null, jointShares: null }, members, {}), { rex: 0.5, partner: 0.5 });
});

test('valuePortfolio converts USD, attributes to members, and falls back to cost when price missing', () => {
  const holdings = [
    { id: 'a', symbol: '0050', name: '0050', market: 'TW', currency: 'TWD', bucket: 'joint', ownerUid: null, jointShares: null,
      lots: [{ side: 'buy', date: d('2026-01-01'), shares: 100, price: 150, fee: 0 }] },
    { id: 'b', symbol: 'VOO', name: 'VOO', market: 'US', currency: 'USD', bucket: 'personal', ownerUid: 'partner', jointShares: null,
      lots: [{ side: 'buy', date: d('2026-01-01'), shares: 2, price: 500, fee: 0 }] },
    { id: 'c', symbol: '2330', name: '2330', market: 'TW', currency: 'TWD', bucket: 'personal', ownerUid: 'rex', jointShares: null,
      lots: [{ side: 'buy', date: d('2026-01-01'), shares: 10, price: 1000, fee: 0 }] },
  ];
  const quotes = {
    '0050': { price: 200, change: 2, changePercent: 1, updatedAt: null },
    VOO: { price: 550, change: -5, changePercent: -1, updatedAt: null },
  };
  const v = calc.valuePortfolio(holdings, quotes, { TWD: 1, USD: 30 }, ['rex', 'partner'], { rex: 50, partner: 50 });
  assert.equal(v.valueTWD, 20000 + 33000 + 10000);
  assert.equal(v.costTWD, 15000 + 30000 + 10000);
  assert.equal(v.unrealizedTWD, 5000 + 3000 + 0);
  assert.equal(v.dayChangeTWD, 200 - 300);
  assert.deepEqual(v.missing, ['2330']);
  assert.equal(v.byBucket.joint.valueTWD, 20000);
  assert.equal(v.byMember.rex.valueTWD, 10000 + 10000);
  assert.equal(v.byMember.partner.valueTWD, 10000 + 33000);

  // Apps Script 同一份資料（用 stub 的 Firestore）結果要一樣
  gs.fsGetDoc_ = (p) => {
    if (p === 'stocks/0050') return { currentPrice: 200, change: 2 };
    if (p === 'stocks/VOO') return { currentPrice: 550, change: -5 };
    if (p === 'fx_rates/USD_TWD') return { rate: 30 };
    return null;
  };
  gs.round2_ = (n) => Math.round(n * 100) / 100;
  const g = gs.hhValueHoldings_({ memberIds: ['rex', 'partner'], splitRatio: { rex: 50, partner: 50 } }, holdings);
  assert.equal(g.totalValueTWD, v.valueTWD);
  assert.equal(g.unrealizedTWD, v.unrealizedTWD);
  assert.equal(g.byMember.partner.valueTWD, v.byMember.partner.valueTWD);
  assert.equal(g.byBucket.joint.valueTWD, v.byBucket.joint.valueTWD);
});

test('projection helpers are consistent', () => {
  const pts = calc.projectGrowth(0, 10000, 0, 12);
  assert.equal(pts.length, 13);
  assert.equal(pts[12].projectedTWD, 120000);
  const need = calc.requiredMonthly(100000, 1000000, 6, 60);
  const check = calc.projectGrowth(100000, need, 6, 60);
  assert.ok(Math.abs(check[60].projectedTWD - 1000000) < 1);
  assert.equal(calc.monthsToTarget(0, 10000, 0, 120000), 12);
  assert.equal(calc.monthsToTarget(200, 0, 0, 100), 0);
  assert.equal(calc.monthsToTarget(0, 0, 0, 100), null);
});

test('normalizeJointSymbol accepts TW ETFs and US tickers', () => {
  assert.deepEqual(calc.normalizeJointSymbol(' 00878 '), { ok: true, symbol: '00878', market: 'TW', currency: 'TWD' });
  assert.deepEqual(calc.normalizeJointSymbol('00679b'), { ok: true, symbol: '00679B', market: 'TW', currency: 'TWD' });
  assert.deepEqual(calc.normalizeJointSymbol('2330.TW'), { ok: true, symbol: '2330', market: 'TW', currency: 'TWD' });
  assert.deepEqual(calc.normalizeJointSymbol('voo'), { ok: true, symbol: 'VOO', market: 'US', currency: 'USD' });
  assert.equal(calc.normalizeJointSymbol('12').ok, false);
  assert.equal(calc.normalizeJointSymbol('').ok, false);
});
