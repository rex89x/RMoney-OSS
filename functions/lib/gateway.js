/**
 * Personal Hub MCP 閘道 — 純邏輯（不依賴 firebase，方便單元測試）。
 *
 * 對外：標準 MCP Streamable HTTP 端點 + OAuth 2.1 授權伺服器（PKCE、動態用戶端註冊、refresh token 輪替）。
 * 對內：把通過驗證的 JSON-RPC 轉送到 Apps Script `?action=mcp`（apps-script/src/Mcp.gs），用閘道密鑰驗證。
 *
 * 為什麼需要這一層：Apps Script Web App 會 302 轉址、不能回正確的 HTTP 狀態碼、也讀不到 Authorization header，
 * Claude.ai 的 connector 無法直接連。
 *
 * 安全設計：
 *   - 授權頁在 Personal Hub SPA（Google 登入）；只有 users/{uid}.role 為 owner / admin 的人能核准，
 *     核准請求帶 Firebase ID token（不是 cookie），所以沒有 CSRF 面。
 *   - 只接受 public client + PKCE S256；redirect_uri 必須完全符合註冊值，且主機在白名單
 *     （claude.ai / claude.com / 本機 loopback），避免授權碼被導到任意網站。
 *   - 授權碼、access token、refresh token 都只存 SHA-256；授權碼 5 分鐘、單次使用；
 *     access token 1 小時；refresh token 90 天且每次使用都輪替。
 *   - 每次 MCP 呼叫都重新確認授權（grant）仍存在、使用者仍是 owner / admin，撤銷立即生效。
 *   - 預設唯讀（scope `hub.read`）。owner 在授權頁或「MCP 連線」卡片把某個授權打開「允許寫入」後，
 *     該授權的 scope 變成 `hub.read hub.write`，閘道轉送時帶 `write: true` 與 uid，Apps Script 才會
 *     提供寫入工具（HubWriteTools.gs）。寫入權限存在 grant 上、每次呼叫重新讀取，關掉立即生效。
 *     client 自己要求什麼 scope 不影響結果：能不能寫只由 owner 決定。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCOPE = 'hub.read';
export const SCOPE_WRITE = 'hub.write';
/** 授權實際擁有的 scope 字串（token 回應用） */
export function grantScope(write) {
  return write === true ? `${SCOPE} ${SCOPE_WRITE}` : SCOPE;
}
export const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const REGISTER_DAILY_LIMIT = 30;
const OWNER_ROLES = ['owner', 'admin'];
/** 可以當 redirect_uri 的 https 主機（Claude 的 OAuth callback） */
export const REDIRECT_HOSTS = ['claude.ai', 'claude.com'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function defaultRandomToken(prefix) {
  return prefix + randomBytes(32).toString('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** PKCE S256：BASE64URL(SHA256(verifier)) === challenge */
export function verifyPkce(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

/** redirect_uri 規則：https + 白名單主機，或 http loopback（原生 client，RFC 8252）；不可帶 fragment */
export function parseRedirectUri(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.hash || url.username || url.password) return null;
  if (url.protocol === 'https:' && REDIRECT_HOSTS.includes(url.hostname)) return { url, loopback: false };
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)) return { url, loopback: true };
  return null;
}

/** 與註冊值比對：一般 client 必須完全相同；loopback 允許不同 port（RFC 8252 §7.3） */
export function redirectMatches(registered, requested) {
  if (registered === requested) return true;
  const a = parseRedirectUri(registered);
  const b = parseRedirectUri(requested);
  if (!a || !b || !a.loopback || !b.loopback) return false;
  return a.url.hostname === b.url.hostname && a.url.pathname === b.url.pathname && a.url.search === b.url.search;
}

function json(status, body, headers = {}) {
  return { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }, body };
}

function oauthError(status, error, description) {
  return json(status, { error, error_description: description });
}

function sameResource(a, b) {
  return String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
}

/**
 * deps:
 *   config        { issuer, resourceUrl, webOrigins: string[] }
 *   store         見 functions/lib/firestore-store.js（測試用記憶體版本在 tests/）
 *   verifyIdToken (idToken) → { uid } | throws
 *   getUserRole   (uid) → string | null
 *   forward       (rpc, { uid, write, client }) → 解析後的 JSON-RPC 回應，或 null（notification）
 *   now           () → ms；randomToken(prefix) → string（測試可注入）
 */
