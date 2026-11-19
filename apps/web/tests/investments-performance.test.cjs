// features/investments/performance.ts — XIRR / TWR
// 本機驗證：node --test apps/web/tests/investments-performance.test.cjs
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

const perf = loadTs(path.resolve(__dirname, '../src/features/investments/performance.ts'));

/** 台北日期 → Date（台北午夜） */
const d = (s) => new Date(`${s}T00:00:00+08:00`);
const close = (actual, expected, eps, msg) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < eps, `${msg ?? ''} expected ${expected}, got ${actual}`);
};

test('xirr: -1000 → +1100 一年後 ≈ 10%', () => {
  const r = perf.xirr([
    { date: d('2025-01-01'), amount: -1000 },
    { date: d('2026-01-01'), amount: 1100 },
  ]);
  close(r, 0.1, 1e-9);
});

test('xirr: 多筆現金流（Excel XIRR 文件範例 = 0.373362535）', () => {
  const r = perf.xirr([
    { date: d('2008-01-01'), amount: -10000 },
    { date: d('2008-03-01'), amount: 2750 },
    { date: d('2008-10-30'), amount: 4250 },
    { date: d('2009-02-15'), amount: 3250 },
    { date: d('2009-04-01'), amount: 2750 },
  ]);
  close(r, 0.373362535, 1e-6);
});

test('xirr: 定期定額 + 期末市值，與試算表一致且順序無關', () => {
  // 每季投入 1000、一年後市值 4200（試算表 XIRR = 0.0804689，Python 二分法交叉驗證）
  const flows = [
    { date: d('2025-01-01'), amount: -1000 },
    { date: d('2025-04-01'), amount: -1000 },
    { date: d('2025-07-01'), amount: -1000 },
    { date: d('2025-10-01'), amount: -1000 },
    { date: d('2026-01-01'), amount: 4200 },
  ];
  const r = perf.xirr(flows);
  // 反向驗證：以 r 折現 NPV ≈ 0
  const t0 = flows[0].date.getTime();
  const npv = flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (f.date.getTime() - t0) / 86400000 / 365), 0);
  assert.ok(Math.abs(npv) < 1e-6, `npv ${npv}`);
  close(r, 0.0804689, 1e-6);
  assert.equal(perf.xirr([...flows].reverse()), r);
});

test('xirr: 虧損與極端情況', () => {
  close(perf.xirr([{ date: d('2025-01-01'), amount: -1000 }, { date: d('2026-01-01'), amount: 500 }]), -0.5, 1e-9);
  // 全部同號 → null
  assert.equal(perf.xirr([{ date: d('2025-01-01'), amount: -1000 }, { date: d('2025-06-01'), amount: -500 }]), null);
  assert.equal(perf.xirr([{ date: d('2025-01-01'), amount: 1000 }, { date: d('2025-06-01'), amount: 500 }]), null);
  // 不足 2 筆 / 同一天 → null
  assert.equal(perf.xirr([{ date: d('2025-01-01'), amount: -1000 }]), null);
  assert.equal(perf.xirr([{ date: d('2025-01-01'), amount: -1000 }, { date: d('2025-01-01'), amount: 1100 }]), null);
  // 很短期間仍可解（年化很大），不會 NaN
  const short = perf.xirr([{ date: d('2025-01-01'), amount: -1000 }, { date: d('2025-01-08'), amount: 1010 }]);
  assert.ok(Number.isFinite(short) && short > 0.5, `short ${short}`);
  // 幾乎虧光 → -99.9%；大賺 100 倍 → 9900%
  close(perf.xirr([{ date: d('2025-01-01'), amount: -1000 }, { date: d('2026-01-01'), amount: 1 }]), -0.999, 1e-9);
  close(perf.xirr([{ date: d('2025-01-01'), amount: -1000 }, { date: d('2026-01-01'), amount: 100000 }]), 99, 1e-6);
});

