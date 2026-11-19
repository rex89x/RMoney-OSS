/**
 * 閘道的 Firestore 儲存層（Admin SDK，繞過 Security Rules）。
 *
 * 這些 collection 在 firestore.rules 裡沒有對應規則，落在「預設 deny」，前端 SDK 完全讀寫不到：
 *   mcp_oauth_clients/{clientId}   動態註冊的 OAuth client
 *   mcp_oauth_codes/{sha256}       授權碼（5 分鐘、單次使用）
 *   mcp_oauth_tokens/{sha256}      access / refresh token（只存雜湊）
 *   mcp_oauth_grants/{grantId}     使用者核准過的授權（App 內可列出、撤銷、切換是否允許寫入）
 *   mcp_gateway/secret             閘道 → Apps Script 的共用密鑰（Apps Script 以 script owner 身分讀取）
 *   mcp_gateway/counters           每日註冊次數
 */
import { randomBytes } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';

export function createFirestoreStore(db) {
  const clients = db.collection('mcp_oauth_clients');
  const codes = db.collection('mcp_oauth_codes');
  const tokens = db.collection('mcp_oauth_tokens');
  const grants = db.collection('mcp_oauth_grants');
  const gateway = db.collection('mcp_gateway');
  let secretCache = null;

  async function take(ref) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      tx.delete(ref);
      return snap.data();
    });
  }

  return {
    async getClient(id) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
      const snap = await clients.doc(id).get();
      return snap.exists ? snap.data() : null;
    },
    putClient: (client) => clients.doc(client.clientId).set(client),
    putCode: (hash, data) => codes.doc(hash).set(data),
    takeCode: (hash) => take(codes.doc(hash)),
    putToken: (hash, data) => tokens.doc(hash).set(data),
    async getToken(hash) {
      const snap = await tokens.doc(hash).get();
      return snap.exists ? snap.data() : null;
    },
    takeToken: (hash) => take(tokens.doc(hash)),
    putGrant: (grant) => grants.doc(grant.grantId).set(grant),
    async getGrant(id) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
      const snap = await grants.doc(id).get();
      return snap.exists ? snap.data() : null;
    },
    async listGrants(uid) {
      const snap = await grants.where('uid', '==', uid).limit(50).get();
      return snap.docs.map((d) => d.data()).sort((a, b) => b.createdAt - a.createdAt);
    },
    /** 撤銷：刪掉 grant 與它名下所有 token（單次 batch，CLAUDE.md §5.4） */
    async deleteGrant(id) {
      const owned = await tokens.where('grantId', '==', id).limit(400).get();
      const batch = db.batch();
      owned.docs.forEach((d) => batch.delete(d.ref));
      batch.delete(grants.doc(id));
      await batch.commit();
    },
    touchGrant: (id, at) => grants.doc(id).update({ lastUsedAt: at }),
    /** 目前只用來切換 write（允許寫入） */
    updateGrant: (id, patch) => grants.doc(id).update(patch),
    async incrementCounter(key) {
      const ref = gateway.doc('counters');
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const next = ((snap.exists && snap.data()[key]) || 0) + 1;
        // 只留當天的計數，doc 不會無限長大
        tx.set(ref, { [key]: next });
        return next;
      });
    },
    /** 清掉過期的授權碼與 token（每次簽發 token 時順手做，不需要排程） */
    async purgeExpired(nowMs) {
      const [oldCodes, oldTokens] = await Promise.all([
        codes.where('expiresAt', '<', nowMs).limit(100).get(),
        tokens.where('expiresAt', '<', nowMs).limit(200).get(),
      ]);
      if (oldCodes.empty && oldTokens.empty) return 0;
      const batch = db.batch();
      [...oldCodes.docs, ...oldTokens.docs].forEach((d) => batch.delete(d.ref));
      await batch.commit();
      return oldCodes.size + oldTokens.size;
    },
    /** 閘道密鑰：第一次使用時產生並存進 Firestore；Apps Script 讀同一份來驗證轉送的請求 */
    async gatewaySecret() {
      if (secretCache) return secretCache;
      const ref = gateway.doc('secret');
      secretCache = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.data().value) return snap.data().value;
        const value = 'rmgw_' + randomBytes(32).toString('base64url');
        tx.set(ref, { value, createdAt: FieldValue.serverTimestamp() });
        return value;
      });
      return secretCache;
    },
  };
}
