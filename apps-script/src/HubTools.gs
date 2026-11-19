/**
 * Hub 資料工具（唯讀）— 讓 LLM「自己去找資料」的單一工具清單。
 *
 * 三個入口共用同一份定義與 handler：
 *   1. MCP 端點（Mcp.gs，action=mcp）— Claude.ai / Claude Code / Claude Desktop 等外部 client
 *   2. App 內 AI 分析（ClaudeAnalysis.gs）— Claude 依任務自行決定要查哪些資料
 *   3. 問一下（Ask.gs askFinance）與 Telegram /ask
 *
 * 設計原則：
 *   - 全部唯讀，不提供任何寫入工具。
 *   - 先給「目錄」（hub_catalog），再讓模型按需要取用聚合或明細；每個工具都有筆數 / 字數上限，
 *     不會一次把整個資料庫倒出去。
 *   - 金額一律 TWD；日期 yyyy-MM-dd（Asia/Taipei）；支出 / 收入口徑同 isConsumptionExpense_ / isEarnedIncome_。
 *   - 帳務聚合類工具沿用 Ask.gs askRunTool_（單一口徑），這裡只補投資、旅遊、機票雷達與其他資料集。
 */

var HUB_TOOL_RESULT_MAX_CHARS_ = 40000;
var HUB_FLIGHT_CABINS_ = ['economy', 'premium_economy', 'business', 'first'];
/** 機票歷史一次最多讀幾筆快照（每天 1–2 筆，約半年以上） */
var HUB_FLIGHT_SNAPSHOT_LIMIT_ = 300;

/** list_records 可查的資料集：collection + 說明 + 「啟用中」的判斷 */
var HUB_DATASETS_ = {
  recurring: { collection: 'recurring', label: '週期交易範本（固定收支）', active: function (r) { return r.active !== false; } },
  subscriptions: { collection: 'subscriptions', label: '訂閱', active: function (r) { return r.active !== false && !r.archivedAt && !r.cancelledAt; } },
  scheduled_payments: { collection: 'scheduled_payments', label: '預定付款', active: function (r) { return !r.paidAt && !r.archivedAt; } },
  installment_plans: { collection: 'installment_plans', label: '分期付款計畫', active: function (r) { return r.active !== false && !r.archivedAt; } },
  savings_goals: { collection: 'savings_goals', label: '儲蓄目標', active: function (r) { return !r.archivedAt; } },
  investment_plans: { collection: 'investment_plans', label: '投資 / 退休規劃', active: function (r) { return !r.archivedAt; } },
  liabilities: { collection: 'liabilities', label: '負債', active: function (r) { return !r.archivedAt; } },
  manual_assets: { collection: 'manual_assets', label: '手動登錄資產（不動產、車等）', active: function (r) { return !r.archivedAt; } },
  rentals: { collection: 'rentals', label: '租賃購入 / 出租設備', active: function (r) { return !r.archivedAt; } },
  budgets: { collection: 'budgets', label: '每月預算' },
  categories: { collection: 'categories', label: '收支類別（key 與名稱）', active: function (r) { return !r.archivedAt; } },
  credit_card_bills: { collection: 'credit_card_bills', label: '信用卡帳單' },
  dividends: { collection: 'dividends', label: '已領股利紀錄' },
  realized_lots: { collection: 'realized_lots', label: '已實現損益（賣出紀錄）' },
  watchlist: { collection: 'watchlist', label: '觀察名單' },
  flight_watches: { collection: 'flight_watches', label: '機票價格追蹤（原始設定；價格與歷史請用 flight_* 工具）', active: function (r) { return r.enabled !== false; } },
  fx_rates: { collection: 'fx_rates', label: '匯率（對 TWD）' },
};

/** 不該送給 LLM 的欄位（身分識別 / 內部狀態 / 大型 blob） */
var HUB_HIDDEN_FIELDS_ = {
  userId: true, ownerId: true, createdBy: true, updatedBy: true, sharedWith: true, pendingInvites: true,
  email: true, uid: true, storagePath: true, driveFileId: true, driveLink: true, coverImage: true, photoUrl: true,
  openingHours: true, lots: true, history: true, snapshots: true, rawResponse: true, fxRatesUsed: true,
  sourceId: true, sourcePlaceQuery: true, placeId: true, lat: true, lng: true,
};

function hubTool_(name, description, properties, required) {
  return {
    name: name,
    description: description,
    input_schema: { type: 'object', properties: properties || {}, required: required || [] },
  };
}

