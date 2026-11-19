/**
 * Claude API client（Anthropic Messages API，raw HTTP — Apps Script 沒有官方 SDK）。
 *
 * 所有 LLM 功能都走 callClaude_()：
 *   - Script Property `ANTHROPIC_API_KEY`（owner 手動設定，前端永遠拿不到）
 *   - 模型由 `ai_budget_configs/{owner}` 的 defaultModel / fastModel 決定（設定 → AI 額度），
 *     預設都是 claude-opus-5-5；後端只接受 CLAUDE_MODEL_PRICES_ 白名單內的 model id
 *   - 每次呼叫把 response.usage 寫進 ai_usage_events（AiBudget.gs）來算本期額度
 *   - 呼叫前檢查額度 hard stop（assertClaudeBudgetAvailable_）
 *
 * API 版本 2026-10-21：不送 temperature / top_p / top_k（會 400）。
 * Opus 5.5 / Sonnet 5.5 thinking 一律開（adaptive），用 output_config.effort 控制深度與花費。
 */

var CLAUDE_API_BASE_ = 'https://api.anthropic.com/v1';
var CLAUDE_API_VERSION_ = '2026-10-21';
var CLAUDE_FALLBACK_BETA_ = 'server-side-fallback-2026-07-01';
var CLAUDE_DEFAULT_MODEL_ = 'claude-opus-5-5';

/** USD / 1M tokens。cacheWrite 為 5 分鐘 TTL 價格；webSearch 為每次搜尋 USD。 */
var CLAUDE_MODEL_PRICES_ = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.20, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.10, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125,
    longInput: 0.50, longOutput: 2.50, longThreshold: 100000 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.20, cacheWrite: 10 },
  // fallback 可能落到的模型（server-side fallbacks: "default"），只用來計價、不可選
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.20, cacheWrite: 2.5 },
};
var CLAUDE_SELECTABLE_MODELS_ = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];
var CLAUDE_WEB_SEARCH_USD_ = 0.01; // $10 / 1,000 searches
/** 這些模型支援 server-side refusal fallback（Haiku 沒有） */
var CLAUDE_FALLBACK_MODELS_ = { 'claude-opus-5-5': true, 'claude-sonnet-5-5': true, 'claude-fable-5-2': true };

function claudeApiKey_() {
  return PROP.getProperty('ANTHROPIC_API_KEY') || '';
}

function claudeConfigured_() {
  return !!claudeApiKey_();
}

/** tier：'default'（行程 / 問答 / 分析）或 'fast'（解析 / OCR / Telegram 快速記帳） */
function claudeModelFor_(tier) {
  var config = null;
  try {
    var uid = aiOwnerId_();
    config = uid ? fsGetDoc_('ai_budget_configs/' + uid) : null;
  } catch (err) {
    console.warn('claudeModelFor_ config', err);
  }
  var selected = config && (tier === 'fast' ? config.fastModel : config.defaultModel);
  return CLAUDE_SELECTABLE_MODELS_.indexOf(selected) >= 0 ? selected : CLAUDE_DEFAULT_MODEL_;
}

/**
 * 組 Messages API request body（純函式，方便測試）。
 * opts: { model, system, messages | prompt, images: [{ mediaType, data }], maxTokens, effort,
 *         tools, webSearchMaxUses, toolChoice ('auto' | 'none'), cache (true → 自動 prompt caching) }
 */
function claudeBuildPayload_(opts) {
  var messages = opts.messages;
  if (!messages) {
    var content = [];
    (opts.images || []).forEach(function (img) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    });
    content.push({ type: 'text', text: String(opts.prompt || '') });
    messages = [{ role: 'user', content: content }];
  }
  var payload = {
    model: opts.model,
    max_tokens: opts.maxTokens || 8000,
    messages: messages,
  };
  if (opts.system) payload.system = opts.system;
  if (opts.effort) payload.output_config = { effort: opts.effort };
  var tools = (opts.tools || []).slice();
  if (opts.webSearchMaxUses) {
    tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: opts.webSearchMaxUses });
  }
  if (tools.length) payload.tools = tools;
  // Opus 5.5 / Sonnet 5.5 / Fable 不接受強制 tool_choice（any / tool 會 400），只送 auto / none
  if (tools.length && opts.toolChoice === 'none') payload.tool_choice = { type: 'none' };
  // 多輪 tool loop：每輪都重送 tools + system + 歷史，開自動快取讓重複的前綴以 cache read 計價
  if (opts.cache) payload.cache_control = { type: 'ephemeral' };
  if (CLAUDE_FALLBACK_MODELS_[opts.model]) payload.fallbacks = 'default';
  return payload;
}

