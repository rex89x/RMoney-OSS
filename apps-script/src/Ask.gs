/**
 * 自然語言查詢（Claude tool use，Claude.gs）
 *
 * askFinance({ question }) → { ok, answer, toolCalls: [...] }
 *
 * LLM 只能呼叫 HubTools.gs 的唯讀工具（hubToolDefs_），不直接碰 Firestore。
 * 帳務聚合類的實作在這裡（askRunTool_），投資 / 旅遊 / 其他資料集在 HubTools.gs：
 *   sum_by_category(start, end, type)      期間各類別合計
 *   sum_by_month(start, end)               期間逐月收入 / 支出
 *   sum_by_payment_method(start, end)      期間各支付方式支出
 *   list_transactions(start, end, keyword?, category?, type?, minAmountTWD?, limit?, offset?)  明細（最多 200 筆）
 *   budget_status(month)                   某月預算使用率
 *   net_worth_latest()                     最新淨值快照
 *   portfolio_latest()                     最新投資快照（市值 / 損益 / 前 10 檔）
 *   accounts_balance()                     各帳戶餘額
 *
 * 日期一律 yyyy-MM-dd（台北）。金額為 TWD。
 * Telegram：/ask <問題>；Web：action=askFinance。
 */

var ASK_MAX_ROUNDS_ = 6;

function askParseDate_(s, endOfDay) {
  var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  var y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, d = parseInt(m[3], 10);
  // 台北 00:00 / 23:59:59 → UTC
  var utc = Date.UTC(y, mo, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0) - 8 * 3600000;
  return new Date(utc);
}

function askCategoryNames_() {
  var names = {};
  try {
    fsListDocs_('categories', 100).forEach(function (c) {
      var key = c.key || String(c._name).split('/').pop();
      names[key] = c.name || key;
    });
  } catch (err) { console.warn('askCategoryNames_', err); }
  return names;
}

function askTxAmount_(t) {
  if (t.settledAmountTWD != null) return Number(t.settledAmountTWD) || 0;
  return Number(t.amountTWD) || 0;
}