/** 工具定義（Anthropic tool 格式；MCP 的 inputSchema 由 Mcp.gs 轉換）。順序固定 → prompt cache 穩定。 */
function hubToolDefs_() {
  var start = { type: 'string', description: '起始日 yyyy-MM-dd（含，台北時間）' };
  var end = { type: 'string', description: '結束日 yyyy-MM-dd（含，台北時間）' };
  var tripId = { type: 'string', description: '旅程 id（由 list_trips 取得）' };
  var watchId = { type: 'string', description: '機票追蹤 id（由 flight_watches 取得）' };
  var cabin = { type: 'string', enum: HUB_FLIGHT_CABINS_, description: '只看這個艙等（選填；不填 = 所有追蹤艙等中的最低價）' };
  return [
    hubTool_('hub_catalog', '列出 Personal Hub 有哪些資料可以查（帳務、投資、旅遊、其他資料集）以及對應的工具。不確定資料在哪裡時先呼叫這個。'),
    hubTool_('sum_by_category', '期間內各類別合計金額（TWD）。type 可為 expense（消費支出）/ income（實際收入）。',
      { start: start, end: end, type: { type: 'string', enum: ['expense', 'income'], description: '預設 expense' } }, ['start', 'end']),
    hubTool_('sum_by_month', '期間內逐月收入與消費支出合計（TWD）。看趨勢、儲蓄率用。', { start: start, end: end }, ['start', 'end']),
    hubTool_('sum_by_payment_method', '期間內各支付方式（現金 / 信用卡名稱）的消費支出合計。', { start: start, end: end }, ['start', 'end']),
    hubTool_('spend_by_merchant', '期間內依備註（店家 / 項目）彙總的消費支出：次數、合計、出現月份數、金額樣本。找訂閱、重複扣款、常去店家用。',
      { start: start, end: end, minMonths: { type: 'integer', description: '至少出現在幾個不同月份才列出，預設 1' }, limit: { type: 'integer', description: '預設 30，最多 80' } }, ['start', 'end']),
    hubTool_('list_transactions', '期間內交易明細，新到舊。可用關鍵字比對備註、限定類別 key / 收支型別 / 最低金額；用 offset 翻頁。',
      { start: start, end: end, keyword: { type: 'string' }, category: { type: 'string', description: '類別 key，例如 food' },
        type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, minAmountTWD: { type: 'number' },
        limit: { type: 'integer', description: '預設 20，最多 200' }, offset: { type: 'integer', description: '略過前幾筆，預設 0' } }, ['start', 'end']),
    hubTool_('budget_status', '某月（yyyy-MM）的預算與實際消費支出。', { month: { type: 'string', description: 'yyyy-MM' } }, ['month']),
    hubTool_('accounts_balance', '各帳戶（現金、銀行、信用卡、投資帳戶等）目前餘額（TWD 換算）。'),
    hubTool_('net_worth_latest', '最新一筆淨值快照（流動資產、投資、負債、淨值）。'),
    hubTool_('net_worth_history', '最近 N 個月的淨值快照（每月一筆），看資產變化趨勢。',
      { months: { type: 'integer', description: '預設 12，最多 36' } }),
    hubTool_('portfolio_latest', '最新投資快照摘要：總市值、成本、未實現損益、當日變動、市場配置、前 10 大持股。'),
    hubTool_('portfolio_positions', '目前持股明細（來自最新投資快照）：股數、市值、占比、損益。可限定市場或代號。',
      { market: { type: 'string', enum: ['TW', 'US'] }, symbols: { type: 'array', items: { type: 'string' }, description: '只看這些代號' },
        sortBy: { type: 'string', enum: ['value', 'pnl', 'pnlPct'], description: '預設 value（市值大到小）' },
        limit: { type: 'integer', description: '預設 30，最多 100' } }),
    hubTool_('portfolio_history', '期間內投資組合每日快照的總市值 / 成本 / 未實現損益（超過 60 點會等距取樣）。',
      { start: start, end: end }, ['start', 'end']),
    hubTool_('stock_quotes', '查指定股票的最新報價（現價、漲跌、昨收、除權息預告）。',
      { symbols: { type: 'array', items: { type: 'string' }, description: '股票代號，例如 ["2330","AAPL"]，最多 20 檔' } }, ['symbols']),
    hubTool_('list_trips', '列出旅程（id、名稱、目的地、日期、預算、狀態）。status 可篩選 planning / active / done。',
      { status: { type: 'string', enum: ['planning', 'active', 'done'] } }),
    hubTool_('trip_detail', '單一旅程的完整資訊：日期、目的地、預算、成員、備註，以及已記帳花費的總額與各類別合計。', { tripId: tripId }, ['tripId']),
    hubTool_('trip_itinerary', '旅程的行程表（每天的主題與項目：時間、標題、地點、類型、預估 / 實際花費、狀態）。可用 date 只看某一天。',
      { tripId: tripId, date: { type: 'string', description: 'yyyy-MM-dd，只看這一天（選填）' } }, ['tripId']),
    hubTool_('trip_expenses', '旅程的記帳明細（日期、金額、類別、備註），新到舊。',
      { tripId: tripId, limit: { type: 'integer', description: '預設 50，最多 200' } }, ['tripId']),
    hubTool_('flight_watches', '機票雷達的追蹤航線清單：航線、日期區段、晚數、艙等、理想價、歷史最低價，以及最新一次查價的價格區間與各艙等價格。查歷史前先用這個拿 watchId。',
      { includePaused: { type: 'boolean', description: '是否包含已暫停的航線，預設 false' } }),
    hubTool_('flight_price_history', '單一機票追蹤航線的歷史價格走勢（每天一點：最低 / 常見 / 最高價，超過 90 點會等距取樣）與統計：期間最低 / 最高、平均、目前價格相對歷史的位置。判斷「現在算不算便宜、趨勢往哪走」用。',
      { watchId: watchId, start: start, end: end, cabin: cabin }, ['watchId']),
    hubTool_('flight_date_prices', '單一機票追蹤航線歷次查價看到的「出發日 / 回程日」候選票價：每組日期的最新價、歷史最低價、被查到的次數、航空公司與轉機次數，由便宜到貴。判斷「哪幾天出發比較便宜」用。',
      { watchId: watchId, cabin: cabin, upcomingOnly: { type: 'boolean', description: '只看出發日在今天之後的，預設 true' },
        limit: { type: 'integer', description: '預設 40，最多 120' } }, ['watchId']),
    hubTool_('list_records', '讀取其他資料集的紀錄。dataset 可為：' + Object.keys(HUB_DATASETS_).map(function (k) {
      return k + '（' + HUB_DATASETS_[k].label + '）';
    }).join('、') + '。',
      { dataset: { type: 'string', enum: Object.keys(HUB_DATASETS_) },
        activeOnly: { type: 'boolean', description: '只列啟用中 / 未封存的，預設 true' },
        limit: { type: 'integer', description: '預設 50，最多 200' } }, ['dataset']),
    hubTool_('taifex_weekly_review', '台指期模擬（虛擬交易，不接券商）一週的完整狀態，給每週檢討用：主帳戶本週損益 / 每日權益 / 平倉交易、每天的訊號與因子分數、'
      + '策略競賽各變體的表現、每週 walk-forward 最佳化與回測結果、盤中技術模擬各監控頻率的績效、目前生效的參數（門檻 / 因子權重 / 資金管理 / 盤中規則）與可調整範圍、最近幾次檢討。',
      { weekEnd: { type: 'string', description: 'yyyy-MM-dd，要看的那一週裡的任何一天（週一到週日為一週）；不給就是今天所在的這一週' } }),
  ];
}

