#!/usr/bin/env node
/**
 * 本機 emulator 種子資料（只打 127.0.0.1，不會碰 production）。
 *
 *   npx firebase-tools emulators:start --only firestore,auth --project demo-rmoney
 *   node scripts/seed-emulator.mjs
 *   npm run dev:emulator --workspace apps/web
 *   瀏覽器 console：await __devSignIn('rex@example.com')   // owner
 *                   await __devSignIn('partner@example.com')    // 伴侶（member）
 *
 * 內容：owner + member、一個共同帳本（含公基金、結算、共同支出）、共同投資持股與快照。
 */
const PROJECT = 'demo-rmoney';
const FS = `http://127.0.0.1:8085/v1/projects/${PROJECT}/databases/(default)/documents`;
const AUTH = `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`;
const HEADERS = { 'Content-Type': 'application/json', Authorization: 'Bearer owner' };

function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}

async function put(path, data) {
  const res = await fetch(`${FS}/${path}`, {
    method: 'PATCH', headers: HEADERS,
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) }),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
}

async function createUser(localId, email, displayName) {
  const res = await fetch(AUTH, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ localId, email, password: 'emulator-only', displayName, emailVerified: true }),
  });
  if (!res.ok && !(await res.text()).includes('DUPLICATE')) throw new Error(`auth ${email}: ${res.status}`);
}

const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * 86400000);
const REX = 'rex-uid';
const PARTNER = 'partner-uid';
const HID = 'demo-household';

await createUser(REX, 'rex@example.com', 'Owner');
await createUser(PARTNER, 'partner@example.com', '伴侶');
await put('config/allowedEmails', { emails: ['rex@example.com', 'partner@example.com'] });
await put(`users/${REX}`, { email: 'rex@example.com', displayName: 'Owner', role: 'owner', createdAt: now, preferences: { theme: 'auto' } });
await put(`users/${PARTNER}`, { email: 'partner@example.com', displayName: '伴侶', role: 'member', createdAt: now, preferences: { theme: 'auto' } });

for (const [i, c] of [['food', '餐飲', 'Utensils', '#F59E0B'], ['transport', '交通', 'Car', '#3B82F6'], ['home', '居家', 'Home', '#10B981'], ['entertainment', '娛樂', 'Gamepad2', '#8B5CF6']].entries()) {
  await put(`categories/${c[0]}`, { key: c[0], name: c[1], type: 'expense', icon: c[2], color: c[3], order: i + 1 });
}

await put(`households/${HID}`, {
  name: '我們的家', ownerId: REX, memberIds: [REX, PARTNER],
  members: {
    [REX]: { uid: REX, displayName: 'Owner', email: 'rex@example.com', color: '#3b82f6', permissions: {} },
    [PARTNER]: { uid: PARTNER, displayName: '伴侶', email: 'partner@example.com', color: '#ec4899', permissions: {} },
  },
  pendingInvites: [], splitRatio: { [REX]: 50, [PARTNER]: 50 }, monthlyBudgetTWD: 30000, inviteCode: 'DEMO2345',
  autoShareTrips: true, ledgerSharing: { [REX]: [PARTNER] },
  investmentPlan: { name: '買房頭期款', targetAmountTWD: 3000000, targetDate: new Date(now.getFullYear() + 5, now.getMonth(), 1), expectedAnnualReturnPct: 6, monthlyContributionTWD: { [REX]: 15000, [PARTNER]: 10000 } },
  householdReport: { enabled: true, frequency: 'weekly', includeLedger: true, includeInvestments: true },
  telegramLinked: { [PARTNER]: true },
  createdAt: daysAgo(200), updatedAt: now,
});
await put(`users/${REX}`, { email: 'rex@example.com', displayName: 'Owner', role: 'owner', createdAt: now, ledgerSharedWith: [PARTNER] });

const notes = ['全聯採買', '晚餐 鼎泰豐', '捷運儲值', '電費', 'Netflix', '週末電影', '早午餐', '計程車', '家樂福', '水費'];
const cats = ['food', 'food', 'transport', 'home', 'entertainment', 'entertainment', 'food', 'transport', 'home', 'home'];
for (let i = 0; i < 40; i += 1) {
  const payer = i % 5 === 0 ? '__household_fund__' : i % 2 === 0 ? REX : PARTNER;
  const amount = 200 + ((i * 373) % 2800);
  const creator = payer === PARTNER ? PARTNER : REX;
  await put(`transactions/demo-tx-${i}`, {
    userId: creator, type: 'expense', amount, currency: 'TWD', amountTWD: amount, fxRate: 1,
    category: cats[i % cats.length], note: notes[i % notes.length], date: daysAgo(i * 3), paymentMethod: 'cash',
    householdId: HID, paidByUid: payer, scope: 'household', shareType: 'custom',
    customShares: [{ memberId: REX, amountTWD: amount / 2 }, { memberId: PARTNER, amountTWD: amount / 2 }],
    myShareTWD: amount / 2, createdAt: daysAgo(i * 3), updatedAt: daysAgo(i * 3), deletedAt: null,
  });
}
for (let i = 0; i < 6; i += 1) {
  await put(`households/${HID}/fund_entries/f${i}`, {
    type: 'contribution', amountTWD: 5000, contributorUid: i % 2 ? PARTNER : REX, note: `${i + 1} 月公基金`,
    date: daysAgo(i * 30), createdBy: i % 2 ? PARTNER : REX, createdAt: daysAgo(i * 30),
  });
}
await put(`households/${HID}/settlements/s1`, { fromUid: PARTNER, toUid: REX, amountTWD: 3200, date: daysAgo(20), note: '上月結算', createdBy: PARTNER, createdAt: daysAgo(20) });

const stocks = {
  '0050': { name: '元大台灣50', price: 198.5, change: 1.2, market: 'TW', currency: 'TWD' },
  '00878': { name: '國泰永續高股息', price: 22.4, change: -0.08, market: 'TW', currency: 'TWD' },
  2330: { name: '台積電', price: 1085, change: 15, market: 'TW', currency: 'TWD' },
  VOO: { name: 'Vanguard S&P 500', price: 548.2, change: -2.1, market: 'US', currency: 'USD' },
};
for (const [sym, s] of Object.entries(stocks)) {
  await put(`stocks/${sym}`, { symbol: sym, name: s.name, market: s.market, currency: s.currency, currentPrice: s.price, prevClose: s.price - s.change, change: s.change, changePercent: (s.change / (s.price - s.change)) * 100, high: s.price, low: s.price, open: s.price, volume: 1000, updatedAt: now });
}
await put('fx_rates/USD_TWD', { base: 'USD', quote: 'TWD', rate: 31.9, updatedAt: now });

const lot = (side, d, shares, price, fee = 20) => ({ side, date: daysAgo(d), shares, price, fee });
const holdings = [
  { id: 'h1', symbol: '0050', name: '元大台灣50', market: 'TW', currency: 'TWD', bucket: 'joint', ownerUid: null, lots: [lot('buy', 300, 1000, 150), lot('buy', 120, 500, 175)] },
  { id: 'h2', symbol: '00878', name: '國泰永續高股息', market: 'TW', currency: 'TWD', bucket: 'personal', ownerUid: PARTNER, lots: [lot('buy', 200, 3000, 21), lot('sell', 40, 500, 23)] },
  { id: 'h3', symbol: '2330', name: '台積電', market: 'TW', currency: 'TWD', bucket: 'personal', ownerUid: REX, source: 'portfolio', lots: [lot('buy', 0, 100, 890, 0)] },
  { id: 'h4', symbol: 'VOO', name: 'Vanguard S&P 500', market: 'US', currency: 'USD', bucket: 'joint', ownerUid: null, jointShares: { [REX]: 60, [PARTNER]: 40 }, lots: [lot('buy', 250, 10, 480, 1)] },
];
for (const h of holdings) {
  const { id, ...rest } = h;
  await put(`households/${HID}/investment_holdings/${id}`, {
    jointShares: null, source: 'manual', sourcePositionId: h.source === 'portfolio' ? 'p1' : null, sourceMissing: false,
    note: null, createdBy: h.ownerUid ?? REX, createdAt: daysAgo(300), updatedAt: now, syncedAt: null, ...rest,
  });
}
for (let i = 30; i >= 0; i -= 1) {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(daysAgo(i));
  const value = 700000 + (30 - i) * 2500 + Math.sin(i) * 8000;
  await put(`households/${HID}/investment_snapshots/${key}`, { date: key, totalValueTWD: value, totalCostTWD: 640000, unrealizedTWD: value - 640000, realizedTWD: 900, dayChangeTWD: 0, byBucket: {}, byMember: {} });
}
console.log('seeded demo-rmoney: rex@example.com (owner) / partner@example.com (member)');

/* ==========================================================================
 * Stress seed（手機版排版稽核用）：讓 owner 的每一頁都有「偏長、偏大」的真實感資料。
 * 全部用固定 doc id（PATCH / commit update）→ 可重複執行。
 * 欄位名稱一律對照 apps/web/src/features/<feature>/types.ts 的 converter。
 * ========================================================================== */
const DOC_ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const encFields = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)]));
const pending = [];
/** 排進批次（之後 flush() 用 :commit 一次送 200 筆，比逐筆 PATCH 快很多） */
const queue = (path, data) => { pending.push({ update: { name: `${DOC_ROOT}/${path}`, fields: encFields(data) } }); };
async function flush() {
  while (pending.length) {
    const writes = pending.splice(0, 200);
    const res = await fetch(`${FS}:commit`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ writes }) });
    if (!res.ok) throw new Error(`commit: ${res.status} ${await res.text()}`);
  }
}

