import { addDoc, collection, getDocs, orderBy, query, limit as qLimit } from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';
import { auditLogConverter, type AuditAction, type AuditLog } from './types';

export const auditLogsCol = () => collection(db, 'audit_logs').withConverter(auditLogConverter);

export interface AuditWriteInput {
  scope: string;
  action: AuditAction;
  entityId: string;
  summary?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** 寫一筆 audit log。失敗不 throw，避免影響主流程 */
export async function writeAudit(input: AuditWriteInput): Promise<void> {
  try {
    const uid = auth.currentUser?.uid ?? 'unknown';
    await addDoc(auditLogsCol(), {
      userId: uid,
      timestamp: new Date(),
      scope: input.scope,
      action: input.action,
      entityId: input.entityId,
      summary: input.summary ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
    } as unknown as AuditLog);
  } catch (err) {
    console.warn('[audit] writeAudit failed', err);
  }
}

export async function listAuditLogs(max = 100): Promise<AuditLog[]> {
  const snap = await getDocs(query(auditLogsCol(), orderBy('timestamp', 'desc'), qLimit(max)));
  return snap.docs.map((d) => d.data());
}
