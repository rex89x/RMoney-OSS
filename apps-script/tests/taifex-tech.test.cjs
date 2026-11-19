const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({ console, Date, Error, isFinite, JSON, Math, Number, String, Array, Object, Infinity, RegExp });
for (const file of ['TaifexStrategy.gs', 'TaifexLive.gs', 'TaifexTech.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
}
const c = context;
const plain = (x) => JSON.parse(JSON.stringify(x));
const config = c.tfNormalizeConfig_({ product: 'TMF', slippagePoints: 1 });
const HOLIDAYS = { '2026-10-09': '國慶日補假', '2027-01-01': '中華民國開國紀念日' };

function sessAt(date, hhmm, holidays = HOLIDAYS) {
  return plain(c.tfSessionAt_(date, hhmm, holidays));
}

/** 從某個時段開盤開始，每 5 分鐘餵一筆價格 */
function feed(prices, { date = '2026-11-10', session = 'day', state = null, bars = [], startM = 0, cfg = config } = {}) {
  let st = state;
  let bs = bars;
  const trades = [];
  const events = [];
  const total = session === 'day' ? c.TAIFEX_DAY_MINUTES : c.TAIFEX_NIGHT_MINUTES;
  prices.forEach((price, i) => {
    const m = startM + i * 5;
    const sess = { session, key: date + (session === 'day' ? 'D' : 'N'), date, m, toClose: total - m };
    const r = c.tfTechStep_(st, bs, { last: price }, sess, { config: cfg, contracts: 1, estimated: false });
    st = r.state;
    bs = r.bars;
    trades.push(...r.trades);
    events.push(...r.events);
  });
  return { state: st, bars: bs, trades, events };
}

test('session detection: day, night across midnight, breaks', () => {
  assert.deepEqual(sessAt('2026-11-10', '08:44'), { session: null, reason: 'break', holidayName: null });
  assert.deepEqual(sessAt('2026-11-10', '08:45'), { session: 'day', key: '2026-11-10D', date: '2026-11-10', m: 0, toClose: 300 });
  assert.equal(sessAt('2026-11-10', '13:45').toClose, 0);
  assert.equal(sessAt('2026-11-10', '13:46').session, null);
  assert.equal(sessAt('2026-11-10', '14:59').reason, 'break');
  assert.deepEqual(sessAt('2026-11-10', '15:00'), { session: 'night', key: '2026-11-10N', date: '2026-11-10', m: 0, toClose: 840 });
  // 週三凌晨 02:00 屬於週二開始的夜盤
  assert.deepEqual(sessAt('2026-11-11', '02:00'), { session: 'night', key: '2026-11-10N', date: '2026-11-10', m: 660, toClose: 180 });
  assert.equal(sessAt('2026-11-11', '05:00').toClose, 0);
  assert.equal(sessAt('2026-11-11', '05:01').reason, 'break');
});

test('weekends: Friday night runs into Saturday morning, nothing on Sunday or Monday pre-dawn', () => {
  assert.equal(sessAt('2026-11-13', '23:00').session, 'night');
  assert.equal(sessAt('2026-11-14', '03:00').key, '2026-11-13N');
  assert.deepEqual(sessAt('2026-11-14', '09:00'), { session: null, reason: 'weekend', holidayName: null });
  assert.equal(sessAt('2026-11-14', '16:00').reason, 'weekend');
  assert.equal(sessAt('2026-11-15', '03:00').reason, 'weekend');
  assert.equal(sessAt('2026-11-16', '03:00').reason, 'weekend');
  assert.equal(sessAt('2026-11-16', '09:00').session, 'day');
});

test('holidays: no day or night session, but the previous night still finishes', () => {
  // 2026-10-09（五）休市
  assert.deepEqual(sessAt('2026-10-09', '09:00'), { session: null, reason: 'holiday', holidayName: '國慶日補假' });
  assert.equal(sessAt('2026-10-09', '15:30').reason, 'holiday');
  assert.equal(sessAt('2026-10-09', '02:00').key, '2026-10-08N');
  assert.equal(sessAt('2026-10-10', '02:00').reason, 'holiday');
  assert.equal(c.tfIsTradingDay_('2026-10-09', HOLIDAYS), false);
  assert.equal(c.tfIsTradingDay_('2026-10-08', HOLIDAYS), true);
  assert.equal(c.tfIsTradingDay_('2026-10-10', {}), false);
});

test('next session skips weekends and holidays', () => {
  assert.deepEqual(plain(c.tfNextSession_('2026-11-10', '07:00', HOLIDAYS)), { session: 'day', date: '2026-11-10', time: '08:45' });
  assert.deepEqual(plain(c.tfNextSession_('2026-11-10', '14:00', HOLIDAYS)), { session: 'night', date: '2026-11-10', time: '15:00' });
  assert.deepEqual(plain(c.tfNextSession_('2026-11-13', '16:00', HOLIDAYS)), { session: 'day', date: '2026-11-16', time: '08:45' });
  // 10/08（四）夜盤中 → 10/09 休市、週末 → 10/12（一）
  assert.deepEqual(plain(c.tfNextSession_('2026-10-08', '20:00', HOLIDAYS)), { session: 'day', date: '2026-10-12', time: '08:45' });
  assert.deepEqual(plain(c.tfNextSession_('2026-12-31', '16:00', HOLIDAYS)), { session: 'day', date: '2027-01-04', time: '08:45' });
});

test('TWSE holiday schedule parsing: ROC dates, trading-day rows excluded', () => {
  const parsed = plain(c.tfParseTwseHolidays_([
    { Name: '中華民國開國紀念日', Date: '1160101', Weekday: '五', Description: '依規定放假1日。' },
    { Name: '國曆新年開始交易日', Date: '1160104', Weekday: '一', Description: '國曆新年開始交易。' },
    { Name: '農曆春節前最後交易日', Date: '1160203', Weekday: '三', Description: '農曆春節前最後交易。' },
    { Name: '農曆春節', Date: '2027/2/8', Weekday: '一', Description: '依規定放假。' },
    { Name: '', Date: '20270405', Description: '' },
    { Name: 'bad', Date: 'x' },
    null,
  ]));
  assert.deepEqual(parsed, { '2027-01-01': '中華民國開國紀念日', '2027-02-08': '農曆春節', '2027-04-05': '休市' });
  assert.deepEqual(plain(c.tfParseTwseHolidays_({ error: 1 })), {});
  assert.equal(c.tfFixedHolidays_(2027)['2027-10-10'], '國慶日');
});

test('tech config: defaults, bounds, extra holidays', () => {
  assert.deepEqual(plain(c.tfNormalizeTechConfig_(undefined)), { enabled: true, day: true, night: true, notify: false, contracts: 1, extraHolidays: [] });
  const t = plain(c.tfNormalizeTechConfig_({ enabled: false, night: false, notify: true, contracts: 99, extraHolidays: ['2026-07-08', 'nope', '2026/7/8', '1150709'] }));
  assert.equal(t.enabled, false);
  assert.equal(t.night, false);
  assert.equal(t.notify, true);
  assert.equal(t.contracts, 1);
  assert.deepEqual(t.extraHolidays, ['2026-07-08', '2026-07-09']);
});

test('quote freshness and sanity', () => {
  const now = Date.UTC(2026, 10, 10, 2, 0, 0);
  assert.equal(c.tfQuoteFresh_({ last: 1, ts: now - 10 * 60000 }, now, 45), true);
  assert.equal(c.tfQuoteFresh_({ last: 1, ts: now - 19 * 3600000 }, now, 45), false);
  assert.equal(c.tfQuoteFresh_({ last: 1 }, now, 45), true);
  assert.equal(c.tfQuoteSane_({ last: 27000 }, 26900), true);
  assert.equal(c.tfQuoteSane_({ last: 2700 }, 26900), false);
  assert.equal(c.tfQuoteSane_({ last: 27000 }, null), true);
  assert.equal(c.tfQuoteSane_({ last: 0 }, null), false);
});

test('MIS quote parser picks the front month and converts Taipei time', () => {
  const json = { RtCode: '0', RtData: { QuoteList: [
    { SymbolID: 'TXF-S', CLastPrice: '27010.55' },
    { SymbolID: 'TXFK6-F', CLastPrice: '27,100', COpenPrice: '27000', CHighPrice: '27150', CLowPrice: '26980', CRefPrice: '26950', CTotalVolume: '54321', CDate: '20261110', CTime: '103005' },
    { SymbolID: 'TXFL6-F', CLastPrice: '27130', CDate: '20261110', CTime: '103001' },
    { SymbolID: 'TXFK6/L6-F', CLastPrice: '30' },
  ] } };
  const q = plain(c.tfParseMisQuote_(json, 'TXFL6'));
  assert.equal(q.symbol, 'TXFL6-F');
  assert.equal(q.last, 27130);
  const front = plain(c.tfParseMisQuote_(json, null));
  assert.equal(front.symbol, 'TXFK6-F');
  assert.equal(front.last, 27100);
  assert.equal(front.prevClose, 26950);
  assert.equal(front.ts, Date.UTC(2026, 10, 10, 2, 30, 5));
  assert.equal(c.tfParseMisQuote_({ RtData: { QuoteList: [] } }, 'TXFL6'), null);
  assert.equal(c.tfParseMisQuote_(null, 'TXFL6'), null);
  assert.equal(c.tfFrontContractFor_('2026-11-10'), '202611');
  assert.equal(c.tfFrontContractFor_('2026-11-18'), '202612');
  // Fugle lastUpdated 是微秒
  assert.equal(c.tfParseFugleQuote_({ lastPrice: 27100, lastUpdated: 1794277805000000 }).ts, 1794277805000);
});

test('5-minute bars: slot alignment, merge within a slot, session highs', () => {
  const sess = (m) => ({ session: 'day', key: '2026-11-10D', date: '2026-11-10', m, toClose: 300 - m });
  let bars = c.tfTechAppendBar_([], { last: 27000, open: 26990, high: 27010, low: 26985 }, sess(2));
  assert.deepEqual(plain(bars), [{ t: '2026-11-10 08:45', s: '2026-11-10D', m: 0, o: 26990, h: 27000, l: 26990, c: 27000, sh: 27010, sl: 26985 }]);
  bars = c.tfTechAppendBar_(bars, { last: 27005, high: 27010, low: 26985 }, sess(4));
  assert.equal(bars.length, 1);
  assert.equal(bars[0].c, 27005);
  // 08:52 → 08:50 那一根；時段最高從 27010 變 27040，代表這 5 分鐘內到過 27040
  bars = c.tfTechAppendBar_(bars, { last: 27020, high: 27040, low: 26985 }, sess(7));
  assert.equal(bars.length, 2);
  assert.deepEqual(plain(bars[1]), { t: '2026-11-10 08:50', s: '2026-11-10D', m: 5, o: 27005, h: 27040, l: 27005, c: 27020, sh: 27040, sl: 26985 });
  // 夜盤跨日的時間標籤
  const night = c.tfTechAppendBar_([], { last: 27000 }, { session: 'night', key: '2026-11-10N', date: '2026-11-10', m: 663, toClose: 177 });
  assert.equal(night[0].t, '2026-11-11 02:00');
  assert.equal(night[0].m, 660);
});

test('aggregation groups by interval from the session open and respects the cutoff', () => {
  const bars = [0, 5, 10, 15, 20, 25, 30].map((m, i) => ({ t: 't' + m, s: 'A', m, o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i }));
  const agg = plain(c.tfTechAggregate_(bars, 15, null));
  assert.deepEqual(agg.map((b) => [b.open, b.high, b.low, b.close]), [[100, 105, 99, 104], [104, 108, 103, 107]]);
  const cut = c.tfTechAggregate_(bars, 15, { key: 'A', m: 15 });
  assert.equal(cut.length, 1);
  const two = c.tfTechAggregate_(bars.concat([{ t: 'n0', s: 'B', m: 0, o: 1, h: 2, l: 0, c: 1 }]), 15, null);
  assert.equal(two.length, 3);
});

test('RSI and MACD basics', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(c.tfRsi_(up, 14)[29], 100);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(c.tfRsi_(down, 14)[29], 0);
  assert.equal(c.tfRsi_(up, 14)[13], null);
  const m = c.tfMacd_(Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.05), 12, 26, 9);
  assert.equal(m.hist[32], null);
  assert.ok(m.hist[59] > 0);
});

