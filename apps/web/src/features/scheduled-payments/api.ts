import {
  collection, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, deleteDoc, addDoc, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { scheduledPaymentConverter, nextDueDate, type ScheduledPayment } from './types';

export const scheduledPaymentsCol = () =>
  collection(db, 'scheduled_payments').withConverter(scheduledPaymentConverter);

export async function listScheduledPayments(): Promise<ScheduledPayment[]> {
  const snap = await getDocs(query(scheduledPaymentsCol(), orderBy('dueDate', 'asc')));
  return snap.docs.map((d) => d.data());
}

export async function upsertScheduledPayment(input: Omit<ScheduledPayment, 'id' | 'createdAt' | 'updatedAt'>, id?: string): Promise<string> {
  const now = new Date();
  if (id) {
    const ref = doc(db, 'scheduled_payments', id).withConverter(scheduledPaymentConverter);
    const existing = await getDoc(ref);
    const created = existing.exists() ? existing.data().createdAt : now;
    await setDoc(ref, { ...input, id, createdAt: created, updatedAt: now } as ScheduledPayment, { merge: true });
    return id;
  }
  const ref = await addDoc(scheduledPaymentsCol(), { ...input, createdAt: now, updatedAt: now } as unknown as ScheduledPayment);
  return ref.id;
}

/**
 * 標記本期已繳：
 *   - one-time: paidAt 設為現在
 *   - 週期性：paidAt 設為現在、dueDate 推進到下一期
 */
export async function markScheduledPaid(id: string): Promise<void> {
  const ref = doc(db, 'scheduled_payments', id).withConverter(scheduledPaymentConverter);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const p = snap.data();
  const now = new Date();
  if (p.recurrence === 'one-time') {
    await updateDoc(doc(db, 'scheduled_payments', id), {
      paidAt: Timestamp.fromDate(now),
      updatedAt: Timestamp.fromDate(now),
    });
    return;
  }
  const next = nextDueDate(p);
  await updateDoc(doc(db, 'scheduled_payments', id), {
    paidAt: Timestamp.fromDate(now),
    dueDate: Timestamp.fromDate(next),
    updatedAt: Timestamp.fromDate(now),
  });
}

export async function deleteScheduledPayment(id: string): Promise<void> {
  await deleteDoc(doc(db, 'scheduled_payments', id));
}