// 固定種子的 PRNG：每次執行產生同一批資料
let _s = 20261111;
const rnd = () => { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + rnd() * (b - a);
const round2 = (n) => Math.round(n * 100) / 100;
const twFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' });
const twKey = (d) => twFmt.format(d);                 // YYYY-MM-DD（台北）
const twMonth = (d) => twKey(d).slice(0, 7);          // YYYY-MM
const daysAhead = (n) => daysAgo(-n);
const hoursAgo = (n) => new Date(now.getTime() - n * 3600000);
/** 台北時間某日 12:00 */
const twNoon = (key) => new Date(`${key}T12:00:00+08:00`);
const monthsAgoKey = (n) => { const [y, m] = twMonth(now).split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const isWeekday = (d) => { const wd = new Date(`${twKey(d)}T12:00:00+08:00`).getUTCDay(); return wd !== 0 && wd !== 6; };

const LONG_ZH = '這是一段刻意寫得非常非常長而且完全沒有任何空白可以換行的中文備註用來測試手機版排版會不會被撐破版面超出螢幕寬度';
const LONG_EN = 'SupercalifragilisticexpialidociousInternationalMerchantServicesHoldingsCorporationLimited-Taipei101Branch';
const LONG_URLISH = 'https://www.example.com/a/very/long/path/without/any/spaces/that/should/wrap-or-truncate/0123456789abcdefghijklmnopqrstuvwxyz';

// ---------------------------------------------------------------- users / config
await put(`users/${REX}`, {
  // role admin：正式環境的 owner 靠 ADMIN_EMAILS 是 admin（admin ⊇ owner），這樣 /admin 與「設定 → 存取」才有內容
  email: 'rex@example.com', displayName: 'Owner', role: 'admin', createdAt: daysAgo(420), ledgerSharedWith: [PARTNER], ledgerEditors: [],
  preferences: {
    theme: 'auto', mainCurrency: 'TWD', costBasisMethod: 'average', tripRecapYears: 3,
    allocationTargets: [{ key: 'TW', label: 'TW 股票', pct: 45, color: '#3b82f6' }, { key: 'US', label: 'US 股票', pct: 35, color: '#8b5cf6' }, { key: 'bond', label: '債券', pct: 10, color: '#06b6d4' }, { key: 'cash', label: '現金 / 等值', pct: 10, color: '#10b981' }],
    emergencyFund: { targetMonths: 12, monthlyBaseline: 123456 },
    inbox: {
      todos: [
        { id: 'todo-1', title: '確認國泰世華 CUBE 卡 11 月帳單金額並安排從薪轉戶自動扣繳（金額比上個月多出三萬多要逐筆核對）', detail: `${LONG_ZH}`, href: '/settings?tab=bills', createdAt: daysAgo(2).toISOString() },
        { id: 'todo-2', title: '補登東京旅遊剩下的日幣現金支出', detail: '收據在背包前袋', href: '/ledger', createdAt: daysAgo(5).toISOString() },
        { id: 'todo-3', title: LONG_EN, detail: null, href: null, createdAt: daysAgo(9).toISOString() },
        { id: 'todo-4', title: '續保：新光人壽長期照顧終身健康保險', detail: '年繳 NT$48,650，11/30 前', href: '/net-worth', createdAt: daysAgo(1).toISOString() },
      ],
      dismissed: {},
    },
  },
});
await put('config/guestEmails', { emails: ['guest-with-a-really-long-email-address-for-layout@example-long-domain.com'] });
// 白名單雜湊 doc：登入時 checkEmailAccess 讀的是 config/*Hashes（明文 doc 只有 admin 可讀），emulator 沒有 Apps Script 可補，seed 要自己寫
const { createHash } = await import('node:crypto');
const sha256 = (email) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
await put('config/allowedEmailHashes', { hashes: ['rex@example.com', 'partner@example.com'].map(sha256).sort(), count: 2, syncedAt: now, syncedBy: 'seed' });
await put('config/guestEmailHashes', { hashes: ['guest-with-a-really-long-email-address-for-layout@example-long-domain.com'].map(sha256), count: 1, syncedAt: now, syncedBy: 'seed' });

// ---------------------------------------------------------------- categories / payment methods
const CATS = [
  ['food', '餐飲', 'expense', 'Utensils', '#F59E0B', 1], ['transport', '交通', 'expense', 'Car', '#3B82F6', 2], ['home', '居家', 'expense', 'Home', '#10B981', 3],
  ['shopping', '購物', 'expense', 'ShoppingBag', '#EC4899', 4], ['medical', '醫療', 'expense', 'Stethoscope', '#EF4444', 5], ['entertainment', '娛樂', 'expense', 'Gamepad2', '#8B5CF6', 6],
  ['education', '學習', 'expense', 'BookOpen', '#06B6D4', 7], ['investment', '投資', 'expense', 'TrendingUp', '#059669', 8], ['gift', '禮物', 'expense', 'Gift', '#F97316', 9],
  ['other', '其他', 'expense', 'MoreHorizontal', '#6B7280', 10], ['salary', '薪資', 'income', 'Briefcase', '#0EA5E9', 11], ['bonus', '獎金', 'income', 'Award', '#EAB308', 12],
  ['invest_return', '投資收益', 'income', 'LineChart', '#10B981', 13], ['gift_income', '禮金', 'income', 'Gift', '#F97316', 14], ['other_income', '其他', 'income', 'MoreHorizontal', '#6B7280', 15],
  ['rental_purchase', '租賃資產購入', 'expense', 'Building2', '#0F766E', 16], ['rental_income', '租賃收入', 'income', 'Building2', '#0F766E', 17],
  ['adjustment', '對帳調整', 'expense', 'Scale', '#94A3B8', 18], ['adjustment_income', '對帳調整', 'income', 'Scale', '#94A3B8', 19],
  ['household_settlement', '共同帳結算', 'expense', 'HandCoins', '#F472B6', 20], ['household_settlement_income', '共同帳結算', 'income', 'HandCoins', '#F472B6', 21],
  ['insurance', '保險', 'expense', 'ShieldCheck', '#6366F1', 22],
  ['kids_education_long', '小孩才藝班與課後安親補習費用（含教材雜費）', 'expense', 'GraduationCap', '#14B8A6', 23],
  ['pet', '寵物', 'expense', 'PawPrint', '#A855F7', 24],
  ['freelance_long', '接案與顧問諮詢收入（境外匯入）', 'income', 'Laptop', '#22C55E', 25],
  ['trip_ticket', '門票', 'expense', 'Ticket', '#8B5CF6', 100], ['trip_hotel', '住宿', 'expense', 'Hotel', '#0EA5E9', 101], ['trip_flight', '機票', 'expense', 'Plane', '#3B82F6', 102],
  ['trip_local_transport', '當地交通', 'expense', 'Bus', '#10B981', 103], ['trip_souvenir', '伴手禮', 'expense', 'Gift', '#F97316', 104], ['trip_food', '旅遊餐飲', 'expense', 'Utensils', '#F59E0B', 105],
];
for (const [key, name, type, icon, color, order] of CATS) queue(`categories/${key}`, { key, name, type, icon, color, order, archivedAt: null });
queue('categories/archived_demo', { key: 'archived_demo', name: '已封存的舊類別', type: 'expense', icon: 'Archive', color: '#9CA3AF', order: 200, archivedAt: daysAgo(90) });

const PMS = [
  ['cash', '現金', 'cash', null, null, '#16A34A', 'Banknote', false, null, null],
  ['cube', '國泰世華 CUBE 卡（日本賞・慶生月加碼）', 'credit', '國泰世華商業銀行', '4321', '#0EA5E9', 'CreditCard', true, 5, 20],
  ['esun-pi', '玉山 Pi 拍錢包信用卡', 'credit', '玉山銀行', '8899', '#059669', 'CreditCard', true, 12, 28],
  ['ctbc-linepay', '中國信託 LINE Pay 聯名卡御璽卡', 'credit', '中國信託商業銀行', '0007', '#22C55E', 'CreditCard', true, 25, 10],
  ['linepay', 'LINE Pay Money', 'mobile', null, null, '#06C755', 'Smartphone', false, null, null],
  ['jko', '街口支付', 'mobile', null, null, '#EF4444', 'Smartphone', false, null, null],
  ['bank-transfer', '銀行轉帳', 'debit', '台新國際商業銀行 Richart', null, '#F59E0B', 'Landmark', false, null, null],
  ['easycard', '悠遊卡', 'other', null, null, '#3B82F6', 'Ticket', false, null, null],
];
PMS.forEach(([key, name, type, bank, last4, color, icon, billingEnabled, statementDay, dueDay], i) => queue(`payment_methods/${key}`, { key, name, type, bank, last4, color, icon, order: i + 1, archivedAt: null, billingEnabled, statementDay, dueDay }));

// ---------------------------------------------------------------- accounts（記帳帳戶）
const acct = (id, name, type, currency, balance, balanceTWD, extra = {}) => queue(`accounts/${id}`, {
  ownerId: REX, name, type, currency, active: true, archivedAt: null, balance, balanceTWD, balanceUpdatedAt: hoursAgo(3),
  creditCard: null, loan: null, eWallet: null, insurance: null, pension: null, legacyPaymentMethod: null, legacySource: 'manual',
  lastReconciledAt: daysAgo(12), createdAt: daysAgo(400), updatedAt: hoursAgo(3), ...extra,
});
acct('acc-cash', '錢包現金', 'cash', 'TWD', 8650, 8650, { legacyPaymentMethod: 'cash' });
acct('acc-bank-main', '台新 Richart 數位帳戶（薪轉・主要扣款帳戶）', 'bank', 'TWD', 1234567, 1234567, { legacyPaymentMethod: 'bank-transfer', note: '薪轉戶，所有信用卡自動扣繳都掛這裡' });
acct('acc-bank-cathay', '國泰世華 KOKO 高利活存', 'bank', 'TWD', 12345678, 12345678, { note: LONG_ZH });
acct('acc-bank-usd', 'Charles Schwab International Brokerage Checking (USD)', 'bank', 'USD', 45678.9, 1457155, {});
acct('acc-bank-jpy', '玉山外幣帳戶-日圓', 'bank', 'JPY', 1280000, 268800, {});
acct('acc-card-cube', '國泰世華 CUBE 卡', 'credit_card', 'TWD', 86420, 86420, { legacyPaymentMethod: 'cube', creditCard: { closingDay: 5, dueDay: 20, cardLast4: '4321', creditLimit: 300000, linkedSettlementAccountId: 'acc-bank-main' } });
acct('acc-card-esun', '玉山 Pi 拍錢包信用卡', 'credit_card', 'TWD', 23110, 23110, { legacyPaymentMethod: 'esun-pi', creditCard: { closingDay: 12, dueDay: 28, cardLast4: '8899', creditLimit: 150000, linkedSettlementAccountId: 'acc-bank-main' } });
acct('acc-card-ctbc', '中國信託 LINE Pay 聯名卡御璽卡', 'credit_card', 'TWD', 1234567, 1234567, { legacyPaymentMethod: 'ctbc-linepay', creditCard: { closingDay: 25, dueDay: 10, cardLast4: '0007', creditLimit: 1500000, linkedSettlementAccountId: 'acc-bank-main' } });
acct('acc-linepay', 'LINE Pay Money', 'e_wallet_balance', 'TWD', 3120, 3120, { legacyPaymentMethod: 'linepay', eWallet: { provider: 'linepay', autoTopUp: { enabled: true, sourceAccountId: 'acc-bank-main', thresholdTWD: 500, topUpAmountTWD: 3000 } } });
acct('acc-easycard', '悠遊卡（自動加值）', 'e_wallet_balance', 'TWD', 412, 412, { legacyPaymentMethod: 'easycard', eWallet: { provider: 'easycard' } });
acct('acc-broker', '元大證券交割戶（台股）', 'investment_cash', 'TWD', 356789, 356789, {});
acct('acc-broker-us', 'Firstrade 美股交割帳戶', 'investment_cash', 'USD', 12034.56, 383901, {});
acct('acc-mortgage', '房貸－台北市信義區松仁路自住宅（第一順位 30 年期）', 'loan', 'TWD', 18765432, 18765432, { loan: { principalTWD: 22000000, interestRate: 2.185, monthlyPayment: 83456, nextDueDate: daysAhead(9), termMonths: 360, linkedSettlementAccountId: 'acc-bank-main' } });
acct('acc-carloan', 'Tesla Model Y 車貸', 'loan', 'TWD', 876543, 876543, { loan: { principalTWD: 1500000, interestRate: 3.2, monthlyPayment: 27123, nextDueDate: daysAhead(18), termMonths: 60, linkedSettlementAccountId: 'acc-bank-main' } });
acct('acc-ins-life', '新光人壽長期照顧終身健康保險（20 年期）', 'insurance', 'TWD', 486500, 486500, { insurance: { insurer: '新光人壽保險股份有限公司', policyNo: 'SKL-2019-00123456789', kind: 'health', premiumTWD: 48650, premiumFrequency: 'annual', nextPremiumDate: daysAhead(19), maturityDate: daysAhead(4800), coverageTWD: 3000000, cashValueTWD: 486500 } });
acct('acc-ins-savings', '富邦人壽美元利率變動型終身壽險', 'insurance', 'USD', 32000, 1020800, { insurance: { insurer: '富邦人壽', policyNo: 'FB-USD-7788', kind: 'savings', premiumTWD: 96000, premiumFrequency: 'semiannual', nextPremiumDate: daysAhead(4), coverageTWD: 5000000, cashValueTWD: 1020800 } });
acct('acc-ins-accident', '國泰產險意外傷害險', 'insurance', 'TWD', 0, 0, { insurance: { insurer: '國泰世紀產物保險', kind: 'accident', premiumTWD: 1280, premiumFrequency: 'monthly', nextPremiumDate: daysAhead(-2), coverageTWD: 10000000 } });
acct('acc-pension', '勞退新制個人專戶（雇主 6% + 自提 6%）', 'pension', 'TWD', 1876543, 1876543, { pension: { provider: '勞動部勞工保險局', employerContributionPct: 6, selfContributionPct: 6, monthlySalaryTWD: 150000, expectedReturnPct: 4, retirementAge: 65, birthYear: 1990 } });

// ---------------------------------------------------------------- transactions（個人，約 13 個月）
const FX = { TWD: 1, USD: 31.9, JPY: 0.21, EUR: 34.6, IDR: 0.002 };
const PM_ACC = { cash: 'acc-cash', cube: 'acc-card-cube', 'esun-pi': 'acc-card-esun', 'ctbc-linepay': 'acc-card-ctbc', linepay: 'acc-linepay', 'bank-transfer': 'acc-bank-main', easycard: 'acc-easycard', jko: null };
const EXP_NOTES = {
  food: ['鼎泰豐 信義店', '全聯福利中心', '路易莎咖啡', '麥當勞 歡樂送', 'Uber Eats 晚餐', '饗饗 INPARADISE 自助餐（家庭聚餐六人含服務費）', '巷口滷肉飯', `${LONG_EN}`, '好市多 Costco 內湖店 週末採買（生鮮＋日用品＋輪胎保養預付）'],
  transport: ['台北捷運 定期票', '高鐵 台北-左營 商務艙', 'Uber', '中油加油', '停車費 信義威秀', 'Tesla 超級充電站'],
  home: ['台電電費', '自來水費', '中華電信光世代 1G/600M', '管理費', 'IKEA 敦北店', '大金冷氣年度保養'],
  shopping: ['UNIQLO', 'Apple Store 台北101 MacBook Pro 16 吋 M5 Max', 'momo 購物網', '蝦皮購物', 'Amazon.co.jp', 'PChome 24h'],
  medical: ['台大醫院 掛號', '牙醫 植牙第二期', '藥局'],
  entertainment: ['Netflix', '威秀影城', 'Nintendo eShop', 'Spotify Premium Family', '五月天演唱會門票'],
  education: ['Coursera Plus 年費', '博客來 書', '日文家教'],
  gift: ['母親節紅包', '同事婚禮禮金'],
  other: ['雜支', 'ATM 手續費', '未分類消費'],
  insurance: ['新光人壽 年繳保費'],
  kids_education_long: ['何嘉仁美語 秋季班學費', '鋼琴課 12 堂'],
  pet: ['寵物醫院 年度健檢', '貓砂與飼料'],
};
const EXP_CATS = Object.keys(EXP_NOTES);
const EXP_WEIGHT = ['food', 'food', 'food', 'food', 'transport', 'transport', 'home', 'home', 'shopping', 'shopping', 'entertainment', 'medical', 'education', 'gift', 'other', 'other', 'kids_education_long', 'pet'];
const PM_KEYS = ['cash', 'cube', 'cube', 'esun-pi', 'ctbc-linepay', 'linepay', 'easycard', 'jko'];
const PM_NAME = Object.fromEntries(PMS.map((p) => [p[0], p[1]]));
const tx = (id, o0) => { const o = { ...o0, ...(o0.paymentMethod ? { paymentMethod: PM_NAME[o0.paymentMethod] ?? o0.paymentMethod } : {}) }; return queue(`transactions/${id}`, {
  userId: REX, type: 'expense', currency: 'TWD', fxRate: 1, category: 'other', paymentMethod: 'cash', fromAccountId: null, toAccountId: null,
  transferGroup: null, tripId: null, tags: [], recurringId: null, deletedAt: null, scope: 'personal', settledAmountTWD: null, settledFxRate: null, settledAt: null,
  loanSettledAt: null, householdId: null, paidByUid: null, createdAt: o.date, updatedAt: o.date, ...o,
}); };
const expenseTx = (id, date, over = {}) => {
  const category = over.category ?? pick(EXP_WEIGHT);
  const pm = over.paymentMethod ?? pick(PM_KEYS);
  const currency = over.currency ?? 'TWD';
  const amount = over.amount ?? Math.round(between(45, category === 'shopping' ? 9000 : 2400));
  const fxRate = FX[currency];
  tx(id, { date, type: 'expense', category, paymentMethod: pm, fromAccountId: PM_ACC[pm] ?? null, currency, amount, fxRate, amountTWD: round2(amount * fxRate), note: pick(EXP_NOTES[category] ?? EXP_NOTES.other), ...over });
};
// 150 筆：平均散在 395 天
for (let i = 0; i < 150; i += 1) {
  const date = new Date(daysAgo(i * 2.63).getTime() - Math.floor(rnd() * 8) * 3600000);
  const over = {};
  if (i % 17 === 3) Object.assign(over, { currency: 'JPY', amount: 128000, category: 'shopping', note: 'ヨドバシカメラ マルチメディアAkiba 秋葉原店（免稅）', paymentMethod: 'cube' });
  if (i % 19 === 5) Object.assign(over, { currency: 'USD', amount: 1299.99, category: 'shopping', note: 'Apple.com US — iPhone 18 Pro Max 1TB Natural Titanium', paymentMethod: 'ctbc-linepay' });
  if (i % 23 === 7) Object.assign(over, { currency: 'EUR', amount: 2480.5, category: 'entertainment', note: 'Booking.com Hotel Sacher Wien', paymentMethod: 'cube' });
  if (i % 29 === 11) Object.assign(over, { currency: 'IDR', amount: 12345678, category: 'food', note: 'Bali Seminyak Beach Club', paymentMethod: 'cash' });
  if (i % 13 === 1) Object.assign(over, { note: `${LONG_ZH}${LONG_ZH}` });
  if (i % 13 === 6) Object.assign(over, { note: `${LONG_EN}/${LONG_URLISH}` });
  if (i === 2) Object.assign(over, { amount: 12345678, category: 'home', note: '自住宅頭期款第二期（匯款至建商履約保證專戶）', paymentMethod: 'bank-transfer' });
  if (i === 40) Object.assign(over, { amount: 9876543, category: 'investment', note: '預售屋工程款', paymentMethod: 'bank-transfer' });
  if (i % 11 === 4) Object.assign(over, { tags: ['報帳', '公司代墊', '2026Q4專案-東京出差-客戶招待', '可抵稅'], subCategory: '商務宴請', invoiceNumber: 'AB-12345678' });
  expenseTx(`rex-tx-${i}`, date, over);
}
// 本月再加 28 筆，讓「本月」卡片有密度
for (let i = 0; i < 28; i += 1) expenseTx(`rex-tx-m${i}`, new Date(daysAgo(i % 10).getTime() - (i * 37 % 600) * 60000), i % 9 === 0 ? { note: LONG_ZH } : {});
// 收入：薪資 ×14、獎金、接案、股利
for (let m = 0; m < 14; m += 1) {
  const date = daysAgo(m * 30 + 6);
  tx(`rex-inc-salary-${m}`, { date, type: 'income', category: 'salary', paymentMethod: 'bank-transfer', toAccountId: 'acc-bank-main', amount: 152340, amountTWD: 152340, note: '薪資轉帳－台灣積體電路製造股份有限公司' });
  if (m % 3 === 0) tx(`rex-inc-free-${m}`, { date: daysAgo(m * 30 + 14), type: 'income', category: 'freelance_long', paymentMethod: 'bank-transfer', toAccountId: 'acc-bank-usd', currency: 'USD', amount: 4500, fxRate: 31.9, amountTWD: 143550, note: `Consulting retainer — ${LONG_EN}` });
  if (m % 4 === 1) tx(`rex-inc-div-${m}`, { date: daysAgo(m * 30 + 20), type: 'income', category: 'invest_return', paymentMethod: 'bank-transfer', toAccountId: 'acc-broker', amount: 38650, amountTWD: 38650, note: '0056 / 00878 季配息入帳' });
}
tx('rex-inc-bonus-1', { date: daysAgo(280), type: 'income', category: 'bonus', paymentMethod: 'bank-transfer', toAccountId: 'acc-bank-main', amount: 1234567, amountTWD: 1234567, note: '年終獎金 + 員工分紅（稅前）' });
tx('rex-inc-bonus-2', { date: daysAgo(8), type: 'income', category: 'bonus', paymentMethod: 'bank-transfer', toAccountId: 'acc-bank-main', amount: 345678, amountTWD: 345678, note: '第三季績效獎金' });
tx('rex-inc-other-1', { date: daysAgo(3), type: 'income', category: 'other_income', paymentMethod: 'cash', toAccountId: 'acc-cash', amount: 1200, amountTWD: 1200, note: '統一發票中獎' });
// 轉帳
for (let i = 0; i < 12; i += 1) {
  const [from, to, amount, note] = pick([
    ['acc-bank-main', 'acc-bank-cathay', 50000, '每月轉高利活存'], ['acc-bank-main', 'acc-broker', 100000, '定期定額扣款入金（元大證券）'],
    ['acc-bank-main', 'acc-card-cube', 86420, '繳國泰世華 CUBE 卡費'], ['acc-bank-main', 'acc-linepay', 3000, 'LINE Pay Money 自動儲值'], ['acc-bank-cathay', 'acc-bank-main', 12345678, '定存到期解約轉回薪轉戶'],
  ]);
  tx(`rex-tr-${i}`, { date: daysAgo(i * 29 + 4), type: 'transfer', category: 'transfer', paymentMethod: 'bank-transfer', fromAccountId: from, toAccountId: to, amount, amountTWD: amount, note, transferGroup: { role: 'leg' } });
}
// 代墊 / 借出（代墊分頁、收件匣「未結清代墊」）
const LOANS = [
  ['i-paid-others', '陳大文與他的大學同學會籌備委員會全體成員', 12800, 3200, null, '同學會包廂訂金先墊'], ['i-paid-others', '伴侶', 6400, 3200, null, '演唱會門票兩張'],
  ['i-paid-others', 'Alexander Maximilian Montgomery-Fitzgerald III', 45600, 11400, null, 'Airbnb 京都町家四人分攤'], ['they-paid-mine', '媽媽', 8900, 8900, null, '媽媽先幫付的牙醫費'],
  ['i-paid-others', '公司（報帳中）', 123456, 0, null, '東京出差機票與住宿先刷自己的卡'], ['i-paid-others', '阿明', 2400, 800, daysAgo(10), '燒肉聚餐（已還）'],
  ['they-paid-mine', '室友小美', 1500, 1500, daysAgo(40), '水電分攤（已結清）'], ['i-paid-others', '弟弟', 1000000, 0, null, '買房頭期款周轉'],
];
LOANS.forEach(([splitMode, counterpartyName, amount, myShareTWD, loanSettledAt, note], i) => tx(`rex-loan-${i}`, {
  date: daysAgo(6 + i * 9), type: 'expense', category: i % 2 ? 'entertainment' : 'food', paymentMethod: 'cube', fromAccountId: splitMode === 'i-paid-others' ? 'acc-card-cube' : null,
  amount, amountTWD: amount, note, splitMode, counterpartyName, myShareTWD, loanSettledAt,
}));
// 回收筒（7 天內軟刪）
for (let i = 0; i < 6; i += 1) expenseTx(`rex-trash-${i}`, daysAgo(3 + i), { deletedAt: hoursAgo(5 + i * 20), note: i === 0 ? `誤刪測試：${LONG_ZH}` : undefined });
// 分期入帳（tag 分期）
for (let i = 0; i < 6; i += 1) tx(`rex-inst-tx-${i}`, { date: daysAgo(i * 30 + 2), category: 'shopping', paymentMethod: 'cube', fromAccountId: 'acc-card-cube', amount: 6658, amountTWD: 6658, note: `MacBook Pro 16 吋 分期 ${6 - i}/24`, tags: ['分期'] });
// 租賃
tx('rex-rental-buy', { date: daysAgo(330), category: 'rental_purchase', paymentMethod: 'bank-transfer', fromAccountId: 'acc-bank-main', amount: 1280000, amountTWD: 1280000, note: '租賃資產購入：咖啡廳商用義式咖啡機組' });
for (let m = 0; m < 10; m += 1) tx(`rex-rental-inc-${m}`, { date: daysAgo(m * 30 + 10), type: 'income', category: 'rental_income', paymentMethod: 'bank-transfer', toAccountId: 'acc-bank-main', amount: 42000, amountTWD: 42000, note: '咖啡機組租金' });
// 疑似訂閱（同 note 連續數月，沒掛 recurringId）
for (let m = 0; m < 5; m += 1) {
  tx(`rex-sub-yt-${m}`, { date: daysAgo(m * 30 + 3), category: 'entertainment', paymentMethod: 'cube', fromAccountId: 'acc-card-cube', amount: 399, amountTWD: 399, note: 'YouTube Premium Family' });
  tx(`rex-sub-icloud-${m}`, { date: daysAgo(m * 30 + 9), category: 'other', paymentMethod: 'cube', fromAccountId: 'acc-card-cube', amount: 300, amountTWD: 300, note: 'APPLE.COM/BILL iCloud+ 2TB' });
}

// ---------------------------------------------------------------- budgets / recurring / subscriptions / scheduled / goals
for (let m = 0; m < 4; m += 1) {
  const month = monthsAgoKey(m);
  queue(`budgets/${REX}_${month}`, { userId: REX, month, total: 60000, byCategory: { food: 15000, transport: 6000, home: 12000, shopping: 8000, entertainment: 4000, medical: 3000, education: 3000, kids_education_long: 12345678, pet: 2000, other: 1000 } });
}
const recTpl = (o) => ({ userId: REX, type: 'expense', amount: o.amount, currency: 'TWD', amountTWD: o.amount, fxRate: 1, category: o.category, paymentMethod: PM_NAME[o.pm ?? 'cube'], note: o.note, date: daysAgo(60), tags: [], scope: 'personal' });
const RECS = [
  ['rec-rent', '房貸月付金（台北市信義區松仁路自住宅第一順位三十年期）', 'monthly', { amount: 83456, category: 'home', pm: 'bank-transfer', note: '房貸月付金' }, 9, true],
  ['rec-netflix', 'Netflix Premium', 'monthly', { amount: 390, category: 'entertainment', note: 'Netflix' }, 3, true],
  ['rec-gym', 'World Gym 健身房月費', 'monthly', { amount: 1688, category: 'entertainment', note: 'World Gym' }, 15, true],
  ['rec-allow', '孝親費', 'monthly', { amount: 20000, category: 'gift', pm: 'bank-transfer', note: '孝親費' }, 25, true],
  ['rec-clean', '居家清潔（雙週）', 'biweekly', { amount: 2400, category: 'home', pm: 'linepay', note: '潔客幫' }, 5, true],
  ['rec-ins', '年繳保費', 'yearly', { amount: 48650, category: 'insurance', pm: 'bank-transfer', note: '新光人壽' }, 19, true],
  ['rec-old', '已停用：舊電信門號', 'monthly', { amount: 599, category: 'home', note: '中華電信 599' }, -40, false],
  ['rec-weekly', '每週菜錢', 'weekly', { amount: 1500, category: 'food', pm: 'cash', note: '傳統市場' }, 2, true],
];
RECS.forEach(([id, label, frequency, tpl, due, active]) => queue(`recurring/${id}`, { userId: REX, template: recTpl(tpl), frequency, nextDue: daysAhead(due), active, lastGeneratedAt: daysAgo(30 - due), label, subscriptionId: id === 'rec-netflix' ? 'sub-netflix' : null }));
const SUBS = [
  ['sub-netflix', 'Netflix Premium 4K + HDR（家庭方案四個裝置）', 390, 'monthly', 3, 'cube', 'entertainment', 'Netflix International B.V.', true, 'rec-netflix'],
  ['sub-spotify', 'Spotify Premium Family', 268, 'monthly', 11, 'cube', 'entertainment', 'Spotify AB', true, null],
  ['sub-icloud', 'iCloud+ 2TB', 300, 'monthly', 9, 'cube', 'other', 'Apple', true, null],
  ['sub-chatgpt', 'ChatGPT Pro', 6380, 'monthly', 21, 'ctbc-linepay', 'education', 'OpenAI, L.L.C.', true, null],
  ['sub-claude', 'Claude Max 20x', 6380, 'monthly', 1, 'ctbc-linepay', 'education', 'Anthropic, PBC', true, null],
  ['sub-adobe', 'Adobe Creative Cloud All Apps（年約月付）', 1785, 'monthly', 17, 'esun-pi', 'education', 'Adobe Systems Software Ireland Ltd', true, null],
  ['sub-amazon', 'Amazon Prime', 4500, 'yearly', 120, 'cube', 'shopping', 'Amazon.com', true, null],
  ['sub-nyt', 'The New York Times Digital All Access', 520, 'weekly', 4, 'cube', 'education', 'NYTimes', true, null],
  ['sub-gym', 'World Gym', 1688, 'monthly', 15, 'esun-pi', 'entertainment', 'World Gym Taiwan', true, null],
  ['sub-1password', '1Password Families', 1920, 'yearly', 200, 'cube', 'other', 'AgileBits Inc.', true, null],
  ['sub-disney', 'Disney+（已取消）', 270, 'monthly', -30, 'cube', 'entertainment', 'Disney', false, null],
  ['sub-domain', `${LONG_EN}.com 網域續約`, 12345, 'yearly', 44, 'cube', 'other', 'Cloudflare Registrar', true, null],
];
SUBS.forEach(([id, name, amountTWD, billingCycle, due, paymentMethod, category, vendor, active, recurringId], i) => queue(`subscriptions/${id}`, {
  name, amountTWD, billingCycle, nextChargeDate: daysAhead(due), paymentMethod: PM_NAME[paymentMethod], category, vendor, active, lastChargedAt: daysAgo(30 - due), recurringId,
  note: i % 3 === 0 ? LONG_ZH : null, createdAt: daysAgo(400 - i), updatedAt: daysAgo(i),
}));
const SCHED = [
  ['sp-tax', '綜合所得稅結算申報（含配偶合併申報・海外所得基本稅額）', 1234567, 200, 'yearly', 'other', 30, null], ['sp-house-tax', '房屋稅', 18650, 170, 'yearly', 'home', 14, null],
  ['sp-land-tax', '地價稅', 9870, 12, 'yearly', 'home', 14, null], ['sp-car-tax', '汽車牌照稅＋燃料費', 22410, -3, 'yearly', 'transport', 7, null],
  ['sp-ins', '新光人壽年繳保費', 48650, 19, 'yearly', 'insurance', 14, null], ['sp-mgmt', '社區管理費（季繳）', 13500, 5, 'quarterly', 'home', 7, null],
  ['sp-tuition', '何嘉仁美語 冬季班學費', 38000, 2, 'one-time', 'kids_education_long', 3, null], ['sp-paid', '第四台年繳（已繳）', 5988, -20, 'yearly', 'home', 7, daysAgo(21)],
  ['sp-nhi', '二代健保補充保費', 2110, 26, 'monthly', 'medical', 5, null],
];
SCHED.forEach(([id, name, amountTWD, due, recurrence, category, remindBeforeDays, paidAt], i) => queue(`scheduled_payments/${id}`, { name, amountTWD, dueDate: daysAhead(due), recurrence, category, remindBeforeDays, paidAt, note: i % 2 ? '記得先把錢轉到薪轉戶' : null, createdAt: daysAgo(300), updatedAt: daysAgo(i) }));
const GOALS = [
  ['goal-house', '換屋頭期款（大安區三房兩廳含車位）', 12345678, 4567890, 900, 'Home', '#0EA5E9', null, 120000],
  ['goal-japan', '2027 北海道滑雪家族旅行', 300000, 187500, 80, 'Plane', '#8B5CF6', null, 25000],
  ['goal-emergency', '緊急預備金（12 個月生活費）', 1200000, 1200000, null, 'ShieldCheck', '#10B981', null, null],
  ['goal-car', '小孩教育基金', 5000000, 876543, 3650, 'GraduationCap', '#F59E0B', null, 30000],
  ['goal-hh', '我們的家：婚禮基金', 800000, 320000, 400, 'Heart', '#EC4899', HID, 20000],
  ['goal-archived', '已封存：舊筆電基金', 60000, 60000, null, 'Laptop', '#6B7280', null, null],
];
GOALS.forEach(([id, name, targetTWD, currentTWD, due, icon, color, householdId, monthlyPlanTWD], i) => {
  queue(`savings_goals/${id}`, { name, targetTWD, currentTWD, targetDate: due ? daysAhead(due) : null, icon, color, archivedAt: id === 'goal-archived' ? daysAgo(100) : null, householdId, monthlyPlanTWD, createdAt: daysAgo(380 - i), updatedAt: daysAgo(i) });
  for (let c = 0; c < 8; c += 1) queue(`savings_goals/${id}/contributions/c${c}`, { date: daysAgo(c * 31 + 4), amountTWD: Math.round(currentTWD / 8), note: c % 3 === 0 ? '年終獎金加碼存入' : null, byUid: c % 2 && householdId ? PARTNER : REX });
});
await put(`ai_budget_configs/${REX}`, { userId: REX, monthlyBudgetTWD: 500, warningPercent: 80, billingMode: 'paid', hardStopEnabled: true, lastAlertMonth: monthsAgoKey(1), lastAlertLevel: 'warning', updatedAt: daysAgo(2) });

// ---------------------------------------------------------------- net worth
const CASH = [
  ['ca-1', '台新 Richart 數位帳戶', 'checking', '台新銀行', 'TWD', 1234567, 1, true], ['ca-2', '國泰世華 KOKO 高利活存（活儲利率 1.5% 上限 12 萬）', 'savings', '國泰世華商業銀行', 'TWD', 12345678, 1, true],
  ['ca-3', '美元定存 12 個月期', 'time_deposit', 'Charles Schwab Bank, SSB', 'USD', 45678.9, 31.9, false], ['ca-4', '日圓活存', 'savings', '玉山銀行', 'JPY', 1280000, 0.21, false],
  ['ca-5', '家中保險箱現金', 'cash', null, 'TWD', 200000, 1, true], ['ca-6', '歐元旅遊備用金', 'other', null, 'EUR', 3200, 34.6, false],
];
CASH.forEach(([id, name, type, bank, currency, amount, fxRate, ef], i) => queue(`cash_accounts/${id}`, { name, type, bank, currency, amount, amountTWD: round2(amount * fxRate), fxRate, countsAsEmergencyFund: ef, note: i === 1 ? LONG_ZH : null, archivedAt: null, updatedAt: daysAgo(i), createdAt: daysAgo(400 - i) }));
const ASSETS = [
  ['ma-1', '台北市信義區松仁路自住宅（實價登錄估值）', 'real_estate', 38765432], ['ma-2', 'Tesla Model Y Long Range 2024', 'vehicle', 1450000],
  ['ma-3', 'Rolex Submariner Date 126610LN', 'collectible', 520000], ['ma-4', '宜蘭農地持分（與家人共有三分之一）', 'real_estate', 4321000], ['ma-5', '公司未上市股票（員工認股）', 'other', 987654],
];
ASSETS.forEach(([id, name, type, valueTWD], i) => queue(`manual_assets/${id}`, { name, type, valueTWD, asOf: daysAgo(20 + i * 10), note: i === 0 ? '依內政部實價登錄同社區近三筆成交均價估算' : null, archivedAt: null, updatedAt: daysAgo(i), createdAt: daysAgo(390 - i) }));
const LIABS = [
  ['li-1', '房貸－台北市信義區松仁路自住宅（第一順位）', 'mortgage', 18765432, 2.185, 83456], ['li-2', 'Tesla 車貸', 'car_loan', 876543, 3.2, 27123],
  ['li-3', '就學貸款', 'student_loan', 123456, 1.15, 3500], ['li-4', '跟爸媽借的裝潢款（無息）', 'personal_loan', 1500000, null, null],
];
LIABS.forEach(([id, name, type, balanceTWD, interestRate, monthlyPayment], i) => queue(`liabilities/${id}`, { name, type, balanceTWD, interestRate, monthlyPayment, asOf: daysAgo(5), note: i === 3 ? '每年過年還 30 萬' : null, archivedAt: null, updatedAt: daysAgo(i), createdAt: daysAgo(395 - i) }));
for (let m = 0; m < 24; m += 1) {
  const month = monthsAgoKey(m);
  const g = 24 - m;
  const liquidTWD = Math.round(9800000 + g * 210000 + Math.sin(m) * 400000);
  const investmentTWD = Math.round(6500000 + g * 320000 + Math.cos(m * 0.7) * 900000);
  const manualAssetsTWD = 46043086 - m * 30000;
  const rentalUnrecoveredTWD = Math.max(0, 1280000 - g * 42000);
  const insurancePensionTWD = 2200000 + g * 50000;
  const liabilitiesTWD = 19641975 + m * 95000;
  const creditCardOutstandingTWD = 60000 + ((m * 7919) % 90000);
  const installmentRemainingTWD = Math.max(0, 159800 - g * 6658);
  queue(`net_worth_snapshots/${month}`, {
    month, liquidTWD, investmentTWD, manualAssetsTWD, rentalUnrecoveredTWD, insurancePensionTWD, liabilitiesTWD, creditCardOutstandingTWD, installmentRemainingTWD,
    netWorthTWD: liquidTWD + investmentTWD + manualAssetsTWD + rentalUnrecoveredTWD + insurancePensionTWD - liabilitiesTWD - creditCardOutstandingTWD - installmentRemainingTWD,
    createdAt: twNoon(`${month}-01`),
  });
}
// 信用卡帳單：每張卡 6 期，最近一期未繳、其中一張逾期
const BILL_CARDS = [['cube', 'acc-card-cube', 20, 5], ['esun-pi', 'acc-card-esun', 28, 12], ['ctbc-linepay', 'acc-card-ctbc', 10, 25]];
for (const [pm, accountId, dueDay, stDay] of BILL_CARDS) {
  for (let m = 0; m < 6; m += 1) {
    const cycleMonth = monthsAgoKey(m);
    const dueDate = twNoon(`${cycleMonth}-${String(dueDay).padStart(2, '0')}`);
    const paid = m > 0 || (pm === 'ctbc-linepay' ? false : dueDate < now && pm === 'esun-pi');
    queue(`credit_card_bills/${pm}__${cycleMonth}`, {
      paymentMethodId: pm, accountId, cycleMonth, statementDate: twNoon(`${cycleMonth}-${String(Math.min(stDay, 28)).padStart(2, '0')}`), dueDate,
      dueDateOverride: m === 0 && pm === 'cube' ? new Date(dueDate.getTime() + 3 * 86400000) : null, overrideReason: m === 0 && pm === 'cube' ? '遇假日順延，銀行簡訊通知改到下週一扣款' : null,
      paidAt: paid ? new Date(dueDate.getTime() - 86400000) : null, paidFromAccountId: paid ? 'acc-bank-main' : null, paidViaTransferId: null,
      amount: pm === 'ctbc-linepay' ? 1234567 - m * 1000 : Math.round(between(18000, 98000)), note: m === 0 ? '含 MacBook 分期第 6 期與東京旅遊海外消費' : null, createdAt: daysAgo(m * 30 + 10), updatedAt: daysAgo(m * 30),
    });
  }
}
// 租賃
const rentalIncomes = (n, amt, payer) => Array.from({ length: n }, (_, i) => { const d = daysAgo(i * 30 + 10); return { id: `inc${i}`, monthKey: twMonth(d), date: d, amountTWD: amt + (i % 3) * 500, txId: null, payerName: payer, note: i % 4 === 0 ? '含逾期補繳' : null, createdAt: d }; });
queue('rentals/rental-coffee', { ownerId: REX, name: '咖啡廳商用義式咖啡機組（La Marzocco Linea PB 三孔＋磨豆機兩台）', assetType: 'equipment', startDate: daysAgo(330), purchaseAmountTWD: 1280000, expectedMonthlyIncome: 42000, expectedMonths: 36, defaultIncomeAccountId: 'acc-bank-main', status: 'active', closedAt: null, note: LONG_ZH, incomes: rentalIncomes(10, 42000, '晨光咖啡有限公司'), createdAt: daysAgo(330), updatedAt: daysAgo(10), archivedAt: null });
queue('rentals/rental-parking', { ownerId: REX, name: '信義區平面車位', assetType: 'real_estate', startDate: daysAgo(700), purchaseAmountTWD: 2800000, expectedMonthlyIncome: 6500, expectedMonths: null, defaultIncomeAccountId: 'acc-bank-main', status: 'active', closedAt: null, note: null, incomes: rentalIncomes(22, 6500, '樓上王先生'), createdAt: daysAgo(700), updatedAt: daysAgo(10), archivedAt: null });
queue('rentals/rental-van', { ownerId: REX, name: 'Toyota Hiace 露營車出租（已結束）', assetType: 'vehicle', startDate: daysAgo(900), purchaseAmountTWD: 650000, expectedMonthlyIncome: 30000, expectedMonths: 24, defaultIncomeAccountId: null, status: 'closed', closedAt: daysAgo(150), note: '賣掉了，回本 112%', incomes: rentalIncomes(24, 30500, '車泊旅行社'), createdAt: daysAgo(900), updatedAt: daysAgo(150), archivedAt: null });
// 分期
const INST = [
  ['inst-mac', 'Apple MacBook Pro 16 吋 M5 Max 64GB/2TB（太空黑）＋ AppleCare+', 159800, 24, 0, 'acc-card-cube', 'shopping', 175, 6, 'active'],
  ['inst-phone', 'iPhone 18 Pro Max 1TB', 59900, 12, 0, 'acc-card-esun', 'shopping', 95, 3, 'active'],
  ['inst-dental', '植牙療程（兩顆）', 180000, 12, 3600, 'acc-card-ctbc', 'medical', 40, 1, 'active'],
  ['inst-sofa', 'HAY Mags Soft 三人座沙發', 123456, 6, 0, 'acc-card-cube', 'home', 300, 6, 'completed'],
  ['inst-cancel', '健身房兩年約（已解約）', 48000, 24, 1200, 'acc-card-esun', 'entertainment', 250, 4, 'cancelled'],
  ['inst-big', '全室裝潢工程款', 12345678, 24, 123456, 'acc-card-ctbc', 'home', 20, 0, 'active'],
];
INST.forEach(([id, title, total, periods, feeTWD, cardAccountId, category, started, paidPeriods, status]) => queue(`installment_plans/${id}`, {
  ownerId: REX, title, totalAmountTWD: total, periods, perPeriodTWD: Math.round((total + feeTWD) / periods), feeTWD, cardAccountId, category, startDate: daysAgo(started), paidPeriods, status,
  note: id === 'inst-mac' ? '零利率，每月 5 號結帳日入帳' : null, lastPostedAt: paidPeriods ? daysAgo(started % 30) : null, cancelledAt: status === 'cancelled' ? daysAgo(120) : null, createdAt: daysAgo(started), updatedAt: daysAgo(2),
}));
// 墊付團
const PAYOUT = [
  ['pg-1', '2026 部門尾牙場地與餐費（晶華酒店宴會廳 5 桌）', 12, 186000, [['林經理', 18600, daysAgo(5), '轉帳'], ['陳大文', 15500, null, null], [LONG_EN, 15500, null, null], ['王小明', 15500, daysAgo(3), 'LINE Pay'], ['張雅婷（代收她先生的份）', 31000, null, null], ['owner（自己）', 15500, daysAgo(12), null]]],
  ['pg-2', '團購：北海道生乳捲', 30, 4800, [['伴侶', 1200, daysAgo(28), '現金'], ['媽媽', 2400, daysAgo(27), '現金'], ['同事 Amy', 1200, daysAgo(25), '街口']]],
  ['pg-3', '同學會包廂', 6, 12800, [['阿明', 3200, null, null], ['小華', 3200, null, null], ['大雄', 3200, null, null]]],
];
PAYOUT.forEach(([id, title, d, total, ps]) => queue(`payout_groups/${id}`, {
  ownerId: REX, title, date: daysAgo(d), totalAmountTWD: total, note: id === 'pg-1' ? LONG_ZH : null, linkedTxId: null,
  participants: ps.map(([name, amountTWD, paidAt, paymentMethod], i) => ({ id: `p${i}`, name, amountTWD, baseAmountTWD: amountTWD, sharedByOthers: false, paidAt, paymentMethod, note: i === 1 ? '說月底發薪再給' : null })),
  createdAt: daysAgo(d), updatedAt: daysAgo(1), archivedAt: null,
}));

// ---------------------------------------------------------------- stocks / candles / history
const STOCKS = {
  '0050': ['元大台灣50', 198.5, 1.2, 'TW'], '00878': ['國泰永續高股息', 22.4, -0.08, 'TW'], 2330: ['台積電', 1085, 15, 'TW'], VOO: ['Vanguard S&P 500', 548.2, -2.1, 'US'],
  2317: ['鴻海精密工業', 212.5, -6.5, 'TW'], 2454: ['聯發科', 1435, 35, 'TW'], 2603: ['長榮海運', 187, -4.5, 'TW'], '00679B': ['元大美國政府20年期(以上)債券ETF基金', 27.86, -0.12, 'TW'],
  '006208': ['富邦台灣采吉50基金', 121.35, 0.75, 'TW'], 2881: ['富邦金融控股', 92.3, 0.4, 'TW'], 3008: ['大立光電', 2455, -85, 'TW'], '00919': ['群益台灣精選高息ETF', 23.71, 0.05, 'TW'],
  NVDA: ['NVIDIA Corporation', 1432.56, 48.9, 'US'], AAPL: ['Apple Inc.', 268.4, -1.35, 'US'], TSLA: ['Tesla, Inc.', 312.8, -22.4, 'US'], MSFT: ['Microsoft Corporation', 512.3, 3.1, 'US'],
  'BRK.B': ['Berkshire Hathaway Inc. Class B Common Stock', 498.75, 0.8, 'US'], QQQ: ['Invesco QQQ Trust Series 1', 588.1, 4.2, 'US'], TLT: ['iShares 20+ Year Treasury Bond ETF', 86.4, -0.6, 'US'], SPY: ['SPDR S&P 500 ETF Trust', 596.3, -2.3, 'US'],
};
const candleSeries = (endPrice, days, vol) => { // 由今天往回走的隨機漫步，回傳舊→新
  const out = []; let close = endPrice;
  for (let i = 0; i < days * 1.5 && out.length < days; i += 1) {
    const d = daysAgo(i); if (!isWeekday(d)) continue;
    const open = close * (1 + between(-0.012, 0.012)); const high = Math.max(open, close) * (1 + between(0, 0.01)); const low = Math.min(open, close) * (1 - between(0, 0.01));
    out.push({ date: twKey(d), open: round2(open), high: round2(high), low: round2(low), close: round2(close), volume: Math.round(vol * between(0.4, 2.2)) });
    close = open * (1 - between(-0.004, 0.006));
  }
  return out.reverse();
};
const CANDLES = {};
for (const [sym, [name, price, change, market]] of Object.entries(STOCKS)) {
  const currency = market === 'TW' ? 'TWD' : 'USD';
  const series = candleSeries(price, sym === '2330' || sym === '0050' ? 420 : 270, market === 'TW' ? 28000000 : 52000000);
  CANDLES[sym] = series;
  const last = series[series.length - 1];
  queue(`stocks/${sym}`, {
    symbol: sym, name, market, currency, currentPrice: price, prevClose: round2(price - change), change, changePercent: round2((change / (price - change)) * 100),
    high: last.high, low: last.low, open: last.open, volume: last.volume, updatedAt: hoursAgo(1),
    upcomingDividend: ['0050', '00878', '2330', 'AAPL', '00919'].includes(sym) ? { exDate: twKey(daysAhead(sym === '2330' ? 6 : 20)), cashPerShare: sym === '2330' ? 5.5 : 0.55, stockPerShare: 0, kind: 'cash', source: 'twse' } : null,
  });
  for (const c of series) queue(`stocks/${sym}/candles/${c.date.replace(/-/g, '')}`, { ...c, source: 'seed' });
}
// 盤中 history（2330 + 0050：近 5 個交易日每 15 分）
for (const sym of ['2330', '0050', 'NVDA']) {
  const base = STOCKS[sym][1]; let n = 0;
  for (let d = 0; d < 9 && n < 5 * 19; d += 1) {
    if (!isWeekday(daysAgo(d))) continue;
    for (let k = 0; k < 19; k += 1) {
      const ts = new Date(`${twKey(daysAgo(d))}T09:00:00+08:00`); ts.setMinutes(ts.getMinutes() + k * 15);
      if (ts > now) continue;
      queue(`stocks/${sym}/history/${ts.getTime()}`, { price: round2(base * (1 - d * 0.004 + Math.sin(k / 3 + d) * 0.006)), volume: Math.round(between(200000, 3000000)), timestamp: ts });
      n += 1;
    }
  }
}

// ---------------------------------------------------------------- portfolio / watchlist / plans / snapshots / realized / dividends
const POS = [
  ['2330', 3000, 512.35, 'TWD', '長期核心持股，2019 年起分批買進，除非基本面轉壞否則不賣'], ['0050', 25000, 128.4, 'TWD', null], ['00878', 120000, 21.85, 'TWD', '領息用'],
  ['2317', 15000, 236.8, 'TWD', '追高套牢中'], ['2454', 800, 978, 'TWD', null], ['2603', 12000, 231.5, 'TWD', LONG_ZH], ['00679B', 300000, 31.2, 'TWD', '債券部位，等降息'],
  ['3008', 300, 3120, 'TWD', '虧損最大的一筆'], ['2881', 20000, 61.2, 'TWD', null], ['006208', 8000, 86.9, 'TWD', null],
  ['NVDA', 420, 187.33, 'USD', 'Split-adjusted cost basis'], ['AAPL', 350, 142.1, 'USD', null], ['TSLA', 260, 398.4, 'USD', 'Bought the top'], ['VOO', 180, 402.75, 'USD', null], ['BRK.B', 95, 512.6, 'USD', null], ['TLT', 1500, 104.2, 'USD', null],
];
const POS_VAL = [];
POS.forEach(([symbol, shares, avgCost, currency, notes], i) => {
  const third = Math.round(shares / 3);
  queue(`portfolio/pos-${symbol.replace('.', '_')}`, {
    userId: REX, symbol, shares, avgCost, currency, notes,
    lots: [{ date: daysAgo(900 - i * 20), shares: third, price: round2(avgCost * 0.9), fee: 120 }, { date: daysAgo(500 - i * 10), shares: third, price: round2(avgCost), fee: 85 }, { date: daysAgo(120 - i * 3), shares: shares - 2 * third, price: round2(avgCost * 1.1), fee: 0 }],
  });
  const fx = currency === 'USD' ? 31.9 : 1; const price = STOCKS[symbol][1];
  POS_VAL.push({ symbol, market: STOCKS[symbol][3], shares, avgCost, currentPrice: price, fxRate: fx, costTWD: Math.round(shares * avgCost * fx), valueTWD: Math.round(shares * price * fx), dayChangeTWD: Math.round(shares * STOCKS[symbol][2] * fx) });
});
const WATCH = [['2330', '跌破季線再加碼'], ['2454', null], ['NVDA', 'Earnings on the 19th — watch data-center guidance and gross margin commentary closely'], ['TSLA', null], ['00919', '配息率'], ['MSFT', null], ['QQQ', null], ['2603', LONG_ZH], ['SPY', 'benchmark'], ['3008', null], ['AAPL', null], ['006208', null]];
WATCH.forEach(([symbol, note], i) => queue(`watchlist/${REX}_${symbol}`, { userId: REX, symbol, ...(note ? { note } : {}), addedAt: daysAgo(i * 11 + 1) }));
const PLANS = [
  ['plan-retire', '55 歲提早退休計畫（FIRE・4% 法則・年支出 150 萬）', 37500000, 5400, 80000, 6.5, null, 'portfolio', 'growth', true],
  ['plan-kid', '小孩出國念書基金', 8000000, 3650, 25000, 5, 876543, 'manual', 'balanced', false],
  ['plan-safe', '保守型債券梯', 3000000, 1500, 15000, 3, 1234567, 'manual', 'conservative', false],
];
PLANS.forEach(([id, name, targetAmountTWD, due, monthlyContributionTWD, expectedAnnualReturnPct, currentAmountTWD, fundingSource, riskLevel, isRetirement], i) => queue(`investment_plans/${id}`, {
  userId: REX, name, targetAmountTWD, targetDate: daysAhead(due), monthlyContributionTWD, expectedAnnualReturnPct, currentAmountTWD, fundingSource, riskLevel,
  notes: i === 0 ? LONG_ZH : null, alertEnabled: true, isRetirement, archivedAt: null, createdAt: daysAgo(300 - i), updatedAt: daysAgo(i),
}));
// 400 天快照（含假日，像排程每天跑）；最後一天 = 目前持倉市值
const totalCostTWD = POS_VAL.reduce((s, p) => s + p.costTWD, 0);
const totalValueNow = POS_VAL.reduce((s, p) => s + p.valueTWD, 0);
let prevValue = null;
for (let i = 400; i >= 0; i -= 1) {
  const date = twKey(daysAgo(i));
  const f = 1 - (i / 400) * 0.42 + Math.sin(i / 17) * 0.05 + Math.sin(i / 5) * 0.012 - (i > 180 && i < 230 ? 0.09 : 0);
  const value = Math.round(totalValueNow * f);
  const cost = Math.round(totalCostTWD * (1 - (i / 400) * 0.25));
  const positions = POS_VAL.map((p) => { const v = Math.round(p.valueTWD * f); const c = Math.round(p.costTWD * (1 - (i / 400) * 0.25)); return { ...p, currentPrice: round2(p.currentPrice * f), costTWD: c, valueTWD: v, pnlTWD: v - c, pnlPct: round2(((v - c) / c) * 100), dayChangeTWD: Math.round(p.dayChangeTWD * (i % 2 ? 1 : -0.6)) }; });
  const agg = (mk) => { const ps = positions.filter((p) => p.market === mk); const v = ps.reduce((s, p) => s + p.valueTWD, 0); const c = ps.reduce((s, p) => s + p.costTWD, 0); return { valueTWD: v, costTWD: c, pnlTWD: v - c, dayChangeTWD: ps.reduce((s, p) => s + p.dayChangeTWD, 0) }; };
  const dayChange = prevValue == null ? 0 : value - prevValue;
  queue(`portfolio_snapshots/${date}`, {
    date, totalValueTWD: value, totalCostTWD: cost, unrealizedPnlTWD: value - cost, unrealizedPnlPct: round2(((value - cost) / cost) * 100), dayChangeTWD: dayChange, dayChangePct: prevValue ? round2((dayChange / prevValue) * 100) : 0,
    byMarket: { TW: agg('TW'), US: agg('US') }, positions, fxRatesUsed: { USD_TWD: 31.9 }, createdAt: twNoon(date),
  });
  prevValue = value;
}
const REAL = [['2330', 'TW', 1000, 420, 1050], ['2317', 'TW', 5000, 240, 198.5], ['NVDA', 'US', 100, 95.4, 1380], ['TSLA', 'US', 80, 410, 288.3], ['2603', 'TW', 8000, 245, 176], ['0050', 'TW', 3000, 118, 190], ['AAPL', 'US', 50, 150, 262], ['3008', 'TW', 100, 3300, 2390], ['00878', 'TW', 30000, 19.8, 22.9], ['MSFT', 'US', 40, 380, 505], ['2454', 'TW', 200, 890, 1460], ['TLT', 'US', 500, 110, 85], ['2881', 'TW', 5000, 58, 91], ['QQQ', 'US', 60, 430, 580], ['00679B', 'TW', 100000, 32.5, 27.9], ['BRK.B', 'US', 20, 470, 500]];
REAL.forEach(([symbol, market, shares, avgCost, sellPrice], i) => {
  const currency = market === 'US' ? 'USD' : 'TWD'; const fxRate = market === 'US' ? 31.9 : 1; const costTWD = Math.round(shares * avgCost * fxRate); const proceedsTWD = Math.round(shares * sellPrice * fxRate);
  queue(`realized_lots/rl-${i}`, { symbol, market, sellDate: daysAgo(i * 22 + 3), shares, avgCost, sellPrice, currency, fxRate, costTWD, proceedsTWD, realizedPnlTWD: proceedsTWD - costTWD, note: i % 4 === 0 ? `停利出場；${LONG_ZH}` : null, costBasisMethod: i % 2 ? 'fifo' : 'average', costBasisFallback: i === 5, buyDate: daysAgo(i * 22 + 400), createdAt: daysAgo(i * 22 + 3) });
});
const DIVS = [['0050', 'TW', 2.7, 25000], ['00878', 'TW', 0.55, 120000], ['2330', 'TW', 5.5, 3000], ['2881', 'TW', 3, 20000], ['00679B', 'TW', 0.33, 300000], ['AAPL', 'US', 0.26, 350], ['VOO', 'US', 1.78, 180], ['MSFT', 'US', 0.83, 40], ['TLT', 'US', 0.31, 1500], ['2317', 'TW', 5.8, 15000], ['006208', 'TW', 1.9, 8000], ['2454', 'TW', 54, 800]];
for (let i = 0; i < 30; i += 1) {
  const [symbol, market, amountPerShare, shares] = DIVS[i % DIVS.length]; const fxRate = market === 'US' ? 31.9 : 1;
  queue(`dividends/div-${i}`, { symbol, market, payDate: daysAgo(i * 13 + 2), amountPerShare, shares, currency: market === 'US' ? 'USD' : 'TWD', fxRate, amountTWD: round2(amountPerShare * shares * fxRate), note: i % 5 === 0 ? '已扣二代健保補充保費 2.11% 與美股 30% 預扣稅' : null, createdAt: daysAgo(i * 13 + 2) });
}

// ---------------------------------------------------------------- swing lab
const TW_SYMS = Object.entries(STOCKS).filter(([, v]) => v[3] === 'TW').map(([s]) => s);
queue('swing_strategy_configs/swing-default', {
  userId: REX, name: '短波段動能突破實驗（強勢股回測支撐＋量能確認）v3', active: true, universeSymbols: TW_SYMS, topN: 8, maxOpenPositions: 5, maxPositionPctOfAssets: 5, riskPerTradePct: 0.75,
  virtualCapitalTWD: 12345678, perTradeBudgetTWD: 2000000, stopLossPct: 4, atrStopMultiplier: 1.5, takeProfitPct: 8, trailingStopPct: 4, maxHoldingDays: 5, minAvgVolume20: 500000, maxMa5DeviationPct: 8,
  minimumRewardRiskRatio: 1.5, marketTrendFilterEnabled: true, weights: { return5: 1, return10: 1, rs20: 1.2, breakout20: 1.4, volumeRatio20: 1, ma5DeviationPenalty: 1 }, notifyEnabled: true, createdAt: daysAgo(200), updatedAt: daysAgo(1),
});
const swingCand = (sym, rank) => { const close = STOCKS[sym][1]; return {
  rank, symbol: sym, name: STOCKS[sym][0], score: round2(92.5 - rank * 6.3), close, volume: 28123456, avgVolume20: 21987654, return5: round2(between(-0.03, 0.12)), return10: round2(between(-0.05, 0.18)), return20: round2(between(-0.08, 0.3)),
  rs20: round2(between(-0.05, 0.2)), breakout20: rank % 2 === 1, volumeRatio20: round2(between(0.6, 3.4)), ma5DeviationPct: round2(between(-2, 7.5)), atr14: round2(close * 0.022), atrPct: 2.2, aboveMa20: rank % 3 !== 0,
  rewardRiskRatio: round2(between(1.2, 3.1)), suggestedStopPrice: round2(close * 0.96), suggestedTakeProfitPrice: round2(close * 1.08),
  notes: ['突破 20 日高點且量能放大 2.4 倍', rank % 2 ? '外資連五日買超、投信同步加碼，籌碼面偏多但乖離已偏大需留意追高風險' : '距 5 日線乖離偏高'],
}; };
let runN = 0;
for (let i = 0; runN < 12; i += 1) {
  const d = daysAgo(i); if (!isWeekday(d)) continue; const runDate = twKey(d);
  queue(`swing_signal_runs/${runDate}`, {
    runDate, market: 'TW', status: runN === 4 ? 'no_candidates' : 'ok', configId: 'swing-default', configName: '短波段動能突破實驗（強勢股回測支撐＋量能確認）v3', generatedAt: twNoon(runDate), benchmarkSymbol: '0050', benchmarkReturn20: 0.0345,
    strategyVersion: 'swing-v3.2.1', marketTrendUp: runN % 5 !== 3, scanned: 1234, eligible: 87, filteredLowVolume: 612, filteredOverheat: 143, filteredTrend: 298, filteredRewardRisk: 94, insufficientData: 12,
    reason: runN === 4 ? '大盤跌破季線，市場趨勢濾網啟動，今日不產生候選' : null, errors: runN === 2 ? ['2603: candles fetch timeout after 3 retries (TWSE 429 Too Many Requests)'] : [],
    candidates: runN === 4 ? [] : TW_SYMS.slice(0, 8).map((s, k) => swingCand(s, k + 1)),
  });
  runN += 1;
}
const SW_EXIT = ['stop_loss', 'take_profit', 'trailing_stop', 'time_exit', 'manual_skip'];
for (let i = 0; i < 30; i += 1) {
  const sym = TW_SYMS[i % TW_SYMS.length]; const px = STOCKS[sym][1]; const status = i < 4 ? 'open' : i < 6 ? 'planned' : i % 9 === 0 ? 'skipped' : 'closed';
  const ret = round2(between(-6.5, 11.5)); const shares = Math.max(1000, Math.round(2000000 / px / 1000) * 1000); const entry = round2(px * (1 - i * 0.004));
  queue(`swing_paper_trades/swt-${i}`, {
    userId: REX, signalRunId: twKey(daysAgo(i * 3 + 1)), symbol: sym, name: STOCKS[sym][0], status, plannedEntryDate: twKey(daysAgo(i * 3)), entryDate: status === 'planned' || status === 'skipped' ? null : twKey(daysAgo(i * 3)),
    entryPrice: status === 'planned' || status === 'skipped' ? null : entry, shares, plannedCapitalTWD: Math.round(shares * entry), plannedRiskTWD: Math.round(shares * entry * 0.04), strategyVersion: 'swing-v3.2.1',
    stopPrice: round2(entry * 0.96), takeProfitPrice: round2(entry * 1.08), trailingStopPct: 4, maxHoldingDays: 5, highestPrice: status === 'planned' ? null : round2(entry * 1.05),
    exitDate: status === 'closed' ? twKey(daysAgo(Math.max(0, i * 3 - 4))) : null, exitPrice: status === 'closed' ? round2(entry * (1 + ret / 100)) : null, exitReason: status === 'closed' ? SW_EXIT[i % 4] : status === 'skipped' ? 'manual_skip' : null,
    grossReturnPct: status === 'closed' ? ret : null, costPct: 0.585, netReturnPct: status === 'closed' ? round2(ret - 0.585) : null, realizedPnlTWD: status === 'closed' ? Math.round(shares * entry * (ret - 0.585) / 100) : null,
    unrealizedPnlTWD: status === 'open' ? Math.round(shares * entry * between(-0.03, 0.06)) : null, holdingDays: status === 'closed' ? 1 + (i % 5) : status === 'open' ? i + 1 : 0, maxFavorablePct: round2(Math.max(ret, 0) + 1.2), maxAdversePct: round2(Math.min(ret, 0) - 0.8),
    notes: i % 6 === 0 ? `開盤跳空超過 3% 放棄追價；${LONG_ZH}` : null, createdAt: daysAgo(i * 3 + 1), updatedAt: hoursAgo(i * 5 + 1),
  });
}
queue(`swing_paper_summaries/${REX}`, { userId: REX, updatedAt: hoursAgo(2), virtualCapitalTWD: 12345678, openTrades: 4, closedTrades: 21, skippedTrades: 3, realizedPnlTWD: 1234567, unrealizedPnlTWD: -345678, equityTWD: 13234567, totalReturnPct: 7.2, winRate: 57.14, averageWinPct: 6.83, averageLossPct: -3.94, expectancyPct: 2.21, profitFactor: 1.87, maxConsecutiveLosses: 4, maxDrawdownPct: 12.34 });
for (let i = 0; i < 3; i += 1) queue(`swing_paper_sync_runs/${twKey(daysAgo(i))}`, { runDate: twKey(daysAgo(i)), generatedAt: hoursAgo(i * 24 + 2), status: 'ok', scanned: 9, opened: 2, closed: 1, noCandles: 0, noEntryCandle: 1 });

// ---------------------------------------------------------------- FX
const PAIRS = [['USD', 'TWD', 31.9], ['JPY', 'TWD', 0.2103], ['EUR', 'TWD', 34.62], ['IDR', 'TWD', 0.00195], ['USD', 'JPY', 151.68], ['GBP', 'TWD', 40.85], ['CNY', 'TWD', 4.412], ['KRW', 'TWD', 0.02291]];
PAIRS.forEach(([base, quote, rate], i) => {
  const id = `${base}_${quote}`;
  queue(`fx_pairs/${id}`, { base, quote, enabled: i !== 7, createdAt: daysAgo(300 - i) });
  queue(`fx_rates/${id}`, { base, quote, rate, source: 'seed', updatedAt: hoursAgo(1) });
  let r = rate;
  for (let d = 0; d < 370; d += 1) { const date = twKey(daysAgo(d)); queue(`fx_rates/${id}/candles/${date}`, { date, rate: Number(r.toPrecision(6)), source: 'seed' }); r *= 1 + between(-0.004, 0.0042); }
});
const ALERTS = [
  ['al-1', 'fx', 'USD_TWD', 'below', 31.5, 'price', true, false, 2, '美金跌破 31.5 分批換匯（每次 5,000 美元，共三次）'], ['al-2', 'fx', 'JPY_TWD', 'below', 0.205, 'price', true, true, null, '日圓甜甜價，換 50 萬日圓旅費'],
  ['al-3', 'fx', 'EUR_TWD', 'above', 36, 'price', false, false, 40, null], ['al-4', 'fx', 'USD_JPY', 'above', 155, 'price', true, false, null, null],
  ['al-5', 'stock', '2330', 'below', 1000, 'price', true, false, 12, '跌破千元加碼'], ['al-6', 'stock', 'NVDA', 'above', 70, 'rsi14', true, false, 1, 'RSI 過熱提醒'],
  ['al-7', 'stock', 'TSLA', 'below', 200, 'ma', true, false, null, '跌破 200 日均線停損'], ['al-8', 'stock', '2454', 'above', 0, 'high52w', true, true, 6, null],
  ['al-9', 'stock', '3008', 'below', -20, 'vsCost', true, false, 3, `${LONG_ZH}`], ['al-10', 'stock', '2330', 'above', 30, 'weight', true, false, null, '單一持股超過 30% 再平衡'],
  ['al-11', 'stock', '2317', 'below', 0, 'low52w', false, false, null, null], ['al-12', 'stock', 'BRK.B', 'above', 520, 'price', true, false, null, null],
];
ALERTS.forEach(([id, type, target, direction, threshold, metric, active, oneShot, last, notes], i) => queue(`alerts/${id}`, { userId: REX, type, target, direction, threshold, metric, active, cooldownMinutes: 60 * (1 + (i % 4)), oneShot, lastTriggeredAt: last == null ? null : daysAgo(last), createdAt: daysAgo(100 - i), ...(notes ? { notes } : {}) }));
for (let i = 0; i < 40; i += 1) { const a = ALERTS[i % ALERTS.length]; queue(`alert_logs/alog-${i}`, { alertId: a[0], triggeredAt: hoursAgo(i * 19 + 2), triggerValue: a[1] === 'fx' ? round2(a[4] * (1 + between(-0.01, 0.01)) * 10000) / 10000 : round2(STOCKS[a[2]][1] * between(0.95, 1.05)), notificationSent: i % 7 !== 0, channel: i % 7 === 0 ? 'none' : 'telegram' }); }

// ---------------------------------------------------------------- TAIFEX
const TX_DAYS = []; for (let i = 0; TX_DAYS.length < 260; i += 1) { const d = daysAgo(i); if (isWeekday(d)) TX_DAYS.push(twKey(d)); } TX_DAYS.reverse();
let txClose = 19800; const TX_CLOSE = TX_DAYS.map((_, i) => { txClose = Math.round(txClose * (1 + between(-0.013, 0.0152)) + Math.sin(i / 9) * 30); return txClose; });
const lastTx = TX_CLOSE[TX_CLOSE.length - 1];
await put('taifex_configs/default', { mode: 'auto', product: 'TX', initialCapital: 10000000, riskPerTradePct: 1.5, maxContracts: 12, allowShort: true, maxDrawdownPct: 20, commissionPerSide: 50, slippagePoints: 1, marginPerContract: 322000, notifyEnabled: true, strategyVariant: 'baseline', intradayEnabled: true, updatedAt: daysAgo(3) });
const taifexTicket = { kind: 'reverse', productLabel: '臺股期貨（大台 TX）', targetSide: 'short', targetContracts: 8, refPrice: lastTx, buffer: 15, steps: [
  { action: 'close', label: '平倉多單 5 口（先平後開，避免保證金不足）', side: 'sell', qty: 5, orderType: 'MWP', price: null, tif: 'ROD', offset: '平倉' },
  { action: 'open', label: '新倉空單 8 口', side: 'sell', qty: 8, orderType: 'LMT', price: lastTx - 15, tif: 'ROD', offset: '新倉' }],
  stopOrder: { side: 'buy', qty: 8, price: lastTx + 386, stopPoints: 386, note: '2×ATR 停損，成交後請立刻掛觸價單（MIT），夜盤同樣有效' }, riskTWD: 617600, riskPct: 5.12, marginTWD: 2576000, validFrom: twKey(daysAhead(1)),
  notes: ['隔日 08:45 開盤以範圍市價（MWP）成交', '若開盤跳空超過 1.5×ATR 則放棄本次反手，等待下一根訊號', LONG_ZH], generatedAt: hoursAgo(4), signalDate: TX_DAYS[TX_DAYS.length - 1] };
const TF_ACCS = [['default', 'baseline', 12345678, 5], ['conservative', 'conservative', 10876543, 2], ['aggressive', 'aggressive', 8765432, 12], ['optimized', 'optimized', 13579246, 6]];
for (const [id, variant, equity, contracts] of TF_ACCS) {
  let e = 10000000; const curve = TX_DAYS.slice(-180).map((d, i) => { e = Math.round(e + (equity - 10000000) / 180 + Math.sin(i / 6 + contracts) * 180000); return { d, e, p: i % 23 < 11 ? contracts : i % 23 < 17 ? -contracts : 0, c: TX_CLOSE[TX_CLOSE.length - 180 + i] }; });
  curve[curve.length - 1].e = equity;
  queue(`taifex_paper_accounts/${id}`, {
    product: 'TX', epoch: 3, equity, initialCapital: 10000000, peakEquity: Math.max(equity, 14234567), maxDrawdownPct: id === 'aggressive' ? 23.45 : 11.87,
    position: { side: 'long', contracts, entryPrice: lastTx - 412, entryDate: TX_DAYS[TX_DAYS.length - 6], stop: lastTx - 380, extreme: lastTx + 95, bars: 6, source: id === 'default' ? 'auto' : 'manual' },
    pending: id === 'default' ? { target: 'short', contracts: 8, source: 'auto', stopPoints: 386, signalDate: TX_DAYS[TX_DAYS.length - 1], createdAt: hoursAgo(4), note: '綜合分數翻空且事件風險解除，隔日開盤反手' } : null,
    lastBarDate: TX_DAYS[TX_DAYS.length - 1], lastClose: lastTx, halted: id === 'aggressive', haltReason: id === 'aggressive' ? '回撤超過 20% 上限（23.45%），自動停止開新倉；請到設定頁重置帳戶或調高上限後才會恢復' : null,
    realizedPnl: equity - 10000000 - 412 * 200 * contracts, totalCosts: 187654, tradeCount: 86, winCount: 41, startDate: TX_DAYS[TX_DAYS.length - 180], equityCurve: curve,
    lastVeto: { date: TX_DAYS[TX_DAYS.length - 3], reason: 'FOMC 利率決議前一日，事件風險否決新倉（僅允許減碼）' }, updatedAt: hoursAgo(2), modelVersion: 'taifex-v2.4.0', variant,
    params: { entry: 0.35, exit: 0.05, adxTrend: 18, chopDamp: 0.6, stopAtr: 2, trailAtr: 3 },
    live: { date: twKey(now), time: '11:42', price: lastTx + 63, estimated: id !== 'default', unrealized: (412 + 63) * 200 * contracts, stopDistance: 443 },
    ticket: id === 'default' ? taifexTicket : null,
  });
}
const TF_EVENTS = [{ type: 'fomc', date: twKey(daysAhead(2)), importance: 'high', note: 'FOMC 利率決議與鮑爾記者會（台北時間週四凌晨 02:00 / 02:30）' }, { type: 'settlement', date: twKey(daysAhead(6)), importance: 'medium', note: '台指期月結算' }, { type: 'earnings', date: twKey(daysAhead(8)), importance: 'high', note: 'NVIDIA 財報' }, { type: 'cpi', date: twKey(daysAhead(1)), importance: 'high', note: '美國 10 月 CPI' }];
TX_DAYS.slice(-130).forEach((date, k) => {
  const idx = TX_DAYS.length - 130 + k; const close = TX_CLOSE[idx]; const comp = round2(Math.sin(k / 7) * 0.8); const desired = comp > 0.35 ? 'long' : comp < -0.35 ? 'short' : 'flat';
  queue(`taifex_signals/${date}`, {
    date, contract: 'TX202612', close, modelVersion: 'taifex-v2.4.0',
    indicators: { ema20: close - 120.55, ema60: close - 340.12, atr20: 193.4, adx14: round2(14 + (k % 20)), donchianHigh: close + 210, donchianLow: close - 620 },
    factors: { trend: { raw: 1.23, score: round2(comp) }, breakout: { raw: 0.62, score: round2(comp * 0.8) }, tsmom: { raw: 0.084, score: round2(comp * 0.6) }, foreignFlow: { raw: -12345, score: round2(-comp * 0.3) }, pcr: { raw: 1.18, score: k % 4 ? 0.2 : null } },
    quantScore: comp, coverage: k % 4 ? 1 : 0.9, sentimentAdj: round2(Math.cos(k) * 0.1), composite: round2(comp + Math.cos(k) * 0.1), trending: k % 20 > 4,
    reasons: ['EMA20 > EMA60 且 ADX 14 日 > 18，趨勢成立', '收盤突破 20 日唐奇安通道上緣', `外資期貨淨空單 ${(12345 + k * 37).toLocaleString()} 口，較前日增加 1,234 口，籌碼面偏空`, 'Put/Call Ratio 1.18，散戶偏多（反指標）'],
    eventRisk: k % 9 === 0, riskEvents: k % 9 === 0 ? TF_EVENTS.slice(0, 2) : [],
    sentiment: { sentiment: round2(Math.cos(k) * 0.6), confidence: 0.72, summary: '美股四大指數收紅、費半大漲 2.3%，台積電 ADR 上漲 1.8%；惟市場觀望本週 FOMC 與 CPI，夜盤量縮。整體輿情中性偏多，但事件風險升高。' },
    desired, decisionReasons: [desired === 'flat' ? '綜合分數落在出場區間內，維持空手' : `綜合分數 ${comp} 超過進場門檻 0.35`, '風險控管：單筆風險 1.5%，依 2×ATR 停損換算口數', k % 9 === 0 ? '事件風險日：口數減半' : '無事件風險'],
    suggestedContracts: desired === 'flat' ? 0 : 8, stopPoints: 386, sizingLimitedBy: k % 5 === 0 ? 'maxContracts' : null, product: 'TX', mode: 'auto',
    position: desired === 'flat' ? null : { side: desired, contracts: 5, entryPrice: close - 412, stop: close - 380, entryDate: TX_DAYS[Math.max(0, idx - 6)] },
    pending: k === 129 ? { target: 'short', contracts: 8, source: 'auto' } : null, equity: 10000000 + k * 18000 + Math.round(Math.sin(k / 5) * 250000), generatedAt: twNoon(date),
  });
});
const TF_EXIT = ['signal', 'stop', 'reverse', 'manual', 'reset', 'halt'];
for (let i = 0; i < 90; i += 1) {
  const closeIdx = TX_DAYS.length - 1 - i * 2; const openIdx = Math.max(0, closeIdx - 1 - (i % 7)); const side = i % 3 === 0 ? 'short' : 'long'; const contracts = 1 + (i % 12);
  const entryPrice = TX_CLOSE[openIdx]; const exitPrice = TX_CLOSE[closeIdx]; const pnlPoints = side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice; const grossPnl = pnlPoints * 200 * contracts; const costs = contracts * 2 * 180;
  queue(`taifex_paper_trades/tft-${i}`, { side, contracts, product: i % 10 === 0 ? 'MTX' : 'TX', openDate: TX_DAYS[openIdx], closeDate: TX_DAYS[closeIdx], entryPrice, exitPrice, pnlPoints, grossPnl, costs, netPnl: grossPnl - costs, holdingBars: closeIdx - openIdx, exitReason: TF_EXIT[i % 6], source: i % 8 === 0 ? 'manual' : 'auto', entryComposite: round2(between(-0.9, 0.9)), epoch: 3, createdAt: twNoon(TX_DAYS[closeIdx]), accountId: TF_ACCS[i % 4][0], intraday: i % 6 === 1, estimated: i % 11 === 0 });
}
for (let i = 0; i < 5; i += 1) {
  const date = twKey(daysAgo(i));
  queue(`taifex_sentiment/${date}`, { date, provider: 'claude-scheduled-task', receivedAt: hoursAgo(i * 24 + 3), pushCount: 2 + i,
    overall: { sentiment: 0.35, confidence: 0.72, summary: '美股四大指數收紅、費半大漲 2.3%，台積電 ADR 上漲 1.8%；惟市場觀望本週 FOMC 與 CPI，夜盤量縮。外資期貨淨空單小幅回補，整體輿情中性偏多，但事件風險升高，建議降低槓桿。', sources: [{ title: 'Reuters: Wall Street ends higher as chipmakers rally ahead of Fed decision and key inflation data', url: 'https://www.reuters.com/markets/us/wall-street-ends-higher-chipmakers-rally-2026-11-10/' }, { title: '經濟日報：外資回補台指期空單', url: 'https://money.udn.com/money/story/5607/0000000' }] },
    drivers: [{ type: 'us_market', direction: 1, note: '標普 500 +0.8%、那斯達克 +1.3%' }, { type: 'tsmc_adr', direction: 1, note: '台積電 ADR +1.8%，溢價 21%' }, { type: 'fed', direction: 0, note: '利率期貨顯示 12 月降息機率 62%' }, { type: 'foreign_flow', direction: -1, note: '外資現貨賣超 123.45 億，期貨淨空單 34,567 口' }, { type: 'geopolitics', direction: -1, note: LONG_ZH }, { type: 'fx', direction: 0, note: '新台幣收 31.9' }],
    events: TF_EVENTS, indicators: { vix: 17.42, spxChangePct: 0.83, soxChangePct: 2.31, tsmAdrChangePct: 1.84, nightSessionChangePct: -0.27 } });
}
const tfMetrics = (r, extra = {}) => ({ totalReturnPct: r, cagrPct: round2(r / 6), sharpe: round2(r / 180), maxDrawdownPct: round2(-12.3 - r / 30), trades: 312, winRatePct: 46.47, profitFactor: 1.83, avgHoldingBars: 8.6, exposurePct: 71.23, finalEquity: Math.round(10000000 * (1 + r / 100)), ...extra });
const tfCurve = (r) => { let e = 10000000; return TX_DAYS.filter((_, i) => i % 2 === 0).map((d, i, a) => { e = Math.round(10000000 * (1 + (r / 100) * (i / a.length)) + Math.sin(i / 8) * 600000); return { d, e }; }); };
await put('taifex_backtests/latest', { generatedAt: hoursAgo(20), modelVersion: 'taifex-v2.4.0', from: '2019-01-02', to: TX_DAYS[TX_DAYS.length - 1], bars: 1912, flowDays: 1650, product: 'TX', initialCapital: 10000000, riskPerTradePct: 1.5,
  variants: { full: { metrics: tfMetrics(234.56), curve: tfCurve(234.56) }, trendOnly: { metrics: tfMetrics(145.67, { trades: 187 }), curve: tfCurve(145.67) }, buyHold: { metrics: tfMetrics(98.76, { trades: 1, winRatePct: 100, profitFactor: null, maxDrawdownPct: -31.63 }), curve: tfCurve(98.76) } },
  recentTrades: Array.from({ length: 25 }, (_, i) => { const ci = TX_DAYS.length - 1 - i * 4; const oi = ci - 3; const side = i % 2 ? 'short' : 'long'; const pts = side === 'long' ? TX_CLOSE[ci] - TX_CLOSE[oi] : TX_CLOSE[oi] - TX_CLOSE[ci]; return { side, contracts: 3 + (i % 6), product: 'TX', openDate: TX_DAYS[oi], closeDate: TX_DAYS[ci], entryPrice: TX_CLOSE[oi], exitPrice: TX_CLOSE[ci], pnlPoints: pts, grossPnl: pts * 200 * (3 + (i % 6)), costs: 1080, netPnl: pts * 200 * (3 + (i % 6)) - 1080, holdingBars: 3, exitReason: TF_EXIT[i % 3], source: 'auto', entryComposite: 0.42 }; }) });
const optV = (p, a, b, eligible = true) => ({ params: p, inSample: tfMetrics(a), outOfSample: tfMetrics(b, { trades: 64 }), eligible });
await put('taifex_optimizations/latest', { generatedAt: daysAgo(4), modelVersion: 'taifex-v2.4.0', bars: 1912, trainFrom: '2019-01-02', trainTo: '2024-12-31', testFrom: '2025-01-02', testTo: TX_DAYS[TX_DAYS.length - 1], maxDrawdownPct: 20,
  best: optV({ entry: 0.4, exit: 0.1, adxTrend: 20, chopDamp: 0.5, stopAtr: 2.5, trailAtr: 3.5 }, 198.4, 41.2), baseline: optV({ entry: 0.35, exit: 0.05, adxTrend: 18, chopDamp: 0.6, stopAtr: 2, trailAtr: 3 }, 176.3, 33.8), stability: 0.78, adopt: true, suggestedRiskPct: 1.25, riskPerTradePct: 1.5,
  variants: Array.from({ length: 12 }, (_, i) => optV({ entry: round2(0.25 + i * 0.03), exit: round2(0.02 + i * 0.01), adxTrend: 14 + i, chopDamp: 0.6, stopAtr: round2(1.5 + i * 0.15), trailAtr: round2(2.5 + i * 0.2) }, 120 + i * 9.87, 12 + i * 3.21, i % 5 !== 4)),
  history: Array.from({ length: 6 }, (_, i) => ({ date: twKey(daysAgo(i * 30 + 4)), params: { entry: round2(0.35 + i * 0.01), exit: 0.05, adxTrend: 18 + i, stopAtr: 2, trailAtr: 3 } })) });
// 每週檢討：一份待核准（含回測對照與警告）、一份已套用、一份不調整（含演算法想法與 PR）
const tfWeekEnd = (weeksAgo) => { const d = new Date(now.getTime() + 8 * 3600000); d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7) - weeksAgo * 7); return d.toISOString().slice(0, 10); };
const tfWeekStart = (end) => { const d = new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 6); return d.toISOString().slice(0, 10); };
const tfCmp = (ret, dd, sharpe, trades) => ({ totalReturnPct: ret, cagrPct: round2(ret / 2), sharpe, maxDrawdownPct: dd, trades, winRatePct: 44.5, profitFactor: 1.6, exposurePct: 58.2 });
const tfProposal = (diff, sections, backtest) => ({ rationale: `近四週訊號多在 0.30–0.35 就反轉，降低進場門檻可以早一根進場；外資部位因子近八週方向正確率最高，權重由選擇權 PCR 移過來。${LONG_ZH}`, sections, diff, switchVariant: true, mainVariant: 'baseline', backtest });
[
  { weeksAgo: 0, status: 'proposed', pnl: -186400, pct: -1.52, idx: -0.84,
    proposal: tfProposal([
      { section: 'params', key: 'entry', from: 0.35, to: 0.3 }, { section: 'weights', key: 'foreignFlow', from: 0.2, to: 0.25 }, { section: 'weights', key: 'pcr', from: 0.1, to: 0.05 },
      { section: 'risk', key: 'riskPerTradePct', from: 1.5, to: 1.2 }, { section: 'risk', key: 'allowShort', from: true, to: false }, { section: 'tech.weights', key: 'macd', from: 0.25, to: 0.3 }, { section: 'tech.weights', key: 'rsi', from: 0.2, to: 0.15 },
    ], ['params', 'weights', 'risk', 'tech'], { from: '2019-04-01', to: TX_DAYS[TX_DAYS.length - 1], outOfSampleFrom: '2024-02-15',
      current: { full: tfCmp(182.4, 16.8, 1.21, 96), outOfSample: tfCmp(41.2, 12.4, 1.05, 37) }, proposed: { full: tfCmp(196.7, 18.9, 1.24, 118), outOfSample: tfCmp(38.6, 15.9, 0.97, 46) },
      warnings: ['樣本外報酬比目前的參數差', '盤中技術模擬沒有歷史回測（5 分 K 只保留約 4 個交易日），調整後要靠之後幾週的實際模擬結果驗證'] }) },
  { weeksAgo: 1, status: 'applied', pnl: 243800, pct: 2.03, idx: 1.42, decidedAt: daysAgo(6),
    proposal: tfProposal([{ section: 'params', key: 'stopAtr', from: 2, to: 2.5 }], ['params'], null) },
  { weeksAgo: 2, status: 'no_change', pnl: 12600, pct: 0.11, idx: null, proposal: null,
    algorithmIdeas: ['加入夜盤漲跌幅作為隔日開盤的過濾條件：夜盤反向超過 1% 時延後一根進場', `把 60 日動能改成 20 / 60 / 120 日三段平均，降低單一週期的雜訊。${LONG_ZH}`], prUrl: 'https://github.com/example/personal-hub/pull/123' },
].forEach((r) => {
  const end = tfWeekEnd(r.weeksAgo);
  queue(`taifex_reviews/${end}`, {
    weekStart: tfWeekStart(end), weekEnd: end, status: r.status, source: 'mcp', client: 'Claude', createdAt: daysAgo(r.weeksAgo * 7), decidedAt: r.decidedAt || null, before: null,
    summary: `本週台指期在 ${lastTx - 400}–${lastTx + 300} 區間震盪，主帳戶多單在週三被停損後空手到週五；分數全週落在 0.28–0.39 之間，沒有再觸發進場。${LONG_ZH}`,
    findings: ['突破因子本週貢獻最大（+0.11），外資部位因子由正轉負', '保守變體因為門檻較高整週空手，躲過週三的回檔', `盤中技術 5 分頻率本週 14 筆、淨損 -8,200；60 分頻率 3 筆、淨利 +21,400。${LONG_ZH}`],
    algorithmIdeas: r.algorithmIdeas || [], prUrl: r.prUrl || null,
    week: { pnl: r.pnl, pct: r.pct, days: 5, endEquity: 12240000 + r.pnl, maxDrawdownPct: 1.9, indexChangePct: r.idx },
    proposal: r.proposal, modelVersion: 'tx-v1', techVersion: 'txi-v1',
  });
});
await put('taifex_tuning/current', { version: 1, reviewId: tfWeekEnd(1), updatedAt: daysAgo(6),
  params: { entry: 0.35, exit: 0.05, adxTrend: 18, chopDamp: 0.6, stopAtr: 2.5, trailAtr: 3 }, weights: { trend: 0.3, breakout: 0.2, tsmom: 0.2, foreignFlow: 0.2, pcr: 0.1 },
  tech: { entry: 0.45, exit: 0.1, stopAtr: 2, trailAtr: 3, weights: { trend: 0.35, macd: 0.25, rsi: 0.2, breakout: 0.2 } },
  history: [{ date: tfWeekEnd(1), action: 'apply', reviewId: tfWeekEnd(1), changes: ['初始停損（ATR 倍數）：2 → 2.5'] }] });
