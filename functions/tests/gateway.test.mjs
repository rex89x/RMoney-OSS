import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ACCESS_TTL_MS, CODE_TTL_MS, REGISTER_DAILY_LIMIT, createGateway, parseRedirectUri, redirectMatches, sha256Hex, verifyPkce } from '../lib/gateway.js';

/** OAuth 授權流程 + MCP 轉送的完整測試（記憶體 store，不碰 Firebase） */
function memoryStore() {
  const clients = new Map(); const codes = new Map(); const tokens = new Map(); const grants = new Map(); const counters = new Map();
  const take = (map, key) => { const v = map.get(key) ?? null; map.delete(key); return v; };
  return {
    tokens, grants, codes,
    getClient: async (id) => clients.get(id) ?? null,
    putClient: async (c) => { clients.set(c.clientId, c); },
    putCode: async (h, d) => { codes.set(h, d); },
    takeCode: async (h) => take(codes, h),
    putToken: async (h, d) => { tokens.set(h, d); },
    getToken: async (h) => tokens.get(h) ?? null,
    takeToken: async (h) => take(tokens, h),
    putGrant: async (g) => { grants.set(g.grantId, g); },
    getGrant: async (id) => grants.get(id) ?? null,
    listGrants: async (uid) => [...grants.values()].filter((g) => g.uid === uid),
    deleteGrant: async (id) => { grants.delete(id); for (const [h, t] of tokens) if (t.grantId === id) tokens.delete(h); },
    touchGrant: async (id, at) => { grants.get(id).lastUsedAt = at; },
    updateGrant: async (id, patch) => { Object.assign(grants.get(id), patch); },
    incrementCounter: async (key) => { counters.set(key, (counters.get(key) ?? 0) + 1); return counters.get(key); },
  };
}

const CONFIG = {
  issuer: 'https://hub.web.app',
  resourceUrl: 'https://asia-east1-hub.cloudfunctions.net/mcp',
  webOrigins: ['https://hub.web.app'],
};
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function setup(overrides = {}) {
  const state = { now: 1_800_000_000_000, roles: { owner1: 'owner', member1: 'member' }, forwarded: [], forwardCtx: [], n: 0 };
  const store = memoryStore();
  const gateway = createGateway({
    config: CONFIG,
    store,
    verifyIdToken: async (t) => { if (!t.startsWith('id:')) throw new Error('bad'); return { uid: t.slice(3) }; },
    getUserRole: async (uid) => state.roles[uid] ?? null,
    forward: async (rpc, fwd) => { state.forwarded.push(rpc); state.forwardCtx.push(fwd); return rpc.id == null ? null : { jsonrpc: '2.0', id: rpc.id, result: { ok: true } }; },
    now: () => state.now,
    randomToken: (prefix) => `${prefix}${++state.n}`.padEnd(20, 'x'),
    ...overrides,
  });
  const call = (method, path, { body, headers = {}, query } = {}) => gateway.handle({ method, path, headers, body, query });
  return { gateway, store, state, call };
}

