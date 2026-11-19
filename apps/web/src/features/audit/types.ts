/**
 * Audit log — 重大寫入紀錄稽核
 *
 * doc 結構：
 *   audit_logs/{auto-id}
 *     userId
 *     timestamp
 *     scope        e.g. 'transaction' | 'category' | 'trip' | 'liability' …
 *     action       'create' | 'update' | 'delete' | 'restore' | 'archive'
 *     entityId
 *     summary?     人類可讀文字（例如「刪除 餐飲 -150 早餐」）
 *     before?      JSON 變更前
 *     after?       JSON 變更後
 */

import {
  Timestamp, type DocumentData, type FirestoreDataConverter, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

export type AuditAction = 'create' | 'update' | 'delete' | 'restore' | 'archive' | 'unarchive';

export interface AuditLog {
  id: string;
  userId: string;
  timestamp: Date;
  scope: string;
  action: AuditAction;
  entityId: string;
  summary?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export const auditLogConverter: FirestoreDataConverter<AuditLog> = {
  toFirestore: (l) => {
    const { id: _id, ...rest } = l as AuditLog;
    void _id;
    const out: Record<string, unknown> = {
      ...rest,
      timestamp: Timestamp.fromDate(rest.timestamp),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): AuditLog => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      timestamp: tsToDate(d.timestamp) ?? new Date(),
      scope: d.scope ?? 'unknown',
      action: (d.action as AuditAction) ?? 'update',
      entityId: d.entityId ?? '',
      summary: d.summary ?? null,
      before: d.before ?? null,
      after: d.after ?? null,
    };
  },
};