await put('taifex_live/current', { quote: { date: twKey(now), time: '11:42:05', contract: 'TX202612', last: lastTx + 63, open: lastTx + 12, high: lastTx + 148, low: lastTx - 97, prevClose: lastTx, basis: -42.35, estimated: false, source: 'taifex-mis' }, quoteUpdatedAt: hoursAgo(0.1), context: { lastDate: TX_DAYS[TX_DAYS.length - 1], lastClose: lastTx, contract: 'TX202612', atr20: 193.4 } });

// 盤中技術模擬（日盤 + 夜盤，4 個監控頻率）
const techStat = (n, wins, net) => ({ n, wins, net, grossWin: Math.max(net, 0) + n * 1234, grossLoss: n * 1234 + Math.max(-net, 0), points: round2(net / 200) });
const techDecision = (i, score, action, target) => ({ t: `${twKey(now)} ${String(9 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`, price: lastTx + i * 7, score, action, target });
const techBot = (interval, net, n, k) => ({
  interval, checks: Math.round(12345 / interval), realized: net, peak: Math.max(net, 0) + 87654, maxDrawdown: 123456 + k * 54321, lastCheck: { key: `${twKey(now)}D`, idx: 12 },
  position: k % 2 ? null : { side: k ? 'short' : 'long', contracts: 2, entryPrice: lastTx + 12, entryTime: `${twKey(now)} 10:15`, entryM: 90, entryScore: 0.47, session: 'day', sessionKey: `${twKey(now)}D`, stop: lastTx - 77.5, extreme: lastTx + 88, unrealized: 1234567 - k * 2345678 },
  stats: { all: techStat(n, Math.round(n * 0.44), net), day: techStat(Math.round(n * 0.4), Math.round(n * 0.2), Math.round(net * 0.3)), night: techStat(Math.round(n * 0.6), Math.round(n * 0.24), Math.round(net * 0.7)) },
  buckets: Object.fromEntries(['d1', 'd2', 'd3', 'd4', 'n1', 'n2', 'n3', 'n4'].map((id, j) => [id, techStat(Math.round(n / 8), Math.round(n / 18), Math.round((net / 8) * (j % 3 === 0 ? -1.5 : 1.2)))])),
  lastDecision: { ...techDecision(11, k === 3 ? null : 0.52 - k * 0.4, k ? 'hold' : 'enter', k ? 'flat' : 'long'), session: 'day', reason: k === 3 ? '資料不足' : `分數 ${0.52 - k * 0.4} ${k ? '未達進場門檻' : '≥ 0.4 且站上慢線'}`, bars: k === 3 ? 22 : 480,
    indicators: k === 3 ? null : { emaFast: lastTx + 23.4, emaSlow: lastTx - 12.3, rsi: 61.2, macdHist: 4.1, atr: 38.5, channelHigh: lastTx + 130, channelLow: lastTx - 240 },
    factors: k === 3 ? null : { trend: 0.7, macd: -0.57, rsi: 0.56, breakout: 0.84 } },
  decisions: Array.from({ length: 24 }, (_, i) => techDecision(i, round2(Math.sin(i / 3 + k)), ['hold', 'enter', 'hold', 'exit', 'hold', 'reverse'][i % 6], ['flat', 'long', 'long', 'flat', 'flat', 'short'][i % 6])),
});
await put('taifex_live/tech', {
  modelVersion: 'txi-v1', epoch: 2, startDate: TX_DAYS[TX_DAYS.length - 45], product: 'TX', contracts: 2, startedAt: daysAgo(45), updatedAt: hoursAgo(0.05),
  status: { state: 'running', reason: null, label: '日盤交易中', date: twKey(now), time: '11:42', session: 'day', sessionKey: `${twKey(now)}D`, m: 177, toClose: 123, price: lastTx + 63, contract: '202612', source: 'taifex_mis', estimated: false, next: { session: 'night', date: twKey(now), time: '15:00' }, updatedAt: hoursAgo(0.05) },
  bots: { m5: techBot(5, -1234567, 312, 0), m15: techBot(15, 2345678, 156, 1), m30: techBot(30, 876543, 64, 2), m60: techBot(60, 123456, 18, 3) },
  sessions: TX_DAYS.slice(-45).flatMap((date, i) => ['D', 'N'].map((sfx, j) => ({ key: date + sfx, session: j ? 'night' : 'day', date, open: TX_CLOSE[TX_CLOSE.length - 45 + i] - 40, high: TX_CLOSE[TX_CLOSE.length - 45 + i] + 150, low: TX_CLOSE[TX_CLOSE.length - 45 + i] - 180, close: TX_CLOSE[TX_CLOSE.length - 45 + i], ticks: j ? 168 : 61,
    pnl: { m5: Math.round(Math.sin(i + j) * 98765 - 13000), m15: Math.round(Math.cos(i / 2 + j) * 87654 + 26000), m30: Math.round(Math.sin(i / 3) * 54321 + 9000), m60: Math.round(Math.cos(i) * 21000) }, trades: { m5: 4, m15: 2, m30: 1 } }))),
});
await put('taifex_live/tech_trades', { updatedAt: hoursAgo(0.05), trades: Array.from({ length: 120 }, (_, i) => {
  const interval = [5, 15, 30, 60][i % 4]; const night = i % 3 === 0; const date = TX_DAYS[TX_DAYS.length - 1 - Math.floor((119 - i) / 6)]; const side = i % 2 ? 'short' : 'long'; const pts = Math.round(between(-180, 220));
  return { bot: `m${interval}`, interval, session: night ? 'night' : 'day', sessionKey: date + (night ? 'N' : 'D'), side, contracts: 2, entryTime: `${date} ${night ? '21:35' : '09:20'}`, entryPrice: lastTx - 100 + i, entryM: night ? 395 : 35, entryScore: 0.46,
    exitTime: `${date} ${night ? '23:10' : '10:45'}`, exitPrice: lastTx - 100 + i + (side === 'long' ? pts : -pts), points: pts, grossPnl: pts * 400, costs: 1284, netPnl: pts * 400 - 1284, reason: ['signal', 'stop', 'reverse', 'session_end'][i % 4], estimated: i % 9 === 0, epoch: 2, modelVersion: 'txi-v1' };
}) });

