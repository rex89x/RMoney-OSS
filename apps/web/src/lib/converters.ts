import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

export function tsToDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  if (typeof value === 'number') return new Date(value);
  return null;
}

export function dateToTs(d?: Date | null): Timestamp | null {
  if (!d) return null;
  return Timestamp.fromDate(d);
}

/** Generic converter factory: give it a mapper from raw → domain, and vice versa */
export function makeConverter<T extends { id: string }>(
  fromFirestore: (id: string, data: DocumentData) => T,
  toFirestore: (model: Omit<T, 'id'>) => DocumentData,
): FirestoreDataConverter<T> {
  return {
    toFirestore: (model) => {
      const { id: _id, ...rest } = model as T;
      void _id;
      return toFirestore(rest as Omit<T, 'id'>);
    },
    fromFirestore: (snap: QueryDocumentSnapshot) => {
      return fromFirestore(snap.id, snap.data());
    },
  };
}
