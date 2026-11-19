// features/import/statement-mapping.ts — 通用對帳單欄位對應（稽核 F4）
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

const m = loadTs(path.resolve(__dirname, '../src/features/import/statement-mapping.ts'));
const twKey = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);

test('本 app 匯出的 CSV header 完全猜中', () => {
  const g = m.guessMapping(['date', 'type', 'amount', 'currency', 'category', 'paymentMethod', 'note', 'tripId']);
  assert.equal(g.date, 'date'); assert.equal(g.amount, 'amount'); assert.equal(g.type, 'type');
  assert.equal(g.paymentMethod, 'paymentMethod'); assert.equal(g.note, 'note'); assert.equal(g.tripId, 'tripId');
});

test('銀行對帳單常見中文欄名：交易日期 / 摘要 / 支出 / 存入；餘額欄不當金額', () => {
  const g = m.guessMapping(['﻿交易日期', '摘要', '支出金額', '存入金額', '帳戶餘額']);
  assert.equal(g.date, '﻿交易日期');
  assert.equal(g.note, '摘要');
  assert.equal(g.debit, '支出金額');
  assert.equal(g.credit, '存入金額');
  assert.equal(g.amount, null);
});

test('金額解析：千分位、NT$、括號負數、尾端負號、全形負號', () => {
  assert.equal(m.parseStatementAmount('1,234'), 1234);
  assert.equal(m.parseStatementAmount('NT$ 1,234.5'), 1234.5);
  assert.equal(m.parseStatementAmount('(500)'), -500);
  assert.equal(m.parseStatementAmount('300-'), -300);
  assert.equal(m.parseStatementAmount('－80'), -80);
  assert.equal(m.parseStatementAmount(''), null);
  assert.equal(m.parseStatementAmount('abc'), null);
});

test('日期解析：西元 / 民國 / 無分隔 / 帶時間，皆為台北當天', () => {
  assert.equal(twKey(m.parseStatementDate('2026/11/08')), '2026-11-08');
  assert.equal(twKey(m.parseStatementDate('115/11/08')), '2026-11-08');
  assert.equal(twKey(m.parseStatementDate('1151108')), '2026-11-08');
  assert.equal(twKey(m.parseStatementDate('20261108')), '2026-11-08');
  assert.equal(twKey(m.parseStatementDate('2026-11-08 23:59:00')), '2026-11-08');
  assert.equal(twKey(m.parseStatementDate('2026年1月5日')), '2026-01-05');
  assert.equal(m.parseStatementDate('11/08'), null);
  assert.equal(m.parseStatementDate('2026/13/01'), null);
});

test('mapStatementRows：支出 / 存入兩欄', () => {
  const mapping = m.guessMapping(['交易日期', '摘要', '支出', '存入']);
  const { rows, errors } = m.mapStatementRows([
    { 交易日期: '115/11/01', 摘要: '全聯', 支出: '1,280', 存入: '' },
    { 交易日期: '115/11/05', 摘要: '薪資', 支出: '', 存入: '52,000' },
    { 交易日期: '???', 摘要: 'x', 支出: '1', 存入: '' },
  ], mapping);
  assert.equal(errors.length, 1);
  assert.deepEqual(rows.map((r) => [twKey(r.date), r.type, r.amount, r.note]), [
    ['2026-11-01', 'expense', 1280, '全聯'],
    ['2026-11-05', 'income', 52000, '薪資'],
  ]);
});

test('mapStatementRows：單欄金額的正負號慣例', () => {
  const mapping = m.guessMapping(['日期', '金額', '說明']);
  const data = [{ 日期: '2026-11-01', 金額: '-120', 說明: '午餐' }, { 日期: '2026-11-02', 金額: '300', 說明: '退款' }];
  assert.deepEqual(m.mapStatementRows(data, mapping, 'negativeIsExpense').rows.map((r) => r.type), ['expense', 'income']);
  assert.deepEqual(m.mapStatementRows(data, mapping, 'positiveIsExpense').rows.map((r) => r.type), ['income', 'expense']);
  assert.deepEqual(m.mapStatementRows(data, mapping, 'allExpense').rows.map((r) => [r.type, r.amount]), [['expense', 120], ['expense', 300]]);
});

test('type 欄文字優先於正負號', () => {
  const mapping = m.guessMapping(['date', 'type', 'amount']);
  const { rows } = m.mapStatementRows([{ date: '2026-11-01', type: 'income', amount: '100' }, { date: '2026-11-01', type: '支出', amount: '50' }], mapping);
  assert.deepEqual(rows.map((r) => r.type), ['income', 'expense']);
});