test('signal: rising market scores positive, falling negative, short history returns null', () => {
  const mk = (fn, n = 60) => Array.from({ length: n }, (_, i) => { const cl = fn(i); return { open: cl - 2, high: cl + 5, low: cl - 5, close: cl }; });
  assert.equal(c.tfTechSignal_(mk((i) => 27000 + i, 20)), null);
  const up = c.tfTechSignal_(mk((i) => 27000 + i * i * 0.2));
  assert.ok(up.score >= c.TAIFEX_TECH_RULES.entry, `up score ${up.score}`);
  const down = c.tfTechSignal_(mk((i) => 27000 - i * i * 0.2));
  assert.ok(down.score <= -c.TAIFEX_TECH_RULES.entry, `down score ${down.score}`);
  assert.equal(c.tfTechDecide_(up, null, true, true).action, 'enter');
  assert.equal(c.tfTechDecide_(up, null, false, true).action, 'hold');
  assert.equal(c.tfTechDecide_(down, null, true, false).action, 'hold');
  assert.equal(c.tfTechDecide_(down, 'long', true, true).action, 'reverse');
  assert.equal(c.tfTechDecide_(down, 'long', false, true).action, 'exit');
  assert.equal(c.tfTechDecide_(up, 'long', true, true).action, 'hold');
  assert.equal(c.tfTechDecide_(null, 'long', true, true).action, 'hold');
});

