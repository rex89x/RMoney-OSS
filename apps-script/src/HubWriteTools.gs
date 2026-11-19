/**
 * Hub 寫入工具 — 讓外部 AI client 透過 MCP「幫忙記帳 / 記股票成交 / 匯入旅程行程」。
 *
 * 只有 Mcp.gs 會用到，而且連線必須被 owner 開啟「允許寫入」才看得到這些工具
 * （OAuth 授權逐一設定，或 bridge token 的寫入開關）。App 內 AI 分析、問一下、Telegram /ask
 * 用的是 HubTools.gs 的唯讀工具，**不會**拿到這裡的任何東西。
 *
 * 設計原則：
 *   - 兩段式：`preview_*` 只做驗證與正規化（不寫入），回 previewId 與每一筆會怎麼寫；
 *     `commit_*` 只接受 previewId，不接受原始資料 → 模型沒辦法跳過預覽直接寫。
 *     預覽 30 分鐘有效、只能確認一次（重試不會重複買賣股票）。
 *   - 寫入邏輯完全沿用既有的 AI 匯入（ImportApply.gs）：類別 / 付款方式 / 帳戶比對、匯率、
 *     帳戶餘額調整、持倉與已實現損益、內容 hash 去重都是同一套，和 web / Telegram 匯入互通。
 *   - 行程沿用 web `features/itinerary/ai-import.ts` + `apply-ai-import.ts` 的規則：項目 id 由
 *     「日期 + 時間 + 標題」推出（重複匯入是更新不是重複）、只覆蓋 AI 管的欄位、旅程日期只往外擴。
 *   - 沒有任何刪除 / 覆寫既有帳務的工具；唯一的「復原」只能軟刪除 MCP 自己寫進去的記帳。
 *   - 每日寫入次數有上限（HUB_WRITE_DAILY_LIMIT_），每次確認寫一筆 audit_logs。
 * 完整規劃與之後要補的工具：docs/MCP_TOOLS.md。
 */

var HUB_WRITE_PREVIEW_TTL_SEC_ = 1800;
var HUB_WRITE_PREVIEW_PREFIX_ = 'mcp-preview-';
var HUB_WRITE_PREVIEW_MAX_CHARS_ = 90000; // CacheService 單一 value 上限 100KB
var HUB_WRITE_MAX_ENTRIES_ = 40;
var HUB_WRITE_MAX_STOPS_ = 120;
var HUB_WRITE_DAILY_LIMIT_ = 200;
var HUB_WRITE_SOURCE_ = 'mcp';
var HUB_ITIN_TYPES_ = ['transport', 'meal', 'activity', 'accommodation', 'shopping'];
/** 與 web features/trips/import-chiauming.ts TYPE_RULES 同一份（沒給 type 時依標題猜） */
var HUB_ITIN_TYPE_RULES_ = [
  { type: 'transport', words: ['機場', '航班', '班機', '起飛', '降落', '登機', '高鐵', '新幹線', '火車', '車站', '捷運', '地鐵', '巴士', '客運', '渡輪', '租車', '取車', '還車', '接駁', 'airport', 'flight', 'station', 'train'] },
  { type: 'accommodation', words: ['飯店', '酒店', '旅館', '民宿', '住宿', '入住', '退房', 'check-in', 'check in', 'checkout', 'check-out', 'hotel', 'hostel', 'airbnb'] },
  { type: 'meal', words: ['早餐', '早午餐', '午餐', '晚餐', '宵夜', '餐廳', '吃', '咖啡', '拉麵', '燒肉', '壽司', '小吃', '甜點', '居酒屋', '食堂', 'restaurant', 'cafe', 'lunch', 'dinner', 'breakfast'] },
  { type: 'shopping', words: ['購物', '逛街', 'outlet', '百貨', '商場', '市集', '超市', '藥妝', 'mall', 'shopping'] },
];

function hubWriteTool_(name, description, properties, required, readOnly) {
  var def = hubTool_(name, description, properties, required);
  def.readOnly = !!readOnly;
  return def;
}

