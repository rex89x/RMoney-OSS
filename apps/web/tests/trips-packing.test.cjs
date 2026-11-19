// features/trips/packing-template.ts — 行李清單範本（F8）
// 不依賴主機時區：天數 / 月份都用台北日曆日。本機驗證：TZ=America/New_York node --test apps/web/tests/trips-packing.test.cjs
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

const p = loadTs(path.resolve(__dirname, '../src/features/trips/packing-template.ts'));

const names = (items) => items.map((i) => i.name);
const find = (items, name) => items.find((i) => i.name === name);
const base = { days: 5, startMonth: 4, international: true, climate: 'temperate', hemisphere: 'north' };

test('國外旅程：護照、轉接頭、外幣、網卡 / eSIM、旅平險', () => {
  const list = p.buildPackingTemplate(base);
  for (const n of ['護照（效期 6 個月以上）', '轉接頭', '外幣', '網卡 / eSIM', '旅平險 / 不便險文件']) {
    assert.ok(names(list).includes(n), `missing ${n}`);
  }
  assert.ok(!names(list).includes('身分證 / 健保卡'));
});

test('國內旅程：身分證，不帶護照 / 轉接頭 / 外幣', () => {
  const list = p.buildPackingTemplate({ ...base, international: false });
  assert.ok(names(list).includes('身分證 / 健保卡'));
  for (const n of ['護照（效期 6 個月以上）', '轉接頭', '外幣', '網卡 / eSIM']) {
    assert.ok(!names(list).includes(n), `unexpected ${n}`);
  }
});

test('衣物數量依天數，最多帶一週份', () => {
  const short = p.buildPackingTemplate({ ...base, days: 2 });
  assert.equal(find(short, '上衣').quantity, 2);
  assert.equal(find(short, '內衣褲').quantity, 3);
  assert.ok(!names(short).includes('洗衣袋 / 洗衣精'));
  const long = p.buildPackingTemplate({ ...base, days: 14 });
  assert.equal(find(long, '上衣').quantity, 7);
  assert.equal(find(long, '內衣褲').quantity, 8);
  assert.equal(find(long, '長褲 / 裙子').quantity, 4);
  assert.ok(names(long).includes('洗衣袋 / 洗衣精'));
  assert.ok(names(long).includes('備用摺疊袋（裝戰利品）'));
  // 每項數量至少 1
  assert.ok(p.buildPackingTemplate({ ...base, days: 0 }).every((i) => i.quantity >= 1));
});

test('季節：北半球 1 月冷、7 月熱、4 月溫和；南半球反過來', () => {
  assert.equal(p.seasonForMonth(1), 'winter');
  assert.equal(p.seasonForMonth(4), 'spring');
  assert.equal(p.seasonForMonth(7), 'summer');
  assert.equal(p.seasonForMonth(10), 'autumn');
  assert.equal(p.seasonForMonth(12), 'winter');
  assert.equal(p.seasonForMonth(1, 'south'), 'summer');
  assert.equal(p.seasonForMonth(7, 'south'), 'winter');
  assert.equal(p.seasonForMonth(12, 'south'), 'summer');

  const winter = p.buildPackingTemplate({ ...base, startMonth: 1 });
  assert.ok(names(winter).includes('保暖外套 / 羽絨衣'));
  assert.ok(names(winter).includes('暖暖包'));
  assert.ok(!names(winter).includes('防曬乳'));
  const summer = p.buildPackingTemplate({ ...base, startMonth: 7 });
  assert.ok(names(summer).includes('短袖上衣'));
  assert.ok(names(summer).includes('防曬乳'));
  assert.ok(!names(summer).includes('保暖外套 / 羽絨衣'));
  const spring = p.buildPackingTemplate({ ...base, startMonth: 4 });
  assert.ok(names(spring).includes('薄外套'));
  // 澳洲 7 月是冬天
  const aus = p.buildPackingTemplate({ ...base, startMonth: 7, hemisphere: 'south' });
  assert.ok(names(aus).includes('保暖外套 / 羽絨衣'));
});

