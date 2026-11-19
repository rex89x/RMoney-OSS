/**
 * Personal Hub MCP 閘道（Cloud Functions 2nd gen，HTTPS）。
 *
 *   https://<region>-<project>.cloudfunctions.net/mcp          ← Claude.ai connector 填這個
 *   …/mcp/oauth/{register,token,revoke}                        ← OAuth 端點
 *   …/mcp/oauth/{client,approve,grants,grants/revoke,grants/update} ← Personal Hub SPA 授權頁 / 管理用
 *
 * 邏輯在 lib/gateway.js；這裡只接 Firebase（Auth 驗 ID token、Firestore 存授權）與 Apps Script。
 * 設定：functions/.env 的 APPS_SCRIPT_URL（CI 由 secret 寫入，見 .github/workflows/deploy-functions.yml）。
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { createGateway } from './lib/gateway.js';
import { createFirestoreStore } from './lib/firestore-store.js';

export const REGION = 'asia-east1';

initializeApp();
const db = getFirestore();
const store = createFirestoreStore(db);
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';

/** ctx = { uid, write, client }：Apps Script 依此決定要不要提供寫入工具、寫入記在誰名下 */
async function forward(rpc, ctx = {}) {
  const base = process.env.APPS_SCRIPT_URL;
  if (!base) throw new Error('APPS_SCRIPT_URL is not configured');
  const url = new URL(base);
  url.searchParams.set('action', 'mcp');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ gatewaySecret: await store.gatewaySecret(), rpc, uid: ctx.uid ?? '', write: ctx.write === true, client: ctx.client ?? '' }),
    redirect: 'follow',
    signal: AbortSignal.timeout(110000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Apps Script HTTP ${resp.status}`);
  if (!text.trim()) return null;
  const parsed = JSON.parse(text);
  // Apps Script 不認得閘道密鑰（尚未部署新版 / 密鑰被重置）→ 當成後端錯誤，不要把 unauthorized 傳回給 client
  if (!Array.isArray(parsed) && parsed?.error?.code === -32001) throw new Error('Apps Script rejected the gateway secret');
  return parsed;
}

const gateway = createGateway({
  config: {
    issuer: `https://${projectId}.web.app`,
    resourceUrl: `https://${REGION}-${projectId}.cloudfunctions.net/mcp`,
    webOrigins: [`https://${projectId}.web.app`, `https://${projectId}.firebaseapp.com`],
  },
  store,
  verifyIdToken: (idToken) => getAuth().verifyIdToken(idToken, true),
  getUserRole: async (uid) => {
    const snap = await db.collection('users').doc(uid).get();
    return snap.exists ? snap.data().role ?? null : null;
  },
  forward,
});

export const mcp = onRequest(
  { region: REGION, invoker: 'public', timeoutSeconds: 120, memory: '256MiB', maxInstances: 3, concurrency: 20 },
  async (req, res) => {
    try {
      const result = await gateway.handle({
        method: req.method,
        path: req.path,
        headers: req.headers,
        query: req.query,
        // express 已依 Content-Type 解析 JSON 與 x-www-form-urlencoded（token 端點）
        body: req.body,
      });
      if (req.path.replace(/\/+$/, '') === '/oauth/token' && result.status === 200) {
        store.purgeExpired(Date.now()).catch((err) => console.error('[purgeExpired]', err));
      }
      res.status(result.status).set(result.headers);
      if (result.body === null) res.end();
      else res.send(JSON.stringify(result.body));
    } catch (err) {
      console.error('[mcp gateway]', err);
      res.status(500).json({ error: 'server_error' });
    }
  },
);