function hubToolNames_() {
  return hubToolDefs_().map(function (t) { return t.name; });
}

// -------- helpers --------

function hubInt_(value, fallback, min, max) {
  var n = parseInt(value, 10);
  if (!isFinite(n)) n = fallback;
  return Math.min(max, Math.max(min, n));
}

function hubDateStr_(value) {
  if (value == null || value === '') return '';
  var d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? String(value) : Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function hubDocId_(doc) {
  return String((doc && doc._name) || '').split('/').pop();
}

/** Firestore doc → 給 LLM 的精簡物件：去掉內部欄位、Date 轉日期字串、長字串截斷、巢狀最多 3 層 */
function hubCompact_(value, depth) {
  depth = depth || 0;
  if (value == null) return null;
  if (value instanceof Date) return hubDateStr_(value);
  if (typeof value === 'number') return Math.round(value * 10000) / 10000;
  if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value;
  if (typeof value !== 'object') return value;
  if (depth >= 3) return Array.isArray(value) ? '[' + value.length + ' items]' : '{…}';
  if (Array.isArray(value)) {
    var arr = value.slice(0, 30).map(function (v) { return hubCompact_(v, depth + 1); });
    if (value.length > 30) arr.push('…(+' + (value.length - 30) + ')');
    return arr;
  }
  var out = {};
  Object.keys(value).forEach(function (k) {
    if (k === '_name') { out.id = hubDocId_(value); return; }
    if (HUB_HIDDEN_FIELDS_[k]) return;
    var v = hubCompact_(value[k], depth + 1);
    if (v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    out[k] = v;
  });
  return out;
}

function hubTxRow_(t, names) {
  return {
    date: hubDateStr_(t.date),
    type: t.type || 'expense',
    amountTWD: Math.round(askTxAmount_(t)),
    category: (names && names[t.category]) || t.category || '',
    paymentMethod: t.paymentMethod || '',
    note: String(t.note || '').slice(0, 80),
  };
}

function hubTripSummary_(t) {
  return {
    tripId: hubDocId_(t),
    name: t.name || '',
    destination: Array.isArray(t.destination) ? t.destination : [],
    startDate: hubDateStr_(t.startDate),
    endDate: hubDateStr_(t.endDate),
    status: t.status || 'planning',
    budget: Number(t.budget) || 0,
    baseCurrency: t.baseCurrency || 'TWD',
  };
}

function hubValidId_(id) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(id || ''));
}

function hubTripTxs_(tripId) {
  return fsRunQuery_('', {
    from: [{ collectionId: 'transactions' }],
    where: { fieldFilter: { field: { fieldPath: 'tripId' }, op: 'EQUAL', value: { stringValue: tripId } } },
    limit: 1000,
  }).filter(function (t) { return !t.deletedAt; });
}

// -------- handlers --------

