import {
  collection, deleteDoc, doc, getDocs, limit, orderBy, query, Timestamp, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { notificationConverter, type AppNotification } from './types';
import { NOTIFICATIONS_LIMIT } from './utils';

export const notificationsCol = () =>
  collection(db, 'notifications').withConverter(notificationConverter);

/** 需要 composite index：notifications userId ASC + createdAt DESC（firestore.indexes.json） */
export async function listNotifications(uid: string, max = NOTIFICATIONS_LIMIT): Promise<AppNotification[]> {
  const snap = await getDocs(query(
    notificationsCol(),
    where('userId', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(max),
  ));
  return snap.docs.map((d) => d.data());
}

export async function markNotificationRead(id: string): Promise<void> {
  await updateDoc(doc(db, 'notifications', id), { readAt: Timestamp.fromDate(new Date()) });
}

/** 多筆一律 writeBatch（CLAUDE.md §5.4）；列表最多 50 筆，遠低於 batch 500 上限 */
export async function markNotificationsRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const batch = writeBatch(db);
  const readAt = Timestamp.fromDate(new Date());
  for (const id of ids) batch.update(doc(db, 'notifications', id), { readAt });
  await batch.commit();
}

/** 通知不是關鍵資料（GAS 60 天後也會清掉），直接硬刪 */
export async function deleteNotification(id: string): Promise<void> {
  await deleteDoc(doc(db, 'notifications', id));
}