test('twr: 期中加碼不影響報酬（與沒加碼時相同）', () => {
  // 第一段 +10%（100 → 110）；07-02 投入 1000（歸屬第二段、視為期初），第二段 +10%（1110 → 1221）
  const withDeposit = perf.twr([
    { date: d('2025-01-01'), valueTWD: 100 },
    { date: d('2025-07-01'), valueTWD: 110 },
    { date: d('2026-01-01'), valueTWD: 1221 },
  ], [{ date: d('2025-07-02'), amountTWD: 1000 }]);
  close(withDeposit.periodReturn, 0.21, 1e-12, 'with deposit');
  // 沒有投入：100 → 110 → 121，同樣 21%
  const noDeposit = perf.twr([
    { date: d('2025-01-01'), valueTWD: 100 },
    { date: d('2025-07-01'), valueTWD: 110 },
    { date: d('2026-01-01'), valueTWD: 121 },
  ], []);
  close(noDeposit.periodReturn, 0.21, 1e-12, 'no deposit');
  // 不扣資金流（直接看市值 100 → 1221）會被扭曲成 1121%
  const naive = perf.twr([
    { date: d('2025-01-01'), valueTWD: 100 },
    { date: d('2026-01-01'), valueTWD: 1221 },
  ], []);
  close(naive.periodReturn, 11.21, 1e-9, 'naive');
  assert.equal(withDeposit.annualized, null, '剛好 365 天不年化');
  assert.equal(withDeposit.series.length, 3);
  close(withDeposit.series[1].index, 110, 1e-9);
  close(withDeposit.series[2].index, 121, 1e-9);
  // 期中投入時 XIRR 與 TWR 不同：同樣的資料，資金加權報酬反映「大筆錢只賺到下半年」
  const x = perf.xirr([
    { date: d('2025-01-01'), amount: -100 },
    { date: d('2025-07-02'), amount: -1000 },
    { date: d('2026-01-01'), amount: 1221 },
  ]);
  assert.ok(x !== null && x > 0.15 && x < 0.21, `xirr ${x}`);
});

test('twr: 首次買進（期初 0）與全部賣光（期末 0）不會除以 0', () => {
  const r = perf.twr([
    { date: d('2025-01-01'), valueTWD: 0 },
    { date: d('2025-01-02'), valueTWD: 1050 }, // 期初投入 1000，漲 5%
    { date: d('2025-01-03'), valueTWD: 0 },    // 全部賣出拿回 1102.5（再漲 5%）
  ], [
    { date: d('2025-01-02'), amountTWD: 1000 },
    { date: d('2025-01-03'), amountTWD: -1102.5 },
  ]);
  close(r.periodReturn, 0.1025, 1e-12);
});

test('twr: 超過一年才年化', () => {
  const r = perf.twr([
    { date: d('2024-01-01'), valueTWD: 100 },
    { date: d('2026-01-01'), valueTWD: 121 },
  ], []);
  close(r.periodReturn, 0.21, 1e-12);
  // 731 天（含 2024 閏年）
  close(r.annualized, Math.pow(1.21, 365 / 731) - 1, 1e-12);
  assert.equal(perf.twr([{ date: d('2025-01-01'), valueTWD: 100 }], []), null);
});

test('buildPortfolioFlows + computePortfolioPerformance: 快照差額推得買進 / 賣出 / 股息流量', () => {
  const at = (s, hh = '07:00') => new Date(`${s}T${hh}:00+08:00`);
  // Day1：持有 A 10 股 @ 成本 100（現價 100）
  // Day2：加碼 A 10 股 @ 110（含費成本 1100），現價 110 → 成本 avg 105 × 20
  // Day3：賣出 10 股 @ 121（實收 1210），現價 121；平均成本 105 → 已實現 160
  //       另收股息 50
  const snaps = [
    { date: '2025-03-01', createdAt: at('2025-03-01'), totalValueTWD: 1000, positions: [{ symbol: 'A', shares: 10, avgCost: 100, fxRate: 1 }] },
    { date: '2025-03-02', createdAt: at('2025-03-02'), totalValueTWD: 2200, positions: [{ symbol: 'A', shares: 20, avgCost: 105, fxRate: 1 }] },
    { date: '2025-03-03', createdAt: at('2025-03-03'), totalValueTWD: 1210, positions: [{ symbol: 'A', shares: 10, avgCost: 105, fxRate: 1 }] },
  ];
  const realized = [{ symbol: 'A', createdAt: at('2025-03-02', '10:00'), realizedPnlTWD: 160 }];
  const dividends = [{ payDate: d('2025-03-03'), amountTWD: 50 }];
  const series = perf.buildPortfolioFlows(snaps, realized, dividends);
  assert.deepEqual(series.keys, ['2025-03-01', '2025-03-02', '2025-03-03']);
  const amounts = series.flows.map((f) => Math.round(f.amountTWD * 100) / 100).sort((a, b) => a - b);
  assert.deepEqual(amounts, [-1210, -50, 1100]);

  const result = perf.computePortfolioPerformance(series, null);
  // TWR：第一段 2200 / (1000 + 1100) = 1.047619；第二段 (1210 + 1210 + 50) / 2200 = 1.122727
  close(result.twr.periodReturn, (2200 / 2100) * (2470 / 2200) - 1, 1e-9);
  assert.equal(result.baseKey, '2025-03-01');
  assert.equal(result.coverageShort, false);
  assert.ok(result.xirr !== null && result.xirr > 0);

  // 起點早於第一筆快照 → coverageShort
  const short = perf.computePortfolioPerformance(series, '2025-01-01');
  assert.equal(short.coverageShort, true);
  // 起點在中間 → 期初用 03-02
  const mid = perf.computePortfolioPerformance(series, '2025-03-02');
  assert.equal(mid.baseKey, '2025-03-02');
  close(mid.twr.periodReturn, 2470 / 2200 - 1, 1e-9);
});

