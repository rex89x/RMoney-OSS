import { callAppsScript } from '@/lib/apps-script';
import { env } from '@/lib/env';
import { auth } from '@/lib/firebase';
import { McpGrantSchema, McpStatusSchema, McpTokenSchema, OAuthClientInfoSchema } from './schema';
import type { McpGrant, McpIssuedToken, McpStatus, OAuthAuthorizeParams, OAuthClientInfo } from './types';

const TOKEN_PREFIX = 'rmcp_';
/** 與 functions/index.js 的 REGION 一致 */
const GATEWAY_REGION = 'asia-east1';

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// -------- stdio bridge token（Claude Code / Desktop，走 Apps Script） --------

/** 32 bytes CSPRNG → `rmcp_` + base64url（43 字元） */
export function generateMcpToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return McpTokenSchema.parse(TOKEN_PREFIX + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

export function buildMcpConnection(token: string, appsScriptUrl: string = env.appsScriptUrl): McpIssuedToken {
  return {
    token,
    claudeCodeCommand:
      `claude mcp add personal-hub -e HUB_MCP_URL=${appsScriptUrl} -e HUB_MCP_TOKEN=${token} -- node scripts/hub-mcp.mjs`,
  };
}

export async function getMcpStatus(): Promise<McpStatus> {
  const data = await callAppsScript('getMcpStatus');
  return McpStatusSchema.parse({
    configured: data.configured === true,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
    lastUsedAt: typeof data.lastUsedAt === 'string' ? data.lastUsedAt : null,
    toolCount: Number(data.toolCount) || 0,
    dailyLimit: Number(data.dailyLimit) || 0,
    writeEnabled: data.writeEnabled === true,
    writeToolCount: Number(data.writeToolCount) || 0,
    dailyWriteLimit: Number(data.dailyWriteLimit) || 0,
  });
}

/** bridge token 的寫入開關（Apps Script Script Property；換 token 會回到唯讀） */
export async function setMcpWriteAccess(enabled: boolean): Promise<void> {
  await callAppsScript('setMcpWriteAccess', undefined, { enabled });
}

/** 產生新 token（舊的立即失效）。後端只收 SHA-256，明文只回給畫面顯示一次。 */
export async function rotateMcpToken(): Promise<McpIssuedToken> {
  if (!env.appsScriptUrl) throw new Error('VITE_APPS_SCRIPT_URL 未設定');
  const token = generateMcpToken();
  await callAppsScript('setMcpToken', undefined, { tokenHash: await sha256Hex(token) });
  return buildMcpConnection(token);
}

export async function revokeMcpToken(): Promise<void> {
  await callAppsScript('revokeMcpToken');
}

// -------- MCP 閘道（Claude.ai 網頁版 / 手機版，OAuth；functions/） --------

/** Claude.ai「新增自訂 connector」要填的網址。不含任何密鑰，可以放心顯示。 */
export function mcpGatewayUrl(projectId: string = env.firebase.projectId): string {
  return `https://${GATEWAY_REGION}-${projectId}.cloudfunctions.net/mcp`;
}

async function requireIdToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error('尚未登入');
  return user.getIdToken();
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(`${mcpGatewayUrl()}${path}`, init);
  } catch (err) {
    console.error('[mcpGateway]', path, err);
    throw new Error('連不上 MCP 閘道（可能尚未部署）');
  }
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const description = typeof data.error_description === 'string' ? data.error_description : null;
    throw new Error(description ?? `MCP 閘道回應 ${resp.status}`);
  }
  return data;
}

function gatewayPost(path: string, body: Record<string, unknown>) {
  // text/plain 會被閘道當成未解析的字串；這幾個端點只有 Personal Hub 網域能跨域呼叫，用 JSON + preflight 即可
  return gatewayFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function listMcpGrants(): Promise<McpGrant[]> {
  const data = await gatewayPost('/oauth/grants', { idToken: await requireIdToken() });
  return McpGrantSchema.array().parse(data.grants ?? []);
}

export async function revokeMcpGrant(grantId: string): Promise<void> {
  await gatewayPost('/oauth/grants/revoke', { idToken: await requireIdToken(), grantId });
}

/** 切換某個已授權 client 能不能寫入；閘道每次呼叫都重讀，下一次工具呼叫就生效 */
export async function setMcpGrantWrite(input: { grantId: string; write: boolean }): Promise<void> {
  await gatewayPost('/oauth/grants/update', { idToken: await requireIdToken(), grantId: input.grantId, write: input.write });
}

/** 顯示同意畫面前先請閘道驗證 client_id / redirect_uri / PKCE，並取得要顯示的名稱 */
export async function fetchOAuthClient(params: OAuthAuthorizeParams): Promise<OAuthClientInfo> {
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return OAuthClientInfoSchema.parse(await gatewayFetch(`/oauth/client?${query.toString()}`));
}

/** 核准：閘道驗證 ID token（owner / admin）後簽發一次性授權碼，回傳要導回 client 的網址 */
export async function approveOAuth(input: { params: OAuthAuthorizeParams; allowWrite: boolean }): Promise<string> {
  const data = await gatewayPost('/oauth/approve', { ...input.params, allowWrite: input.allowWrite, idToken: await requireIdToken() });
  if (typeof data.redirectTo !== 'string') throw new Error('MCP 閘道沒有回傳導向網址');
  return data.redirectTo;
}

/** 拒絕：依 OAuth 規範帶 error=access_denied 導回 client（只在 fetchOAuthClient 驗證過 redirect_uri 後呼叫） */
export function buildDenyRedirect(params: OAuthAuthorizeParams): string {
  const url = new URL(params.redirect_uri);
  url.searchParams.set('error', 'access_denied');
  if (params.state) url.searchParams.set('state', params.state);
  return url.toString();
}
