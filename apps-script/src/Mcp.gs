/**
 * MCP（Model Context Protocol）端點 — 讓外部 AI client 自己來查 Personal Hub 的資料。
 *
 *   POST {WEB_APP_URL}?action=mcp
 *
 * 實作 MCP Streamable HTTP 的「無狀態 JSON 回應」子集（JSON-RPC 2.0）：
 *   initialize / notifications/* / ping / tools/list / tools/call
 * 工具：
 *   - HubTools.gs 的唯讀工具（hubToolDefs_ / hubCallTool_），與 App 內 AI 分析用的是同一套；所有連線都有。
 *   - HubWriteTools.gs 的寫入工具（記帳 / 股票成交 / 旅程行程，兩段式預覽 → 確認）；
 *     只有 owner 明確開啟「允許寫入」的連線才列得出來、才呼叫得動。
 *
 * 安全模型（沿用 FlightIngest.gs 的 token 做法）：
 *   - 不吃 Firebase idToken（外部 client 無法登入 Google），改用專用的 MCP token。
 *     Token 由前端 crypto.getRandomValues 產生（`rmcp_` + 43 字元），Apps Script 只存 SHA-256；
 *     明文只顯示一次給使用者複製。沒產生 token 之前這個端點完全關閉。
 *   - 預設唯讀；每個工具都有筆數 / 字數上限。寫入要另外開：
 *       bridge token → Script Property `MCP_TOKEN_WRITE`（AI 分析頁的開關，setMcpWriteAccess）；
 *       OAuth 授權 → 閘道依 grant 的設定在 body 帶 `write: true`（授權頁或 MCP 連線卡片逐一設定）。
 *     沒開寫入的連線 tools/list 看不到寫入工具，硬呼叫會被拒絕。寫入另有每日上限與 audit_logs 紀錄。
 *   - 隨時可在 AI 分析頁輪替或撤銷；每日呼叫次數有上限（MCP_DAILY_LIMIT_）擋濫用。
 *   - Apps Script Web App 讀不到 HTTP header、也不能回正確的狀態碼，所以這個端點不直接對外給 AI client 連，
 *     只接受 body 包起來的兩種呼叫（token 一律在 POST body，不接受放在 URL）：
 *       a. `{ mcpToken, rpc }` — scripts/hub-mcp.mjs（stdio bridge，Claude Code / Desktop）
 *       b. `{ gatewaySecret, rpc }` — MCP 閘道（functions/，Claude.ai 網頁版 / 手機版用 OAuth 登入後由閘道轉送）。
 *          密鑰由閘道第一次啟動時產生並存在 Firestore `mcp_gateway/secret`（Rules 預設 deny，前端讀不到），
 *          這裡以 script owner 身分讀出來比對；使用者身分與授權撤銷由閘道負責。
 *   - 一律回同一個 unauthorized 錯誤，不透露是沒設定、格式錯還是 token 不對。
 */

var MCP_TOKEN_PATTERN_ = /^rmcp_[A-Za-z0-9_-]{43}$/;
var MCP_PROTOCOL_VERSIONS_ = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
var MCP_DAILY_LIMIT_ = 1500;
var MCP_SERVER_INFO_ = { name: 'personal-hub', title: 'Personal Hub', version: '1.2.0' };
var MCP_PROP_KEYS_ = ['MCP_TOKEN_SHA256', 'MCP_TOKEN_UID', 'MCP_TOKEN_CREATED_AT', 'MCP_TOKEN_LAST_USED_AT', 'MCP_TOKEN_WRITE'];

// -------- token 管理（Firebase idToken 驗證後由前端呼叫，owner / admin 限定） --------

function setMcpToken(body, authResult) {
  var hash = String((body && body.tokenHash) || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: 'invalid tokenHash' };
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  var createdAt = new Date().toISOString();
  PROP.setProperties({ MCP_TOKEN_SHA256: hash, MCP_TOKEN_UID: authResult.uid, MCP_TOKEN_CREATED_AT: createdAt });
  PROP.deleteProperty('MCP_TOKEN_LAST_USED_AT');
  // 新 token 一律從唯讀開始：寫入權限要對「這一把」token 重新開
  PROP.deleteProperty('MCP_TOKEN_WRITE');
  return { ok: true, createdAt: createdAt };
}

/** bridge token 的寫入開關（owner / admin 在 AI 分析頁切換）；沒有 token 時不能開 */
function setMcpWriteAccess(body, authResult) {
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  var enabled = !!(body && body.enabled === true);
  if (enabled && !PROP.getProperty('MCP_TOKEN_SHA256')) return { ok: false, error: 'no bridge token' };
  if (enabled) PROP.setProperty('MCP_TOKEN_WRITE', '1');
  else PROP.deleteProperty('MCP_TOKEN_WRITE');
  return { ok: true, writeEnabled: enabled };
}