/** 寫入工具定義。readOnly = true 的（選項 / 預覽）不會改任何資料，但仍只給有寫入權限的連線。 */
function hubWriteToolDefs_() {
  var date = { type: 'string', description: 'yyyy-MM-dd（台北時間）' };
  var entryItem = {
    type: 'object',
    description: '一筆記帳（kind = expense / income）或一筆股票成交（kind = trade）',
    properties: {
      kind: { type: 'string', enum: ['expense', 'income', 'trade'] },
      date: date,
      amount: { type: 'number', description: '記帳：原幣金額（正數）' },
      currency: { type: 'string', description: 'ISO 幣別，預設 TWD；股票預設依市場（TW→TWD、US→USD）' },
      category: { type: 'string', description: '記帳：類別 key 或名稱（由 entry_options 取得）；對不到會放「其他」並在預覽標示' },
      note: { type: 'string', description: '備註 / 品項' },
      merchant: { type: 'string', description: '記帳：店家（會併進備註）' },
      account: { type: 'string', description: '記帳：付款帳戶或支付方式名稱；股票：交割帳戶名稱（都由 entry_options 取得）' },
      tags: { type: 'array', items: { type: 'string' } },
      fxRate: { type: 'number', description: '1 單位原幣 = ? TWD；不給就用系統當下匯率' },
      tripId: { type: 'string', description: '記帳：歸到這個旅程（由 list_trips 取得），選填' },
      id: { type: 'string', description: '來源單號（發票號碼、成交序號），用來去重，選填' },
      symbol: { type: 'string', description: '股票：代號，例如 2330、00878、AAPL' },
      side: { type: 'string', enum: ['buy', 'sell'], description: '股票：買進 / 賣出' },
      shares: { type: 'number', description: '股票：股數（台股一張 = 1000 股）' },
      price: { type: 'number', description: '股票：成交單價（原幣）' },
      market: { type: 'string', enum: ['TW', 'US'], description: '股票：市場，不給就從代號判斷' },
      fee: { type: 'number', description: '股票：手續費（原幣）' },
      tax: { type: 'number', description: '股票：交易稅（原幣）' },
    },
    required: ['kind', 'date'],
  };
  var stop = {
    type: 'object',
    properties: {
      date: date,
      title: { type: 'string', description: '項目名稱' },
      time: { type: 'string', description: '開始時間 HH:mm（選填）' },
      endTime: { type: 'string', description: '結束時間 HH:mm（選填）' },
      type: { type: 'string', enum: HUB_ITIN_TYPES_, description: '不給會依標題判斷' },
      place: { type: 'string', description: '地點名稱' },
      address: { type: 'string' },
      note: { type: 'string' },
      mapsUrl: { type: 'string', description: 'Google Maps 連結（只收 Google 地圖網域；沒有把握就不要給，不要自己編）' },
      estimatedCost: { type: 'number', description: '預估花費' },
      currency: { type: 'string', description: '預估花費的幣別，預設 TWD' },
    },
    required: ['date', 'title'],
  };
  var previewId = { type: 'string', description: 'preview 工具回傳的 previewId' };
  return [
    hubWriteTool_('entry_options', '記帳 / 記股票成交前先查：可用的類別（key、名稱、收支型別）、帳戶與支付方式名稱、預設交割帳戶、今天日期。'
      + '用這裡的名稱填 preview_entries 的 category / account，比對才會準。', {}, [], true),
    hubWriteTool_('preview_entries', '【第一步，不會寫入】驗證並正規化要記的帳或股票成交：回傳每一筆會記成什麼（類別、付款方式 / 帳戶、TWD 金額、'
      + '警告或錯誤）與 previewId。把預覽結果給使用者確認後，再呼叫 commit_entries。一次最多 ' + HUB_WRITE_MAX_ENTRIES_ + ' 筆。'
      + '賣出股票會檢查持倉；錯誤的列不會被寫入。',
      { items: { type: 'array', items: entryItem, description: '要記的項目' } }, ['items'], true),
    hubWriteTool_('commit_entries', '【第二步，會寫入】把 preview_entries 的結果寫進 Personal Hub：新增記帳、更新帳戶餘額；'
      + '股票成交會更新持倉、已實現損益與交割帳戶餘額。使用者確認預覽內容後才呼叫。每個 previewId 只能用一次。',
      { previewId: previewId, excludeIndexes: { type: 'array', items: { type: 'integer' }, description: '不要寫入的列（preview 回傳的 index），選填' } },
      ['previewId']),
    hubWriteTool_('undo_entry', '復原一筆由 MCP 記的帳（軟刪除並還原帳戶餘額；7 天內可在 App 回收筒還原）。只能復原 commit_entries 回傳的 transactionId，'
      + '不能刪其他來源的交易，也不能復原股票成交（股票請到 App 的投資頁調整）。',
      { transactionId: { type: 'string', description: 'commit_entries 回傳的 transactionId' } }, ['transactionId']),
    hubWriteTool_('preview_itinerary', '【第一步，不會寫入】驗證要匯入的旅程行程。給 tripId 就加到現有旅程（由 list_trips 取得），'
      + '不給 tripId 而給 trip 就會新建一個旅程。回傳每個項目是新增還是更新、旅程日期會不會被擴大，以及 previewId。'
      + '同一天、同時間、同標題的項目視為同一個（重複匯入是更新）。一次最多 ' + HUB_WRITE_MAX_STOPS_ + ' 個項目。',
      { tripId: { type: 'string', description: '加到這個現有旅程（與 trip 二擇一）' },
        trip: { type: 'object', description: '新建旅程（與 tripId 二擇一）',
          properties: { title: { type: 'string' }, destination: { type: 'string', description: '目的地，多個用逗號分隔' }, startDate: date, endDate: date },
          required: ['title', 'startDate', 'endDate'] },
        stops: { type: 'array', items: stop, description: '行程項目' } }, ['stops'], true),
    hubWriteTool_('commit_itinerary', '【第二步，會寫入】把 preview_itinerary 的結果寫進旅程行程表（必要時先建立旅程）。使用者確認預覽內容後才呼叫。'
      + '不會刪除或改動預覽以外的既有項目。每個 previewId 只能用一次。',
      { previewId: previewId }, ['previewId']),
    hubWriteTool_('preview_taifex_review', '【第一步，不會寫入】驗證一份台指期模擬的「每週檢討 + 參數調整提案」。先用 taifex_weekly_review 看這一週的狀態與可調整範圍。'
      + 'changes 只放要改的 key；超出範圍或權重總和不是 1 會直接回錯誤。有動到日線參數 / 權重 / 資金管理時會跑「目前 vs 提案」的回測對照（完整期間 + 樣本外）。'
      + '回傳 previewId、每一項 from → to、回測對照與警告。沒有要調整就不要給 changes（存成「不調整」的檢討）。',
      { weekEnd: { type: 'string', description: 'yyyy-MM-dd，檢討的那一週裡的任何一天；不給就是今天所在的這一週' },
        summary: { type: 'string', description: '這一週發生什麼、策略表現如何、原因（繁體中文，1500 字內）' },
        findings: { type: 'array', items: { type: 'string' }, description: '重點發現，最多 8 條，每條 300 字內' },
        algorithmIdeas: { type: 'array', items: { type: 'string' }, description: '需要改程式才能做的演算法想法（改公式、加因子），最多 6 條；參數調整不要放這裡' },
        prUrl: { type: 'string', description: '如果已經為演算法調整開了 GitHub PR，放 PR 網址（選填）' },
        rationale: { type: 'string', description: '有 changes 時必填：為什麼是這些數字、依據哪些證據（1500 字內）' },
        changes: { type: 'object', description: '要調整的參數（只放要改的 key）',
          properties: {
            params: { type: 'object', description: '日線進出場門檻與停損：entry / exit / adxTrend / chopDamp / stopAtr / trailAtr' },
            weights: { type: 'object', description: '日線因子權重：trend / breakout / tsmom / foreignFlow / pcr（改完總和要是 1）' },
            risk: { type: 'object', description: '資金管理：riskPerTradePct / maxContracts / maxDrawdownPct / allowShort' },
            tech: { type: 'object', description: '盤中技術模擬：entry / exit / stopAtr / trailAtr / weights { trend, macd, rsi, breakout }（權重總和 1）' },
          } } }, ['summary'], true),
    hubWriteTool_('commit_taifex_review', '【第二步，會寫入】把 preview_taifex_review 的結果存成這一週的檢討與提案，並推播給 owner。'
      + '**不會改任何參數**：提案要 owner 在 App「台指期模擬 → 週檢討」核准才會生效，所以排程執行時不需要等使用者確認就可以呼叫。'
      + '同一週再存一次會取代還沒被核准的那一份；已核准的不能取代。每個 previewId 只能用一次。',
      { previewId: previewId }, ['previewId']),
  ];
}

