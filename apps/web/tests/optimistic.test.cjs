// lib/optimistic.ts — 樂觀更新工具（稽核 F5）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['@tanstack/react-query'], alias: { '@': path.resolve(__dirname, '../src') } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const { patchById, definedOnly, optimisticUpdate } = loadTs(path.resolve(__dirname, '../src/lib/optimistic.ts'));

test('patchById 只改指定 id，找不到時回傳原陣列（reference 不變）', () => {
  const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
  const next = patchById(rows, 'b', { n: 3 });
  assert.deepEqual(next, [{ id: 'a', n: 1 }, { id: 'b', n: 3 }]);
  assert.equal(next[0], rows[0]);
  assert.equal(patchById(rows, 'zz', { n: 9 }), rows);
});

test('definedOnly 去掉 undefined，保留 null / 0 / 空字串', () => {
  assert.deepEqual(definedOnly({ a: undefined, b: null, c: 0, d: '' }), { b: null, c: 0, d: '' });
});

test('optimisticUpdate 套用到所有符合 key 的 query，rollback 還原', async () => {
  const store = new Map([['["transactions","u",{"limit":10}]', [{ id: 'x', n: 1 }]], ['["transactions","u",{}]', undefined]]);
  const qc = {
    cancelQueries: async () => {},
    getQueriesData: () => [...store.entries()].map(([k, v]) => [JSON.parse(k), v]),
    setQueryData: (k, v) => store.set(JSON.stringify(k), v),
  };
  const rollback = await optimisticUpdate(qc, ['transactions'], (rows) => rows.map((r) => ({ ...r, n: 2 })));
  assert.deepEqual(store.get('["transactions","u",{"limit":10}]'), [{ id: 'x', n: 2 }]);
  assert.equal(store.get('["transactions","u",{}]'), undefined, '沒資料的 query 不動');
  rollback();
  assert.deepEqual(store.get('["transactions","u",{"limit":10}]'), [{ id: 'x', n: 1 }]);
});