function revokeMcpToken(body, authResult) {
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  MCP_PROP_KEYS_.forEach(function (key) { PROP.deleteProperty(key); });
  return { ok: true };
}

function getMcpStatus() {
  return {
    ok: true,
    configured: !!PROP.getProperty('MCP_TOKEN_SHA256'),
    createdAt: PROP.getProperty('MCP_TOKEN_CREATED_AT') || null,
    lastUsedAt: PROP.getProperty('MCP_TOKEN_LAST_USED_AT') || null,
    toolCount: hubToolDefs_().length,
    dailyLimit: MCP_DAILY_LIMIT_,
    writeEnabled: PROP.getProperty('MCP_TOKEN_WRITE') === '1',
    writeToolCount: hubWriteToolDefs_().length,
    dailyWriteLimit: HUB_WRITE_DAILY_LIMIT_,
  };
}

function mcpAuthorized_(token) {
  var expected = PROP.getProperty('MCP_TOKEN_SHA256');
  token = String(token || '');
  return !!expected && MCP_TOKEN_PATTERN_.test(token)
    && flightIngestSafeEqual_(flightIngestSha256Hex_(token), expected);
}

/** 閘道密鑰：比對 Firestore `mcp_gateway/secret`（雜湊在 CacheService 快取 10 分鐘，避免每次呼叫都讀 Firestore） */
function mcpGatewayAuthorized_(secret) {
  secret = String(secret || '');
  if (!/^rmgw_[A-Za-z0-9_-]{43}$/.test(secret)) return false;
  var cache = CacheService.getScriptCache();
  var presented = flightIngestSha256Hex_(secret);
  var expected = cache.get('mcp-gateway-secret-hash');
  if (expected && flightIngestSafeEqual_(presented, expected)) return true;
  // 快取沒有或不符（密鑰可能剛被重置）→ 重新讀一次
  var doc = null;
  try { doc = fsGetDoc_('mcp_gateway/secret'); } catch (err) { console.warn('mcpGatewayAuthorized_', err); }
  if (!doc || !doc.value) return false;
  expected = flightIngestSha256Hex_(doc.value);
  cache.put('mcp-gateway-secret-hash', expected, 600);
  return flightIngestSafeEqual_(presented, expected);
}

/** 每日呼叫次數（CacheService 計數，非精確但足以擋失控的 client）；回傳 false = 超過上限 */
function mcpConsumeQuota_() {
  var cache = CacheService.getScriptCache();
  var key = 'mcp-calls-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  var used = parseInt(cache.get(key), 10) || 0;
  if (used >= MCP_DAILY_LIMIT_) return false;
  cache.put(key, String(used + 1), 21600);
  // lastUsedAt 最多 10 分鐘寫一次，避免每次呼叫都寫 Script Properties
  if (!cache.get('mcp-last-used-flag')) {
    cache.put('mcp-last-used-flag', '1', 600);
    PROP.setProperty('MCP_TOKEN_LAST_USED_AT', new Date().toISOString());
  }
  return true;
}

// -------- JSON-RPC --------

function mcpError_(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: code, message: message } };
}

function mcpToolList_(canWrite) {
  var tools = hubToolDefs_().map(function (t) {
    return {
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };
  });
  if (!canWrite) return tools;
  return tools.concat(hubWriteToolDefs_().map(function (t) {
    return {
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
      // 寫入工具只新增 / 更新，不刪除既有資料（undo_entry 是軟刪除自己寫的那一筆）
      annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
    };
  }));
}

var MCP_INSTRUCTIONS_READ_ = 'Personal Hub（owner 的個人記帳 / 投資 / 旅遊規劃系統）。金額為 TWD、日期為 yyyy-MM-dd（Asia/Taipei）。'
  + '不確定資料在哪裡時先呼叫 hub_catalog；先用聚合工具看全貌，再針對需要的部分查明細。';
var MCP_INSTRUCTIONS_WRITE_ = '這個連線可以寫入：記帳 / 股票成交用 entry_options → preview_entries → commit_entries，'
  + '匯入旅程行程用 list_trips → preview_itinerary → commit_itinerary。preview 不會寫入；'
  + '一定要先把 preview 的結果（類別、付款帳戶、金額、警告）給使用者看過並得到確認，才呼叫 commit。'
  + '使用者沒說的欄位（付款方式、類別）不要自己編，讓 preview 用預設值並把警告轉告使用者。記錯的帳用 undo_entry 復原。'
  + '台指期模擬的每週檢討用 taifex_weekly_review → preview_taifex_review → commit_taifex_review：commit 只存一份「待 owner 在 App 核准」的提案、'
  + '不會改任何參數，所以排程執行時可以直接 commit，不需要等使用者確認。';

