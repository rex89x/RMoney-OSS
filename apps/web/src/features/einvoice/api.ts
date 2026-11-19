import { doc, getDoc, updateDoc, FieldPath } from 'firebase/firestore';
import { db } from '@/lib/firebase';

const IGNORE_TTL_MS = 180 * 86400000;

/** 使用者按「忽略」的發票號碼 → ISO 時間；存在 users/{uid}.preferences.einvoice.ignored，180 天後失效 */
export async function getIgnoredInvoices(uid: string): Promise<Record<string, string>> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return {};
  const raw = snap.data()?.preferences?.einvoice?.ignored;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  const cutoff = Date.now() - IGNORE_TTL_MS;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    const ts = Date.parse(v);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    out[k] = v;
  }
  return out;
}

export async function ignoreInvoices(uid: string, invoiceNumbers: string[]): Promise<void> {
  if (invoiceNumbers.length === 0) return;
  const now = new Date().toISOString();
  const ref = doc(db, 'users', uid);
  const [first, ...rest] = invoiceNumbers;
  if (!first) return;
  const args: unknown[] = [];
  for (const n of rest) args.push(new FieldPath('preferences', 'einvoice', 'ignored', n), now);
  await updateDoc(ref, new FieldPath('preferences', 'einvoice', 'ignored', first), now, ...args);
}
