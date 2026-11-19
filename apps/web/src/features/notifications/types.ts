/**
 * App 內通知中心（2026-11 稽核 F1）。
 *
 * Doc 由 Apps Script `sendNotification_` 寫入（apps-script/src/InAppNotifications.gs），
 * 前端只讀、標已讀、刪除。Rules：`notifications/{id}` owner-only。
 *
 *   notifications/{id}
 *     userId      owner uid
 *     key         通知 key（同 NotificationKey，但 GAS 可能有前端還沒列的 key → string）
 *     title / body
 *     createdAt   Timestamp
 *     readAt      Timestamp | null
 *     link        站內路徑 | null
 *     severity    'info' | 'warn' | 'error'
 *     telegramOk  Telegram 是否送達
 */
import {
  Timestamp, type DocumentData, type FirestoreDataConverter, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

export type NotificationSeverity = 'info' | 'warn' | 'error';

/** 命名避開 DOM 的 `Notification` */
export interface AppNotification {
  id: string;
  userId: string;
  key: string;
  title: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
  link: string | null;
  severity: NotificationSeverity;
  telegramOk: boolean | null;
}

function toSeverity(value: unknown): NotificationSeverity {
  return value === 'warn' || value === 'error' ? value : 'info';
}

export const notificationConverter: FirestoreDataConverter<AppNotification> = {
  toFirestore: (n) => {
    const { id: _id, ...rest } = n as AppNotification;
    void _id;
    return {
      ...rest,
      createdAt: Timestamp.fromDate(rest.createdAt),
      readAt: rest.readAt ? Timestamp.fromDate(rest.readAt) : null,
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): AppNotification => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: typeof d.userId === 'string' ? d.userId : '',
      key: typeof d.key === 'string' ? d.key : '',
      title: typeof d.title === 'string' && d.title ? d.title : '通知',
      body: typeof d.body === 'string' ? d.body : '',
      createdAt: tsToDate(d.createdAt) ?? new Date(0),
      readAt: tsToDate(d.readAt),
      link: typeof d.link === 'string' && d.link ? d.link : null,
      severity: toSeverity(d.severity),
      telegramOk: typeof d.telegramOk === 'boolean' ? d.telegramOk : null,
    };
  },
};