export function createGateway({ config, store, verifyIdToken, getUserRole, forward, now = Date.now, randomToken = defaultRandomToken }) {
  const mcpOrigins = [...REDIRECT_HOSTS.map((h) => `https://${h}`), ...config.webOrigins];

  function protectedResourceMetadata() {
    return {
      resource: config.resourceUrl,
      authorization_servers: [config.issuer],
      scopes_supported: [SCOPE, SCOPE_WRITE],
      bearer_methods_supported: ['header'],
      resource_name: 'Personal Hub',
    };
  }

  function authorizationServerMetadata() {
    return {
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/oauth/authorize`,
      token_endpoint: `${config.resourceUrl}/oauth/token`,
      registration_endpoint: `${config.resourceUrl}/oauth/register`,
      revocation_endpoint: `${config.resourceUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE, SCOPE_WRITE],
    };
  }

  function cors(req, kind) {
    const origin = req.headers.origin;
    // register / token / revoke / metadata 是公開端點、不帶 cookie，任何來源都可以呼叫
    if (kind === 'public') return { 'Access-Control-Allow-Origin': '*' };
    // SPA 專用端點只允許 Personal Hub 自己的網域
    if (origin && config.webOrigins.includes(origin)) return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    return {};
  }

  async function requireOwner(idToken) {
    if (!idToken || typeof idToken !== 'string') return { error: oauthError(401, 'unauthorized', 'missing idToken') };
    let uid;
    try { ({ uid } = await verifyIdToken(idToken)); } catch { return { error: oauthError(401, 'unauthorized', 'invalid idToken') }; }
    const role = await getUserRole(uid);
    if (!OWNER_ROLES.includes(role)) return { error: oauthError(403, 'access_denied', 'only the owner can authorize MCP access') };
    return { uid };
  }

  async function register(body) {
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || uris.length > 5 || !uris.every((u) => typeof u === 'string' && parseRedirectUri(u))) {
      return oauthError(400, 'invalid_redirect_uri', `redirect_uris must be https on ${REDIRECT_HOSTS.join(' / ')} or http loopback`);
    }
    const day = new Date(now()).toISOString().slice(0, 10);
    if (await store.incrementCounter(`register-${day}`) > REGISTER_DAILY_LIMIT) {
      return oauthError(429, 'temporarily_unavailable', 'too many client registrations today');
    }
    const client = {
      clientId: randomToken('rmcl_'),
      clientName: String(body.client_name || 'MCP client').replace(/[\u0000-\u001f<>]/g, '').slice(0, 80),
      redirectUris: uris,
      createdAt: now(),
    };
    await store.putClient(client);
    return json(201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: grantScope(true),
    });
  }

  /** 驗證授權請求參數（SPA 顯示同意畫面前、以及核准時都跑一次） */
  async function checkAuthorizeParams(p) {
    const client = p?.client_id ? await store.getClient(String(p.client_id)) : null;
    if (!client) return { error: oauthError(400, 'invalid_client', 'unknown client_id') };
    const redirectUri = String(p.redirect_uri || '');
    if (!client.redirectUris.some((u) => redirectMatches(u, redirectUri))) {
      return { error: oauthError(400, 'invalid_redirect_uri', 'redirect_uri does not match the registered client') };
    }
    if (p.response_type && p.response_type !== 'code') return { error: oauthError(400, 'unsupported_response_type', 'only code') };
    if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9\-_]{43}$/.test(String(p.code_challenge || ''))) {
      return { error: oauthError(400, 'invalid_request', 'PKCE with S256 is required') };
    }
    if (p.resource && !sameResource(p.resource, config.resourceUrl)) {
      return { error: oauthError(400, 'invalid_target', 'unknown resource') };
    }
    return { client, redirectUri };
  }

  async function clientInfo(query) {
    const checked = await checkAuthorizeParams(query);
    if (checked.error) return checked.error;
    return json(200, { clientName: checked.client.clientName, redirectHost: new URL(checked.redirectUri).host });
  }

  async function approve(body) {
    const owner = await requireOwner(body?.idToken);
    if (owner.error) return owner.error;
    const checked = await checkAuthorizeParams(body);
    if (checked.error) return checked.error;
    const code = randomToken('rmac_');
    await store.putCode(sha256Hex(code), {
      uid: owner.uid,
      clientId: checked.client.clientId,
      clientName: checked.client.clientName,
      redirectUri: checked.redirectUri,
      codeChallenge: String(body.code_challenge),
      // owner 在同意畫面勾了「允許寫入」才是 true；沒帶一律唯讀
      write: body.allowWrite === true,
      expiresAt: now() + CODE_TTL_MS,
    });
    const target = new URL(checked.redirectUri);
    target.searchParams.set('code', code);
    if (body.state != null) target.searchParams.set('state', String(body.state));
    return json(200, { redirectTo: target.toString() });
  }

  async function issueTokens(grantId, uid, clientId, write) {
    const accessToken = randomToken('rmat_');
    const refreshToken = randomToken('rmrt_');
    const base = { grantId, uid, clientId };
    await store.putToken(sha256Hex(accessToken), { ...base, kind: 'access', expiresAt: now() + ACCESS_TTL_MS });
    await store.putToken(sha256Hex(refreshToken), { ...base, kind: 'refresh', expiresAt: now() + REFRESH_TTL_MS });
    return json(200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: grantScope(write),
    }, { Pragma: 'no-cache' });
  }

  async function token(body) {
    const grantType = body?.grant_type;
    if (grantType === 'authorization_code') {
      // takeCode：原子性地取出並刪除，授權碼只能用一次
      const record = body.code ? await store.takeCode(sha256Hex(body.code)) : null;
      if (!record || record.expiresAt < now()) return oauthError(400, 'invalid_grant', 'authorization code is invalid or expired');
      if (record.clientId !== body.client_id || record.redirectUri !== body.redirect_uri) {
        return oauthError(400, 'invalid_grant', 'client_id or redirect_uri mismatch');
      }
      if (!verifyPkce(body.code_verifier, record.codeChallenge)) return oauthError(400, 'invalid_grant', 'PKCE verification failed');
      const grantId = randomToken('rmgr_');
      const write = record.write === true;
      await store.putGrant({ grantId, uid: record.uid, clientId: record.clientId, clientName: record.clientName, write, createdAt: now(), lastUsedAt: null });
      return issueTokens(grantId, record.uid, record.clientId, write);
    }
    if (grantType === 'refresh_token') {
      // 輪替：舊的 refresh token 取出即作廢
      const record = body.refresh_token ? await store.takeToken(sha256Hex(body.refresh_token)) : null;
      if (!record || record.kind !== 'refresh' || record.expiresAt < now()) return oauthError(400, 'invalid_grant', 'refresh token is invalid or expired');
      if (body.client_id && body.client_id !== record.clientId) return oauthError(400, 'invalid_grant', 'client mismatch');
      const grant = await store.getGrant(record.grantId);
      if (!grant) return oauthError(400, 'invalid_grant', 'authorization was revoked');
      return issueTokens(record.grantId, record.uid, record.clientId, grant.write === true);
    }
    return oauthError(400, 'unsupported_grant_type', 'authorization_code or refresh_token');
  }

  /** RFC 7009：不論 token 是否存在都回 200 */
  async function revoke(body) {
    const record = body?.token ? await store.getToken(sha256Hex(body.token)) : null;
    if (record) await store.deleteGrant(record.grantId);
    return json(200, {});
  }

  async function listGrants(body) {
    const owner = await requireOwner(body?.idToken);
    if (owner.error) return owner.error;
    const grants = await store.listGrants(owner.uid);
    return json(200, { grants: grants.map((g) => ({ grantId: g.grantId, clientName: g.clientName, write: g.write === true, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt })) });
  }

  /** owner 在「MCP 連線」卡片切換某個授權能不能寫入；下一次 MCP 呼叫就生效 */
  async function updateGrant(body) {
    const owner = await requireOwner(body?.idToken);
    if (owner.error) return owner.error;
    if (typeof body.write !== 'boolean') return oauthError(400, 'invalid_request', 'write must be a boolean');
    const grant = body.grantId ? await store.getGrant(String(body.grantId)) : null;
    if (!grant || grant.uid !== owner.uid) return oauthError(404, 'not_found', 'unknown grant');
    await store.updateGrant(grant.grantId, { write: body.write });
    return json(200, { ok: true, write: body.write });
  }

  async function revokeGrant(body) {
    const owner = await requireOwner(body?.idToken);
    if (owner.error) return owner.error;
    const grant = body?.grantId ? await store.getGrant(String(body.grantId)) : null;
    if (grant && grant.uid === owner.uid) await store.deleteGrant(grant.grantId);
    return json(200, { ok: true });
  }

  function unauthorized(description) {
    const metadataUrl = `${config.resourceUrl}/.well-known/oauth-protected-resource`;
    return json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: description } }, {
      'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="${description}"`,
    });
  }

  async function mcp(req) {
    // 瀏覽器來源只接受 Claude 與 Personal Hub 自己（DNS rebinding / 惡意網頁防護）；伺服器對伺服器沒有 Origin
    if (req.headers.origin && !mcpOrigins.includes(req.headers.origin)) return json(403, { error: 'origin not allowed' });
    if (req.method !== 'POST') return json(405, { error: 'POST only' }, { Allow: 'POST' });
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!match) return unauthorized('missing bearer token');
    const record = await store.getToken(sha256Hex(match[1]));
    if (!record || record.kind !== 'access' || record.expiresAt < now()) return unauthorized('token is invalid or expired');
    const grant = await store.getGrant(record.grantId);
    if (!grant) return unauthorized('authorization was revoked');
    if (!OWNER_ROLES.includes(await getUserRole(record.uid))) return unauthorized('user is no longer allowed');
    const rpc = req.body;
    if (!rpc || typeof rpc !== 'object') return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    await store.touchGrant(record.grantId, now());
    let response;
    try {
      response = await forward(rpc, { uid: record.uid, write: grant.write === true, client: grant.clientName });
    } catch (err) {
      console.error('[mcp forward]', err);
      return json(502, { jsonrpc: '2.0', id: Array.isArray(rpc) ? null : rpc.id ?? null, error: { code: -32603, message: 'Personal Hub backend unavailable' } });
    }
    // notification / response 沒有回應內容 → 202 Accepted（MCP Streamable HTTP）
    if (response === null) return { status: 202, headers: {}, body: null };
    return json(200, response);
  }

  /** req: { method, path（已去掉 function 名稱）, headers（小寫 key）, query, body } → { status, headers, body } */
  async function handle(req) {
    const path = (req.path || '/').replace(/\/+$/, '') || '/';
    const isSpaRoute = ['/oauth/client', '/oauth/approve', '/oauth/grants', '/oauth/grants/revoke', '/oauth/grants/update'].includes(path);
    const isMcp = path === '/' || path === '/mcp';
    const corsHeaders = isMcp ? {} : cors(req, isSpaRoute ? 'spa' : 'public');
    if (req.method === 'OPTIONS') {
      return { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version', 'Access-Control-Max-Age': '3600' }, body: null };
    }
    let res;
    if (isMcp) res = await mcp(req);
    else if (path.startsWith('/.well-known/oauth-protected-resource') && req.method === 'GET') res = json(200, protectedResourceMetadata(), { 'Cache-Control': 'public, max-age=300' });
    else if (path.startsWith('/.well-known/oauth-authorization-server') && req.method === 'GET') res = json(200, authorizationServerMetadata(), { 'Cache-Control': 'public, max-age=300' });
    else if (path === '/oauth/client' && req.method === 'GET') res = await clientInfo(req.query || {});
    else if (req.method !== 'POST') res = json(404, { error: 'not_found' });
    else if (path === '/oauth/register') res = await register(req.body);
    else if (path === '/oauth/approve') res = await approve(req.body);
    else if (path === '/oauth/token') res = await token(req.body);
    else if (path === '/oauth/revoke') res = await revoke(req.body);
    else if (path === '/oauth/grants') res = await listGrants(req.body);
    else if (path === '/oauth/grants/revoke') res = await revokeGrant(req.body);
    else if (path === '/oauth/grants/update') res = await updateGrant(req.body);
    else res = json(404, { error: 'not_found' });
    return { ...res, headers: { ...res.headers, ...corsHeaders } };
  }

  return { handle, protectedResourceMetadata, authorizationServerMetadata };
}