function hubCatalog_() {
  return {
    today: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'),
    timezone: TZ,
    currency: 'TWD（外幣交易已換算，另有原幣欄位）',
    areas: [
      { area: '記帳 / 收支', tools: ['sum_by_month', 'sum_by_category', 'sum_by_payment_method', 'spend_by_merchant', 'list_transactions', 'budget_status'],
        note: '支出指「消費支出」（不含轉帳、對帳調整、租賃購入、共同帳結算）；收入指實際收入。' },
      { area: '資產 / 淨值', tools: ['accounts_balance', 'net_worth_latest', 'net_worth_history'] },
      { area: '投資 / 持股', tools: ['portfolio_latest', 'portfolio_positions', 'portfolio_history', 'stock_quotes'],
        note: '持股來自每日投資快照；股利、已實現損益、觀察名單、投資規劃用 list_records。' },
      { area: '旅遊', tools: ['list_trips', 'trip_detail', 'trip_itinerary', 'trip_expenses'],
        note: '先 list_trips 拿 tripId，再查細節。' },
      { area: '機票雷達', tools: ['flight_watches', 'flight_price_history', 'flight_date_prices'],
        note: '先 flight_watches 拿 watchId 與最新價格，再查歷史走勢（flight_price_history）或各出發日票價（flight_date_prices）。'
          + '價格是所有旅客合計的 TWD，來自公開搜尋 / 報價快照，不是可直接購買的即時報價。' },
      { area: '台指期模擬（虛擬交易）', tools: ['taifex_weekly_review'],
        note: '一次給一週的帳戶、交易、訊號、策略變體、最佳化、盤中技術模擬與目前參數。與真實投資組合無關，不計入淨值。' },
      { area: '其他資料集', tools: ['list_records'], datasets: Object.keys(HUB_DATASETS_).map(function (k) {
        return { dataset: k, label: HUB_DATASETS_[k].label };
      }) },
    ],
    tips: '先用聚合工具看全貌，再針對可疑或重要的部分查明細；不需要的資料不要查。',
  };
}

function hubSpendByMerchant_(args) {
  var start = askParseDate_(args.start, false);
  var end = askParseDate_(args.end, true);
  if (!start || !end) return { error: 'bad date' };
  var minMonths = hubInt_(args.minMonths, 1, 1, 24);
  var limit = hubInt_(args.limit, 30, 1, 80);
  var names = askCategoryNames_();
  var groups = {};
  queryTxsBetween_(start, end).forEach(function (t) {
    if (!isConsumptionExpense_(t)) return;
    var note = String(t.note || '').trim();
    if (!note) return;
    var key = note.toLowerCase().slice(0, 30);
    if (!groups[key]) groups[key] = { note: note.slice(0, 40), category: names[t.category] || t.category || '', months: {}, count: 0, totalTWD: 0, amounts: [] };
    var g = groups[key];
    var amount = askTxAmount_(t);
    g.months[hubDateStr_(t.date).slice(0, 7)] = true;
    g.count++;
    g.totalTWD += amount;
    if (g.amounts.length < 6) g.amounts.push(Math.round(amount));
  });
  var rows = Object.keys(groups).map(function (k) { return groups[k]; })
    .filter(function (g) { return Object.keys(g.months).length >= minMonths; })
    .sort(function (a, b) { return b.totalTWD - a.totalTWD; });
  return {
    start: args.start, end: args.end, matched: rows.length,
    merchants: rows.slice(0, limit).map(function (g) {
      return { note: g.note, category: g.category, count: g.count, monthsSeen: Object.keys(g.months).length,
        totalTWD: Math.round(g.totalTWD), sampleAmounts: g.amounts };
    }),
  };
}

function hubNetWorthHistory_(args) {
  var months = hubInt_(args.months, 12, 1, 36);
  var docs = fsRunQuery_('', {
    from: [{ collectionId: 'net_worth_snapshots' }],
    orderBy: [{ field: { fieldPath: 'month' }, direction: 'DESCENDING' }],
    limit: months,
  });
  return {
    snapshots: docs.reverse().map(function (nw) {
      return { month: nw.month, liquidTWD: Math.round(nw.liquidTWD || 0), investmentTWD: Math.round(nw.investmentTWD || 0),
        manualAssetsTWD: Math.round(nw.manualAssetsTWD || 0), liabilitiesTWD: Math.round(nw.liabilitiesTWD || 0),
        netWorthTWD: Math.round(nw.netWorthTWD || 0) };
    }),
  };
}

function hubPortfolioPositions_(args) {
  var snap = getLatestSnapshot_();
  if (!snap) return { error: 'no snapshot' };
  var total = Number(snap.totalValueTWD) || 0;
  var wanted = Array.isArray(args.symbols) ? args.symbols.map(function (s) { return String(s).trim().toUpperCase(); }) : [];
  var sortKey = args.sortBy === 'pnl' ? 'pnlTWD' : args.sortBy === 'pnlPct' ? 'pnlPct' : 'valueTWD';
  var rows = (snap.positions || []).filter(function (p) {
    if (args.market && p.market !== args.market) return false;
    if (wanted.length && wanted.indexOf(String(p.symbol).toUpperCase()) < 0) return false;
    return true;
  }).sort(function (a, b) { return (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0); });
  var limit = hubInt_(args.limit, 30, 1, 100);
  return {
    date: snap.date, totalValueTWD: Math.round(total), matched: rows.length,
    positions: rows.slice(0, limit).map(function (p) {
      return { symbol: p.symbol, name: p.name || '', market: p.market, currency: p.currency || '', shares: p.shares,
        avgCost: p.avgCost, price: p.price != null ? p.price : p.currentPrice,
        valueTWD: Math.round(p.valueTWD || 0), costTWD: Math.round(p.costTWD || 0),
        weightPct: total ? Math.round((p.valueTWD || 0) / total * 1000) / 10 : null,
        pnlTWD: Math.round(p.pnlTWD || 0), pnlPct: Math.round((p.pnlPct || 0) * 10) / 10 };
    }),
  };
}

