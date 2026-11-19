import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { flightWatchConverter, parseFlightPriceEstimate, type FlightPriceSnapshot, type FlightWatch } from './types';

export const flightWatchesCol = () =>
  collection(db, 'flight_watches').withConverter(flightWatchConverter);

/**
 * 我看得到的訂閱 = 自己建立的 + 共同帳本成員分享給我的（`sharedWith` array-contains 我）。
 * 分兩個 query 是因為 rules 只能證明這兩種條件；分享那一個不 orderBy，避免多一組 composite index，合併後在前端排序。
 */
export async function listFlightWatches(userId: string): Promise<FlightWatch[]> {
  const [own, shared] = await Promise.all([
    getDocs(query(flightWatchesCol(), where('userId', '==', userId), orderBy('createdAt', 'desc'), limit(50))),
    getDocs(query(flightWatchesCol(), where('sharedWith', 'array-contains', userId), limit(50))),
  ]);
  const byId = new Map<string, FlightWatch>();
  for (const item of [...own.docs, ...shared.docs]) byId.set(item.id, item.data());
  return [...byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** 只改分享名單（不動 updatedAt，避免 Claude 排程同步狀態被誤判為變更） */
export async function setFlightWatchSharing(entries: { id: string; sharedWith: string[] }[]): Promise<void> {
  if (entries.length === 0) return;
  const batch = writeBatch(db);
  for (const entry of entries) batch.update(doc(db, 'flight_watches', entry.id), { sharedWith: entry.sharedWith });
  await batch.commit();
}

export async function createFlightWatch(watch: Omit<FlightWatch, 'id'>): Promise<string> {
  const ref = await addDoc(flightWatchesCol(), watch as FlightWatch);
  return ref.id;
}

export async function updateFlightWatch(id: string, patch: Partial<FlightWatch>): Promise<void> {
  await updateDoc(doc(db, 'flight_watches', id), { ...patch, updatedAt: new Date() });
}

export async function deleteFlightWatch(id: string): Promise<void> {
  await deleteDoc(doc(db, 'flight_watches', id));
}

export async function listFlightPriceSnapshots(watchId: string): Promise<FlightPriceSnapshot[]> {
  const snapshot = await getDocs(
    query(collection(db, 'flight_watches', watchId, 'snapshots'), orderBy('checkedAt', 'desc'), limit(36)),
  );
  return snapshot.docs.flatMap((item) => {
    const estimate = parseFlightPriceEstimate(item.data());
    return estimate ? [{ ...estimate, id: item.id }] : [];
  }).reverse();
}

/** 複製 Claude 排程提示詞後，記下每條航線當下的 criteriaKey，之後條件改了就能提醒重新複製 */
export async function markClaudePromptKeys(entries: Array<{ id: string; criteriaKey: string }>): Promise<void> {
  if (entries.length === 0) return;
  const batch = writeBatch(db);
  // 不動 updatedAt：這只是同步標記，不是搜尋條件變更
  entries.forEach(({ id, criteriaKey }) => {
    batch.update(doc(db, 'flight_watches', id), { claudePromptKey: criteriaKey });
  });
  await batch.commit();
}
