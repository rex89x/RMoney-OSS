// features/net-worth/household-fund-share.ts — 淨值頁「共同公基金」份額（資訊揭露，不計入淨值）
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
const { householdFundShare } = loadTs(path.resolve(__dirname, '../src/features/net-worth/household-fund-share.ts'));

test('依分攤比例算份額，含公基金欠我的代墊', () => {
  const r = householdFundShare({ balanceTWD: 30000, owedToMember: { rex: 1200 } }, { rex: 60, partner: 40 }, 'rex');
  assert.deepEqual(r, { ratioPct: 60, equityTWD: 18000, owedToMeTWD: 1200 });
});

test('比例加總不是 100 時正規化；我不在比例裡 = 0', () => {
  assert.equal(householdFundShare({ balanceTWD: 900, owedToMember: {} }, { a: 1, b: 2 }, 'b').equityTWD, 600);
  assert.equal(householdFundShare({ balanceTWD: 900, owedToMember: {} }, { a: 1 }, 'zz').equityTWD, 0);
});