function hubPortfolioHistory_(args) {
  if (!askParseDate_(args.start, false) || !askParseDate_(args.end, true)) return { error: 'bad date' };
  var docs = fsRunQuery_('', {
    from: [{ collectionId: 'portfolio_snapshots' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: args.start } } },
      { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: args.end } } },
    ] } },
    orderBy: [{ field: { fieldPath: 'date' }, direction: 'ASCENDING' }],
    limit: 800,
  });
  var step = Math.max(1, Math.ceil(docs.length / 60));
  var points = docs.filter(function (_d, i) { return i % step === 0 || i === docs.length - 1; });
  return {
    start: args.start, end: args.end, days: docs.length, sampledEvery: step,
    points: points.map(function (s) {
      return { date: s.date, totalValueTWD: Math.round(s.totalValueTWD || 0), totalCostTWD: Math.round(s.totalCostTWD || 0),
        unrealizedPnlTWD: Math.round(s.unrealizedPnlTWD || 0) };
    }),
  };
}

function hubStockQuotes_(args) {
  var symbols = (Array.isArray(args.symbols) ? args.symbols : []).map(function (s) { return String(s).trim().toUpperCase(); })
    .filter(function (s) { return /^[A-Z0-9.\-]{1,12}$/.test(s); }).slice(0, 20);
  if (!symbols.length) return { error: 'missing symbols' };
  return {
    quotes: symbols.map(function (symbol) {
      var s = null;
      try { s = fsGetDoc_('stocks/' + symbol); } catch (err) { console.warn('hubStockQuotes_', symbol, err); }
      if (!s) return { symbol: symbol, error: 'not tracked' };
      return { symbol: symbol, name: s.name || '', market: s.market, currency: s.currency, price: s.currentPrice, prevClose: s.prevClose,
        change: s.change, changePercent: s.changePercent, updatedAt: hubDateStr_(s.updatedAt),
        upcomingDividend: s.upcomingDividend ? hubCompact_(s.upcomingDividend) : null };
    }),
  };
}

function hubListTrips_(args) {
  var trips = fsListAllDocs_('trips', 200).map(hubTripSummary_)
    .filter(function (t) { return !args.status || t.status === args.status; })
    .sort(function (a, b) { return String(b.startDate).localeCompare(String(a.startDate)); });
  return { count: trips.length, trips: trips.slice(0, 60) };
}

function hubTripDetail_(args) {
  if (!hubValidId_(args.tripId)) return { error: 'bad tripId' };
  var trip = fsGetDoc_('trips/' + args.tripId);
  if (!trip) return { error: 'trip not found' };
  var names = askCategoryNames_();
  var byCategory = {};
  var spent = 0;
  var txs = hubTripTxs_(args.tripId);
  txs.forEach(function (t) {
    if (t.type !== 'expense') return;
    var amount = askTxAmount_(t);
    spent += amount;
    var k = names[t.category] || t.category || 'other';
    byCategory[k] = (byCategory[k] || 0) + amount;
  });
  var out = hubTripSummary_(Object.assign({}, trip, { _name: 'trips/' + args.tripId }));
  out.foreignCurrencies = trip.foreignCurrencies || [];
  out.members = (trip.members || []).map(function (m) { return m && m.name; }).filter(Boolean);
  out.notes = String(trip.notes || '').slice(0, 1500);
  out.expenseCount = txs.length;
  out.spentTWD = Math.round(spent);
  out.spentByCategory = Object.keys(byCategory).map(function (k) { return { category: k, amountTWD: Math.round(byCategory[k]) }; })
    .sort(function (a, b) { return b.amountTWD - a.amountTWD; });
  return out;
}

function hubTripItinerary_(args) {
  if (!hubValidId_(args.tripId)) return { error: 'bad tripId' };
  var trip = fsGetDoc_('trips/' + args.tripId);
  var itineraryId = (trip && trip.itineraryId) || args.tripId;
  if (!hubValidId_(itineraryId)) return { error: 'bad itinerary id' };
  var base = 'itineraries/' + itineraryId;
  var itinerary = fsGetDoc_(base);
  var days = fsListDocs_(base + '/days', 60).sort(function (a, b) { return hubDocId_(a).localeCompare(hubDocId_(b)); });
  if (!itinerary && !days.length) return { error: 'no itinerary for this trip' };
  if (args.date) days = days.filter(function (d) { return (d.date || hubDocId_(d)) === args.date; });
  var out = {
    tripId: args.tripId,
    title: (itinerary && itinerary.title) || (trip && trip.name) || '',
    summary: String((itinerary && itinerary.summary) || '').slice(0, 800),
    tips: (itinerary && Array.isArray(itinerary.tips)) ? itinerary.tips.slice(0, 12) : [],
    notes: String((itinerary && itinerary.notes) || '').slice(0, 2000),
    days: days.map(function (d) {
      var dayId = hubDocId_(d);
      var items = fsListDocs_(base + '/days/' + dayId + '/items', 60)
        .sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0); });
      return {
        date: d.date || dayId, theme: d.theme || '',
        items: items.map(function (it) {
          var row = { time: [it.startTime, it.endTime].filter(Boolean).join('-'), type: it.type || '', title: it.title || '' };
          if (it.placeName) row.place = it.placeName;
          if (it.address) row.address = String(it.address).slice(0, 80);
          if (it.estimatedCost != null) row.estimatedCost = it.estimatedCost;
          if (it.actualCost != null) row.actualCost = it.actualCost;
          if (it.currency) row.currency = it.currency;
          if (it.status && it.status !== 'planned') row.status = it.status;
          if (it.notes) row.notes = String(it.notes).slice(0, 200);
          return row;
        }),
      };
    }),
  };
  return out;
}