async function authorize(ctx, idToken = 'id:owner1', extra = {}) {
  const reg = await ctx.call('POST', '/oauth/register', { body: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
  const params = { client_id: reg.body.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'st1', resource: CONFIG.resourceUrl };
  const approved = await ctx.call('POST', '/oauth/approve', { body: { ...params, ...extra, idToken } });
  return { reg, params, approved };
}

async function fullLogin(ctx, extra = {}) {
  const { params, approved } = await authorize(ctx, 'id:owner1', extra);
  const code = new URL(approved.body.redirectTo).searchParams.get('code');
  const tokens = await ctx.call('POST', '/oauth/token', { body: { grant_type: 'authorization_code', code, client_id: params.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER } });
  return { params, code, tokens };
}

test('redirect uri rules: allowlisted https hosts and loopback only', () => {
  assert.ok(parseRedirectUri('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(parseRedirectUri('http://localhost:33418/callback'));
  assert.equal(parseRedirectUri('https://evil.example/cb'), null);
  assert.equal(parseRedirectUri('https://claude.ai.evil.example/cb'), null);
  assert.equal(parseRedirectUri('http://claude.ai/cb'), null);
  assert.equal(parseRedirectUri('https://claude.ai/cb#frag'), null);
  assert.equal(parseRedirectUri('https://user@claude.ai/cb'), null);
  assert.equal(redirectMatches('http://localhost:1/cb', 'http://localhost:9999/cb'), true);
  assert.equal(redirectMatches('http://localhost:1/cb', 'http://localhost:1/other'), false);
  assert.equal(redirectMatches(REDIRECT, REDIRECT + '?x=1'), false);
});

test('pkce: S256 only, verifier format enforced', () => {
  assert.equal(verifyPkce(VERIFIER, CHALLENGE), true);
  assert.equal(verifyPkce('w'.repeat(64), CHALLENGE), false);
  assert.equal(verifyPkce('short', CHALLENGE), false);
  assert.equal(verifyPkce(undefined, CHALLENGE), false);
});

test('metadata points the client at the hosting issuer and function endpoints', async () => {
  const ctx = setup();
  const pr = await ctx.call('GET', '/.well-known/oauth-protected-resource');
  assert.equal(pr.body.resource, CONFIG.resourceUrl);
  assert.deepEqual(pr.body.authorization_servers, [CONFIG.issuer]);
  const as = await ctx.call('GET', '/.well-known/oauth-authorization-server');
  assert.equal(as.body.authorization_endpoint, 'https://hub.web.app/oauth/authorize');
  assert.equal(as.body.token_endpoint, CONFIG.resourceUrl + '/oauth/token');
  assert.deepEqual(as.body.code_challenge_methods_supported, ['S256']);
});

test('register rejects foreign redirect hosts and is rate limited', async () => {
  const ctx = setup();
  const bad = await ctx.call('POST', '/oauth/register', { body: { redirect_uris: ['https://evil.example/cb'] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_redirect_uri');
  for (let i = 0; i < REGISTER_DAILY_LIMIT; i++) {
    assert.equal((await ctx.call('POST', '/oauth/register', { body: { redirect_uris: [REDIRECT] } })).status, 201);
  }
  assert.equal((await ctx.call('POST', '/oauth/register', { body: { redirect_uris: [REDIRECT] } })).status, 429);
});

test('unauthenticated MCP call gets 401 with resource metadata pointer', async () => {
  const ctx = setup();
  const res = await ctx.call('POST', '/', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(res.status, 401);
  assert.match(res.headers['WWW-Authenticate'], /resource_metadata="https:\/\/asia-east1-hub\.cloudfunctions\.net\/mcp\/\.well-known\/oauth-protected-resource"/);
  assert.equal((await ctx.call('POST', '/', { headers: { authorization: 'Bearer nope' }, body: {} })).status, 401);
  assert.equal(ctx.state.forwarded.length, 0);
});

test('only the owner can approve; params are re-validated at approval', async () => {
  const ctx = setup();
  const member = await authorize(ctx, 'id:member1');
  assert.equal(member.approved.status, 403);
  const anon = await ctx.call('POST', '/oauth/approve', { body: { ...member.params } });
  assert.equal(anon.status, 401);
  const forged = await ctx.call('POST', '/oauth/approve', { body: { ...member.params, idToken: 'forged' } });
  assert.equal(forged.status, 401);
  const wrongRedirect = await ctx.call('POST', '/oauth/approve', { body: { ...member.params, idToken: 'id:owner1', redirect_uri: 'https://claude.ai/other' } });
  assert.equal(wrongRedirect.body.error, 'invalid_redirect_uri');
  const noPkce = await ctx.call('POST', '/oauth/approve', { body: { ...member.params, idToken: 'id:owner1', code_challenge_method: 'plain' } });
  assert.equal(noPkce.body.error, 'invalid_request');
  const wrongResource = await ctx.call('POST', '/oauth/approve', { body: { ...member.params, idToken: 'id:owner1', resource: 'https://other.example/mcp' } });
  assert.equal(wrongResource.body.error, 'invalid_target');
  assert.equal(ctx.store.codes.size, 0);
});

test('full flow: approve → code → tokens → MCP call forwarded; tokens stored hashed', async () => {
  const ctx = setup();
  const info = await authorize(ctx);
  const redirect = new URL(info.approved.body.redirectTo);
  assert.equal(redirect.origin + redirect.pathname, REDIRECT);
  assert.equal(redirect.searchParams.get('state'), 'st1');
  const code = redirect.searchParams.get('code');
  const exchange = { grant_type: 'authorization_code', code, client_id: info.params.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER };
  const tokens = await ctx.call('POST', '/oauth/token', { body: exchange });
  assert.equal(tokens.status, 200);
  assert.equal(tokens.body.token_type, 'Bearer');
  assert.equal(tokens.body.expires_in, ACCESS_TTL_MS / 1000);
  // 明文不落地：store 的 key 是雜湊
  assert.equal(ctx.store.tokens.has(tokens.body.access_token), false);
  assert.equal(ctx.store.tokens.has(sha256Hex(tokens.body.access_token)), true);
  // 授權碼只能用一次
  assert.equal((await ctx.call('POST', '/oauth/token', { body: exchange })).body.error, 'invalid_grant');

  const auth = { authorization: `Bearer ${tokens.body.access_token}` };
  const ok = await ctx.call('POST', '/', { headers: auth, body: { jsonrpc: '2.0', id: 7, method: 'tools/list' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { jsonrpc: '2.0', id: 7, result: { ok: true } });
  const notification = await ctx.call('POST', '/mcp', { headers: auth, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(notification.status, 202);
  assert.equal(notification.body, null);
  assert.equal(ctx.state.forwarded.length, 2);
  assert.equal([...ctx.store.grants.values()][0].lastUsedAt, ctx.state.now);
  // refresh token 不能當 access token 用
  assert.equal((await ctx.call('POST', '/', { headers: { authorization: `Bearer ${tokens.body.refresh_token}` }, body: {} })).status, 401);
  assert.equal((await ctx.call('GET', '/', { headers: auth })).status, 405);
  assert.equal((await ctx.call('POST', '/', { headers: { ...auth, origin: 'https://evil.example' }, body: {} })).status, 403);
});

test('code exchange fails on wrong verifier, wrong client, or expiry', async () => {
  for (const mutate of [
    (b) => { b.code_verifier = 'w'.repeat(64); },
    (b) => { b.client_id = 'someone-else'; },
    (b) => { b.redirect_uri = 'https://claude.com/api/mcp/auth_callback'; },
    (_b, ctx) => { ctx.state.now += CODE_TTL_MS + 1; },
  ]) {
    const ctx = setup();
    const info = await authorize(ctx);
    const body = { grant_type: 'authorization_code', code: new URL(info.approved.body.redirectTo).searchParams.get('code'), client_id: info.params.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER };
    mutate(body, ctx);
    const res = await ctx.call('POST', '/oauth/token', { body });
    assert.equal(res.body.error, 'invalid_grant');
    assert.equal(ctx.store.tokens.size, 0);
  }
});

test('access token expires; refresh rotates and the old refresh token dies', async () => {
  const ctx = setup();
  const { tokens, params } = await fullLogin(ctx);
  ctx.state.now += ACCESS_TTL_MS + 1;
  assert.equal((await ctx.call('POST', '/', { headers: { authorization: `Bearer ${tokens.body.access_token}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401);
  const refreshed = await ctx.call('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: params.client_id } });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.refresh_token, tokens.body.refresh_token);
  assert.equal((await ctx.call('POST', '/', { headers: { authorization: `Bearer ${refreshed.body.access_token}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 200);
  const replay = await ctx.call('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token } });
  assert.equal(replay.body.error, 'invalid_grant');
});

test('revoking a grant (in app or via RFC 7009) cuts access immediately; role loss does too', async () => {
  const ctx = setup();
  const { tokens } = await fullLogin(ctx);
  const auth = { authorization: `Bearer ${tokens.body.access_token}` };
  const list = await ctx.call('POST', '/oauth/grants', { body: { idToken: 'id:owner1' }, headers: { origin: 'https://hub.web.app' } });
  assert.equal(list.body.grants.length, 1);
  assert.equal(list.body.grants[0].clientName, 'Claude');
  assert.equal(list.headers['Access-Control-Allow-Origin'], 'https://hub.web.app');
  assert.equal((await ctx.call('POST', '/oauth/grants', { body: { idToken: 'id:member1' } })).status, 403);
  // 別人不能撤銷（也看不到）
  await ctx.call('POST', '/oauth/grants/revoke', { body: { idToken: 'id:member1', grantId: list.body.grants[0].grantId } });
  assert.equal(ctx.store.grants.size, 1);
  await ctx.call('POST', '/oauth/grants/revoke', { body: { idToken: 'id:owner1', grantId: list.body.grants[0].grantId } });
  assert.equal(ctx.store.grants.size, 0);
  assert.equal(ctx.store.tokens.size, 0);
  assert.equal((await ctx.call('POST', '/', { headers: auth, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401);
  assert.equal((await ctx.call('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token } })).body.error, 'invalid_grant');

  const second = setup();
  const login = await fullLogin(second);
  second.state.roles.owner1 = 'member';
  assert.equal((await second.call('POST', '/', { headers: { authorization: `Bearer ${login.tokens.body.access_token}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401);
  const third = setup();
  const login3 = await fullLogin(third);
  assert.equal((await third.call('POST', '/oauth/revoke', { body: { token: login3.tokens.body.refresh_token } })).status, 200);
  assert.equal(third.store.grants.size, 0);
});

test('backend failure surfaces as 502, not as an auth error; CORS is scoped', async () => {
  const ctx = setup({ forward: async () => { throw new Error('down'); } });
  const { tokens } = await fullLogin(ctx);
  const res = await ctx.call('POST', '/', { headers: { authorization: `Bearer ${tokens.body.access_token}` }, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } });
  assert.equal(res.status, 502);
  assert.equal(res.body.id, 3);
  const foreign = await ctx.call('OPTIONS', '/oauth/approve', { headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.headers['Access-Control-Allow-Origin'], undefined);
  const pub = await ctx.call('OPTIONS', '/oauth/token', { headers: { origin: 'https://claude.ai' } });
  assert.equal(pub.headers['Access-Control-Allow-Origin'], '*');
  assert.equal((await ctx.call('GET', '/nope')).status, 404);
});

test('client info endpoint validates before the consent screen is shown', async () => {
  const ctx = setup();
  const { params } = await authorize(ctx);
  const ok = await ctx.call('GET', '/oauth/client', { query: params });
  assert.deepEqual(ok.body, { clientName: 'Claude', redirectHost: 'claude.ai' });
  assert.equal((await ctx.call('GET', '/oauth/client', { query: { ...params, client_id: 'x' } })).body.error, 'invalid_client');
});

test('write access: read-only by default, opt-in at consent, forwarded with uid', async () => {
  const ro = setup();
  const login = await fullLogin(ro);
  assert.equal(login.tokens.body.scope, 'hub.read');
  await ro.call('POST', '/', { headers: { authorization: `Bearer ${login.tokens.body.access_token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.deepEqual(ro.state.forwardCtx[0], { uid: 'owner1', write: false, client: 'Claude' });
  // 只有明確的 true 才算；字串 / 1 不算
  for (const allowWrite of ['true', 1, 'yes']) {
    const ctx = setup();
    assert.equal((await fullLogin(ctx, { allowWrite })).tokens.body.scope, 'hub.read');
    assert.equal([...ctx.store.grants.values()][0].write, false);
  }

  const rw = setup();
  const writer = await fullLogin(rw, { allowWrite: true });
  assert.equal(writer.tokens.body.scope, 'hub.read hub.write');
  await rw.call('POST', '/', { headers: { authorization: `Bearer ${writer.tokens.body.access_token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.deepEqual(rw.state.forwardCtx[0], { uid: 'owner1', write: true, client: 'Claude' });
  // client 自己要求 hub.write 沒有用：owner 沒勾就是唯讀
  const asked = setup();
  assert.equal((await fullLogin(asked, { scope: 'hub.read hub.write' })).tokens.body.scope, 'hub.read');
  const meta = await rw.call('GET', '/.well-known/oauth-authorization-server');
  assert.deepEqual(meta.body.scopes_supported, ['hub.read', 'hub.write']);
});

test('write access can be toggled per grant by the owner and applies on the next call', async () => {
  const ctx = setup();
  const { tokens, params } = await fullLogin(ctx);
  const auth = { authorization: `Bearer ${tokens.body.access_token}` };
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const list = await ctx.call('POST', '/oauth/grants', { body: { idToken: 'id:owner1' } });
  const grantId = list.body.grants[0].grantId;
  assert.equal(list.body.grants[0].write, false);

  assert.equal((await ctx.call('POST', '/oauth/grants/update', { body: { idToken: 'id:member1', grantId, write: true } })).status, 403);
  assert.equal((await ctx.call('POST', '/oauth/grants/update', { body: { grantId, write: true } })).status, 401);
  assert.equal((await ctx.call('POST', '/oauth/grants/update', { body: { idToken: 'id:owner1', grantId, write: 'true' } })).status, 400);
  assert.equal((await ctx.call('POST', '/oauth/grants/update', { body: { idToken: 'id:owner1', grantId: 'nope', write: true } })).status, 404);
  await ctx.call('POST', '/', { headers: auth, body: ping });
  assert.equal(ctx.state.forwardCtx.at(-1).write, false);

  const on = await ctx.call('POST', '/oauth/grants/update', { body: { idToken: 'id:owner1', grantId, write: true }, headers: { origin: 'https://hub.web.app' } });
  assert.deepEqual(on.body, { ok: true, write: true });
  assert.equal(on.headers['Access-Control-Allow-Origin'], 'https://hub.web.app');
  await ctx.call('POST', '/', { headers: auth, body: ping });
  assert.equal(ctx.state.forwardCtx.at(-1).write, true);
  assert.equal((await ctx.call('POST', '/oauth/grants', { body: { idToken: 'id:owner1' } })).body.grants[0].write, true);
  // refresh 之後的 scope 跟著 grant 目前的設定
  const refreshed = await ctx.call('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: params.client_id } });
  assert.equal(refreshed.body.scope, 'hub.read hub.write');

  await ctx.call('POST', '/oauth/grants/update', { body: { idToken: 'id:owner1', grantId, write: false } });
  await ctx.call('POST', '/', { headers: { authorization: `Bearer ${refreshed.body.access_token}` }, body: ping });
  assert.equal(ctx.state.forwardCtx.at(-1).write, false);
  // 別人的 grant 動不了
  ctx.state.roles.owner2 = 'owner';
  assert.equal((await ctx.call('POST', '/oauth/grants/update', { body: { idToken: 'id:owner2', grantId, write: true } })).status, 404);
  assert.equal([...ctx.store.grants.values()][0].write, false);
});
