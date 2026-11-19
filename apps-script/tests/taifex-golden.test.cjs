/**
 * 台指期策略黃金測試資料（docs/TAIFEX_PAPER_TRADING_PLAN.md §9.5.4）。
 *
 * - 固定的合成日 K（含換月、外資、PCR）→ TaifexStrategy.gs 的訊號、回測交易與績效，存成 fixtures/taifex-golden.json。
 * - 現在用途：GAS 引擎回歸測試，改公式卻沒升 TAIFEX_MODEL_VERSION 會在這裡失敗。
 * - 之後用途：Rust 決策引擎移植時用同一份 JSON 逐筆比對（分數到小數 3 位、損益到整數元）。
 *
 * 刻意改公式時：升 TAIFEX_MODEL_VERSION，然後 `UPDATE_GOLDEN=1 node --test apps-script/tests/taifex-golden.test.cjs` 重新產生。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const FIXTURE = path.join(__dirname, 'fixtures', 'taifex-golden.json');
const context = vm.createContext({ console, Date, Error, isFinite, JSON, Math, Number, String, Array, Object, Infinity, RegExp });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/TaifexStrategy.gs'), 'utf8'), context);
const c = context;

/** 確定性亂數（Park–Miller）→ 三段行情（漲 / 跌 / 盤整）、每 21 根換月、外資與 PCR 序列 */
function generateBars(n = 480) {
  let seed = 20261109;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const round1 = (x) => Math.round(x * 10) / 10;
  const bars = [];
  let close = 22000;
  let flow = -5000;
  let day = Date.UTC(2025, 0, 2);
  for (let i = 0; i < n; i++) {
    while ([0, 6].includes(new Date(day).getUTCDay())) day += 86400000;
    const regime = Math.floor(i / 60) % 3;
    const drift = [0.0018, -0.0016, 0][regime];
    const open = round1(close * (1 + gauss() * 0.003));
    const next = round1(open * (1 + drift + gauss() * 0.009));
    const high = round1(Math.max(open, next) * (1 + rnd() * 0.004));
    const low = round1(Math.min(open, next) * (1 - rnd() * 0.004));
    flow = Math.round(flow + drift * 3e6 + gauss() * 1500);
    const month = Math.floor(i / 21);
    const contract = String(2025 + Math.floor(month / 12)) + String((month % 12) + 1).padStart(2, '0');
    const nextMonth = month + 1;
    const nextContract = String(2025 + Math.floor(nextMonth / 12)) + String((nextMonth % 12) + 1).padStart(2, '0');
    bars.push({
      date: new Date(day).toISOString().slice(0, 10),
      contract,
      open, high, low, close: next,
      nextContract,
      nextClose: round1(next + 15 + gauss() * 5),
      foreignNetOi: flow,
      pcrOi: round1(110 + gauss() * 12),
    });
    close = next;
    day += 86400000;
  }
  return bars;
}

// 微台：以合成資料約 250 點的 ATR，小台在 1% 風險預算下會算出 0 口而完全不交易
const CONFIG = { product: 'TMF', initialCapital: 2000000, riskPerTradePct: 1, maxContracts: 8, maxDrawdownPct: 25 };

function compute(bars) {
  const series = c.tfPrepareSeries_(bars);
  const signals = [];
  for (let i = c.TAIFEX_RULES.warmup; i < bars.length; i += 7) {
    const s = c.tfSignalAt_(series, i, {});
    signals.push({ index: i, date: s.date, composite: s.composite, quantScore: s.quantScore, coverage: s.coverage, factors: s.factors, atr20: s.indicators.atr20, adx14: s.indicators.adx14 });
  }
  const full = c.runTaifexBacktest_(bars, CONFIG, { series });
  const trendOnly = c.runTaifexBacktest_(bars, CONFIG, { series, weights: c.TAIFEX_TREND_ONLY_WEIGHTS });
  return JSON.parse(JSON.stringify({
    modelVersion: c.TAIFEX_MODEL_VERSION,
    config: c.tfNormalizeConfig_(CONFIG),
    signals,
    backtest: {
      full: { metrics: full.metrics, trades: full.trades, finalEquity: full.curve[full.curve.length - 1].equity },
      trendOnly: { metrics: trendOnly.metrics, finalEquity: trendOnly.curve[trendOnly.curve.length - 1].equity },
    },
  }));
}

test('taifex strategy matches golden fixture (bump TAIFEX_MODEL_VERSION when formulas change)', () => {
  const bars = generateBars();
  const output = compute(bars);
  if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(FIXTURE)) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify({ description: 'TaifexStrategy.gs golden vectors — see docs/TAIFEX_PAPER_TRADING_PLAN.md §9.5.4', input: { bars }, output }, null, 1)}\n`);
  }
  const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(golden.input.bars, JSON.parse(JSON.stringify(bars)), '輸入產生器改變了，請重新產生 fixture');
  assert.equal(output.modelVersion, golden.output.modelVersion, '模型版本不同：請重新產生 fixture');
  assert.deepEqual(output, golden.output);
  // fixture 要有足夠的內容才有比對價值
  assert.ok(golden.output.backtest.full.trades.length >= 5, `trades ${golden.output.backtest.full.trades.length}`);
  assert.ok(golden.output.signals.some((s) => s.factors.foreignFlow.score !== null));
});
