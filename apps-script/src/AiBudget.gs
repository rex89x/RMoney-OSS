/**
 * Claude API 用量計量與額度控管。
 *
 * 每次 Claude 呼叫的 response.usage 由 recordClaudeUsage_() 寫進 ai_usage_events（provider: 'anthropic'），
 * 依官方牌價（CLAUDE_MODEL_PRICES_，Claude.gs）估算 USD。額度以「計費週期」算：
 * 預設每月 23 號（台北時間 00:00）重置、每期 USD 100，可在 設定 → AI 額度 調整。
 * 這是 Personal Hub 自己的估算，不是 Anthropic Console 的帳單；Console 才是最終依據。
 *
 * 舊的 Gemini 事件（沒有 provider 欄位）仍留在 collection 裡，但不計入 Claude 額度。
 */

var AI_PRICE_VERSION_ = '2026-11-12-claude';
var AI_DEFAULT_CREDIT_USD_ = 100;
var AI_DEFAULT_RESET_DAY_ = 23;
var AI_DEFAULT_USD_TWD_ = 32;
var AI_PROVIDER_ = 'anthropic';

function aiOwnerId_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('ai-budget-owner-id');
  if (cached) return cached;
  var roles = ['owner', 'admin'];
  for (var i = 0; i < roles.length; i++) {
    var users = fsRunQuery_('', {
      from: [{ collectionId: 'users' }],
      where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL',
        value: { stringValue: roles[i] } } },
      limit: 1,
    });
    if (users[0] && users[0]._name) {
      var uid = String(users[0]._name).split('/').pop();
      cache.put('ai-budget-owner-id', uid, 21600);
      return uid;
    }
  }
  return '';
}

function aiNumber_(value) {
  var parsed = Number(value);
  return isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Claude response.usage → 正規化的 token 計數 */
function aiUsageFromClaude_(data) {
  var usage = (data && data.usage) || {};
  var serverTools = usage.server_tool_use || {};
  var inputTokens = aiNumber_(usage.input_tokens);
  var cacheReadTokens = aiNumber_(usage.cache_read_input_tokens);
  var cacheWriteTokens = aiNumber_(usage.cache_creation_input_tokens);
  var outputTokens = aiNumber_(usage.output_tokens);
  return {
    inputTokens: inputTokens,
    cacheReadTokens: cacheReadTokens,
    cacheWriteTokens: cacheWriteTokens,
    outputTokens: outputTokens,
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    webSearchRequests: aiNumber_(serverTools.web_search_requests),
  };
}

/** 依模型牌價估算 USD（output 已含 thinking tokens） */
function aiEstimateClaudeCostUSD_(model, usage) {
  var prices = CLAUDE_MODEL_PRICES_[model] || CLAUDE_MODEL_PRICES_[CLAUDE_DEFAULT_MODEL_];
  var promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  var long = prices.longThreshold && promptTokens > prices.longThreshold;
  var inputRate = long ? prices.longInput : prices.input;
  var outputRate = long ? prices.longOutput : prices.output;
  return (usage.inputTokens * inputRate
    + usage.cacheReadTokens * prices.cacheRead
    + usage.cacheWriteTokens * prices.cacheWrite
    + usage.outputTokens * outputRate) / 1000000
    + usage.webSearchRequests * CLAUDE_WEB_SEARCH_USD_;
}

/** Best-effort：計量失敗不能讓成功的 Claude 回應變成功能失敗。 */
function recordClaudeUsage_(data, requestedModel, feature) {
  try {
    var uid = aiOwnerId_();
    if (!uid) throw new Error('owner user not found');
    var usage = aiUsageFromClaude_(data);
    if (!usage.totalTokens && !usage.webSearchRequests) return null;
    // fallback 時 data.model 是實際服務的模型
    var model = (data && data.model) || requestedModel;
    var now = new Date();
    var event = {
      userId: uid,
      provider: AI_PROVIDER_,
      feature: feature || 'other',
      model: model,
      requestedModel: requestedModel,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      webSearchRequests: usage.webSearchRequests,
      costUSD: aiEstimateClaudeCostUSD_(model, usage),
      priceVersion: AI_PRICE_VERSION_,
      occurredAt: now,
      occurredDateTW: Utilities.formatDate(now, TZ, 'yyyy-MM-dd'),
    };
    fsAddDoc_('ai_usage_events', event);
    aiMaybeNotifyBudget_(uid);
    return event;
  } catch (err) {
    console.error('recordClaudeUsage_', err);
    return null;
  }
}

function aiResetDay_(config) {
  var day = Math.floor(Number(config && config.cycleResetDay));
  return day >= 1 && day <= 28 ? day : AI_DEFAULT_RESET_DAY_;
}

function aiCreditUSD_(config) {
  return aiNumber_(config && config.monthlyCreditUSD) || AI_DEFAULT_CREDIT_USD_;
}

/**
 * 計費週期（台北時間）：resetDay 00:00 起算一個月。
 * offset 0 = 包含 refDate 的那一期，-1 = 上一期。純函式（測試用）。
 */
function aiCycleBounds_(refDate, resetDay, offset) {
  var parts = Utilities.formatDate(refDate, TZ, 'yyyy-M-d').split('-');
  var year = Number(parts[0]);
  var month = Number(parts[1]) - 1;
  var day = Number(parts[2]);
  if (day < resetDay) month -= 1;
  month += offset || 0;
  var startUtc = Date.UTC(year, month, resetDay) - 8 * 3600000;
  var endUtc = Date.UTC(year, month + 1, resetDay) - 8 * 3600000;
  return { start: new Date(startUtc), end: new Date(endUtc) };
}

function aiListEventsBetween_(start, end) {
  return fsRunQuery_('', {
    from: [{ collectionId: 'ai_usage_events' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'occurredAt' }, op: 'GREATER_THAN_OR_EQUAL',
        value: { timestampValue: start.toISOString() } } },
      { fieldFilter: { field: { fieldPath: 'occurredAt' }, op: 'LESS_THAN',
        value: { timestampValue: end.toISOString() } } },
    ] } },
    limit: 5000,
  });
}