/**
 * 處理單一 JSON-RPC message；notification（沒有 id）回 null。
 * auth = { write, uid, client }：這個連線能不能寫入、以誰的身分、client 名稱（稽核用）。
 */
function mcpHandleMessage_(msg, auth) {
  auth = auth || {};
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return mcpError_(msg && msg.id, -32600, 'Invalid Request');
  }
  var isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;
  var params = msg.params || {};
  switch (msg.method) {
    case 'initialize': {
      var requested = String(params.protocolVersion || '');
      return { jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: MCP_PROTOCOL_VERSIONS_.indexOf(requested) >= 0 ? requested : MCP_PROTOCOL_VERSIONS_[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO_,
        instructions: auth.write ? MCP_INSTRUCTIONS_READ_ + MCP_INSTRUCTIONS_WRITE_ : MCP_INSTRUCTIONS_READ_ + '這個連線是唯讀的。',
      } };
    }
    case 'ping':
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: mcpToolList_(!!auth.write) } };
    case 'tools/call': {
      var name = String(params.name || '');
      var isWriteTool = hubWriteToolNames_().indexOf(name) >= 0;
      if (isWriteTool && !auth.write) {
        // 不當成「不存在」：讓模型能告訴使用者要去哪裡開
        return { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text',
          text: JSON.stringify({ error: 'this connection is read-only; the owner can enable write access in Personal Hub → AI 分析 → MCP 連線' }) }] } };
      }
      if (!isWriteTool && hubToolNames_().indexOf(name) < 0) return mcpError_(msg.id, -32602, 'Unknown tool: ' + name);
      var out = isWriteTool ? hubWriteCallTool_(name, params.arguments || {}, auth) : hubCallTool_(name, params.arguments || {});
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: out.text }], isError: !!out.isError } };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id: msg.id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id: msg.id, result: { prompts: [] } };
    default:
      return mcpError_(msg.id, -32601, 'Method not found: ' + msg.method);
  }
}

/**
 * Web App 入口（Main.gs route_ 在 Firebase auth 之前分派）。
 * body：bridge 的 `{ mcpToken, rpc }` 或閘道的 `{ gatewaySecret, rpc, uid, write, client }`；rpc 是 JSON-RPC message 或 batch。
 * 閘道帶來的 uid / write / client 只有在閘道密鑰驗證通過後才採信。
 */
function mcpEndpoint_(e, method) {
  var out = function (obj) {
    return ContentService.createTextOutput(obj === null ? '' : JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  };
  if (method !== 'POST') return out(mcpError_(null, -32600, 'POST only (this server does not offer an SSE stream)'));
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || ''); }
  catch (_err) { return out(mcpError_(null, -32700, 'Parse error')); }
  var wrapped = body && !Array.isArray(body) && body.rpc !== undefined;
  var rpc = wrapped ? body.rpc : null;
  var firstId = Array.isArray(rpc) ? null : (rpc && rpc.id);
  var viaGateway = wrapped && !!body.gatewaySecret;
  var authorized = wrapped && (viaGateway ? mcpGatewayAuthorized_(body.gatewaySecret) : mcpAuthorized_(body.mcpToken));
  if (!authorized) return out(mcpError_(firstId, -32001, 'unauthorized'));
  var auth = viaGateway
    ? { write: body.write === true, uid: String(body.uid || ''), client: String(body.client || 'OAuth client').slice(0, 60) }
    : { write: PROP.getProperty('MCP_TOKEN_WRITE') === '1', uid: PROP.getProperty('MCP_TOKEN_UID') || '', client: 'bridge token' };
  var handle = function (msg) { return mcpHandleMessage_(msg, auth); };
  if (!mcpConsumeQuota_()) return out(mcpError_(firstId, -32002, 'daily MCP call limit reached'));
  try {
    if (Array.isArray(rpc)) {
      if (!rpc.length || rpc.length > 20) return out(mcpError_(null, -32600, 'Invalid batch'));
      var responses = rpc.map(handle).filter(function (r) { return r !== null; });
      return out(responses.length ? responses : null);
    }
    return out(handle(rpc));
  } catch (err) {
    console.error('[mcpEndpoint_]', err);
    return out(mcpError_(firstId, -32603, 'Internal error'));
  }
}