function hubWriteToolNames_() {
  return hubWriteToolDefs_().map(function (t) { return t.name; });
}

// -------- 共用：預覽暫存、每日上限、稽核 --------

function hubWriteCache_() {
  return CacheService.getScriptCache();
}

function hubWriteSavePreview_(pending) {
  var text = JSON.stringify(pending);
  if (text.length > HUB_WRITE_PREVIEW_MAX_CHARS_) return null;
  var id = 'pv_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  hubWriteCache_().put(HUB_WRITE_PREVIEW_PREFIX_ + id, text, HUB_WRITE_PREVIEW_TTL_SEC_);
  return id;
}

/** 取出並作廢預覽（單次使用）。LockService 擋住同一個 previewId 的並行確認。回 pending 或 { error } */
function hubWriteTakePreview_(previewId, kind, ctx) {
  var id = String(previewId || '');
  if (!/^pv_[a-f0-9]{20}$/.test(id)) return { error: 'bad previewId' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { error: 'busy, try again' };
  try {
    var cache = hubWriteCache_();
    var raw = cache.get(HUB_WRITE_PREVIEW_PREFIX_ + id);
    if (!raw) return { error: 'preview not found or expired (previews last 30 minutes and can be committed once); call the preview tool again' };
    var pending = JSON.parse(raw);
    if (pending.kind !== kind) return { error: 'this previewId belongs to a different preview tool' };
    if (pending.uid !== ctx.uid) return { error: 'preview belongs to another connection' };
    cache.remove(HUB_WRITE_PREVIEW_PREFIX_ + id);
    return pending;
  } finally {
    lock.releaseLock();
  }
}

/** 每日寫入次數（commit / undo 各算一次）；回 false = 超過上限 */
function hubWriteConsumeQuota_() {
  var cache = hubWriteCache_();
  var key = 'mcp-writes-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  var used = parseInt(cache.get(key), 10) || 0;
  if (used >= HUB_WRITE_DAILY_LIMIT_) return false;
  cache.put(key, String(used + 1), 21600);
  return true;
}

/** 資料的 userId 一律是 owner（單一使用者系統）；admin 透過 MCP 寫入時也記在 owner 名下 */
function hubWriteOwnerUid_(ctx) {
  var owner = null;
  try { owner = getOwnerUid_(); } catch (err) { console.warn('hubWriteOwnerUid_', err); }
  return owner || ctx.uid;
}

/** audit_logs（與 web features/audit 同一個 collection）；失敗不影響主流程 */
function hubWriteAudit_(ctx, scope, action, entityId, summary) {
  try {
    fsAddDoc_('audit_logs', {
      userId: ctx.uid, timestamp: new Date(), scope: scope, action: action, entityId: String(entityId || ''),
      summary: ('MCP（' + (ctx.client || 'unknown') + '）· ' + summary).slice(0, 300),
    });
  } catch (err) { console.warn('hubWriteAudit_', err); }
}

// -------- 記帳 / 股票成交 --------

function hubEntryOptions_() {
  var ctx = tgLoadEntryContext_();
  var tradeAccounts = ctx.accounts.filter(function (a) { return IMPORT_TRADE_ACCOUNT_TYPES_.indexOf(a.type) >= 0; });
  var defaultTrade = tradeAccounts.filter(function (a) { return a.type === 'investment_cash'; })[0] || tradeAccounts[0] || null;
  var payments = [];
  (ctx.paymentMethods || []).forEach(function (p) { if (p.name && payments.indexOf(p.name) < 0) payments.push(p.name); });
  IMPORT_DEFAULT_PAYMENT_METHODS_.forEach(function (name) { if (payments.indexOf(name) < 0) payments.push(name); });
  return {
    today: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'),
    timezone: TZ,
    categories: ctx.categories.map(function (c) { return { key: c.key, name: c.name, type: c.type }; }),
    accounts: ctx.accounts.map(function (a) {
      var row = { name: a.name, type: a.type };
      if (a.legacyPaymentMethod && a.legacyPaymentMethod !== a.name) row.paymentMethodName = a.legacyPaymentMethod;
      return row;
    }),
    paymentMethods: payments,
    defaultTradeAccount: defaultTrade ? defaultTrade.name : null,
    notes: [
      '記帳的 account 可以填帳戶名稱（會同步調整該帳戶餘額）或支付方式名稱（只記名稱）。',
      '收入不能入信用卡；股票成交的 account 要是銀行 / 現金 / 交割帳戶。',
      '日期一律 yyyy-MM-dd（台北時間）；使用者說「今天 / 昨天」請依 today 換算。',
    ],
  };
}

function hubEntryRowView_(row) {
  var r = row.resolved;
  var view = { index: row.index, kind: row.kind, status: row.status };
  if (row.kind === 'trade') {
    view.date = r.date; view.symbol = r.symbol; view.market = r.market; view.side = r.side;
    view.shares = r.shares; view.price = r.price; view.currency = r.currency;
    view.fee = r.fee; view.grossTWD = r.grossTWD; view.account = r.accountName;
  } else {
    view.date = r.date; view.amount = r.amount; view.currency = r.currency; view.amountTWD = r.amountTWD;
    view.category = r.categoryName; view.paymentMethod = r.paymentMethod;
    if (r.accountName) view.account = r.accountName;
    if (r.note) view.note = r.note;
    if (r.tripName) view.trip = r.tripName;
  }
  if (row.messages.length) view.messages = row.messages;
  return view;
}

function hubPreviewEntries_(args, ctx) {
  var raw = Array.isArray(args.items) ? args.items : (args.items && typeof args.items === 'object' ? [args.items] : []);
  if (!raw.length) return { error: 'items is required (an array of expense / income / trade items)' };
  if (raw.length > HUB_WRITE_MAX_ENTRIES_) return { error: 'too many items; at most ' + HUB_WRITE_MAX_ENTRIES_ + ' per preview, split into batches' };

  var items = [];
  var rejected = [];
  var tripIds = [];
  raw.forEach(function (entry, index) {
    var v = importValidateItem_(entry);
    if (!v.ok) { rejected.push({ index: index, message: v.message }); return; }
    var tripId = entry && entry.tripId != null && entry.tripId !== '' ? String(entry.tripId) : '';
    if (tripId && v.item.kind === 'trade') tripId = '';
    if (tripId && !hubValidId_(tripId)) { rejected.push({ index: index, message: 'tripId: 格式不對' }); return; }
    items.push(v.item);
    tripIds.push(tripId);
  });
  if (!items.length) return { error: 'every item is invalid', rejected: rejected };

  // 旅程名稱（同一個 tripId 只讀一次）
  var trips = {};
  tripIds.forEach(function (id) {
    if (!id || id in trips) return;
    var trip = null;
    try { trip = fsGetDoc_('trips/' + id); } catch (err) { console.warn('hubPreviewEntries_ trip', err); }
    trips[id] = trip ? (trip.name || id) : null;
  });

  var ownerUid = hubWriteOwnerUid_(ctx);
  var rows = importNormalize_(items, importLoadContext_(ownerUid));
  rows.forEach(function (row, i) {
    row.resolved.source = HUB_WRITE_SOURCE_;
    var tripId = tripIds[i];
    if (tripId) {
      if (trips[tripId] === null) { row.hard = true; row.messages.push('找不到旅程 ' + tripId + '（請用 list_trips 查）'); }
      else { row.resolved.tripId = tripId; row.resolved.tripName = trips[tripId]; }
    }
    if (row.kind !== 'trade' && !row.hard) {
      var existing = null;
      try { existing = fsGetDoc_('transactions/' + row.id); } catch (err) { console.warn('hubPreviewEntries_ dedupe', err); }
      if (existing) {
        row.duplicate = true;
        row.messages.push(existing.deletedAt
          ? '相同內容的記帳之前記過但已刪除，確認時會略過（要重記請在 note 加上區別）'
          : '已經有一筆內容完全相同的記帳，確認時會略過（若真的是另一筆，請在 note 加上區別再預覽一次）');
      }
    }
    importRecompute_(row);
  });

  var writable = rows.filter(function (r) { return r.status !== 'error' && !r.duplicate; }).length;
  var out = {
    count: rows.length,
    willWrite: writable,
    errors: rows.filter(function (r) { return r.status === 'error'; }).length,
    rows: rows.map(hubEntryRowView_),
  };
  if (rejected.length) out.rejected = rejected;
  if (!writable) {
    out.note = '沒有可以寫入的項目，請修正後再預覽一次。';
    return out;
  }
  var previewId = hubWriteSavePreview_({ kind: 'entries', uid: ctx.uid, ownerUid: ownerUid, rows: rows });
  if (!previewId) return { error: 'preview too large; split into smaller batches' };
  out.previewId = previewId;
  out.expiresInMinutes = HUB_WRITE_PREVIEW_TTL_SEC_ / 60;
  out.nextStep = '把上面的內容（特別是有 messages 的列）給使用者確認，確認後呼叫 commit_entries({ previewId })。status = error 的列不會寫入。';
  return out;
}

function hubCommitEntries_(args, ctx) {
  var pending = hubWriteTakePreview_(args.previewId, 'entries', ctx);
  if (pending.error) return pending;
  if (!hubWriteConsumeQuota_()) return { error: 'daily MCP write limit reached (' + HUB_WRITE_DAILY_LIMIT_ + ')' };
  var exclude = {};
  (Array.isArray(args.excludeIndexes) ? args.excludeIndexes : []).forEach(function (i) { exclude[parseInt(i, 10)] = true; });
  var rows = pending.rows;
  rows.forEach(function (row) { if (exclude[row.index]) row.excluded = true; });

  var results = importApply_(rows, pending.ownerUid);
  var byId = {};
  rows.forEach(function (row) { byId[row.id] = row; });
  var created = 0; var skipped = 0; var failed = 0;
  var view = results.map(function (res) {
    var row = byId[res.id];
    var item = { index: row.index, kind: row.kind, outcome: res.outcome };
    if (res.outcome === 'created') created++;
    else if (res.outcome === 'skipped') skipped++;
    else failed++;
    if (res.message) item.message = res.message;
    if (row.kind !== 'trade' && res.outcome === 'created') item.transactionId = res.id;
    item.summary = importRowSummary_(row).replace(/^[•△✗○]\s*/, '').split('\n')[0];
    return item;
  });
  if (created) {
    hubWriteAudit_(ctx, 'transaction', 'create', view.filter(function (v) { return v.transactionId; }).map(function (v) { return v.transactionId; }).join(',').slice(0, 200),
      '寫入 ' + created + ' 筆：' + view.filter(function (v) { return v.outcome === 'created'; }).map(function (v) { return v.summary; }).join('；'));
  }
  return {
    created: created, skipped: skipped, failed: failed,
    notWritten: rows.length - results.length,
    results: view,
    note: created ? '記帳可用 undo_entry({ transactionId }) 復原；股票成交無法由 MCP 復原。' : '沒有寫入任何項目。',
  };
}

function hubUndoEntry_(args, ctx) {
  var id = String(args.transactionId || '');
  if (!hubValidId_(id)) return { error: 'bad transactionId' };
  var tx = fsGetDoc_('transactions/' + id);
  if (!tx) return { error: 'transaction not found' };
  if (tx.source !== HUB_WRITE_SOURCE_) return { error: 'only entries written through MCP can be undone here; edit other transactions in the app' };
  if (tx.deletedAt) return { error: 'already deleted' };
  if (!hubWriteConsumeQuota_()) return { error: 'daily MCP write limit reached (' + HUB_WRITE_DAILY_LIMIT_ + ')' };
  fsSetDoc_('transactions/' + id, { deletedAt: new Date(), updatedAt: new Date() }, true);
  // 還原帳戶餘額（與 web softDeleteTransaction / Telegram 刪除同一條規則）
  try { tgAdjustTxAccount_(tx, -1); } catch (err) { console.warn('hubUndoEntry_ revert', err); }
  var summary = hubDateStr_(tx.date) + ' ' + (tx.type === 'income' ? '+' : '-') + Math.round(Number(tx.amountTWD) || 0) + ' ' + (tx.note || tx.category || '');
  hubWriteAudit_(ctx, 'transaction', 'delete', id, '復原（軟刪除）' + summary);
  return { ok: true, transactionId: id, undone: summary, note: '已軟刪除並還原帳戶餘額；7 天內可在 App 的回收筒還原。' };
}

// -------- 旅程行程 --------

function hubItinStr_(value, max) {
  var s = typeof value === 'string' ? value.trim() : (typeof value === 'number' ? String(value) : '');
  return s.length > max ? s.slice(0, max) : s;
}

function hubItinValidDate_(value) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return false;
  var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** 「9:00」補成「09:00」；不合法回空字串 */
function hubItinTime_(value) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(hubItinStr_(value, 8));
  if (!m) return '';
  var padded = (m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2];
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(padded) ? padded : '';
}