/** 純函式：彙總一期的 Claude 事件（測試用） */
function aiSummarizeEvents_(events, uid) {
  var totals = {
    requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, totalTokens: 0, webSearchRequests: 0, costUSD: 0,
  };
  var byFeature = {};
  var byModel = {};
  var byDay = {};
  (events || []).forEach(function (event) {
    if (!event || event.userId !== uid || event.provider !== AI_PROVIDER_) return;
    totals.requests++;
    ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'webSearchRequests']
      .forEach(function (key) { totals[key] += aiNumber_(event[key]); });
    var cost = aiNumber_(event.costUSD);
    totals.costUSD += cost;
    [byFeature, byModel].forEach(function (bucket, index) {
      var key = String((index === 0 ? event.feature : event.model) || 'unknown');
      if (!bucket[key]) bucket[key] = { requests: 0, totalTokens: 0, costUSD: 0 };
      bucket[key].requests++;
      bucket[key].totalTokens += aiNumber_(event.totalTokens);
      bucket[key].costUSD += cost;
    });
    var dayKey = event.occurredDateTW || 'unknown';
    byDay[dayKey] = (byDay[dayKey] || 0) + cost;
  });
  return { totals: totals, byFeature: byFeature, byModel: byModel, byDay: byDay };
}

function aiUsdToTwd_() {
  try {
    var rate = fsGetDoc_('fx_rates/USD_TWD');
    return aiNumber_(rate && rate.rate) || AI_DEFAULT_USD_TWD_;
  } catch (err) {
    console.warn('aiUsdToTwd_', err);
    return AI_DEFAULT_USD_TWD_;
  }
}