test('氣候覆蓋季節：熱帶 1 月仍帶泳衣 / 防蚊液；寒冷地區夏天仍帶羽絨', () => {
  const tropical = p.buildPackingTemplate({ ...base, startMonth: 1, climate: 'tropical' });
  assert.ok(names(tropical).includes('泳衣'));
  assert.ok(names(tropical).includes('防蚊液'));
  assert.ok(!names(tropical).includes('保暖外套 / 羽絨衣'));
  const cold = p.buildPackingTemplate({ ...base, startMonth: 7, climate: 'cold' });
  assert.ok(names(cold).includes('保暖外套 / 羽絨衣'));
});

test('地名判斷：國內外、氣候、半球', () => {
  assert.equal(p.isInternationalTrip(['花蓮', '台東']), false);
  assert.equal(p.isInternationalTrip(['臺北']), false);
  assert.equal(p.isInternationalTrip(['東京']), true);
  assert.equal(p.isInternationalTrip(['台北', '大阪']), true);
  assert.equal(p.isInternationalTrip([], ['JPY']), true);
  assert.equal(p.isInternationalTrip(['花蓮'], ['TWD']), false);
  assert.equal(p.isInternationalTrip([]), false);

  assert.equal(p.inferClimate([]), null);
  assert.equal(p.inferClimate(['曼谷']), 'tropical');
  assert.equal(p.inferClimate(['Bali']), 'tropical');
  assert.equal(p.inferClimate(['東京']), 'temperate');
  assert.equal(p.inferClimate(['冰島 雷克雅維克']), 'cold');
  assert.equal(p.inferClimate(['曼谷', '冰島']), 'cold');
  assert.equal(p.inferHemisphere(['雪梨']), 'south');
  assert.equal(p.inferHemisphere(['東京']), 'north');
});

test('inferPackingContext：天數 / 月份用台北日曆日（UTC 前一天也不算錯）', () => {
  // 台北 2026-02-01 00:30 出發 = UTC 1/31 16:30；台北 2026-02-05 23:00 回 = UTC 2/5 15:00
  const ctx = p.inferPackingContext({
    destination: ['札幌'],
    startDate: new Date('2026-01-31T16:30:00.000Z'),
    endDate: new Date('2026-02-05T15:00:00.000Z'),
    foreignCurrencies: ['JPY'],
  });
  assert.equal(ctx.days, 5);
  assert.equal(ctx.startMonth, 2);
  assert.equal(ctx.international, true);
  assert.equal(ctx.climate, 'temperate');
  assert.equal(p.resolveWeather(ctx), 'cold');

  const sameDay = p.inferPackingContext({
    destination: [], startDate: new Date('2026-07-10T02:00:00Z'), endDate: new Date('2026-07-10T10:00:00Z'),
  });
  assert.equal(sameDay.days, 1);
  assert.equal(sameDay.climate, null);
  assert.equal(sameDay.international, false);
});

test('filterNewTemplateItems：已存在的名稱（忽略空白 / 大小寫）不重複加入', () => {
  const template = p.buildPackingTemplate(base);
  const filtered = p.filterNewTemplateItems(template, ['轉接頭', ' 網卡/eSIM ', 'ESIM']);
  assert.ok(!names(filtered).includes('轉接頭'));
  assert.ok(!names(filtered).includes('網卡 / eSIM'));
  assert.equal(filtered.length, template.length - 2);
  // 範本本身也不會有重複名稱
  assert.equal(new Set(names(template)).size, template.length);
  assert.deepEqual(p.filterNewTemplateItems(template, names(template)), []);
});

test('packingProgress', () => {
  assert.deepEqual(p.packingProgress([]), { packed: 0, total: 0, percent: 0 });
  assert.deepEqual(
    p.packingProgress([{ packed: true }, { packed: false }, { packed: true }]),
    { packed: 2, total: 3, percent: 67 },
  );
});