function hubTripExpenses_(args) {
  if (!hubValidId_(args.tripId)) return { error: 'bad tripId' };
  var names = askCategoryNames_();
  var limit = hubInt_(args.limit, 50, 1, 200);
  var txs = hubTripTxs_(args.tripId).sort(function (a, b) { return hubDateStr_(b.date).localeCompare(hubDateStr_(a.date)); });
  return {
    tripId: args.tripId, count: txs.length,
    transactions: txs.slice(0, limit).map(function (t) {
      var row = hubTxRow_(t, names);
      if (t.currency && t.currency !== 'TWD') { row.amount = t.amount; row.currency = t.currency; }
      return row;
    }),
  };
}

// -------- 機票雷達 --------

function hubFlightRound_(value) {
  var n = Number(value);
  return isFinite(n) && n > 0 ? Math.round(n) : null;
}

function hubFlightCabinArg_(value) {
  return HUB_FLIGHT_CABINS_.indexOf(String(value || '')) >= 0 ? String(value) : '';
}

/** 航線的固定條件（清單與歷史工具共用的表頭） */
function hubFlightWatchHead_(watch, id) {
  var type = flightTripType_(watch);
  var head = {
    watchId: id,
    route: flightRouteText_(watch),
    tripType: type,
    departureStart: hubDateStr_(watch.departureStart),
    departureEnd: hubDateStr_(watch.departureEnd),
    adults: Number(watch.adults) || 1,
    cabins: flightWatchCabins_(watch),
  };
  if (watch.segmentLabel) head.segmentLabel = String(watch.segmentLabel).slice(0, 40);
  if (type !== 'oneway') head.nights = [Number(watch.minNights) || 0, Number(watch.maxNights) || 0];
  if (watch.nonstopOnly === true) head.nonstopOnly = true;
  return head;
}

function hubFlightCabinRows_(estimate) {
  return (Array.isArray(estimate && estimate.cabinEstimates) ? estimate.cabinEstimates : []).map(function (c) {
    var row = { cabin: c.cabin, minPriceTWD: hubFlightRound_(c.minPriceTWD), typicalPriceTWD: hubFlightRound_(c.typicalPriceTWD),
      maxPriceTWD: hubFlightRound_(c.maxPriceTWD) };
    if (c.bestAirline) row.bestAirline = String(c.bestAirline).slice(0, 40);
    return row;
  });
}

function hubFlightWatches_(args) {
  var watches = fsListAllDocs_('flight_watches', 300)
    .filter(function (w) { return args.includePaused === true || w.enabled !== false; })
    .sort(function (a, b) { return hubDateStr_(a.departureStart).localeCompare(hubDateStr_(b.departureStart)); });
  return {
    count: watches.length,
    priceNote: '價格為所有旅客合計的 TWD',
    watches: watches.slice(0, 80).map(function (w) {
      var row = hubFlightWatchHead_(w, hubDocId_(w));
      var est = w.latestEstimate;
      row.enabled = w.enabled !== false;
      row.provider = flightProvider_(w);
      row.targetPriceTWD = hubFlightRound_(w.maxPriceTWD);
      row.bestPriceTWD = hubFlightRound_(w.bestPriceTWD);
      row.lastCheckedAt = hubDateStr_(w.lastCheckedAt);
      if (w.lastError) row.lastError = String(w.lastError).slice(0, 160);
      if (est) {
        row.latest = { checkedAt: hubDateStr_(est.checkedAt), minPriceTWD: hubFlightRound_(est.minPriceTWD),
          typicalPriceTWD: hubFlightRound_(est.typicalPriceTWD), maxPriceTWD: hubFlightRound_(est.maxPriceTWD),
          confidence: est.confidence || 'low', advice: est.advice || 'watch', cabins: hubFlightCabinRows_(est) };
      }
      return row;
    }),
  };
}

/** 讀航線與它的快照（新到舊，最多 HUB_FLIGHT_SNAPSHOT_LIMIT_ 筆）；失敗回 { error } */
function hubFlightLoad_(watchId) {
  if (!hubValidId_(watchId)) return { error: 'bad watchId' };
  var watch = fsGetDoc_('flight_watches/' + watchId);
  if (!watch) return { error: 'flight watch not found; call flight_watches for valid ids' };
  var snapshots = fsRunQuery_('flight_watches/' + watchId, {
    from: [{ collectionId: 'snapshots' }],
    orderBy: [{ field: { fieldPath: 'checkedAt' }, direction: 'DESCENDING' }],
    limit: HUB_FLIGHT_SNAPSHOT_LIMIT_,
  });
  return { watch: watch, snapshots: snapshots };
}