function aiOwnerConfig_(uid) {
  try { return uid ? fsGetDoc_('ai_budget_configs/' + uid) : null; }
  catch (err) { console.warn('aiOwnerConfig_', err); return null; }
}

/** 目前這一期的花費（USD），給 hard stop / 通知 / 估價用 */
function aiCurrentCycleSpend_(uid, config) {
  var bounds = aiCycleBounds_(new Date(), aiResetDay_(config), 0);
  var summary = aiSummarizeEvents_(aiListEventsBetween_(bounds.start, bounds.end), uid);
  return { bounds: bounds, spentUSD: summary.totals.costUSD, creditUSD: aiCreditUSD_(config) };
}

/** action=getAiUsageSummary  body: { cycleOffset?: 0 | -1 | ... -6 } */
function getAiUsageSummary(body, authResult) {
  var uid = authResult && authResult.uid;
  if (!uid) return { ok: false, error: 'missing user' };
  var offset = Math.max(-6, Math.min(0, Math.floor(Number(body && body.cycleOffset) || 0)));
  var config = aiOwnerConfig_(uid);
  var resetDay = aiResetDay_(config);
  var bounds = aiCycleBounds_(new Date(), resetDay, offset);
  var summary = aiSummarizeEvents_(aiListEventsBetween_(bounds.start, bounds.end), uid);
  return {
    ok: true,
    cycleOffset: offset,
    cycleStart: bounds.start.toISOString(),
    cycleEnd: bounds.end.toISOString(),
    resetDay: resetDay,
    creditUSD: aiCreditUSD_(config),
    totals: summary.totals,
    byFeature: summary.byFeature,
    byModel: summary.byModel,
    byDay: summary.byDay,
    usdToTwd: aiUsdToTwd_(),
    apiKeyConfigured: claudeConfigured_(),
    defaultModel: claudeModelFor_('default'),
    fastModel: claudeModelFor_('fast'),
    priceVersion: AI_PRICE_VERSION_,
  };
}

function aiMaybeNotifyBudget_(uid) {
  var config = aiOwnerConfig_(uid);
  var cycle = aiCurrentCycleSpend_(uid, config);
  var usagePct = cycle.spentUSD / cycle.creditUSD * 100;
  var threshold = aiNumber_(config && config.warningPercent) || 80;
  var level = usagePct >= 100 ? 'over' : (usagePct >= threshold ? 'warning' : '');
  var cycleKey = Utilities.formatDate(cycle.bounds.start, TZ, 'yyyy-MM-dd');
  if (!level || (config && config.lastAlertCycle === cycleKey && config.lastAlertLevel === level)) return;
  sendNotification_('aiBudget', [
    '[Personal Hub] Claude API 額度提醒',
    '--------------------',
    '本期（' + cycleKey + ' 起）已用：US$' + cycle.spentUSD.toFixed(2),
    '每期額度：US$' + cycle.creditUSD.toFixed(0),
    '使用率：' + Math.round(usagePct) + '%',
    level === 'over' ? '已達額度上限，請到 設定 → AI 額度 檢查。' : '已達警示門檻。',
  ].join('\n'));
  fsSetDoc_('ai_budget_configs/' + uid, {
    lastAlertCycle: cycleKey,
    lastAlertLevel: level,
    updatedAt: new Date(),
  }, true);
}

/** hard stop：開啟後，本期估算花費達額度就拒絕新的 Claude 請求 */
function assertClaudeBudgetAvailable_() {
  var uid = aiOwnerId_();
  if (!uid) return;
  var config = aiOwnerConfig_(uid);
  if (!config || config.hardStopEnabled !== true) return;
  var cycle = aiCurrentCycleSpend_(uid, config);
  if (cycle.spentUSD >= cycle.creditUSD) {
    throw new Error('Claude API 本期額度已用完（US$' + cycle.spentUSD.toFixed(2) + ' / US$'
      + cycle.creditUSD.toFixed(0) + '），請至 設定 → AI 額度 調整。');
  }
}