function claudeHeaders_(payload) {
  var headers = {
    'x-api-key': claudeApiKey_(),
    'anthropic-version': CLAUDE_API_VERSION_,
  };
  if (payload && payload.fallbacks) headers['anthropic-beta'] = CLAUDE_FALLBACK_BETA_;
  return headers;
}

/** UrlFetchApp request 物件（fetch 與 fetchAll 共用） */
function claudeRequest_(payload) {
  return {
    url: CLAUDE_API_BASE_ + '/messages',
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: claudeHeaders_(payload),
    payload: JSON.stringify(payload),
  };
}

/** 把 HTTP 錯誤轉成可讀訊息（不含 API key） */
function claudeHttpError_(code, bodyText) {
  var message = '';
  try {
    var parsed = JSON.parse(bodyText);
    message = (parsed && parsed.error && parsed.error.message) || '';
  } catch (_e) { message = String(bodyText || '').slice(0, 200); }
  if (code === 401) return 'Claude API key 無效（請檢查 Script Property ANTHROPIC_API_KEY）';
  if (code === 429) return 'Claude API 速率或額度限制，請稍後再試：' + message;
  if (code === 529 || code >= 500) return 'Claude API 暫時無法使用（' + code + '），請稍後再試';
  return 'Claude API ' + code + ': ' + message;
}

/** response.content → 最終文字（只取 text block，忽略 thinking / tool blocks） */
function claudeResponseText_(data) {
  return ((data && data.content) || [])
    .filter(function (block) { return block && block.type === 'text' && typeof block.text === 'string'; })
    .map(function (block) { return block.text; })
    .join('')
    .trim();
}

/**
 * 解析 HTTP 回應：檢查狀態碼、stop_reason、記錄用量。
 * 回傳 data（已 JSON.parse）；失敗 throw Error。
 */
function claudeHandleResponse_(response, model, feature) {
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code >= 400) throw new Error(claudeHttpError_(code, text));
  var data = JSON.parse(text);
  recordClaudeUsage_(data, model, feature);
  if (data.stop_reason === 'refusal') {
    throw new Error('Claude 拒絕處理這個請求' + (data.stop_details && data.stop_details.explanation
      ? '：' + String(data.stop_details.explanation).slice(0, 120) : ''));
  }
  return data;
}

/**
 * 單次呼叫。opts 同 claudeBuildPayload_，另需 feature（用量歸類）與 tier（'default' | 'fast'）。
 * 回傳 { text, data, model, truncated }；失敗 throw Error。
 * web search 回 pause_turn 時自動續跑（最多 3 次）。
 */
function callClaude_(opts) {
  if (!claudeConfigured_()) throw new Error('ANTHROPIC_API_KEY 尚未設定（Apps Script → Script Properties）');
  assertClaudeBudgetAvailable_();
  var model = opts.model || claudeModelFor_(opts.tier || 'default');
  var payload = claudeBuildPayload_(Object.assign({}, opts, { model: model }));
  var url = CLAUDE_API_BASE_ + '/messages';
  var data = claudeHandleResponse_(UrlFetchApp.fetch(url, claudeFetchOptions_(payload)), model, opts.feature);
  var rounds = 0;
  var collected = (data.content || []).slice();
  while (data.stop_reason === 'pause_turn' && rounds < 3) {
    rounds++;
    payload.messages = payload.messages.concat([{ role: 'assistant', content: data.content }]);
    data = claudeHandleResponse_(UrlFetchApp.fetch(url, claudeFetchOptions_(payload)), model, opts.feature);
    collected = collected.concat(data.content || []);
  }
  var merged = Object.assign({}, data, { content: collected });
  return {
    text: claudeResponseText_(data),
    data: merged,
    model: data.model || model,
    truncated: data.stop_reason === 'max_tokens',
  };
}

/**
 * Agent loop：Claude 自己決定要呼叫哪些工具取資料，直到寫出最終答案。
 *
 * opts：callClaude_ 的參數，另加
 *   tools            Anthropic tool 定義（順序固定，prompt cache 才會命中）
 *   runTool(name, input) → { text, isError }
 *   maxRounds        最多幾輪「呼叫工具」（預設 6）
 *   deadlineMs       超過這個時間就不再開新的工具輪（Apps Script 單次執行 6 分鐘上限）
 *   maxInputTokens   累計 input tokens 上限，超過就要求直接作答（費用護欄）
 *
 * 達到任一上限時，最後一輪用 tool_choice: none 要求 Claude 以手上的資料完成回答。
 * 回傳 { text, model, truncated, rounds, toolCalls: [{ name, args }], usage }；失敗 throw Error。
 */