/** 快照在指定艙等（或整體）的價格區間；該艙等沒有資料回 null */
function hubFlightSnapshotPrices_(snapshot, cabin) {
  var src = snapshot;
  if (cabin) {
    src = (Array.isArray(snapshot.cabinEstimates) ? snapshot.cabinEstimates : []).filter(function (c) { return c && c.cabin === cabin; })[0];
    if (!src) return null;
  }
  var min = hubFlightRound_(src.minPriceTWD);
  if (min === null) return null;
  return { min: min, typical: hubFlightRound_(src.typicalPriceTWD), max: hubFlightRound_(src.maxPriceTWD) };
}

function hubFlightPriceHistory_(args) {
  var loaded = hubFlightLoad_(args.watchId);
  if (loaded.error) return loaded;
  var cabin = hubFlightCabinArg_(args.cabin);
  var start = args.start ? String(args.start) : '';
  var end = args.end ? String(args.end) : '';
  if ((start && !askParseDate_(start, false)) || (end && !askParseDate_(end, true))) return { error: 'bad date' };
  // 每天一點：取當天最後一次查價（快照已是新到舊，第一個遇到的就是當天最後一筆）
  var byDay = {};
  var scans = 0;
  loaded.snapshots.forEach(function (snap) {
    var date = hubDateStr_(snap.checkedAt);
    if (!date || (start && date < start) || (end && date > end)) return;
    var prices = hubFlightSnapshotPrices_(snap, cabin);
    if (!prices) return;
    scans++;
    if (byDay[date]) return;
    var point = { date: date, minPriceTWD: prices.min, typicalPriceTWD: prices.typical, maxPriceTWD: prices.max };
    if (snap.confidence === 'low') point.lowConfidence = true;
    byDay[date] = point;
  });
  var days = Object.keys(byDay).sort().map(function (d) { return byDay[d]; });
  var out = hubFlightWatchHead_(loaded.watch, String(args.watchId));
  out.cabin = cabin || 'all';
  out.targetPriceTWD = hubFlightRound_(loaded.watch.maxPriceTWD);
  out.scans = scans;
  out.days = days.length;
  if (!days.length) {
    out.note = '這個期間 / 艙等沒有查價紀錄';
    out.points = [];
    return out;
  }
  var mins = days.map(function (p) { return p.minPriceTWD; });
  var sorted = mins.slice().sort(function (a, b) { return a - b; });
  var lowest = days.reduce(function (a, b) { return b.minPriceTWD < a.minPriceTWD ? b : a; });
  var highest = days.reduce(function (a, b) { return b.minPriceTWD > a.minPriceTWD ? b : a; });
  var first = days[0];
  var latest = days[days.length - 1];
  var average = mins.reduce(function (a, b) { return a + b; }, 0) / mins.length;
  var pct = function (value, base) { return base ? Math.round((value - base) / base * 1000) / 10 : null; };
  var recent = days.slice(-7).map(function (p) { return p.minPriceTWD; });
  out.stats = {
    firstDate: first.date, latestDate: latest.date,
    latestMinTWD: latest.minPriceTWD,
    lowestMinTWD: lowest.minPriceTWD, lowestDate: lowest.date,
    highestMinTWD: highest.minPriceTWD, highestDate: highest.date,
    averageMinTWD: Math.round(average),
    medianMinTWD: Math.round(flightMedian_(sorted)),
    recent7AverageMinTWD: Math.round(recent.reduce(function (a, b) { return a + b; }, 0) / recent.length),
    changeSinceFirstPct: pct(latest.minPriceTWD, first.minPriceTWD),
    latestVsAveragePct: pct(latest.minPriceTWD, average),
    // 歷史上有多少比例的日子比目前便宜（0 = 目前就是歷史最低）
    cheaperDaysPct: Math.round(mins.filter(function (m) { return m < latest.minPriceTWD; }).length / mins.length * 100),
  };
  var step = Math.max(1, Math.ceil(days.length / 90));
  out.sampledEvery = step;
  out.points = days.filter(function (_p, i) { return i % step === 0 || i === days.length - 1; });
  if (loaded.snapshots.length >= HUB_FLIGHT_SNAPSHOT_LIMIT_) out.note = '只讀取最近 ' + HUB_FLIGHT_SNAPSHOT_LIMIT_ + ' 次查價';
  return out;
}