test('bots check at their own frequency, enter on an uptrend, and flatten before the close', () => {
  // 前一天夜盤先暖機（橫盤），日盤一路上漲到收盤
  const warm = feed(Array.from({ length: 168 }, (_, i) => 27000 + (i % 2 ? 3 : -3)), { date: '2026-11-09', session: 'night' });
  const r = feed(Array.from({ length: 61 }, (_, i) => 27000 + i * i * 0.15), { state: warm.state, bars: warm.bars });
  const bots = r.state.bots;
  // 日盤 300 分鐘：扣掉收盤前 10 分鐘，5 分頻率檢查 57 次、60 分頻率 4 次
  assert.equal(bots.m5.checks - warm.state.bots.m5.checks, 57);
  assert.equal(bots.m15.checks - warm.state.bots.m15.checks, 19);
  assert.equal(bots.m60.checks - warm.state.bots.m60.checks, 4);
  const enters = r.events.filter((e) => e.type === 'enter' && e.bot === 'm5');
  assert.ok(enters.length >= 1);
  assert.equal(enters[0].side, 'long');
  // 收盤時全部空手，最後一筆是收盤平倉且賺錢
  Object.values(bots).forEach((b) => assert.equal(b.position, null));
  const m5Trades = r.trades.filter((t) => t.bot === 'm5');
  const last = m5Trades[m5Trades.length - 1];
  assert.equal(last.reason, 'session_end');
  assert.equal(last.session, 'day');
  assert.ok(last.netPnl > 0);
  assert.equal(last.netPnl, last.grossPnl - last.costs);
  assert.equal(bots.m5.stats.day.n, m5Trades.length);
  assert.equal(bots.m5.stats.night.n, warm.state.bots.m5.stats.night.n);
  assert.equal(Math.round(bots.m5.realized), Math.round(m5Trades.reduce((s, t) => s + t.netPnl, 0) + warm.state.bots.m5.realized));
  // 時段摘要：兩個時段
  assert.deepEqual(r.state.sessions.map((s) => s.key), ['2026-11-09N', '2026-11-10D']);
  assert.equal(r.state.sessions[1].ticks, 61);
  assert.ok(bots.m5.lastDecision.indicators.atr > 0);
  assert.ok(bots.m5.decisions.length <= c.TAIFEX_TECH_MAX_DECISIONS);
});

