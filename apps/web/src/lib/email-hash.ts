/**
 * 白名單 email 的雜湊（SHA-256 hex，小寫 + trim 後計算）。
 *
 * 為什麼要雜湊：登入前要判斷「這個 Google 帳號能不能用」，所以 `config/allowedEmailHashes` 必須讓
 * 任何已登入者讀；若直接存明文 email，任何 Google 帳號都能列出 owner、伴侶與所有受邀者的 email
 *（2026-11 稽核 S3）。存雜湊後前端只能驗「自己」在不在名單，列不出別人。
 *
 * 明文名單 `config/allowedEmails` / `config/guestEmails` 仍保留給 admin 後台與 Apps Script，
 * 兩邊寫入時都要同步雜湊 doc（Apps Script：`syncWhitelistHashes_`；前端：`syncWhitelistHashes`）。
 * Apps Script 端的 `emailHash_` 用同樣的正規化 + SHA-256，兩邊結果必須一致。
 */

export const WHITELIST_HASH_DOCS = {
  allowedEmails: 'allowedEmailHashes',
  guestEmails: 'guestEmailHashes',
} as const;

export type WhitelistDocId = keyof typeof WHITELIST_HASH_DOCS;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function emailHash(email: string): Promise<string> {
  const normalized = normalizeEmail(email);
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function emailHashes(emails: readonly string[]): Promise<string[]> {
  const unique = Array.from(new Set(emails.map(normalizeEmail).filter(Boolean)));
  return Promise.all(unique.map(emailHash));
}
