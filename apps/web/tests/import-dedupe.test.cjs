// features/ledger/import-dedupe.ts — CSV 匯入去重（稽核 D5）
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

const { dedupeImportRows, importDedupeKey } = loadTs(path.resolve(__dirname, '../src/features/ledger/import-dedupe.ts'));

const tw = (s) => new Date(`${s}:00+08:00`);
const row = (over = {}) => ({
  userId: 'u', type: 'expense', amount: 120, currency: 'TWD', amountTWD: 120, fxRate: 1,
  category: 'food', paymentMethod: '現金', note: '午餐', date: tw('2026-11-08T12:00'), ...over,
});

test('key 用台北日期：台北凌晨不會被算成前一天', () => {
  assert.equal(importDedupeKey(row({ date: tw('2026-11-09T00:30') })).split('|')[0], '2026-11-09');
});

test('同一份檔案重複匯入：全部視為重複', () => {
  const csv = [row(), row({ note: '晚餐', amount: 250, amountTWD: 250 })];
  const existing = csv.map((r) => ({ ...r, deletedAt: null }));
  const { fresh, duplicates } = dedupeImportRows(csv, existing);
  assert.equal(fresh.length, 0);
  assert.equal(duplicates.length, 2);
});

test('次數比對：既有 1 筆、CSV 有 2 筆一樣的 → 只匯入 1 筆', () => {
  const { fresh, duplicates } = dedupeImportRows([row(), row()], [{ ...row(), deletedAt: null }]);
  assert.equal(fresh.length, 1);
  assert.equal(duplicates.length, 1);
});

test('備註不同、同日同金額不算重複；備註比對忽略大小寫與多餘空白', () => {
  assert.equal(dedupeImportRows([row({ note: '便當' })], [{ ...row(), deletedAt: null }]).fresh.length, 1);
  assert.equal(dedupeImportRows([row({ note: '  Lunch  Box ' })], [{ ...row({ note: 'lunch box' }), deletedAt: null }]).fresh.length, 0);
});

test('已軟刪的既有交易不算數；新列帶 importSourceHash', () => {
  const { fresh } = dedupeImportRows([row()], [{ ...row(), deletedAt: new Date() }]);
  assert.equal(fresh.length, 1);
  assert.match(fresh[0].importSourceHash, /^csv:2026-11-08\|expense\|120\.00\|TWD\|午餐$/);
});