function hubFlightDatePrices_(args) {
  var loaded = hubFlightLoad_(args.watchId);
  if (loaded.error) return loaded;
  var cabin = hubFlightCabinArg_(args.cabin);
  var limit = hubInt_(args.limit, 40, 1, 120);
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var groups = {};
  // 快照新到舊：每組日期第一次遇到的就是最新價
  loaded.snapshots.forEach(function (snap) {
    var seenAt = hubDateStr_(snap.checkedAt);
    (Array.isArray(snap.travelWindows) ? snap.travelWindows : []).forEach(function (w) {
      var price = hubFlightRound_(w && w.priceTWD);
      var departure = String((w && w.departureDate) || '');
      if (price === null || !/^\d{4}-\d{2}-\d{2}$/.test(departure)) return;
      if (cabin && w.cabin !== cabin) return;
      if (args.upcomingOnly !== false && departure < today) return;
      var ticketing = w.ticketing === 'separate' ? 'separate' : 'single';
      var key = [departure, w.returnDate || '', w.cabin || '', ticketing].join('|');
      var g = groups[key];
      if (!g) {
        g = groups[key] = { departureDate: departure, returnDate: String(w.returnDate || ''), cabin: w.cabin || '', ticketing: ticketing,
          latestPriceTWD: price, latestSeen: seenAt, lowestPriceTWD: price, lowestSeen: seenAt, highestPriceTWD: price, timesSeen: 0,
          airline: String(w.airline || '').slice(0, 40), stops: Math.max(0, Number(w.stops) || 0) };
        if (ticketing === 'separate') {
          g.outboundPriceTWD = hubFlightRound_(w.outboundPriceTWD);
          g.returnPriceTWD = hubFlightRound_(w.returnPriceTWD);
          if (w.returnAirline) g.returnAirline = String(w.returnAirline).slice(0, 40);
        }
        if (w.departureTime) g.departureTime = w.departureTime;
        if (w.flightNumber) g.flightNumber = w.flightNumber;
      }
      g.timesSeen++;
      if (price <= g.lowestPriceTWD) { g.lowestPriceTWD = price; g.lowestSeen = seenAt; }
      if (price > g.highestPriceTWD) g.highestPriceTWD = price;
    });
  });
  var rows = Object.keys(groups).map(function (k) { return groups[k]; })
    .sort(function (a, b) { return a.latestPriceTWD - b.latestPriceTWD || a.departureDate.localeCompare(b.departureDate); });
  var out = hubFlightWatchHead_(loaded.watch, String(args.watchId));
  out.cabin = cabin || 'all';
  out.scans = loaded.snapshots.length;
  out.matched = rows.length;
  out.note = 'latestPriceTWD 是該組日期最後一次被查到的價格（latestSeen 當天），不一定是今天的價格；timesSeen 少的日期參考性較低。';
  out.dates = rows.slice(0, limit).map(function (g) {
    if (!g.returnDate) delete g.returnDate;
    return g;
  });
  return out;
}

function hubListRecords_(args) {
  var dataset = HUB_DATASETS_[String(args.dataset || '')];
  if (!dataset) return { error: 'unknown dataset; use one of: ' + Object.keys(HUB_DATASETS_).join(', ') };
  var limit = hubInt_(args.limit, 50, 1, 200);
  var docs = fsListAllDocs_(dataset.collection, 300);
  if (args.activeOnly !== false && dataset.active) docs = docs.filter(dataset.active);
  return {
    dataset: args.dataset, label: dataset.label, count: docs.length,
    records: docs.slice(0, limit).map(function (d) { return hubCompact_(d); }),
  };
}

/** 執行單一工具，回傳可 JSON 序列化的物件（失敗回 { error }，不 throw 給 LLM 以外的層） */
function hubRunTool_(name, args) {
  args = args || {};
  switch (name) {
    case 'hub_catalog': return hubCatalog_();
    case 'spend_by_merchant': return hubSpendByMerchant_(args);
    case 'net_worth_history': return hubNetWorthHistory_(args);
    case 'portfolio_positions': return hubPortfolioPositions_(args);
    case 'portfolio_history': return hubPortfolioHistory_(args);
    case 'stock_quotes': return hubStockQuotes_(args);
    case 'list_trips': return hubListTrips_(args);
    case 'trip_detail': return hubTripDetail_(args);
    case 'trip_itinerary': return hubTripItinerary_(args);
    case 'trip_expenses': return hubTripExpenses_(args);
    case 'flight_watches': return hubFlightWatches_(args);
    case 'flight_price_history': return hubFlightPriceHistory_(args);
    case 'flight_date_prices': return hubFlightDatePrices_(args);
    case 'list_records': return hubListRecords_(args);
    case 'taifex_weekly_review': return buildTaifexWeekReview_(args);
    default:
      // 帳務聚合沿用 Ask.gs（單一口徑）
      return askRunTool_(name, args);
  }
}

/** 給 LLM / MCP 的文字結果：{ text, isError }；超過上限就截斷並標示 */
function hubCallTool_(name, args) {
  var result;
  var isError = false;
  try {
    if (hubToolNames_().indexOf(name) < 0) result = { error: 'unknown tool ' + name };
    else result = hubRunTool_(name, args);
  } catch (err) {
    console.error('[hubCallTool_]', name, err);
    result = { error: String(err && err.message || err) };
  }
  if (result && result.error) isError = true;
  var text = JSON.stringify(result);
  if (text.length > HUB_TOOL_RESULT_MAX_CHARS_) {
    text = text.slice(0, HUB_TOOL_RESULT_MAX_CHARS_) + '\n…（結果過長已截斷，請縮小日期範圍或調低 limit 再查）';
  }
  return { text: text, isError: isError };
}