function askRunTool_(name, args) {
  args = args || {};
  var start = askParseDate_(args.start, false);
  var end = askParseDate_(args.end, true);
  switch (name) {
    case 'sum_by_category': {
      if (!start || !end) return { error: 'bad date' };
      var type = args.type === 'income' ? 'income' : 'expense';
      var txs = queryTxsBetween_(start, end);
      var names = askCategoryNames_();
      var agg = {};
      var total = 0;
      txs.forEach(function (t) {
        if (!(type === 'expense' ? isConsumptionExpense_(t) : isEarnedIncome_(t))) return;
        var amt = askTxAmount_(t);
        var k = t.category || 'other';
        agg[k] = (agg[k] || 0) + amt;
        total += amt;
      });
      var rows = Object.keys(agg).map(function (k) { return { category: k, name: names[k] || k, amountTWD: Math.round(agg[k]) }; })
        .sort(function (a, b) { return b.amountTWD - a.amountTWD; });
      return { type: type, start: args.start, end: args.end, totalTWD: Math.round(total), byCategory: rows };
    }
    case 'sum_by_month': {
      if (!start || !end) return { error: 'bad date' };
      var txs2 = queryTxsBetween_(start, end);
      var months = {};
      txs2.forEach(function (t) {
        if (t.deletedAt) return;
        var d = t.date instanceof Date ? t.date : new Date(t.date);
        var k = Utilities.formatDate(d, TZ, 'yyyy-MM');
        if (!months[k]) months[k] = { month: k, incomeTWD: 0, expenseTWD: 0 };
        // 消費支出 / 實際收入口徑（Notifications.gs isConsumptionExpense_ / isEarnedIncome_）
        if (isEarnedIncome_(t)) months[k].incomeTWD += askTxAmount_(t);
        else if (isConsumptionExpense_(t)) months[k].expenseTWD += askTxAmount_(t);
      });
      return { months: Object.keys(months).sort().map(function (k) {
        return { month: k, incomeTWD: Math.round(months[k].incomeTWD), expenseTWD: Math.round(months[k].expenseTWD) };
      }) };
    }
    case 'sum_by_payment_method': {
      if (!start || !end) return { error: 'bad date' };
      var txs3 = queryTxsBetween_(start, end);
      var pm = {};
      txs3.forEach(function (t) {
        if (!isConsumptionExpense_(t)) return;
        var k = t.paymentMethod || '未填';
        pm[k] = (pm[k] || 0) + askTxAmount_(t);
      });
      return { byPaymentMethod: Object.keys(pm).map(function (k) { return { paymentMethod: k, amountTWD: Math.round(pm[k]) }; })
        .sort(function (a, b) { return b.amountTWD - a.amountTWD; }) };
    }
    case 'list_transactions': {
      if (!start || !end) return { error: 'bad date' };
      var limit = Math.min(200, Math.max(1, parseInt(args.limit, 10) || 20));
      var offset = Math.max(0, parseInt(args.offset, 10) || 0);
      var kw = String(args.keyword || '').toLowerCase();
      var cat = String(args.category || '');
      var txType = String(args.type || '');
      var minAmount = Number(args.minAmountTWD) || 0;
      var names2 = askCategoryNames_();
      var rows2 = queryTxsBetween_(start, end).filter(function (t) {
        if (t.deletedAt) return false;
        if (cat && t.category !== cat) return false;
        if (txType && t.type !== txType) return false;
        if (minAmount && askTxAmount_(t) < minAmount) return false;
        if (kw && String(t.note || '').toLowerCase().indexOf(kw) === -1) return false;
        return true;
      }).sort(function (a, b) {
        var da = a.date instanceof Date ? a.date.getTime() : new Date(a.date).getTime();
        var db = b.date instanceof Date ? b.date.getTime() : new Date(b.date).getTime();
        return db - da;
      });
      return {
        count: rows2.length,
        offset: offset,
        transactions: rows2.slice(offset, offset + limit).map(function (t) {
          var d = t.date instanceof Date ? t.date : new Date(t.date);
          return { date: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'), type: t.type, amountTWD: Math.round(askTxAmount_(t)),
            category: names2[t.category] || t.category, categoryKey: t.category || '', paymentMethod: t.paymentMethod || '', note: t.note || '' };
        }),
      };
    }
    case 'budget_status': {
      var month = String(args.month || '');
      if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'bad month' };
      var parts = month.split('-');
      var ms = askParseDate_(month + '-01', false);
      var lastDay = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10), 0).getDate();
      var me = askParseDate_(month + '-' + ('0' + lastDay).slice(-2), true);
      var spent = 0;
      queryTxsBetween_(ms, me).forEach(function (t) { if (isConsumptionExpense_(t)) spent += askTxAmount_(t); });
      var budgets = fsListDocs_('budgets', 50).filter(function (x) { return x.month === month; })[0];
      var total = budgets ? (Number(budgets.total) || 0) : 0;
      return { month: month, spentTWD: Math.round(spent), budgetTWD: Math.round(total),
        usagePct: total ? Math.round(spent / total * 100) : null, byCategory: budgets ? budgets.byCategory : null };
    }
    case 'net_worth_latest': {
      var docs = fsRunQuery_('', { from: [{ collectionId: 'net_worth_snapshots' }], orderBy: [{ field: { fieldPath: 'month' }, direction: 'DESCENDING' }], limit: 1 });
      var nw = docs && docs[0];
      if (!nw) return { error: 'no snapshot' };
      return { month: nw.month, liquidTWD: Math.round(nw.liquidTWD || 0), investmentTWD: Math.round(nw.investmentTWD || 0),
        manualAssetsTWD: Math.round(nw.manualAssetsTWD || 0), insurancePensionTWD: Math.round(nw.insurancePensionTWD || 0), liabilitiesTWD: Math.round(nw.liabilitiesTWD || 0),
        creditCardOutstandingTWD: Math.round(nw.creditCardOutstandingTWD || 0),
        installmentRemainingTWD: Math.round(nw.installmentRemainingTWD || 0), netWorthTWD: Math.round(nw.netWorthTWD || 0) };
    }
    case 'portfolio_latest': {
      var snap = getLatestSnapshot_();
      if (!snap) return { error: 'no snapshot' };
      var positions = (snap.positions || []).slice().sort(function (a, b) { return (b.valueTWD || 0) - (a.valueTWD || 0); }).slice(0, 10)
        .map(function (p) { return { symbol: p.symbol, market: p.market, shares: p.shares, valueTWD: Math.round(p.valueTWD || 0), pnlTWD: Math.round(p.pnlTWD || 0), pnlPct: Math.round((p.pnlPct || 0) * 10) / 10 }; });
      return { date: snap.date, totalValueTWD: Math.round(snap.totalValueTWD || 0), totalCostTWD: Math.round(snap.totalCostTWD || 0),
        unrealizedPnlTWD: Math.round(snap.unrealizedPnlTWD || 0), unrealizedPnlPct: Math.round((snap.unrealizedPnlPct || 0) * 10) / 10,
        dayChangeTWD: Math.round(snap.dayChangeTWD || 0), byMarket: snap.byMarket || {}, topPositions: positions };
    }
    case 'accounts_balance': {
      var accounts = fsListAllDocs_('accounts', 100).filter(function (a) { return a.active !== false && !a.archivedAt; });
      return { accounts: accounts.map(function (a) { return { name: a.name, type: a.type, currency: a.currency, balance: a.balance, balanceTWD: Math.round(accountBalanceTWD_(a)) }; }) };
    }
    default:
      return { error: 'unknown tool ' + name };
  }
}

