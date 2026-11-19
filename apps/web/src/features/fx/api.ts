import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit as qLimit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  Alert, alertConverter, AlertLog, alertLogConverter, FxCandle, fxCandleConverter, FxPair, fxPairConverter, FxRate, fxConverter,
} from './types';

export const fxCol = () => collection(db, 'fx_rates').withConverter(fxConverter);
export const alertCol = () => collection(db, 'alerts').withConverter(alertConverter);
export const alertLogsCol = () => collection(db, 'alert_logs').withConverter(alertLogConverter);

export async function listFxRates(): Promise<FxRate[]> {
  const snap = await getDocs(query(fxCol(), orderBy('base', 'asc')));
  return snap.docs.map((d) => d.data());
}

export async function getFxCandles(pair: string, limitDays = 365): Promise<FxCandle[]> {
  const ref = collection(db, 'fx_rates', pair, 'candles').withConverter(fxCandleConverter);
  const q = query(ref, orderBy('date', 'desc'), qLimit(limitDays));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()).reverse();
}

export const fxPairsCol = () => collection(db, 'fx_pairs').withConverter(fxPairConverter);

export async function listFxPairs(): Promise<FxPair[]> {
  const snap = await getDocs(query(fxPairsCol(), orderBy('base', 'asc')));
  return snap.docs.map((d) => d.data());
}

export async function upsertFxPair(base: string, quote: string, enabled = true): Promise<string> {
  const id = `${base}_${quote}`.toUpperCase();
  const parts = id.split('_');
  const b = parts[0] ?? '';
  const q = parts[1] ?? '';
  await setDoc(doc(db, 'fx_pairs', id).withConverter(fxPairConverter), {
    id, base: b, quote: q, enabled, createdAt: new Date(),
  }, { merge: true });
  return id;
}

export async function setFxPairEnabled(id: string, enabled: boolean): Promise<void> {
  await updateDoc(doc(db, 'fx_pairs', id), { enabled });
}

export async function deleteFxPair(id: string): Promise<void> {
  await deleteDoc(doc(db, 'fx_pairs', id));
}

export async function listAlerts(userId: string): Promise<Alert[]> {
  const q = query(alertCol(), where('userId', '==', userId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function createAlert(a: Omit<Alert, 'id'>): Promise<string> {
  const ref = await addDoc(alertCol(), a as unknown as Alert);
  return ref.id;
}

export async function updateAlert(id: string, patch: Partial<Alert>): Promise<void> {
  await updateDoc(doc(db, 'alerts', id), patch as Record<string, unknown>);
}

export async function deleteAlert(id: string): Promise<void> {
  await deleteDoc(doc(db, 'alerts', id));
}

export async function listRecentAlertLogs(limit = 20): Promise<AlertLog[]> {
  const snap = await getDocs(query(alertLogsCol(), orderBy('triggeredAt', 'desc'), qLimit(limit)));
  return snap.docs.map((d) => d.data());
}
