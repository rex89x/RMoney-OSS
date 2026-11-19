/**
 * 共同帳本公基金「每月計畫」：每月固定存入 + 固定從公基金扣款。
 *
 * 設定存在 `households/{hid}.fundPlan`（前端 features/household/fund-plan.ts 同一份規則）：
 *   enabled, dayOfMonth (1–31，超過當月天數就用月底), startMonth ('yyyy-MM'),
 *   autoRecord（到日自動幫每位成員記一筆存入）, contributions { uid: TWD },
 *   fixedExpenses [{ id, name, amountTWD, categoryKey, dayOfMonth, enabled }]
 *
 * 每天 01:00（tick_daily_0100）跑一次，全部冪等：
 * - 固定扣款：交易 id 固定為 `fundplan_{hid}_{itemId}_{yyyyMM}`，已存在（含軟刪）就不再建立，
 *   所以使用者刪掉某個月的扣款不會被補回來；前端「立即扣款」用同一個 id，不會重複。
 * - 自動存入：fund_entries 以 `planMonth` + `contributorUid` 判斷本月是否已存（手動記錄也算）；
 *   另外寫 `fundPlanRuns['c:{uid}'] = 'yyyy-MM'`，使用者刪掉自動存入那筆也不會在隔天又長回來。
 * - 只處理 startMonth 之後、而且「今天已到扣款日」的月份；不回補更早的月份。
 */

var FUND_PLAN_ITEM_ID_PATTERN_ = /^[A-Za-z0-9_-]{1,40}$/;

function runHouseholdFundPlans() {
  var households = [];
  try { households = fsListAllDocs_('households', 50); } catch (err) {
    console.error('[runHouseholdFundPlans] list households', err);
    return { ok: false, error: String(err) };
  }
  var now = new Date();
  var today = fundPlanTaipeiToday_(now);
  var summary = { ok: true, contributions: 0, expenses: 0, households: 0 };
  households.forEach(function (hh) {
    var plan = normalizeFundPlan_(hh.fundPlan);
    if (!plan || !plan.enabled) return;
    var hid = String(hh._name || '').split('/').pop();
    if (!hid) return;
    summary.households++;
    try {
      summary.expenses += runFundPlanExpenses_(hid, hh, plan, today, now);
      summary.contributions += runFundPlanContributions_(hid, hh, plan, today, now);
    } catch (err) {
      console.error('[runHouseholdFundPlans]', hid, err);
      try { notifyError('householdFundPlan', err); } catch (notifyErr) { console.error(notifyErr); }
    }
  });
  return summary;
}

/** 台北今天的年月日 */
function fundPlanTaipeiToday_(now) {
  return {
    year: Number(Utilities.formatDate(now, 'Asia/Taipei', 'yyyy')),
    month: Number(Utilities.formatDate(now, 'Asia/Taipei', 'M')),
    day: Number(Utilities.formatDate(now, 'Asia/Taipei', 'd')),
  };
}

function fundPlanMonthKey_(year, month) {
  return year + '-' + (month < 10 ? '0' : '') + month;
}

/** 指定日超過當月天數時用月底（2 月 30 號 → 2/28 或 2/29） */
function fundPlanDueDay_(dayOfMonth, year, month) {
  var last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(Math.max(1, Math.round(Number(dayOfMonth) || 1)), last);
}

/** 今天是否已經到了這個月的扣款／存入日，而且在計畫開始月份之後 */
function fundPlanIsDue_(plan, dayOfMonth, today) {
  var monthKey = fundPlanMonthKey_(today.year, today.month);
  if (plan.startMonth && monthKey < plan.startMonth) return false;
  return today.day >= fundPlanDueDay_(dayOfMonth, today.year, today.month);
}

/** 台北某日中午（UTC 04:00），避免 Timestamp 在任何時區被推到前一天 */
function fundPlanDueDate_(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 4, 0, 0));
}

function normalizeFundPlan_(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var contributions = {};
  Object.keys(raw.contributions || {}).forEach(function (uid) {
    var amount = Math.round(Number(raw.contributions[uid]));
    if (isFinite(amount) && amount > 0) contributions[uid] = amount;
  });
  var fixedExpenses = (Array.isArray(raw.fixedExpenses) ? raw.fixedExpenses : [])
    .map(function (item) {
      if (!item || !FUND_PLAN_ITEM_ID_PATTERN_.test(String(item.id || ''))) return null;
      var amount = Math.round(Number(item.amountTWD));
      if (!isFinite(amount) || amount <= 0 || !item.categoryKey) return null;
      return {
        id: String(item.id),
        name: String(item.name || '').slice(0, 40),
        amountTWD: amount,
        categoryKey: String(item.categoryKey),
        dayOfMonth: Math.min(31, Math.max(1, Math.round(Number(item.dayOfMonth) || 1))),
        enabled: item.enabled !== false,
      };
    })
    .filter(function (item) { return item !== null; });
  return {
    enabled: raw.enabled === true,
    dayOfMonth: Math.min(31, Math.max(1, Math.round(Number(raw.dayOfMonth) || 1))),
    startMonth: /^\d{4}-\d{2}$/.test(String(raw.startMonth || '')) ? String(raw.startMonth) : '',
    autoRecord: raw.autoRecord === true,
    contributions: contributions,
    fixedExpenses: fixedExpenses,
  };
}