function askSystemPrompt_() {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var weekday = Utilities.formatDate(new Date(), TZ, 'EEEE');
  return [
    '你是 owner 的個人助理，只回答與他在 Personal Hub 記錄的資料有關的問題：記帳、預算、資產淨值、投資持股、旅遊計畫與行程。',
    '今天是 ' + today + '（' + weekday + '，Asia/Taipei）。金額除非另外標示都是新台幣。',
    '需要數字或內容時一定先呼叫工具取得，不要憑空猜；只查回答問題需要的資料。「上個月」「今年」「最近三個月」等相對時間要換算成實際日期範圍。',
    '回答用繁體中文，簡短直接：先給結論，再列 2 到 5 個重點；金額用 NT$ 與千分位；避免長篇解釋；不要使用 emoji。',
    '如果資料不足或問題超出範圍，直接說明。',
  ].join('\n');
}

/** 主流程：Claude 自己挑工具查資料（claudeAgentLoop_），最多 ASK_MAX_ROUNDS_ 輪 */
function askFinance(body) {
  var question = String((body && body.question) || '').trim();
  if (!question) return { ok: false, error: 'missing question' };
  if (question.length > 500) question = question.slice(0, 500);
  try {
    var res = claudeAgentLoop_({
      feature: 'financeAsk', tier: 'default', effort: 'low', maxTokens: 8000,
      system: askSystemPrompt_(), messages: [{ role: 'user', content: question }],
      tools: hubToolDefs_(), runTool: hubCallTool_,
      maxRounds: ASK_MAX_ROUNDS_, deadlineMs: 150000, maxInputTokens: 120000,
    });
    return { ok: true, answer: res.text || '（沒有回覆內容）', toolCalls: res.toolCalls, model: res.model };
  } catch (err) {
    console.error('[askFinance]', err);
    return { ok: false, error: String(err && err.message || err) };
  }
}
