import {
  addDoc, collection, getDocs, limit as qLimit, orderBy, query, Timestamp, where,
} from 'firebase/firestore';
import { auth, db } from './firebase';

export interface ErrorLogEntry {
  scope: string;
  message: string;
  stack?: string;
  componentStack?: string;
}

export interface ErrorLogRecord extends ErrorLogEntry {
  id: string;
  userId?: string;
  userAgent?: string;
  url?: string;
  createdAt: Date;
}

/**
 * Log runtime error to Firestore error_logs (best-effort; never throws).
 */
export async function logError(entry: ErrorLogEntry): Promise<void> {
  try {
    const uid = auth.currentUser?.uid ?? null;
    await addDoc(collection(db, 'error_logs'), {
      ...entry,
      userId: uid,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      // 只留 origin + path：query 可能帶 ?join=CODE 邀請碼（2026-11 稽核 S15）
      url: typeof window !== 'undefined' ? window.location.origin + window.location.pathname : null,
      createdAt: Timestamp.fromDate(new Date()),
    });
  } catch (err) {
    // 寫 log 本身不能影響 app；只在 console 記
    console.warn('[logError] failed to persist', err);
  }
}

/**
 * 近 N 天的錯誤紀錄（依 createdAt desc）。預設 3 天，限 500 筆夠分頁。
 */
export async function listRecentErrors(days = 3, max = 500): Promise<ErrorLogRecord[]> {
  try {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const snap = await getDocs(
      query(
        collection(db, 'error_logs'),
        where('createdAt', '>=', Timestamp.fromDate(since)),
        orderBy('createdAt', 'desc'),
        qLimit(max),
      ),
    );
    return snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      const ts = data.createdAt as { toDate?: () => Date } | undefined;
      return {
        id: d.id,
        scope: String(data.scope ?? 'unknown'),
        message: String(data.message ?? ''),
        stack: data.stack as string | undefined,
        componentStack: data.componentStack as string | undefined,
        userId: data.userId as string | undefined,
        userAgent: data.userAgent as string | undefined,
        url: data.url as string | undefined,
        createdAt: ts?.toDate?.() ?? new Date(),
      };
    });
  } catch (err) {
    console.warn('[listRecentErrors]', err);
    return [];
  }
}