test('stop loss triggers on any tick regardless of monitor frequency', () => {
  const warm = feed(Array.from({ length: 168 }, (_, i) => 27000 + (i % 2 ? 3 : -3)), { date: '2026-11-09', session: 'night' });
  const up = feed(Array.from({ length: 31 }, (_, i) => 27000 + i * i * 0.4), { state: warm.state, bars: warm.bars });
  const pos = up.state.bots.m15.position;
  assert.ok(pos, '15 分頻率應該已經進場');
  assert.equal(pos.side, 'long');
  // 60 分頻率要 35 根 60 分 K（約 2 個交易日）才開始決策
  assert.equal(up.state.bots.m60.position, null);
  assert.equal(up.state.bots.m60.lastDecision.reason, '資料不足');
  // 下一個 5 分鐘（開盤後 155 分，不是 15 分頻率的監控點）直接跌破停損：照樣出場，成交在停損價
  const crash = feed([pos.stop - 50], { state: up.state, bars: up.bars, startM: 155 });
  const t = crash.trades.filter((x) => x.bot === 'm15')[0];
  assert.equal(t.reason, 'stop');
  assert.equal(t.exitPrice, pos.stop);
  assert.equal(crash.state.bots.m15.position, null);
  assert.equal(crash.state.bots.m15.checks, up.state.bots.m15.checks);
});

