import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { WHITELIST_HASH_DOCS, emailHashes, type WhitelistDocId } from '@/lib/email-hash';

/**
 * 把 config/{allowedEmails|guestEmails}.emails 的雜湊寫到 config/{...Hashes}.hashes。
 * 只有 admin 有 config 寫入權限；WhitelistPanel 每次改名單後呼叫，
 * useInitAuth 在 admin 登入後也會 best-effort 跑一次（部署後自動補齊、修正漂移）。
 */
export async function writeWhitelistHashes(docId: WhitelistDocId, emails: readonly string[]): Promise<void> {
  const hashes = await emailHashes(emails);
  hashes.sort();
  await setDoc(doc(db, 'config', WHITELIST_HASH_DOCS[docId]), {
    hashes,
    count: hashes.length,
    syncedAt: new Date(),
    syncedBy: 'web',
  }, { merge: true });
}

/** 讀明文名單 → 重算雜湊 → 與現有雜湊 doc 不同才寫。回傳有沒有寫入。 */
export async function syncWhitelistHashes(docId: WhitelistDocId): Promise<boolean> {
  const plainSnap = await getDoc(doc(db, 'config', docId));
  const plain = plainSnap.data() as { emails?: unknown } | undefined;
  const emails = Array.isArray(plain?.emails) ? plain.emails.map((e) => String(e)) : [];
  const expected = await emailHashes(emails);
  expected.sort();

  const hashSnap = await getDoc(doc(db, 'config', WHITELIST_HASH_DOCS[docId]));
  const current = hashSnap.data() as { hashes?: unknown } | undefined;
  const existing = Array.isArray(current?.hashes) ? current.hashes.map((h) => String(h)).sort() : null;
  if (existing && existing.length === expected.length && existing.every((h, i) => h === expected[i])) {
    return false;
  }
  await writeWhitelistHashes(docId, emails);
  return true;
}

export async function syncAllWhitelistHashes(): Promise<void> {
  await syncWhitelistHashes('allowedEmails');
  await syncWhitelistHashes('guestEmails');
}