function claudeAgentLoop_(opts) {
  var startedAt = new Date().getTime();
  var maxRounds = opts.maxRounds || 6;
  var deadlineMs = opts.deadlineMs || 200000;
  var maxInputTokens = opts.maxInputTokens || 150000;
  var messages = (opts.messages || []).slice();
  var toolCalls = [];
  var usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, webSearchRequests: 0 };
  var costUSD = 0;
  var base = {
    feature: opts.feature, tier: opts.tier, model: opts.model, effort: opts.effort, maxTokens: opts.maxTokens,
    system: opts.system, tools: opts.tools, cache: true,
  };
  var rounds = 0;
  var forceFinal = false;
  for (;;) {
    var res = callClaude_(Object.assign({}, base, { messages: messages, toolChoice: forceFinal ? 'none' : 'auto' }));
    var u = aiUsageFromClaude_(res.data);
    usage.inputTokens += u.inputTokens;
    usage.cacheReadTokens += u.cacheReadTokens;
    usage.cacheWriteTokens += u.cacheWriteTokens;
    usage.outputTokens += u.outputTokens;
    costUSD += aiEstimateClaudeCostUSD_(res.model, u);
    var content = res.data.content || [];
    var calls = content.filter(function (block) { return block && block.type === 'tool_use'; });
    if (forceFinal || res.data.stop_reason !== 'tool_use' || !calls.length) {
      return { text: res.text, model: res.model, truncated: res.truncated, rounds: rounds, toolCalls: toolCalls,
        usage: usage, costUSD: costUSD };
    }
    rounds++;
    // thinking block 要原封不動回傳，所以整個 content 推回去
    messages.push({ role: 'assistant', content: content });
    var results = calls.map(function (call) {
      var out = opts.runTool(call.name, call.input || {});
      toolCalls.push({ name: call.name, args: call.input || {} });
      return { type: 'tool_result', tool_use_id: call.id, content: out.text, is_error: !!out.isError };
    });
    var spentInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (rounds >= maxRounds || new Date().getTime() - startedAt > deadlineMs || spentInput > maxInputTokens) {
      forceFinal = true;
      results.push({ type: 'text', text: '（系統）已達查詢上限，不能再呼叫工具。請直接根據目前取得的資料完成回答，資料不足的部分明確說明。' });
    }
    // 平行呼叫的結果一律放在同一則 user message（tool_result 在前、文字在後）
    messages.push({ role: 'user', content: results });
  }
}

function claudeFetchOptions_(payload) {
  var req = claudeRequest_(payload);
  delete req.url;
  return req;
}

/** 呼叫並把文字解析成 JSON（容忍圍欄 / 彎引號，走 ImportJson.gs 的修復） */
function callClaudeJson_(opts) {
  var result = callClaude_(opts);
  var loose = importParseJsonLoosely_(result.text);
  if (!loose.ok) {
    var err = new Error(result.truncated ? 'Claude 回應過長被截斷，請縮短內容再試' : 'Claude 回傳的不是合法 JSON');
    err.raw = result.text.slice(0, 200);
    throw err;
  }
  return { json: loose.data, text: result.text, repaired: loose.repaired, model: result.model };
}

/**
 * 免費的 token 計數（count_tokens 不計費），給「確認後才執行」的對話框估價用。
 * 回傳 input tokens；失敗回 null（估價失敗不擋使用者）。
 */
function claudeCountTokens_(opts) {
  if (!claudeConfigured_()) return null;
  try {
    var model = opts.model || claudeModelFor_(opts.tier || 'default');
    var payload = claudeBuildPayload_(Object.assign({}, opts, { model: model }));
    var body = { model: payload.model, messages: payload.messages };
    if (payload.system) body.system = payload.system;
    if (payload.tools) body.tools = payload.tools;
    var response = UrlFetchApp.fetch(CLAUDE_API_BASE_ + '/messages/count_tokens', {
      method: 'post',
      muteHttpExceptions: true,
      contentType: 'application/json',
      headers: claudeHeaders_(null),
      payload: JSON.stringify(body),
    });
    if (response.getResponseCode() >= 400) {
      console.warn('claudeCountTokens_', response.getResponseCode(), response.getContentText().slice(0, 200));
      return null;
    }
    return Number(JSON.parse(response.getContentText()).input_tokens) || null;
  } catch (err) {
    console.warn('claudeCountTokens_', err);
    return null;
  }
}