/** 公基金付款仍依預設比例記錄「各成員負擔」，與前端 SplitEditor 的 ratio 模式一致（尾差給最後一位） */
function fundPlanShares_(amountTWD, memberIds, splitRatio) {
  var ids = (memberIds || []).filter(Boolean);
  if (ids.length === 0) return [];
  var ratio = splitRatio || {};
  var total = ids.reduce(function (sum, id) { return sum + (Number(ratio[id]) || 0); }, 0);
  var shares = [];
  var allocated = 0;
  ids.forEach(function (id, index) {
    var weight = total > 0 ? (Number(ratio[id]) || 0) / total : 1 / ids.length;
    var amount = index === ids.length - 1 ? amountTWD - allocated : Math.round(amountTWD * weight);
    allocated += amount;
    shares.push({ memberId: id, amountTWD: amount });
  });
  return shares;
}

function fundPlanExpenseTxId_(hid, itemId, year, month) {
  return 'fundplan_' + hid + '_' + itemId + '_' + year + (month < 10 ? '0' : '') + month;
}

function runFundPlanExpenses_(hid, hh, plan, today, now) {
  var created = 0;
  plan.fixedExpenses.forEach(function (item) {
    if (!item.enabled || !fundPlanIsDue_(plan, item.dayOfMonth, today)) return;
    var txId = fundPlanExpenseTxId_(hid, item.id, today.year, today.month);
    if (fsGetDoc_('transactions/' + txId)) return;
    var dueDay = fundPlanDueDay_(item.dayOfMonth, today.year, today.month);
    fsSetDoc_('transactions/' + txId, buildFundPlanExpenseTx_(hid, hh, item, today.year, today.month, dueDay, now), false);
    created++;
  });
  return created;
}

function buildFundPlanExpenseTx_(hid, hh, item, year, month, dueDay, now) {
  return {
    userId: hh.ownerId,
    type: 'expense',
    amount: item.amountTWD,
    currency: 'TWD',
    amountTWD: item.amountTWD,
    fxRate: 1,
    category: item.categoryKey,
    paymentMethod: '公基金',
    fromAccountId: null,
    toAccountId: null,
    transferGroup: null,
    note: item.name || '公基金固定扣款',
    date: fundPlanDueDate_(year, month, dueDay),
    createdAt: now,
    updatedAt: now,
    tripId: null,
    tags: ['共同', '公基金固定扣款'],
    recurringId: null,
    deletedAt: null,
    scope: 'household',
    householdId: hid,
    paidByUid: HOUSEHOLD_FUND_PAYER_ID_,
    payerId: null,
    shareType: 'custom',
    customShares: fundPlanShares_(item.amountTWD, hh.memberIds, hh.splitRatio),
    // 公基金付款不形成任何人的負擔（與 splitPatch 一致）
    myShareTWD: 0,
    fundPlanItemId: item.id,
    fundPlanMonth: fundPlanMonthKey_(year, month),
  };
}

function runFundPlanContributions_(hid, hh, plan, today, now) {
  if (!plan.autoRecord || !fundPlanIsDue_(plan, plan.dayOfMonth, today)) return 0;
  var monthKey = fundPlanMonthKey_(today.year, today.month);
  var runs = hh.fundPlanRuns && typeof hh.fundPlanRuns === 'object' ? hh.fundPlanRuns : {};
  var memberIds = hh.memberIds || [];
  var existing = fsRunQuery_('households/' + hid, {
    from: [{ collectionId: 'fund_entries' }],
    where: { fieldFilter: { field: { fieldPath: 'planMonth' }, op: 'EQUAL', value: { stringValue: monthKey } } },
    limit: 50,
  });
  var already = {};
  existing.forEach(function (entry) { if (entry.contributorUid) already[entry.contributorUid] = true; });
  var dueDay = fundPlanDueDay_(plan.dayOfMonth, today.year, today.month);
  var runPatch = {};
  var created = 0;
  memberIds.forEach(function (uid) {
    var amount = plan.contributions[uid];
    if (!amount || already[uid] || runs['c:' + uid] === monthKey) return;
    fsAddDoc_('households/' + hid + '/fund_entries', {
      type: 'contribution',
      amountTWD: amount,
      contributorUid: uid,
      note: monthKey.replace('-', '/') + ' 每月固定存入',
      date: fundPlanDueDate_(today.year, today.month, dueDay),
      // 記在本人名下，本人之後可以自己修改或刪除
      createdBy: uid,
      createdAt: now,
      planMonth: monthKey,
      source: 'plan',
    });
    runPatch['c:' + uid] = monthKey;
    created++;
  });
  if (created > 0) {
    var merged = {};
    Object.keys(runs).forEach(function (key) { merged[key] = runs[key]; });
    Object.keys(runPatch).forEach(function (key) { merged[key] = runPatch[key]; });
    fsSetDoc_('households/' + hid, { fundPlanRuns: merged }, true);
  }
  return created;
}
