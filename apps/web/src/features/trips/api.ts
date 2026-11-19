import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { getAppStorage } from '@/lib/firebase';
import { ChunkedBatch } from '@/features/itinerary/chunked-batch';
import {
  packingItemConverter, Trip, tripConverter, TripDocument, tripDocumentConverter,
  type PackingItem,
} from './types';
import type { PackingTemplateItem } from './packing-template';

export const tripsCol = () => collection(db, 'trips').withConverter(tripConverter);

export async function listTrips(userId: string): Promise<Trip[]> {
  // owner 的 + 被分享給 userId 的（Firestore 不支援 OR，跑兩個 query 後合併）
  const qOwn = query(tripsCol(), where('userId', '==', userId), orderBy('startDate', 'desc'));
  const qShared = query(tripsCol(), where('sharedWith', 'array-contains', userId), orderBy('startDate', 'desc'));
  const [ownSnap, sharedSnap] = await Promise.all([
    getDocs(qOwn),
    getDocs(qShared),
  ]);
  const seen = new Set<string>();
  const result: Trip[] = [];
  for (const snap of [ownSnap, sharedSnap]) {
    for (const d of snap.docs) {
      const t = d.data();
      if (!seen.has(t.id)) {
        seen.add(t.id);
        result.push(t);
      }
    }
  }
  return result.sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
}

export async function getTrip(id: string): Promise<Trip | null> {
  const snap = await getDoc(doc(db, 'trips', id).withConverter(tripConverter));
  return snap.exists() ? snap.data() : null;
}

export async function createTrip(t: Omit<Trip, 'id'>, id?: string): Promise<string> {
  if (id) {
    await setDoc(doc(db, 'trips', id).withConverter(tripConverter), { ...t, id } as Trip);
    return id;
  }
  const ref = await addDoc(tripsCol(), t as unknown as Trip);
  return ref.id;
}

export async function updateTrip(id: string, patch: Partial<Trip>): Promise<void> {
  const p: Record<string, unknown> = { ...patch };
  await updateDoc(doc(db, 'trips', id), p);
}

export async function deleteTrip(id: string): Promise<void> {
  await deleteDoc(doc(db, 'trips', id));
}

// -------- Trip documents --------

export const tripDocumentsCol = (tripId: string) =>
  collection(db, 'trips', tripId, 'documents').withConverter(tripDocumentConverter);

export async function listTripDocuments(tripId: string): Promise<TripDocument[]> {
  const snap = await getDocs(query(tripDocumentsCol(tripId), orderBy('createdAt', 'desc')));
  return snap.docs.map((d) => d.data());
}

export async function addTripDocument(
  tripId: string,
  data: Omit<TripDocument, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<string> {
  const now = new Date();
  const ref = await addDoc(tripDocumentsCol(tripId), {
    ...data,
    createdAt: now,
    updatedAt: now,
  } as TripDocument);
  return ref.id;
}

export async function updateTripDocument(
  tripId: string,
  docId: string,
  patch: Partial<TripDocument>,
): Promise<void> {
  const clean: Record<string, unknown> = { updatedAt: new Date(), ...patch };
  // Firestore 拒絕 undefined
  for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
  await setDoc(
    doc(db, 'trips', tripId, 'documents', docId),
    clean,
    { merge: true },
  );
}

export async function deleteTripDocument(
  tripId: string,
  docId: string,
  storagePath?: string | null,
): Promise<void> {
  if (storagePath) {
    try {
      const [{ ref: storageRef, deleteObject }, storage] = await Promise.all([import('firebase/storage'), getAppStorage()]);
      await deleteObject(storageRef(storage, storagePath));
    }
    catch (err) { console.warn('[deleteTripDocument storage]', err); }
  }
  await deleteDoc(doc(db, 'trips', tripId, 'documents', docId));
}

// -------- Packing list --------
// 子集合 trips/{tripId}/packing/{itemId}：旅伴可同時勾選，不會互相覆蓋整份清單。
// 寫入權限：trip owner 全部欄位；被分享的成員只能改 packed / assignee（見 firestore.rules）。

export const tripPackingCol = (tripId: string) =>
  collection(db, 'trips', tripId, 'packing').withConverter(packingItemConverter);

export type PackingItemInput = Pick<PackingItem, 'name' | 'category' | 'quantity' | 'assignee'>;

/** 共享成員也能用的欄位（rules 只放行這幾個 + updatedAt） */
export type PackingMemberPatch = Partial<Pick<PackingItem, 'packed' | 'assignee'>>;

export async function listPackingItems(tripId: string): Promise<PackingItem[]> {
  const snap = await getDocs(query(tripPackingCol(tripId), orderBy('order', 'asc')));
  return snap.docs.map((d) => d.data());
}

export async function addPackingItem(tripId: string, input: PackingItemInput, order: number): Promise<string> {
  const now = new Date();
  const ref = doc(tripPackingCol(tripId));
  await setDoc(ref, {
    id: ref.id,
    ...input,
    packed: false,
    order,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

/** 一次寫入多筆（從範本產生），用 batch 避免連打（CLAUDE.md §5.4） */
export async function addPackingItemsBulk(
  tripId: string,
  items: PackingTemplateItem[],
  startOrder: number,
): Promise<number> {
  if (items.length === 0) return 0;
  const now = new Date();
  const batch = new ChunkedBatch();
  items.forEach((t, i) => {
    const ref = doc(tripPackingCol(tripId));
    batch.add((b) => b.set(ref, {
      id: ref.id,
      name: t.name,
      category: t.category,
      quantity: t.quantity,
      assignee: null,
      packed: false,
      order: startOrder + i,
      createdAt: now,
      updatedAt: now,
    }));
  });
  await batch.commit();
  return items.length;
}

/** owner 編輯名稱 / 分類 / 數量 / 指派 */
export async function updatePackingItem(
  tripId: string,
  itemId: string,
  patch: Partial<PackingItemInput> & PackingMemberPatch,
): Promise<void> {
  const clean: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
  await updateDoc(doc(db, 'trips', tripId, 'packing', itemId), clean);
}

export async function deletePackingItem(tripId: string, itemId: string): Promise<void> {
  await deleteDoc(doc(db, 'trips', tripId, 'packing', itemId));
}

/** 全部取消勾選：只改 packed，共享成員也能做 */
export async function uncheckAllPackingItems(tripId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const now = new Date();
  const batch = new ChunkedBatch();
  for (const id of itemIds) {
    batch.add((b) => b.update(doc(db, 'trips', tripId, 'packing', id), { packed: false, updatedAt: now }));
  }
  await batch.commit();
}
