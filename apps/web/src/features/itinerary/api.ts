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
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  itineraryConverter, itineraryDayConverter, itineraryItemConverter, openingHoursToFirestore,
  type ItemOpeningHours, type ItineraryDay, type ItineraryDoc, type ItineraryItem,
} from './types';

export async function getItinerary(id: string): Promise<ItineraryDoc | null> {
  const snap = await getDoc(doc(db, 'itineraries', id).withConverter(itineraryConverter));
  return snap.exists() ? snap.data() : null;
}

export async function upsertItinerary(id: string, data: Omit<ItineraryDoc, 'id'>): Promise<void> {
  await setDoc(doc(db, 'itineraries', id).withConverter(itineraryConverter), { ...data, id } as ItineraryDoc, { merge: true });
}

/** 只更新 notes / tips；不會覆寫其他欄位。會自動更新 notesUpdatedAt。 */
export async function updateItineraryNotes(
  id: string,
  patch: { notes?: string; tips?: string[] },
): Promise<void> {
  const ref = doc(db, 'itineraries', id);
  const clean: Record<string, unknown> = {};
  if (patch.notes !== undefined) {
    clean.notes = patch.notes;
    clean.notesUpdatedAt = new Date();
  }
  if (patch.tips !== undefined) clean.tips = patch.tips;
  if (Object.keys(clean).length === 0) return;
  await setDoc(ref, clean, { merge: true });
}

export async function listDays(itineraryId: string): Promise<ItineraryDay[]> {
  const ref = collection(db, 'itineraries', itineraryId, 'days').withConverter(itineraryDayConverter);
  const snap = await getDocs(query(ref, orderBy('date', 'asc')));
  return snap.docs.map((d) => d.data());
}

export async function upsertDay(itineraryId: string, day: ItineraryDay): Promise<void> {
  await setDoc(
    doc(db, 'itineraries', itineraryId, 'days', day.id).withConverter(itineraryDayConverter),
    day,
    { merge: true },
  );
}

export async function listItems(itineraryId: string, dayId: string): Promise<ItineraryItem[]> {
  const ref = collection(db, 'itineraries', itineraryId, 'days', dayId, 'items').withConverter(
    itineraryItemConverter,
  );
  // Firestore 端先用 order 排（穩定 fallback、保留拖曳偏好）；client-side 再依 startTime 重排，
  // 讓「新增 09:00 項目時不必手動拖回 14:00 之前」自動成立。
  const snap = await getDocs(query(ref, orderBy('order', 'asc')));
  return sortItemsByTime(snap.docs.map((d) => d.data()));
}

/**
 * 規則：
 *   1. 有 startTime 的依 HH:mm 升冪
 *   2. 同時間或都沒時間 → 用 order 當 tiebreaker（保留 reorder 結果）
 *   3. 沒 startTime 的一律排在有時間項目之後
 */
export function sortItemsByTime(items: ItineraryItem[]): ItineraryItem[] {
  return items.slice().sort((a, b) => {
    const aMin = parseHHMM(a.startTime);
    const bMin = parseHHMM(b.startTime);
    if (aMin != null && bMin != null) {
      if (aMin !== bMin) return aMin - bMin;
      return (a.order ?? 0) - (b.order ?? 0);
    }
    if (aMin != null) return -1;
    if (bMin != null) return 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

function parseHHMM(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1]!, 10); // 非空：regex 已匹配，群組一定存在
  const mm = parseInt(m[2]!, 10); // 非空：regex 已匹配，群組一定存在
  if (Number.isNaN(h) || Number.isNaN(mm)) return null;
  return h * 60 + mm;
}

export async function upsertItem(
  itineraryId: string,
  dayId: string,
  item: ItineraryItem,
): Promise<string> {
  if (!item.id) {
    const ref = await addDoc(
      collection(db, 'itineraries', itineraryId, 'days', dayId, 'items').withConverter(itineraryItemConverter),
      item as ItineraryItem,
    );
    return ref.id;
  }
  await setDoc(
    doc(db, 'itineraries', itineraryId, 'days', dayId, 'items', item.id).withConverter(itineraryItemConverter),
    item,
    { merge: true },
  );
  return item.id;
}

export async function updateItem(
  itineraryId: string,
  dayId: string,
  itemId: string,
  patch: Partial<ItineraryItem>,
): Promise<void> {
  // Firestore rejects undefined values — strip them. 若要清欄位，未來可用 deleteField() sentinel。
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v !== undefined) clean[k] = v;
  }
  await updateDoc(
    doc(db, 'itineraries', itineraryId, 'days', dayId, 'items', itemId),
    clean,
  );
}

/** 把抓到的營業時間存回 item（只有 trip writer 能寫，rules 把關） */
export async function saveItemOpeningHours(
  itineraryId: string,
  dayId: string,
  itemId: string,
  hours: ItemOpeningHours,
): Promise<void> {
  await updateDoc(
    doc(db, 'itineraries', itineraryId, 'days', dayId, 'items', itemId),
    { openingHours: openingHoursToFirestore(hours) },
  );
}

export async function deleteItem(
  itineraryId: string,
  dayId: string,
  itemId: string,
): Promise<void> {
  await deleteDoc(doc(db, 'itineraries', itineraryId, 'days', dayId, 'items', itemId));
}

export async function reorderItems(
  itineraryId: string,
  dayId: string,
  orderedIds: string[],
): Promise<void> {
  const batch = writeBatch(db);
  orderedIds.forEach((id, idx) => {
    batch.update(
      doc(db, 'itineraries', itineraryId, 'days', dayId, 'items', id),
      { order: idx + 1 },
    );
  });
  await batch.commit();
}

export async function deleteDay(itineraryId: string, dayId: string): Promise<void> {
  const items = await listItems(itineraryId, dayId);
  const batch = writeBatch(db);
  items.forEach((it) => batch.delete(doc(db, 'itineraries', itineraryId, 'days', dayId, 'items', it.id)));
  batch.delete(doc(db, 'itineraries', itineraryId, 'days', dayId));
  await batch.commit();
}

/**
 * 搬遷整個 day 到新的 dayId（= 改日期）：複製所有 items 到新子集合後，刪除舊 day + items。
 */
export async function moveDay(
  itineraryId: string,
  oldDayId: string,
  newDayId: string,
  meta: { date: string; theme?: string },
): Promise<void> {
  if (oldDayId === newDayId) return;
  const items = await listItems(itineraryId, oldDayId);

  // 1. 建新 day doc + 複製 items (單一 batch)
  const writeB = writeBatch(db);
  writeB.set(
    doc(db, 'itineraries', itineraryId, 'days', newDayId).withConverter(itineraryDayConverter),
    { id: newDayId, date: meta.date, theme: meta.theme } as ItineraryDay,
    { merge: true },
  );
  items.forEach((it) => {
    writeB.set(
      doc(db, 'itineraries', itineraryId, 'days', newDayId, 'items', it.id).withConverter(itineraryItemConverter),
      it,
      { merge: true },
    );
  });
  await writeB.commit();

  // 2. 刪除舊 day 的 items + day doc
  const delB = writeBatch(db);
  items.forEach((it) => delB.delete(doc(db, 'itineraries', itineraryId, 'days', oldDayId, 'items', it.id)));
  delB.delete(doc(db, 'itineraries', itineraryId, 'days', oldDayId));
  await delB.commit();
}