// ---------------------------------------------------------------- Stock radar
const RADAR_ACTIONS = ['add', 'hold', 'trim', 'exit', 'buy', 'watch', 'avoid', 'insufficient'];
const radarItem = (sym, k, dayShift) => {
  const [name, price, , market] = STOCKS[sym]; const pos = POS.find((p) => p[0] === sym); const comp = round2(Math.sin(k * 1.7 + dayShift / 3) * 1.6);
  const pv = POS_VAL.find((p) => p.symbol === sym);
  return {
    symbol: sym, name, held: Boolean(pos), inWatchlist: WATCH.some((w) => w[0] === sym), shares: pos ? pos[1] : 0, avgCost: pos ? pos[2] : null, currency: market === 'US' ? 'USD' : 'TWD',
    marketValueTWD: pv ? pv.valueTWD : null, weightPct: pv ? round2((pv.valueTWD / totalValueNow) * 100) : null, unrealizedPct: pv ? round2(((pv.valueTWD - pv.costTWD) / pv.costTWD) * 100) : null,
    close: round2(price * (1 - dayShift * 0.003)), priceDate: twKey(daysAgo(dayShift)), quantScore: comp, sentimentAdj: round2(Math.cos(k) * 0.2), composite: round2(comp + Math.cos(k) * 0.2), coverage: k % 5 === 4 ? 0.63 : 1, eventRisk: k % 4 === 1,
    sentiment: k % 6 === 5 ? null : { score: round2(Math.cos(k) * 0.8), confidence: 0.7, summary: `${name} 第三季營收年增 34.2% 優於市場預期，法說會上調全年資本支出指引；惟毛利率受匯率與海外新廠稀釋影響，分析師對明年展望看法分歧。`, catalysts: ['AI 伺服器需求強勁，先進製程產能利用率維持滿載', '下週公布月營收', LONG_ZH], riskEvents: [{ type: 'earnings', date: twKey(daysAhead(8)), note: '第四季財報與法說會' }, { type: 'ex_dividend', date: null, note: '除息日未定' }], earningsSurprise: ['beat', 'miss', 'inline', null][k % 4], sources: [{ title: `Bloomberg: ${name} raises full-year capex guidance as AI demand outpaces supply`, url: 'https://www.bloomberg.com/news/articles/2026-11-10/example' }, { title: '工商時報', url: 'https://www.ctee.com.tw/news/20261110700000-430501' }] },
    action: RADAR_ACTIONS[(k + (pos ? 0 : 4)) % 8], reasons: ['12-1 月動能位於全市場前 20%', '股價站上 200 日均線且距 52 週高點僅 3.2%', k % 2 ? '外資近 20 日買超 123,456 張、融資餘額同步下降，籌碼安定' : '近 21 日報酬過熱（+28.4%），短線有反轉風險', '持倉權重已達 18.7%，超過單一持股上限 15%'],
    factors: { tsmom: { raw: 0.342, score: round2(comp * 0.9) }, relMom: { raw: 0.12, score: round2(comp * 0.7) }, high52: { raw: 0.968, score: 1.2 }, trend: { raw: 1, score: comp > 0 ? 1 : -1 }, reversal: { raw: -0.084, score: -0.4 }, lowVol: { raw: 0.284, score: 0.1 }, ...(market === 'TW' ? { instFlow: { raw: 123456, score: 0.8 }, marginChange: { raw: -0.034, score: 0.3 } } : {}) },
    metrics: { historyDays: 252, mom12_1: 0.342, ret21: 0.284, vol60: 0.284, ma200: round2(price * 0.86), high52: round2(price * 1.032), atr14: round2(price * 0.021), chandelierStop: round2(price * 0.93) },
  };
};
const radarSyms = { TW: Object.keys(STOCKS).filter((s) => STOCKS[s][3] === 'TW'), US: Object.keys(STOCKS).filter((s) => STOCKS[s][3] === 'US' && s !== 'SPY') };
let radarDays = 0;
for (let i = 0; radarDays < 45; i += 1) {
  const d = daysAgo(i); if (!isWeekday(d)) continue; const runDate = twKey(d);
  for (const market of ['TW', 'US']) {
    const items = radarSyms[market].map((s, k) => radarItem(s, k, i));
    queue(`stock_radar_runs/${runDate}_${market}`, {
      runDate, market, modelVersion: 'radar-v1.6.0', generatedAt: twNoon(runDate), status: radarDays === 3 && market === 'US' ? 'partial' : 'ok', regime: ['risk_on', 'neutral', 'risk_off'][Math.floor(i / 9) % 3], effectiveRegime: ['risk_on', 'neutral', 'risk_off'][Math.floor(i / 9) % 3],
      marketView: { sentiment: 0.3, confidence: 0.65, summary: '聯準會會議前市場觀望氣氛濃厚，AI 類股領漲但成交量萎縮；台股受惠外資回補與新台幣升值，惟融資餘額創波段新高需留意籌碼凌亂風險。', events: ['週四凌晨 FOMC 利率決議', '週五台積電 10 月營收公布', '下週三 NVIDIA 財報'], sources: [{ title: 'Financial Times: Markets brace for Fed decision', url: 'https://www.ft.com/content/example' }] },
      sentimentAt: twNoon(runDate), sentimentCount: items.length - 2, flowDays: 20,
      benchmark: { symbol: market === 'TW' ? '0050' : 'SPY', close: STOCKS[market === 'TW' ? '0050' : 'SPY'][1], priceDate: runDate, ma200: market === 'TW' ? 176.4 : 561.2, mom12_1: 0.213 },
      universeSize: items.length, items, errors: radarDays === 3 && market === 'US' ? ['TLT: Yahoo Finance quote request timed out after 30000 ms', 'BRK.B: symbol mapping failed (BRK-B)'] : [],
    });
    const returns = Object.fromEntries(radarSyms[market].map((s, k) => [s, { entryDate: runDate, fwd1: i >= 1 ? round2(Math.sin(k + i) * 0.03 * 100) / 100 : null, fwd5: i >= 7 ? round2(Math.sin(k * 2 + i) * 8) / 100 : null, fwd20: i >= 28 ? round2(Math.cos(k + i) * 18) / 100 : null }]));
    queue(`stock_radar_outcomes/${runDate}_${market}`, { runDate, market, modelVersion: 'radar-v1.6.0', returns, benchmark: { entryDate: runDate, fwd1: i >= 1 ? 0.0041 : null, fwd5: i >= 7 ? 0.0123 : null, fwd20: i >= 28 ? 0.0345 : null }, complete: i >= 28 });
  }
  radarDays += 1;
}
for (const market of ['TW', 'US']) {
  let s = 1; let e = 1; let b = 1;
  const curve = Array.from({ length: 96 }, (_, i) => { s *= 1 + between(-0.03, 0.045); e *= 1 + between(-0.03, 0.04); b *= 1 + between(-0.035, 0.042); const d = new Date(Date.UTC(2018, 10 + i, 1)); return { date: d.toISOString().slice(0, 10), strategy: round2(s * 1000) / 1000, equalWeight: round2(e * 1000) / 1000, benchmark: round2(b * 1000) / 1000, holdings: 5 + (i % 6) }; });
  await put(`stock_radar_backtests/${market}`, { modelVersion: 'radar-v1.6.0', generatedAt: daysAgo(2), benchmarkSymbol: market === 'TW' ? '0050' : 'SPY', from: '2018-11-01', to: twKey(daysAgo(11)), periods: 96, samples: 1728, symbols: 18, skippedSymbols: ['00919', '00679B', 'BRK.B'],
    meanIC: 0.0634, icTStat: 2.87, icPositiveRate: 0.6354, buckets: [{ key: 'strong', n: 412, avgExcess20: 0.0234, hitRate: 0.6123 }, { key: 'positive', n: 498, avgExcess20: 0.0087, hitRate: 0.5412 }, { key: 'weak', n: 467, avgExcess20: -0.0045, hitRate: 0.4789 }, { key: 'very_weak', n: 351, avgExcess20: -0.0198, hitRate: 0.4123 }],
    strategy: { totalReturn: 4.5678, cagr: 0.2391, volatility: 0.2145, sharpe: 1.11, maxDrawdown: -0.2876 }, equalWeight: { totalReturn: 2.3456, cagr: 0.1629, volatility: 0.1987, sharpe: 0.82, maxDrawdown: -0.3312 }, benchmark: { totalReturn: 1.8765, cagr: 0.1412, volatility: 0.1765, sharpe: 0.8, maxDrawdown: -0.2954 },
    curve, icSeries: curve.map((p, i) => ({ date: p.date, ic: round2(Math.sin(i / 4) * 0.2 + 0.06), n: 18 })) });
}
await put('stock_radar_configs/default', { promptSymbols: { TW: radarSyms.TW, US: radarSyms.US }, promptCopiedAt: { TW: daysAgo(1), US: daysAgo(8) } });