// ---------------------------------------------------------------------------
// F7：FIFO / 平均成本（features/investments/cost-basis.ts）
// ---------------------------------------------------------------------------
const cb = loadTs(path.resolve(__dirname, '../src/features/investments/cost-basis.ts'));

/** 模擬 executePortfolioTrade 的持倉更新（買進：avgCost 含費；賣出：依 planSell 落帳） */
function buy(pos, date, shares, price, fee = 0) {
  const cashNative = shares * price + fee;
  const total = pos.shares + shares;
  const lot = { date: d(date), shares, price, ...(fee > 0 ? { fee } : {}) };
  return pos.shares > 0
    ? { ...pos, shares: total, avgCost: (pos.avgCost * pos.shares + cashNative) / total, lots: [...pos.lots, lot] }
    : { shares, avgCost: cashNative / shares, lots: [lot] };
}
function sell(pos, date, shares, price, method, { fee = 0, fxRate = 1 } = {}) {
  const cashTWD = (shares * price - fee) * fxRate;
  const plan = cb.planSell(pos, shares, method);
  const rows = cb.realizedRows(plan, shares, cashTWD, fxRate);
  const lot = { date: d(date), shares: -shares, price };
  const next = {
    ...pos,
    shares: plan.remainingShares,
    ...(plan.method === 'fifo' ? { avgCost: plan.remainingAvgCost } : {}),
    lots: [...pos.lots, lot],
  };
  return { pos: next, plan, rows };
}
const sumPnl = (rows) => rows.reduce((s, r) => s + r.realizedPnlTWD, 0);

test('FIFO vs 平均成本：3 買 2 賣', () => {
  let p = { shares: 0, avgCost: 0, lots: [] };
  p = buy(p, '2025-01-01', 100, 10);
  p = buy(p, '2025-02-01', 100, 12);
  p = buy(p, '2025-03-01', 100, 15);
  close(p.avgCost, 3700 / 300, 1e-12);

  // FIFO
  const f1 = sell(p, '2025-04-01', 150, 20, 'fifo');
  assert.equal(f1.plan.method, 'fifo');
  assert.equal(f1.plan.fallback, false);
  assert.deepEqual(f1.rows.map((r) => [r.shares, r.unitCost]), [[100, 10], [50, 12]]);
  close(sumPnl(f1.rows), 3000 - 1600, 1e-9);
  close(f1.pos.avgCost, 14, 1e-12, '剩 50@12 + 100@15');
  assert.equal(f1.rows[0].buyDate.getTime(), d('2025-01-01').getTime());
  // 各批 proceeds 加總剛好等於實收
  assert.equal(f1.rows.reduce((s, r) => s + r.proceedsTWD, 0), 3000);
  const f2 = sell(f1.pos, '2025-05-01', 100, 18, 'fifo');
  assert.deepEqual(f2.rows.map((r) => [r.shares, r.unitCost]), [[50, 12], [50, 15]]);
  close(sumPnl(f2.rows), 1800 - 1350, 1e-9);
  close(f2.pos.avgCost, 15, 1e-12);
  assert.equal(f2.pos.shares, 50);

  // 平均成本
  const a1 = sell(p, '2025-04-01', 150, 20, 'average');
  assert.equal(a1.plan.method, 'average');
  assert.equal(a1.rows.length, 1);
  assert.equal(a1.rows[0].buyDate, null);
  close(sumPnl(a1.rows), 3000 - 150 * (3700 / 300), 1e-9);
  assert.equal(a1.pos.avgCost, p.avgCost, '平均成本法賣出不改 avgCost');
  const a2 = sell(a1.pos, '2025-05-01', 100, 18, 'average');
  close(sumPnl(a2.rows), 1800 - 100 * (3700 / 300), 1e-9);

  // 成本守恆：總賣出款 − 總已實現 + 剩餘持倉成本 = 總投入成本 3700（兩法都成立）
  close(sumPnl(f1.rows) + sumPnl(f2.rows), 1850, 1e-9);
  close(sumPnl(a1.rows) + sumPnl(a2.rows), 1716.6666666667, 1e-6);
  close(4800 - 1850 + f2.pos.avgCost * 50, 3700, 1e-9);
  close(4800 - (sumPnl(a1.rows) + sumPnl(a2.rows)) + a2.pos.avgCost * 50, 3700, 1e-9);
});