/** 只收 Google Maps 網域的連結（與 web sanitizeMapsUrl 同規則；Apps Script 沒有 URL，用 regex 拆） */
function hubItinMapsUrl_(value) {
  var raw = hubItinStr_(value, 2001);
  if (!raw || raw.length > 2000 || /[\s<>"]/.test(raw)) return '';
  var m = /^https?:\/\/([^\/?#:@]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(raw);
  if (!m) return '';
  var host = m[1].toLowerCase();
  var path = (m[2] || '/').toLowerCase();
  var ok = host === 'maps.app.goo.gl'
    || (host === 'goo.gl' && path.indexOf('/maps') === 0)
    || /^maps\.google\.[a-z.]+$/.test(host)
    || (/^(www\.)?google\.[a-z.]+$/.test(host) && path.indexOf('/maps') === 0);
  return ok ? 'https://' + raw.replace(/^https?:\/\//i, '') : '';
}

function hubItinGuessType_(title, place) {
  var text = (title + ' ' + (place || '')).toLowerCase();
  for (var i = 0; i < HUB_ITIN_TYPE_RULES_.length; i++) {
    var rule = HUB_ITIN_TYPE_RULES_[i];
    for (var j = 0; j < rule.words.length; j++) if (text.indexOf(rule.words[j]) >= 0) return rule.type;
  }
  return 'activity';
}

/** 與 web normalizeTitleForMatch 完全相同（項目 id 要跨管道一致） */
function hubItinTitleKey_(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('zh-TW')
    .replace(/[\s　]+/g, '')
    .replace(/[，,。.、・·「」『』()（）[\]【】!！?？:：;；~～\-–—_/\\]/g, '');
}

/** 與 web aiItemIdFor 相同：同一天、同時間、同標題 → 同一個 id */
function hubItinItemId_(stop) {
  return 'ai_' + importSha256Hex_(stop.date + '|' + (stop.time || '') + '|' + hubItinTitleKey_(stop.title)).slice(0, 40);
}

/** 單一項目收斂成可信任的形狀；缺標題或日期不合法回 null（與 web normalizeProposedStop 同規則） */
function hubItinNormalizeStop_(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var title = hubItinStr_(raw.title, 80);
  var date = hubItinStr_(raw.date, 10);
  if (!title || !hubItinValidDate_(date)) return null;
  var stop = { title: title, date: date };
  var time = hubItinTime_(raw.time);
  var endTime = hubItinTime_(raw.endTime);
  if (time) stop.time = time;
  if (endTime && (!time || endTime > time)) stop.endTime = endTime;
  var place = hubItinStr_(raw.place, 120);
  stop.type = HUB_ITIN_TYPES_.indexOf(raw.type) >= 0 ? raw.type : hubItinGuessType_(title, place);
  stop.place = place || title;
  var address = hubItinStr_(raw.address, 200);
  if (address) stop.address = address;
  var note = hubItinStr_(raw.note != null ? raw.note : raw.notes, 500);
  if (note) stop.note = note;
  var mapsUrl = hubItinMapsUrl_(raw.mapsUrl);
  if (mapsUrl) stop.mapsUrl = mapsUrl;
  var cost = importNum_(raw.estimatedCost);
  if (cost >= 0 && cost < 1e9) {
    stop.estimatedCost = cost;
    var currency = hubItinStr_(raw.currency, 3).toUpperCase();
    stop.currency = /^[A-Z]{3}$/.test(currency) ? currency : 'TWD';
  }
  return stop;
}

/** 地點搜尋字串：place + 目的地第一段（與 web searchQueryFor 同規則，沒有 mapQuery 欄位） */
function hubItinPlaceQuery_(stop, destination) {
  var base = stop.place || stop.address || '';
  if (!base) return '';
  var region = String(destination || '').split(/[,，、]/)[0].trim();
  return region && base.indexOf(region) < 0 ? base + ' ' + region : base;
}

/** yyyy-MM-dd → 台北當天 00:00（與 web dateInputToTWDate 相同） */
function hubItinDateTW_(ymd) {
  var p = String(ymd).split('-');
  return new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10), -8, 0, 0));
}

/** 旅程日期只往外擴、不縮小 */
function hubItinWiden_(range, dates) {
  var sorted = dates.slice().sort();
  var first = sorted[0];
  var last = sorted[sorted.length - 1];
  return {
    startDate: first && first < range.startDate ? first : range.startDate,
    endDate: last && last > range.endDate ? last : range.endDate,
  };
}

/** 解析目標旅程：現有（tripId）或新建（trip）。回 { tripId, itineraryId, title, destination, range, isNew } 或 { error } */
function hubItinTarget_(target) {
  if (target.tripId) {
    var trip = fsGetDoc_('trips/' + target.tripId);
    if (!trip) return { error: 'trip not found; call list_trips for valid ids' };
    var itineraryId = trip.itineraryId || target.tripId;
    if (!hubValidId_(itineraryId)) return { error: 'bad itinerary id' };
    return {
      tripId: target.tripId, itineraryId: itineraryId, isNew: false, trip: trip,
      title: trip.name || '', destination: (Array.isArray(trip.destination) ? trip.destination : []).join(', '),
      range: { startDate: hubDateStr_(trip.startDate), endDate: hubDateStr_(trip.endDate) },
    };
  }
  return {
    tripId: null, itineraryId: null, isNew: true, trip: null,
    title: target.trip.title, destination: target.trip.destination,
    range: { startDate: target.trip.startDate, endDate: target.trip.endDate },
  };
}

/** 讀出計畫中各日期已存在的項目：{ dayExists: {date: true}, items: {date: [item]} } */
function hubItinExisting_(itineraryId, dates) {
  var out = { dayExists: {}, items: {} };
  if (!itineraryId) return out;
  var base = 'itineraries/' + itineraryId;
  fsListDocs_(base + '/days', 100).forEach(function (d) { out.dayExists[hubDocId_(d)] = true; });
  dates.forEach(function (date) {
    out.items[date] = out.dayExists[date] ? fsListDocs_(base + '/days/' + date + '/items', 200) : [];
  });
  return out;
}

function hubItinUniqueDates_(stops) {
  var seen = {};
  return stops.map(function (s) { return s.date; }).filter(function (d) { if (seen[d]) return false; seen[d] = true; return true; }).sort();
}

function hubPreviewItinerary_(args, ctx) {
  var rawStops = Array.isArray(args.stops) ? args.stops : [];
  if (!rawStops.length) return { error: 'stops is required' };
  if (rawStops.length > HUB_WRITE_MAX_STOPS_) return { error: 'too many stops; at most ' + HUB_WRITE_MAX_STOPS_ + ' per preview' };

  var target;
  if (args.tripId != null && args.tripId !== '') {
    if (!hubValidId_(args.tripId)) return { error: 'bad tripId' };
    target = { tripId: String(args.tripId) };
  } else {
    var t = args.trip && typeof args.trip === 'object' ? args.trip : null;
    var title = t ? hubItinStr_(t.title, 80) : '';
    if (!t || !title || !hubItinValidDate_(t.startDate) || !hubItinValidDate_(t.endDate)) {
      return { error: 'give either tripId (existing trip, from list_trips) or trip { title, startDate, endDate } to create a new one' };
    }
    var a = String(t.startDate); var b = String(t.endDate);
    target = { trip: { title: title, destination: hubItinStr_(t.destination, 120), startDate: a <= b ? a : b, endDate: a <= b ? b : a } };
  }
  var resolved = hubItinTarget_(target);
  if (resolved.error) return resolved;

  var stops = [];
  var rejected = [];
  var seen = {};
  rawStops.forEach(function (raw, index) {
    var stop = hubItinNormalizeStop_(raw);
    if (!stop) { rejected.push({ index: index, message: '缺 title 或 date 不是合法的 yyyy-MM-dd' }); return; }
    var id = hubItinItemId_(stop);
    if (seen[id]) { rejected.push({ index: index, message: '與前面某一筆重複（同一天、同時間、同標題）' }); return; }
    seen[id] = true;
    stops.push(stop);
  });
  if (!stops.length) return { error: 'every stop is invalid', rejected: rejected };

  var dates = hubItinUniqueDates_(stops);
  var existing = hubItinExisting_(resolved.itineraryId, dates);
  var range = hubItinWiden_(resolved.range, dates);
  var creates = 0; var updates = 0;
  var days = dates.map(function (date) {
    var ids = {};
    (existing.items[date] || []).forEach(function (it) { ids[hubDocId_(it)] = true; });
    return {
      date: date,
      outsideCurrentTripDates: date < resolved.range.startDate || date > resolved.range.endDate,
      items: stops.filter(function (s) { return s.date === date; })
        .sort(function (x, y) { return (x.time || '99:99').localeCompare(y.time || '99:99'); })
        .map(function (s) {
          var isUpdate = !!ids[hubItinItemId_(s)];
          if (isUpdate) updates++; else creates++;
          var row = { action: isUpdate ? 'update' : 'create', time: [s.time, s.endTime].filter(Boolean).join('-'), type: s.type, title: s.title, place: s.place };
          if (s.estimatedCost != null) { row.estimatedCost = s.estimatedCost; row.currency = s.currency; }
          if (s.mapsUrl) row.hasMapsUrl = true;
          return row;
        }),
    };
  });

  var previewId = hubWriteSavePreview_({ kind: 'itinerary', uid: ctx.uid, ownerUid: hubWriteOwnerUid_(ctx), target: target, stops: stops });
  if (!previewId) return { error: 'preview too large; split into smaller batches' };
  var out = {
    trip: resolved.isNew
      ? { action: 'create', title: resolved.title, destination: resolved.destination, startDate: range.startDate, endDate: range.endDate }
      : { action: 'existing', tripId: resolved.tripId, title: resolved.title, startDate: resolved.range.startDate, endDate: resolved.range.endDate },
    willCreate: creates, willUpdate: updates, days: days,
    previewId: previewId, expiresInMinutes: HUB_WRITE_PREVIEW_TTL_SEC_ / 60,
    nextStep: '把上面的內容給使用者確認，確認後呼叫 commit_itinerary({ previewId })。',
  };
  if (!resolved.isNew && (range.startDate !== resolved.range.startDate || range.endDate !== resolved.range.endDate)) {
    out.trip.datesWillWidenTo = range;
  }
  if (rejected.length) out.rejected = rejected;
  return out;
}

function hubCommitItinerary_(args, ctx) {
  var pending = hubWriteTakePreview_(args.previewId, 'itinerary', ctx);
  if (pending.error) return pending;
  if (!hubWriteConsumeQuota_()) return { error: 'daily MCP write limit reached (' + HUB_WRITE_DAILY_LIMIT_ + ')' };
  var stops = pending.stops;
  var resolved = hubItinTarget_(pending.target);
  if (resolved.error) return resolved;
  var dates = hubItinUniqueDates_(stops);
  var range = hubItinWiden_(resolved.range, dates);
  var now = new Date();

  var tripId = resolved.tripId;
  var itineraryId = resolved.itineraryId;
  if (resolved.isNew) {
    var added = fsAddDoc_('trips', {
      userId: pending.ownerUid, createdAt: now, name: resolved.title,
      destination: String(resolved.destination || '').split(/[,，、]/).map(function (v) { return v.trim(); }).filter(Boolean),
      startDate: hubItinDateTW_(range.startDate), endDate: hubItinDateTW_(range.endDate),
      baseCurrency: 'TWD', foreignCurrencies: [], budget: 0, status: 'planning', notes: 'MCP 匯入行程',
    });
    tripId = String((added && added.name) || '').split('/').pop();
    if (!hubValidId_(tripId)) return { error: 'failed to create trip' };
    itineraryId = tripId;
  } else {
    var patch = {};
    if (range.startDate !== resolved.range.startDate) patch.startDate = hubItinDateTW_(range.startDate);
    if (range.endDate !== resolved.range.endDate) patch.endDate = hubItinDateTW_(range.endDate);
    if (Object.keys(patch).length) fsSetDoc_('trips/' + tripId, patch, true);
  }

  var base = 'itineraries/' + itineraryId;
  var existingItinerary = resolved.isNew ? null : fsGetDoc_(base);
  if (existingItinerary) fsSetDoc_(base, { startDate: range.startDate, endDate: range.endDate }, true);
  else {
    fsSetDoc_(base, { tripId: tripId, userId: pending.ownerUid, title: resolved.title, destination: resolved.destination || '',
      startDate: range.startDate, endDate: range.endDate }, true);
  }

  var existing = hubItinExisting_(existingItinerary ? itineraryId : null, dates);
  var writes = [];
  var created = 0; var updated = 0;
  dates.forEach(function (date) {
    if (!existing.dayExists[date]) {
      writes.push({ update: { name: fsDocumentName_(base + '/days/' + date), fields: encodeFields_({ date: date }) } });
    }
    var dayItems = existing.items[date] || [];
    var nextOrder = dayItems.reduce(function (max, it) { return Math.max(max, Number(it.order) || 0); }, 0) + 1;
    stops.filter(function (s) { return s.date === date; })
      .sort(function (x, y) { return (x.time || '99:99').localeCompare(y.time || '99:99'); })
      .forEach(function (stop) {
        var id = hubItinItemId_(stop);
        var prev = dayItems.filter(function (it) { return hubDocId_(it) === id; })[0] || null;
        var placeQuery = hubItinPlaceQuery_(stop, resolved.destination);
        // 地點沒變而且已定位過 → 保留座標與連結；變了就清掉，讓 App 的「重新定位」補上
        var keepPlace = !!(prev && prev.sourcePlaceQuery === placeQuery && prev.lat != null && prev.lng != null
          && (!stop.mapsUrl || prev.mapsUrl === stop.mapsUrl));
        var item = {};
        if (prev) {
          Object.keys(prev).forEach(function (k) { if (k !== '_name') item[k] = prev[k]; });
          if (!keepPlace) { delete item.placeId; delete item.lat; delete item.lng; delete item.photoUrl; delete item.openingHours; }
        } else {
          item.order = nextOrder++;
          item.status = 'planned';
        }
        item.title = stop.title;
        item.type = stop.type;
        item.placeName = stop.place;
        item.sourcePlaceQuery = placeQuery;
        // AI 管的選填欄位：這次沒給就清掉（與 web applyAiImport 相同）
        ['startTime', 'endTime', 'notes'].forEach(function (k) { delete item[k]; });
        if (stop.time) item.startTime = stop.time;
        if (stop.endTime) item.endTime = stop.endTime;
        if (stop.note) item.notes = stop.note;
        if (stop.address) item.address = stop.address;
        else if (!keepPlace) delete item.address;
        if (stop.estimatedCost != null) { item.estimatedCost = stop.estimatedCost; item.currency = stop.currency; }
        if (!keepPlace) {
          var mapsUrl = stop.mapsUrl || (placeQuery ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(placeQuery) : '');
          if (mapsUrl) item.mapsUrl = mapsUrl; else delete item.mapsUrl;
        }
        writes.push({ update: { name: fsDocumentName_(base + '/days/' + date + '/items/' + id), fields: encodeFields_(item) } });
        if (prev) updated++; else created++;
      });
  });
  // 天與項目一次 batch 寫完（CLAUDE.md §5.4）。batchWrite 不是 atomic：個別失敗會在 status 裡，不會 throw
  var batch = fsBatchWrite_(writes) || {};
  var failedWrites = (batch.status || []).filter(function (st) { return st && st.code; }).length;
  if (failedWrites) {
    console.error('[hubCommitItinerary_] batch failures', failedWrites, tripId);
    return { error: failedWrites + ' of ' + writes.length + ' writes failed; preview again to retry (re-importing the same items updates them, it does not duplicate)', tripId: tripId };
  }

  hubWriteAudit_(ctx, 'trip', resolved.isNew ? 'create' : 'update', tripId,
    '行程匯入「' + resolved.title + '」：新增 ' + created + ' 項、更新 ' + updated + ' 項（' + dates[0] + ' ~ ' + dates[dates.length - 1] + '）');
  return {
    tripId: tripId, tripCreated: resolved.isNew, title: resolved.title,
    startDate: range.startDate, endDate: range.endDate,
    created: created, updated: updated, days: dates.length,
    note: '項目還沒有地圖座標；在 App 打開這個旅程的地圖按「重新定位」就會補上。可用 trip_itinerary({ tripId }) 檢查結果。',
  };
}

// -------- 台指期模擬：每週檢討 + 調整提案（邏輯在 TaifexReview.gs） --------

function hubPreviewTaifexReview_(args, ctx) {
  var built = tfBuildReviewDoc_(args);
  if (built.error) return built;
  var previewId = hubWriteSavePreview_({ kind: 'taifex_review', uid: ctx.uid, review: built.review });
  if (!previewId) return { error: 'review is too large; shorten the text fields' };
  var proposal = built.review.proposal;
  return {
    previewId: previewId,
    weekStart: built.review.weekStart,
    weekEnd: built.review.weekEnd,
    willSaveAs: built.review.status === 'proposed' ? '調整提案（等 owner 核准）' : '不調整的檢討',
    replacesExisting: built.replaces,
    changes: proposal ? tfTuneDiffLines_(proposal.diff) : [],
    switchesMainAccountToTunedVariant: proposal ? proposal.switchVariant : false,
    backtest: proposal ? proposal.backtest : null,
    warnings: built.warnings,
    note: 'commit_taifex_review 只會把這份檢討存起來並通知 owner，不會改任何參數；owner 在 App 核准後才套用。',
  };
}

function hubCommitTaifexReview_(args, ctx) {
  var pending = hubWriteTakePreview_(args.previewId, 'taifex_review', ctx);
  if (pending.error) return pending;
  if (!hubWriteConsumeQuota_()) return { error: 'daily write limit reached' };
  var saved = tfSaveReview_(pending.review, ctx);
  if (saved.error) return saved;
  hubWriteAudit_(ctx, 'taifex', 'review', saved.reviewId, '台指期週檢討 ' + saved.reviewId
    + (pending.review.proposal ? '：提案 ' + tfTuneDiffLines_(pending.review.proposal.diff).join('、') : '：不調整'));
  return {
    ok: true,
    reviewId: saved.reviewId,
    status: saved.status,
    note: saved.status === 'proposed'
      ? '提案已存檔並通知 owner；參數尚未變更，owner 在 App「台指期模擬 → 週檢討」按套用後才生效。'
      : '檢討已存檔（不調整參數）。',
  };
}

// -------- dispatcher --------

function hubWriteRunTool_(name, args, ctx) {
  switch (name) {
    case 'entry_options': return hubEntryOptions_();
    case 'preview_entries': return hubPreviewEntries_(args, ctx);
    case 'commit_entries': return hubCommitEntries_(args, ctx);
    case 'undo_entry': return hubUndoEntry_(args, ctx);
    case 'preview_itinerary': return hubPreviewItinerary_(args, ctx);
    case 'commit_itinerary': return hubCommitItinerary_(args, ctx);
    case 'preview_taifex_review': return hubPreviewTaifexReview_(args, ctx);
    case 'commit_taifex_review': return hubCommitTaifexReview_(args, ctx);
    default: return { error: 'unknown tool ' + name };
  }
}

/** 給 MCP 的文字結果：{ text, isError }。ctx = { uid, client }（由 Mcp.gs 依連線帶入） */
function hubWriteCallTool_(name, args, ctx) {
  var result;
  try {
    if (!ctx || !ctx.uid) result = { error: 'this connection has no user identity; reconnect and try again' };
    else result = hubWriteRunTool_(name, args || {}, ctx);
  } catch (err) {
    console.error('[hubWriteCallTool_]', name, err);
    result = { error: String(err && err.message || err) };
  }
  return { text: JSON.stringify(result), isError: !!(result && result.error) };
}