test('a position left over from a previous session is closed at that session last price', () => {
  const warm = feed(Array.from({ length: 168 }, (_, i) => 27000 + (i % 2 ? 3 : -3)), { date: '2026-11-09', session: 'night' });
  const up = feed(Array.from({ length: 30 }, (_, i) => 27000 + i * i * 0.4), { state: warm.state, bars: warm.bars });
  assert.ok(up.state.bots.m5.position);
  const lastDayClose = up.bars[up.bars.length - 1].c;
  // 排程漏跑到夜盤才回來
  const night = feed([lastDayClose + 500], { date: '2026-11-10', session: 'night', state: up.state, bars: up.bars });
  const t = night.trades.filter((x) => x.bot === 'm5')[0];
  assert.equal(t.reason, 'session_end');
  assert.equal(t.exitPrice, lastDayClose);
  assert.equal(t.sessionKey, '2026-11-10D');
  // 損益記在原本的日盤時段
  const daySummary = night.state.sessions.filter((s) => s.key === '2026-11-10D')[0];
  assert.equal(daySummary.pnl.m5, t.netPnl);
});

test('no new entries in the last 30 minutes; shorts disabled by config', () => {
  const warm = feed(Array.from({ length: 168 }, (_, i) => 27000 + (i % 2 ? 3 : -3)), { date: '2026-11-09', session: 'night' });
  const flat = feed(Array.from({ length: 55 }, (_, i) => 27000 + (i % 2 ? 3 : -3)), { state: warm.state, bars: warm.bars });
  const late = feed([27100, 27250, 27400, 27600, 27800, 28000], { state: flat.state, bars: flat.bars, startM: 275 });
  assert.equal(late.events.filter((e) => e.type === 'enter').length, 0);
  const noShort = c.tfNormalizeConfig_({ product: 'TMF', allowShort: false });
  const down = feed(Array.from({ length: 40 }, (_, i) => 27000 - i * i * 0.4), { state: warm.state, bars: warm.bars, cfg: noShort });
  assert.equal(down.events.filter((e) => e.type === 'enter').length, 0);
  const withShort = feed(Array.from({ length: 40 }, (_, i) => 27000 - i * i * 0.4), { state: warm.state, bars: warm.bars });
  assert.equal(withShort.events.filter((e) => e.type === 'enter')[0].side, 'short');
});

test('entry-time buckets', () => {
  assert.equal(c.tfTechBucketId_('day', 0), 'd1');
  assert.equal(c.tfTechBucketId_('day', 30), 'd2');
  assert.equal(c.tfTechBucketId_('day', 200), 'd4');
  assert.equal(c.tfTechBucketId_('night', 59), 'n1');
  assert.equal(c.tfTechBucketId_('night', 400), 'n3');
  assert.equal(c.tfTechBucketId_('night', 800), 'n4');
});
