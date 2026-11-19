// features/investments/symbol-utils.ts — 台股代號規則（4–6 位數字 + 英文字尾），並與 Apps Script Stocks.gs 對照
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
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

const web = loadTs(path.resolve(__dirname, '../src/features/investments/symbol-utils.ts'));
const gas = vm.createContext({ console, String, Number, Math, Object, Array, JSON, Date });
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../apps-script/src/Stocks.gs'), 'utf8'), gas);

const ACCEPT = [
  ['2330', 'TW', 'TWD', 'stock', '個股'],
  ['0050', 'TW', 'TWD', 'etf', 'ETF'],
  ['00878', 'TW', 'TWD', 'etf', 'ETF'],
  ['006208', 'TW', 'TWD', 'etf', 'ETF'],
  ['00981A', 'TW', 'TWD', 'etf', '主動式股票型 ETF'],
  ['00980D', 'TW', 'TWD', 'etf', '主動式債券型 ETF'],
  ['00679B', 'TW', 'TWD', 'etf', '債券型 ETF'],
  ['00631L', 'TW', 'TWD', 'etf', '槓桿型 ETF'],
  ['00632R', 'TW', 'TWD', 'etf', '反向型 ETF'],
  ['00980T', 'TW', 'TWD', 'etf', '平衡型 ETF'],
  ['00642U', 'TW', 'TWD', 'etf', '期貨型 ETF'],
  ['00636K', 'TW', 'USD', 'etf', '外幣交易股票型 ETF'],
  ['00680C', 'TW', 'USD', 'etf', '外幣交易債券型 ETF'],
  ['2881A', 'TW', 'TWD', 'preferred', '特別股'],
  ['2330X', 'TW', 'TWD', 'convertible', '可轉換公司債換股權利證書'],
  ['910322', 'TW', 'TWD', 'dr', '存託憑證（DR）'],
  ['AAPL', 'US', 'USD', null, null],
  ['BRK.B', 'US', 'USD', null, null],
];

test('接受台股 4–6 位數字 + 英文字尾，正確判斷市場 / 幣別 / 類型', () => {
  for (const [sym, market, currency, kind, label] of ACCEPT) {
    const r = web.normalizeStockSymbol(sym);
    assert.equal(r.ok, true, sym);
    assert.equal(r.symbol, sym, sym);
    assert.equal(r.market, market, sym);
    assert.equal(r.currency, currency, sym);
    assert.equal(r.twInfo ? r.twInfo.kind : null, kind, sym);
    assert.equal(r.twInfo ? r.twInfo.label : null, label, sym);
  }
});

test('輸入容錯：小寫、空白、.TW / .TWO 後綴、名稱後綴 -KY / -DR', () => {
  assert.equal(web.normalizeStockSymbol(' 00981a ').symbol, '00981A');
  assert.equal(web.normalizeStockSymbol('00878.TW').symbol, '00878');
  assert.equal(web.normalizeStockSymbol('6488.two').symbol, '6488');
  assert.equal(web.normalizeStockSymbol('1590-KY').symbol, '1590');
  assert.equal(web.normalizeStockSymbol('910322-DR').symbol, '910322');
});

test('拒絕不合格的台股代號', () => {
  for (const bad of ['233', '1234567', '00878ABC', '2330-1', '']) {
    assert.equal(web.normalizeStockSymbol(bad).ok, false, bad);
  }
});

test('Apps Script 規則與前端一致（市場、幣別、正規化）', () => {
  for (const [sym, market, currency] of ACCEPT) {
    assert.equal(gas.inferStockMarket_(sym, null), market, `market ${sym}`);
    if (market === 'TW') assert.equal(gas.twSymbolCurrency_(sym), currency, `currency ${sym}`);
    assert.equal(gas.isTwSymbol_(sym), market === 'TW', `isTw ${sym}`);
  }
  assert.equal(gas.normalizeStockSymbol_(' 00981a.tw '), '00981A');
  assert.equal(gas.normalizeStockSymbol_('1590-KY'), '1590');
});

test('Apps Script：代號是台股時，舊資料寫錯的 market=US 以代號為準', () => {
  assert.equal(gas.inferStockMarket_('00878', { market: 'US' }), 'TW');
  assert.equal(gas.inferStockMarket_('AAPL', { market: 'US' }), 'US');
});