test('平均成本路徑與舊版 executePortfolioTrade 輸出逐位元相同', () => {
  // 舊版：costTWD = avgCost × shares × fxRate；proceedsTWD = cashTWD；realized = cashTWD − costTWD
  const cases = [
    { avgCost: 123.456789, shares: 37, price: 150.1, fee: 7.3, fxRate: 32.1234 },
    { avgCost: 3700 / 300, shares: 150, price: 20, fee: 0, fxRate: 1 },
    { avgCost: 0.1 + 0.2, shares: 3, price: 0.7, fee: 0.01, fxRate: 30.5 },
  ];
  for (const c of cases) {
    const pos = { shares: 1000, avgCost: c.avgCost, lots: [] };
    const cashTWD = (c.shares * c.price - c.fee) * c.fxRate;
    const legacyCost = c.avgCost * c.shares * c.fxRate;
    const plan = cb.planSell(pos, c.shares, 'average');
    const rows = cb.realizedRows(plan, c.shares, cashTWD, c.fxRate);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].unitCost, c.avgCost);
    assert.equal(rows[0].costTWD, legacyCost);
    assert.equal(rows[0].proceedsTWD, cashTWD);
    assert.equal(rows[0].realizedPnlTWD, cashTWD - legacyCost);
    assert.equal(plan.remainingAvgCost, c.avgCost);
  }
});

test('FIFO：買進手續費算進批次成本；美股匯率套用賣出當下', () => {
  let p = { shares: 0, avgCost: 0, lots: [] };
  p = buy(p, '2025-01-01', 10, 100, 5); // 每股 100.5
  p = buy(p, '2025-02-01', 10, 110, 5); // 每股 110.5
  close(p.avgCost, 105.5, 1e-12);
  const s = sell(p, '2025-03-01', 15, 120, 'fifo', { fee: 3, fxRate: 30 });
  assert.deepEqual(s.rows.map((r) => [r.shares, r.unitCost]), [[10, 100.5], [5, 110.5]]);
  const cashTWD = (15 * 120 - 3) * 30;
  close(s.rows.reduce((t, r) => t + r.costTWD, 0), (1005 + 552.5) * 30, 1e-9);
  close(sumPnl(s.rows), cashTWD - (1005 + 552.5) * 30, 1e-9);
  close(s.pos.avgCost, 110.5, 1e-12);
});

test('FIFO：批次紀錄不完整 → 退回平均成本並標記 fallback', () => {
  // 手動調整過股數：持倉 300 股，但 lots 只有一筆 100 股
  const pos = { shares: 300, avgCost: 12, lots: [{ date: d('2025-01-01'), shares: 100, price: 10 }] };
  assert.equal(cb.canUseFifo(pos), false);
  const plan = cb.planSell(pos, 50, 'fifo');
  assert.equal(plan.method, 'average');
  assert.equal(plan.fallback, true);
  assert.equal(plan.rows[0].unitCost, 12);
  // 沒有 lots 的舊持倉
  assert.equal(cb.canUseFifo({ shares: 10, lots: [] }), false);
  // 超賣的歷史（賣出日早於買進）也視為不可靠
  const badLots = [{ date: d('2025-01-01'), shares: -10, price: 5 }, { date: d('2025-02-01'), shares: 10, price: 5 }];
  assert.equal(cb.replayFifoLots(badLots, 0).reliable, false);
  // 匯入的歷史成交不照日期順序寫入 → 重播依日期排序
  const outOfOrder = [
    { date: d('2025-03-01'), shares: 10, price: 15 },
    { date: d('2025-01-01'), shares: 10, price: 10 },
  ];
  const r = cb.planSell({ shares: 20, avgCost: 12.5, lots: outOfOrder }, 10, 'fifo');
  assert.equal(r.method, 'fifo');
  assert.equal(r.rows[0].unitCost, 10);
  assert.equal(cb.parseCostBasisMethod('fifo'), 'fifo');
  assert.equal(cb.parseCostBasisMethod(undefined), 'average');
  assert.equal(cb.parseCostBasisMethod('lifo'), 'average');
});