// ---------------------------------------------------------------- trips / itinerary
const MEM_REX = { uid: REX, name: 'Owner', email: 'rex@example.com', color: '#3b82f6' };
const MEM_PARTNER = { uid: PARTNER, name: '伴侶', email: 'partner@example.com', color: '#ec4899' };
const MEM_MOM = { name: '媽媽（不用 App，由 owner 代記）', color: '#f59e0b' };
const MEM_ALEX = { name: 'Alexander Maximilian Montgomery-Fitzgerald III', email: 'alexander.montgomery.fitzgerald@example-long-domain.co.uk', color: '#10b981' };
const TRIP = 'trip-tokyo-2026'; // 過去 6 天（剛結束）
const tripStart = twKey(daysAgo(24)); const tripEnd = twKey(daysAgo(19));
const TRIPS = [
  [TRIP, '2026 秋・東京＋箱根＋河口湖六天五夜賞楓溫泉美食之旅（爸媽同行）', ['東京 Tokyo', '箱根 Hakone', '河口湖 Kawaguchiko', '橫濱 Yokohama'], 24, 19, ['JPY', 'USD'], 320000, 'done', [MEM_REX, MEM_PARTNER, MEM_MOM, MEM_ALEX], [PARTNER]],
  ['trip-hokkaido-2027', '2027 北海道二世谷滑雪', ['札幌', '二世谷 Niseko', '小樽'], -75, -83, ['JPY'], 12345678, 'planning', [MEM_REX, MEM_PARTNER], [PARTNER]],
  ['trip-now-kenting', '墾丁快閃（進行中）', ['墾丁', '恆春'], 1, -2, [], 30000, 'active', [MEM_REX, MEM_PARTNER], []],
  ['trip-europe-2025', 'Europe 2025: Vienna → Salzburg → Hallstatt → Prague → Český Krumlov', ['Vienna', 'Salzburg', 'Hallstatt', 'Prague', 'Český Krumlov'], 420, 408, ['EUR', 'USD'], 450000, 'done', [MEM_REX, MEM_PARTNER, MEM_ALEX], []],
  ['trip-bali-2026', '峇里島家族旅行', ['Ubud', 'Seminyak'], 200, 194, ['IDR'], 180000, 'done', [MEM_REX], []],
];
TRIPS.forEach(([id, name, destination, s, e, foreignCurrencies, budget, status, members, sharedWith], i) => queue(`trips/${id}`, {
  userId: REX, ownerId: REX, name, destination, startDate: twNoon(twKey(daysAgo(s))), endDate: twNoon(twKey(daysAgo(e))), baseCurrency: 'TWD', foreignCurrencies, budget, itineraryId: id, status,
  notes: i === 0 ? `爸媽第一次去日本，行程不要排太滿。${LONG_ZH}` : '', createdAt: daysAgo(s + 60), members, sharedWith, pendingInvites: i === 0 ? ['pending-invitee-with-long-address@example-long-domain.com'] : [],
}));
// 旅遊交易（東京：JPY 為主）
const TRIP_TX = [
  ['trip_flight', '長榮航空 BR198 TPE-NRT 來回 ×4（豪華經濟艙）', 'TWD', 123456, 'cube'], ['trip_hotel', 'ホテル雅叙園東京 Hotel Gajoen Tokyo エグゼクティブスイート 2泊', 'JPY', 328000, 'cube'], ['trip_hotel', '箱根強羅花壇 一泊二食付（和洋室・露天風呂付）', 'JPY', 264000, 'cube'],
  ['trip_local_transport', 'JR東日本 東京廣域周遊券 ×4', 'JPY', 60000, 'cash'], ['trip_local_transport', '箱根フリーパス', 'JPY', 28000, 'cash'], ['trip_food', '鮨さいとう（おまかせ・4名）', 'JPY', 128000, 'cube'],
  ['trip_food', '一蘭拉麵 新宿中央東口店', 'JPY', 5960, 'cash'], ['trip_food', '築地場外市場 海鮮丼', 'JPY', 12800, 'cash'], ['trip_ticket', 'teamLab Planets TOKYO DMM', 'JPY', 15200, 'ctbc-linepay'],
  ['trip_ticket', '東京迪士尼海洋 一日護照 ×4 ＋ DPA 快速通關', 'JPY', 61600, 'ctbc-linepay'], ['trip_souvenir', '東京ばな奈・NewYork Perfect Cheese・白い恋人 各種伴手禮', 'JPY', 23460, 'cash'], ['trip_souvenir', LONG_EN, 'USD', 245.5, 'ctbc-linepay'],
  ['shopping', 'ビックカメラ 有楽町店 Sony α7 V ボディ（免稅）', 'JPY', 398000, 'cube'], ['trip_food', '河口湖 ほうとう不動', 'JPY', 6600, 'cash'], ['trip_local_transport', 'Suica 儲值', 'JPY', 10000, 'cash'],
  ['trip_food', '橫濱中華街 聘珍樓', 'JPY', 24800, 'cube'], ['medical', 'マツモトキヨシ 藥妝', 'JPY', 18340, 'cash'], ['trip_ticket', '澀谷 SKY 展望台（日落時段）', 'JPY', 10000, 'ctbc-linepay'],
  ['trip_local_transport', '成田 Skyliner', 'JPY', 10280, 'cash'], ['trip_food', '便利商店早餐', 'JPY', 2140, 'cash'], ['other', '旅遊不便險 ×4', 'TWD', 2880, 'linepay'], ['trip_food', LONG_ZH, 'JPY', 4400, 'cash'],
];
const TRIP_MEMBERS = [REX, PARTNER, MEM_MOM.name, MEM_ALEX.name];
TRIP_TX.forEach(([category, note, currency, amount, pm], i) => {
  const fxRate = FX[currency]; const amountTWD = round2(amount * fxRate); const date = i === 0 ? daysAgo(70) : new Date(daysAgo(24 - (i % 6)).getTime() + i * 1800000);
  const shareType = i % 5 === 0 ? 'payer' : i % 5 === 1 ? 'custom' : 'equal'; const payerId = i % 4 === 3 ? PARTNER : REX;
  tx(`rex-trip-tx-${i}`, {
    date, category, note, currency, amount, fxRate, amountTWD, paymentMethod: pm, fromAccountId: PM_ACC[pm] ?? null, tripId: TRIP, payerId, shareType,
    ...(shareType === 'custom' ? { customShares: [{ memberId: REX, amountTWD: round2(amountTWD * 0.5), amount: round2(amount * 0.5) }, { memberId: PARTNER, amountTWD: round2(amountTWD * 0.3), amount: round2(amount * 0.3) }, { memberId: MEM_MOM.name, amountTWD: round2(amountTWD * 0.2), amount: round2(amount * 0.2) }] } : {}),
    myShareTWD: shareType === 'payer' ? (payerId === REX ? amountTWD : 0) : shareType === 'custom' ? round2(amountTWD * 0.5) : round2(amountTWD / 4),
    ...(i === 5 ? { lineItems: [{ id: 'li1', name: 'おまかせコース ×4', amountTWD: round2(amountTWD * 0.8), paidFor: TRIP_MEMBERS }, { id: 'li2', name: '日本酒ペアリング（十四代・而今・新政 No.6）', amountTWD: round2(amountTWD * 0.2), paidFor: [REX, MEM_ALEX.name], note: '只有兩個人喝' }] } : {}),
    ...(currency === 'JPY' && pm !== 'cash' && i % 2 === 0 ? { settledAmountTWD: round2(amountTWD * 1.015), settledFxRate: round2(fxRate * 1.015 * 10000) / 10000, settledAt: daysAgo(10) } : {}),
    prepaid: i < 3,
  });
});
['trip-europe-2025', 'trip-bali-2026', 'trip-now-kenting'].forEach((tid, t) => { for (let i = 0; i < 8; i += 1) { const cur = t === 0 ? 'EUR' : t === 1 ? 'IDR' : 'TWD'; const amount = t === 0 ? Math.round(between(20, 900)) : t === 1 ? Math.round(between(80000, 4000000)) : Math.round(between(120, 4800)); tx(`rex-trip-${tid}-${i}`, { date: daysAgo((t === 0 ? 419 : t === 1 ? 199 : 1) - (i % (t === 2 ? 2 : 6))), category: pick(['trip_food', 'trip_hotel', 'trip_ticket', 'trip_local_transport', 'trip_souvenir']), note: pick(['Café Central Wien', 'Hotel', 'Museum ticket', 'Taxi / Grab', '伴手禮']), currency: cur, amount, fxRate: FX[cur], amountTWD: round2(amount * FX[cur]), paymentMethod: 'cube', fromAccountId: 'acc-card-cube', tripId: tid, payerId: REX, shareType: 'equal', myShareTWD: round2(amount * FX[cur] / 2) }); } });
// 文件 / 行李
const TDOCS = [['link', '長榮航空電子機票收據（訂位代號 ABC123）－owner・伴侶・媽媽・Alexander 四人', 'flight', LONG_URLISH], ['link', 'Hotel Gajoen Tokyo 訂房確認信', 'hotel', 'https://www.booking.com/confirmation.html?aid=123456'], ['link', '箱根強羅花壇 予約確認', 'hotel', 'https://www.gorakadan.com/'], ['link', '富邦產險旅遊綜合險保單（海外突發疾病＋班機延誤＋行李遺失）', 'insurance', 'https://www.fubon.com/insurance/'], ['link', 'Visit Japan Web QR', 'visa', 'https://vjw-lp.digital.go.jp/'], ['file', 'disney-sea-tickets.pdf', 'ticket', 'https://example.com/disney-sea-tickets.pdf'], ['link', 'teamLab 入場 QR', 'ticket', 'https://www.teamlab.art/'], ['link', LONG_EN, 'other', LONG_URLISH]];
TDOCS.forEach(([type, title, category, url], i) => queue(`trips/${TRIP}/documents/doc${i}`, { type, title, url, storagePath: null, driveFileId: null, driveLink: null, size: type === 'file' ? 1234567 : null, contentType: type === 'file' ? 'application/pdf' : null, category, note: i % 3 === 0 ? '登機前 48 小時線上報到；媽媽的護照號碼要再確認一次' : null, createdBy: i % 2 ? PARTNER : REX, createdAt: daysAgo(40 - i), updatedAt: daysAgo(30 - i) }));
const PACK = [['documents', '護照（效期六個月以上）＋影本兩份'], ['documents', '日幣現金 20 萬＋信用卡三張（CUBE / LINE Pay / Pi）'], ['documents', 'Visit Japan Web QR code 截圖'], ['clothes', '發熱衣 ×4'], ['clothes', '羽絨外套'], ['clothes', '好走的鞋'], ['clothes', '泳衣（溫泉旅館用不到但還是帶著）'], ['toiletries', '牙刷牙膏'], ['toiletries', '隱形眼鏡與保養液'], ['electronics', 'Sony α7 V＋24-70mm F2.8 GM II＋備用電池三顆＋記憶卡'], ['electronics', '行動電源 20000mAh'], ['electronics', '萬用轉接頭'], ['electronics', 'eSIM（IIJmio 10GB/7 天）'], ['health', '暈車藥・腸胃藥・感冒藥・OK 繃'], ['health', '媽媽的血壓藥（七天份＋備用三天）'], ['other', '折疊購物袋'], ['other', LONG_EN], ['other', '給民宿主人的台灣伴手禮（鳳梨酥）']];
PACK.forEach(([category, name], i) => queue(`trips/${TRIP}/packing/pk${i}`, { name, category, packed: i % 3 !== 1, quantity: i === 3 ? 4 : 1, assignee: [REX, PARTNER, MEM_MOM.name, null][i % 4], order: i, createdAt: daysAgo(40), updatedAt: daysAgo(25) }));
PACK.slice(0, 6).forEach(([category, name], i) => queue(`trips/trip-hokkaido-2027/packing/pk${i}`, { name, category, packed: false, quantity: 1, assignee: null, order: i, createdAt: daysAgo(5), updatedAt: daysAgo(5) }));
// 行程
const NOTES_MD = `# 東京＋箱根 行前筆記\n\n## 航班\n- 去程 BR198 TPE 08:50 → NRT 13:15（第二航廈）\n- 回程 BR197 NRT 14:15 → TPE 17:05\n\n## 注意事項\n1. 爸媽膝蓋不好，**每天步數控制在一萬步以內**，車站盡量找電梯。\n2. 箱根フリーパス在新宿小田急旅遊服務中心買，記得帶護照。\n3. ${LONG_ZH}\n\n## 訂位\n| 餐廳 | 日期 | 時間 | 訂位代號 |\n|---|---|---|---|\n| 鮨さいとう | Day 2 | 18:00 | TBL-20261019-0042 |\n| 聘珍樓 橫濱本店 | Day 6 | 12:30 | - |\n\n## 連結\n${LONG_URLISH}\n\n## 緊急聯絡\n- 駐日代表處：+81-3-3280-7811\n- 富邦產險海外急難救助：+886-2-6636-7890\n`;
const ITIN = (tid, title, destination, s, e, notes) => queue(`itineraries/${tid}`, { userId: REX, tripId: tid, title, summary: '以賞楓與溫泉為主軸，前段東京市區、中段箱根強羅溫泉一泊、後段河口湖看富士山，最後一天橫濱中華街午餐後直接去機場。', tips: ['Suica 可以直接加進 Apple Wallet，不用買實體卡', '箱根登山電車週末下午非常擠，建議 15:00 前上山', `雨備：${LONG_ZH}`], notes, notesUpdatedAt: daysAgo(26), generatedByLLM: true, llmModel: 'gemini-2.5-pro', destination, startDate: s, endDate: e });
ITIN(TRIP, '2026 秋・東京＋箱根＋河口湖六天五夜', '東京・箱根・河口湖・橫濱', tripStart, tripEnd, NOTES_MD);
ITIN('trip-hokkaido-2027', '2027 北海道二世谷滑雪', '札幌・二世谷・小樽', twKey(daysAhead(75)), twKey(daysAhead(83)), '# 待辦\n- [ ] 訂雪具\n- [ ] 訂教練\n');
const hours = (noHours = false) => ({ placeId: 'ChIJCewJkL2LGGAR3Qmk0vCTGkg', weekdayText: ['星期一: 10:00 – 21:00', '星期二: 10:00 – 21:00', '星期三: 休息', '星期四: 10:00 – 21:00', '星期五: 10:00 – 22:00', '星期六: 09:00 – 22:00', '星期日: 09:00 – 21:00'], periods: [0, 1, 2, 4, 5, 6].map((day) => ({ open: { day, time: '1000' }, close: { day, time: '2100' } })), utcOffsetMinutes: 540, businessStatus: 'OPERATIONAL', url: 'https://maps.google.com/?cid=5195627782660688349', ...(noHours ? { noHours: true } : {}), fetchedAt: daysAgo(27) });
const DAYS = [
  ['抵達東京・目黑雅敘園・惠比壽', [
    ['07:00', '08:50', 'transport', '桃園機場第二航廈 → 成田機場第二航廈（長榮 BR198，記得 06:20 前完成託運）', '桃園國際機場第二航廈', '337台灣桃園市大園區航站南路9號', 25.0777, 121.2328, 0, 'TWD'],
    ['13:15', '15:00', 'transport', '成田 Skyliner → 日暮里 → JR 山手線 → 目黑', '成田空港第2ターミナル駅', '〒282-0004 千葉県成田市古込1-1', 35.7735, 140.3875, 10280, 'JPY'],
    ['15:30', '16:30', 'accommodation', 'Check-in：ホテル雅叙園東京 Hotel Gajoen Tokyo（エグゼクティブスイート・百段階段見学付き）', 'ホテル雅叙園東京', '〒153-0064 東京都目黒区下目黒1丁目8−1', 35.6316, 139.7128, 328000, 'JPY'],
    ['17:00', '18:00', 'activity', '目黑川沿岸散步', '目黒川', '東京都目黒区中目黒', 35.6442, 139.6989, 0, 'JPY'],
    ['18:30', '20:30', 'meal', '惠比壽橫丁居酒屋（爸媽想吃烤雞肉串與關東煮，先到先排，不接受訂位）', '恵比寿横丁', '〒150-0013 東京都渋谷区恵比寿1丁目7−4', 35.6477, 139.7112, 16000, 'JPY'],
    ['21:00', null, 'shopping', '成城石井買明天早餐', '成城石井 アトレ目黒店', '東京都品川区上大崎2丁目16−9', 35.6339, 139.7157, 3000, 'JPY'],
  ]],
  ['築地・銀座・teamLab・壽司', [
    ['08:00', '10:00', 'meal', '築地場外市場早餐（玉子燒、海鮮丼、草莓大福）', '築地場外市場', '〒104-0045 東京都中央区築地4丁目16−2', 35.6655, 139.7707, 12800, 'JPY'],
    ['10:30', '13:00', 'shopping', '銀座：GINZA SIX、伊東屋本店、UNIQLO 銀座旗艦店（十二層樓）、ビックカメラ有楽町店買相機', 'GINZA SIX', '〒104-0061 東京都中央区銀座6丁目10−1', 35.6696, 139.7641, 398000, 'JPY'],
    ['13:30', '14:30', 'meal', '銀座 篝 雞白湯拉麵', '銀座 篝 本店', '東京都中央区銀座6丁目4−12', 35.6712, 139.7609, 6000, 'JPY'],
    ['15:30', '17:30', 'activity', 'teamLab Planets TOKYO DMM（要脫鞋涉水，媽媽穿褲裝；15:30 場次）', 'teamLab Planets TOKYO DMM', '〒135-0061 東京都江東区豊洲6丁目1−16', 35.6491, 139.7898, 15200, 'JPY'],
    ['18:00', '20:30', 'meal', '鮨さいとう（おまかせ・四名・訂位代號 TBL-20261019-0042・遲到 15 分鐘取消）', '鮨さいとう', '〒106-0032 東京都港区六本木1丁目4−5 アークヒルズ サウスタワー 1F', 35.6655, 139.7397, 128000, 'JPY'],
  ]],
  ['東京迪士尼海洋', [
    ['07:30', '08:30', 'transport', '目黑 → 舞濱（JR 京葉線）→ Disney Resort Line', '舞浜駅', '千葉県浦安市舞浜', 35.6366, 139.8836, 2400, 'JPY'],
    ['09:00', '21:00', 'activity', '東京ディズニーシー：Fantasy Springs（アナとエルサのフローズンジャーニー DPA）→ ソアリン → センター・オブ・ジ・アース → ビリーヴ！〜シー・オブ・ドリームス〜', '東京ディズニーシー', '〒279-8511 千葉県浦安市舞浜1−13', 35.6267, 139.8851, 61600, 'JPY'],
    ['12:00', '13:00', 'meal', 'マゼランズ（要事先 Priority Seating）', 'マゼランズ', '東京ディズニーシー メディテレーニアンハーバー', 35.6262, 139.8868, 28000, 'JPY'],
    ['21:30', null, 'transport', '回飯店', null, null, null, null, 2400, 'JPY'],
  ]],
  ['箱根：登山電車・大涌谷・強羅花壇', [
    ['08:30', '10:10', 'transport', '新宿 → 箱根湯本（小田急ロマンスカー GSE 展望席 1 號車）', '新宿駅 小田急線', '東京都新宿区西新宿1丁目1−3', 35.6905, 139.6995, 9880, 'JPY'],
    ['10:30', '11:30', 'transport', '箱根登山電車 → 強羅 → 箱根登山纜車 → 早雲山', '強羅駅', '神奈川県足柄下郡箱根町強羅', 35.2507, 139.0476, 0, 'JPY'],
    ['11:45', '13:00', 'activity', '大涌谷：黑玉子（吃一顆延壽七年）、箱根空中纜車看富士山', '大涌谷', '〒250-0631 神奈川県足柄下郡箱根町仙石原1251', 35.2437, 139.0206, 2000, 'JPY'],
    ['13:30', '15:00', 'activity', '蘆之湖海賊船 桃源台 → 元箱根、箱根神社平和鳥居', '箱根神社', '〒250-0522 神奈川県足柄下郡箱根町元箱根80−1', 35.2046, 139.0256, 0, 'JPY'],
    ['16:00', null, 'accommodation', 'Check-in：強羅花壇（一泊二食・和洋室露天風呂付・懷石料理 18:30 開始）', '強羅花壇', '〒250-0408 神奈川県足柄下郡箱根町強羅1300', 35.2486, 139.0492, 264000, 'JPY'],
  ]],
  ['河口湖：富士山・紅葉迴廊', [
    ['09:30', '11:40', 'transport', '強羅 → 御殿場 → 河口湖（高速巴士，車次少要先訂）', '河口湖駅', '山梨県南都留郡富士河口湖町船津3641', 35.4983, 138.7688, 9600, 'JPY'],
    ['12:00', '13:00', 'meal', 'ほうとう不動 東恋路店（雲朵造型建築）', 'ほうとう不動 東恋路店', '〒401-0301 山梨県南都留郡富士河口湖町船津東恋路2458', 35.4899, 138.7809, 6600, 'JPY'],
    ['13:30', '15:00', 'activity', '河口湖紅葉迴廊＋大石公園（もみじ回廊；富士河口湖紅葉祭期間有攤販）', 'もみじ回廊', '山梨県南都留郡富士河口湖町河口', 35.5239, 138.7634, 0, 'JPY'],
    ['15:30', '16:30', 'activity', '新倉山淺間公園 忠靈塔（398 階，爸媽在下面等）', '新倉山浅間公園', '〒403-0011 山梨県富士吉田市浅間2丁目4−1', 35.5012, 138.8014, 0, 'JPY'],
    ['17:00', '19:00', 'transport', '河口湖 → 新宿 高速巴士', 'バスタ新宿', '東京都渋谷区千駄ヶ谷5丁目24−55', 35.6884, 139.7006, 8800, 'JPY'],
    ['19:30', null, 'meal', LONG_EN, null, LONG_URLISH, null, null, 12000, 'JPY'],
  ]],
  ['橫濱中華街・回程', [
    ['09:00', '10:00', 'accommodation', 'Check-out、行李寄放', 'ホテル雅叙園東京', '〒153-0064 東京都目黒区下目黒1丁目8−1', 35.6316, 139.7128, 0, 'JPY'],
    ['10:30', '12:00', 'shopping', '澀谷 PARCO（Nintendo TOKYO、ポケモンセンターシブヤ）最後採購', '渋谷PARCO', '〒150-8377 東京都渋谷区宇田川町15−1', 35.6620, 139.6987, 30000, 'JPY'],
    ['12:30', '14:00', 'meal', '橫濱中華街 聘珍樓', '聘珍樓 横濱本店', '神奈川県横浜市中区山下町149', 35.4433, 139.6456, 24800, 'JPY'],
    ['14:15', '17:05', 'transport', '成田 → 桃園（BR197）', '成田国際空港', '千葉県成田市古込1−1', 35.7720, 140.3929, 0, 'TWD'],
  ]],
];
DAYS.forEach(([theme, items], d) => {
  const date = twKey(daysAgo(24 - d));
  queue(`itineraries/${TRIP}/days/${date}`, { date, theme });
  items.forEach(([startTime, endTime, type, title, placeName, address, lat, lng, estimatedCost, currency], i) => queue(`itineraries/${TRIP}/days/${date}/items/it${String(i).padStart(2, '0')}`, {
    order: i, startTime, ...(endTime ? { endTime } : {}), type, title, ...(placeName ? { placeName, placeId: `seed-place-${d}-${i}` } : {}), ...(address ? { address } : {}), ...(lat != null ? { lat, lng, mapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` } : {}),
    estimatedCost, ...(i % 2 === 0 ? { actualCost: Math.round(estimatedCost * 1.08) } : {}), currency, notes: i % 3 === 0 ? `記得先買票。${LONG_ZH}` : i % 3 === 1 ? '可刷 Suica' : '', status: i % 5 === 4 ? 'skipped' : 'done',
    ...(type !== 'transport' && placeName ? { openingHours: hours(i % 4 === 3) } : {}),
  }));
});
for (let d = 0; d < 3; d += 1) { const date = twKey(daysAhead(75 + d)); queue(`itineraries/trip-hokkaido-2027/days/${date}`, { date, theme: ['抵達札幌', '二世谷 Grand Hirafu 滑雪', '小樽運河'][d] }); for (let i = 0; i < 3; i += 1) queue(`itineraries/trip-hokkaido-2027/days/${date}/items/it${i}`, { order: i, startTime: `${String(9 + i * 4).padStart(2, '0')}:00`, type: ['transport', 'activity', 'meal'][i], title: ['新千歲機場 → 札幌', 'Niseko Grand Hirafu 全日雪票＋私人教練（中文）', '成吉思汗烤羊肉 だるま 本店'][i], estimatedCost: [4000, 45000, 9000][i], currency: 'JPY', status: 'planned' }); }

// ---------------------------------------------------------------- flight watches
const fwEstimate = (base, k) => ({
  minPriceTWD: base, typicalPriceTWD: Math.round(base * 1.22), maxPriceTWD: Math.round(base * 1.9), confidence: ['high', 'medium', 'low'][k % 3], summary: '近兩週票價緩步走低，長榮與星宇在 12/18 前後有促銷艙位；跨年檔期（12/27–1/3）仍比淡季貴約 45%，建議避開或提早下訂。',
  advice: ['buy_now', 'watch', 'wait'][k % 3], adviceReason: '目前價格已低於近 90 天中位數 12%，且距出發不到 60 天，再等下去降價空間有限、漲價風險較高。',
  cabinEstimates: [{ cabin: 'economy', minPriceTWD: base, typicalPriceTWD: Math.round(base * 1.2), maxPriceTWD: Math.round(base * 1.8), bestAirline: '長榮航空 EVA Air' }, { cabin: 'premium_economy', minPriceTWD: Math.round(base * 1.7), typicalPriceTWD: Math.round(base * 2), maxPriceTWD: Math.round(base * 2.6), bestAirline: '星宇航空 STARLUX Airlines' }, { cabin: 'business', minPriceTWD: Math.round(base * 3.4), typicalPriceTWD: Math.round(base * 4.1), maxPriceTWD: Math.round(base * 6.2), bestAirline: 'All Nippon Airways' }],
  travelWindows: Array.from({ length: 6 }, (_, i) => ({ departureDate: twKey(daysAhead(40 + i * 3)), returnDate: twKey(daysAhead(46 + i * 3)), cabin: i % 3 === 2 ? 'business' : 'economy', priceTWD: Math.round(base * (1 + i * 0.07) * (i % 3 === 2 ? 3.4 : 1)), airline: ['長榮航空', '星宇航空', '中華航空 China Airlines', 'Japan Airlines', 'Peach Aviation', 'Cathay Pacific Airways'][i], stops: i % 4 === 3 ? 1 : 0, reason: i % 2 ? '平日出發、紅眼班機，價格最低但抵達時間是清晨 05:10' : '直飛、時段佳', ...(i % 3 === 1 ? { ticketing: 'separate', outboundPriceTWD: Math.round(base * 0.55), returnPriceTWD: Math.round(base * 0.52), returnAirline: 'ZIPAIR Tokyo' } : { ticketing: 'single' }), departureTime: '08:50', arrivalTime: '13:15', durationMinutes: 205 + i * 15, flightNumber: `BR${198 + i}`, returnDepartureTime: '14:15', returnArrivalTime: '17:05' })),
  sources: [{ title: 'Google Flights — TPE to NRT round trip', url: 'https://www.google.com/travel/flights?q=Flights%20to%20NRT%20from%20TPE' }, { title: 'Skyscanner', url: 'https://www.skyscanner.com.tw/' }, { title: '長榮航空官網促銷頁', url: 'https://www.evaair.com/zh-tw/' }], ...(k % 2 ? { provider: 'claude' } : {}), checkedAt: hoursAgo(5 + k),
});
const FW = [
  ['fw-tokyo', '東京跨年（owner＋伴侶＋爸媽）', 'roundtrip', 'TPE', 'NRT', '', '', 'single', 12345, ['economy', 'premium_economy', 'business'], 4, 'claude', '北海道滑雪'], ['fw-sapporo', '札幌滑雪', 'openjaw', 'TPE', 'CTS', 'HKD', 'TPE', 'both', 18760, ['economy'], 2, 'gemini', '北海道滑雪'],
  ['fw-london', 'London Heathrow 商務艙里程票替代方案', 'roundtrip', 'TPE', 'LHR', '', '', 'separate', 123456, ['business', 'first'], 2, 'duffel', ''], ['fw-oneway', '回程單程', 'oneway', 'KIX', 'TPE', '', '', null, 4321, ['economy'], 1, 'claude', ''],
  ['fw-err', '已停用：曼谷', 'roundtrip', 'TPE', 'BKK', '', '', 'single', 7890, ['economy'], 2, 'gemini', ''],
];
FW.forEach(([id, segmentLabel, tripType, origin, destination, returnOrigin, returnDestination, ticketSearch, base, cabins, adults, scanProvider, claudeGroup], k) => {
  queue(`flight_watches/${id}`, {
    userId: REX, sharedWith: k === 0 ? [PARTNER] : [], segmentLabel, tripType, claudeGroup, origin, destination, returnOrigin, returnDestination, ticketSearch, departureStart: daysAhead(40), departureEnd: daysAhead(60), minNights: 5, maxNights: 9, adults,
    cabin: cabins[0], selectedCabins: cabins, nonstopOnly: k % 2 === 0, excludeLowCostCarriers: k === 0, airlineFilter: k === 0 ? 'include' : k === 2 ? 'exclude' : 'all', airlineCodes: k === 0 ? ['BR', 'JX', 'CI', 'NH', 'JL'] : k === 2 ? ['MU', 'CA'] : [],
    scanProvider, geminiModel: 'gemini-2.5-pro', scanFrequency: ['daily', 'weekdays', 'weekly'][k % 3], weeklyDay: 1, notifyOnDeal: true, notifyOnEveryScan: k === 0, priceDropPercent: 5, maxPriceTWD: k === 3 ? null : Math.round(base * 1.1), enabled: k !== 4,
    latestEstimate: fwEstimate(base, k), bestPriceTWD: Math.round(base * 0.94), lastError: k === 4 ? 'Duffel API error 429: rate limit exceeded for offer_requests; retry after 3600 seconds (request id: req_0000AbCdEfGhIjKlMnOpQr)' : null, lastCheckedAt: hoursAgo(5 + k), claudePromptKey: null, createdAt: daysAgo(30 - k), updatedAt: hoursAgo(5 + k),
  });
  for (let s = 0; s < 30; s += 1) { const est = fwEstimate(Math.round(base * (1 + Math.sin(s / 4) * 0.12 + s * 0.004)), k); queue(`flight_watches/${id}/snapshots/s${String(s).padStart(2, '0')}`, { ...est, travelWindows: est.travelWindows.slice(0, 3), checkedAt: daysAgo(s) }); }
});

// ---------------------------------------------------------------- notifications / audit / error logs
const NOTIF = [
  ['budget-warn', '預算警示：餐飲已用 92%', '本月餐飲預算 NT$15,000，已花 NT$13,812，還有 19 天。照目前速度月底會超支約 NT$9,400。', 'warn', '/ledger?tab=analysis'],
  ['cc-due', '信用卡帳單即將到期：中國信託 LINE Pay 聯名卡御璽卡', '應繳 NT$1,234,567，繳款截止日 11/10（已逾期 1 天）。請確認薪轉戶餘額是否足夠自動扣繳。', 'error', '/settings?tab=bills'],
  ['alert-fx', 'USD/TWD 跌破 31.5', '現價 31.482。提醒內容：美金跌破 31.5 分批換匯（每次 5,000 美元，共三次）', 'info', '/fx'],
  ['taifex', '台指期模擬：訊號翻空，明日開盤反手 8 口', `綜合分數 -0.47。${LONG_ZH}`, 'warn', '/taifex'],
  ['radar', '股市雷達（台股）：3 檔建議減碼', '2317 鴻海精密工業、2603 長榮海運、3008 大立光電', 'info', '/stock-radar'],
  ['flight', '機票降價：TPE → NRT 來回 NT$12,345（-11%）', '長榮航空 12/18 出發、12/24 回程，直飛。', 'info', '/flights'],
  ['system', LONG_EN, LONG_URLISH, 'error', null],
  ['sched', '排程支出 3 天後到期：何嘉仁美語 冬季班學費 NT$38,000', '', 'warn', '/settings?tab=scheduled'],
];
for (let i = 0; i < 32; i += 1) { const [key, title, body, severity, link] = NOTIF[i % NOTIF.length]; queue(`notifications/ntf-${i}`, { userId: REX, key: `${key}-${i}`, title, body, createdAt: hoursAgo(i * 7 + 1), readAt: i > 9 ? hoursAgo(i * 7) : null, link, severity, telegramOk: i % 6 === 0 ? false : i % 6 === 1 ? null : true }); }
const AUD_SCOPE = ['transactions', 'accounts', 'portfolio', 'trips', 'categories', 'credit_card_bills', 'installment_plans'];
const AUD_ACT = ['create', 'update', 'delete', 'restore', 'archive', 'unarchive'];
for (let i = 0; i < 40; i += 1) queue(`audit_logs/aud-${i}`, { userId: REX, timestamp: hoursAgo(i * 5 + 1), scope: AUD_SCOPE[i % 7], action: AUD_ACT[i % 6], entityId: `rex-tx-${i}-${'x'.repeat(i % 4 === 0 ? 40 : 4)}`, summary: i % 3 === 0 ? `修改金額 NT$1,234,567 → NT$12,345,678；備註：${LONG_ZH}` : '新增交易 鼎泰豐 信義店 NT$2,380', before: i % 2 ? { amountTWD: 1234567, note: '舊備註' } : null, after: { amountTWD: 12345678, note: LONG_ZH, category: 'food' } });
for (let i = 0; i < 12; i += 1) queue(`error_logs/err-${i}`, { scope: ['Ledger', 'Investments', 'appsScript:updateStockPrices', 'TripDetail'][i % 4], message: i % 2 ? `FirebaseError: Missing or insufficient permissions. (path: transactions/${'a'.repeat(28)})` : 'TypeError: Cannot read properties of undefined (reading \'toFixed\') at formatCurrencyWithVeryLongFunctionNameForLayoutTesting', stack: `Error: boom\n    at render (https://example.web.app/assets/index-${'f'.repeat(16)}.js:1:234567)\n    at commitRoot (https://example.web.app/assets/vendor-react-${'e'.repeat(16)}.js:40:1234)`, componentStack: '\n    in TransactionList\n    in LedgerPage\n    in ErrorBoundary', userId: REX, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1', url: `https://example.web.app/ledger?tab=analysis&from=${LONG_EN}`, createdAt: hoursAgo(i * 5 + 1) });

await flush();
console.log('seeded stress data for rex@example.com (all pages)');
