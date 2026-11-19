import {
  collection, doc, getDocs, orderBy, query, setDoc, updateDoc, deleteDoc, addDoc, Timestamp, getDoc, limit as qLimit,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  cashAccountConverter, manualAssetConverter, liabilityConverter, netWorthSnapshotConverter,
  type CashAccount, type ManualAsset, type Liability, type NetWorthSnapshot,
} from './types';

export const cashAccountsCol = () => collection(db, 'cash_accounts').withConverter(cashAccountConverter);
export const manualAssetsCol = () => collection(db, 'manual_assets').withConverter(manualAssetConverter);
export const liabilitiesCol = () => collection(db, 'liabilities').withConverter(liabilityConverter);
export const netWorthSnapshotsCol = () =>
  collection(db, 'net_worth_snapshots').withConverter(netWorthSnapshotConverter);

// ---------- cash accounts ----------

export async function listCashAccounts(): Promise<CashAccount[]> {
  const snap = await getDocs(query(cashAccountsCol(), orderBy('createdAt', 'asc')));
  return snap.docs.map((d) => d.data()).filter((a) => !a.archivedAt);
}

export async function upsertCashAccount(input: Omit<CashAccount, 'id' | 'createdAt' | 'updatedAt'>, id?: string): Promise<string> {
  const now = new Date();
  if (id) {
    const ref = doc(db, 'cash_accounts', id).withConverter(cashAccountConverter);
    const existing = await getDoc(ref);
    const created = existing.exists() ? existing.data().createdAt : now;
    await setDoc(ref, { ...input, id, createdAt: created, updatedAt: now } as CashAccount, { merge: true });
    return id;
  }
  const ref = await addDoc(cashAccountsCol(), { ...input, createdAt: now, updatedAt: now } as unknown as CashAccount);
  return ref.id;
}

export async function archiveCashAccount(id: string): Promise<void> {
  await updateDoc(doc(db, 'cash_accounts', id), {
    archivedAt: Timestamp.fromDate(new Date()),
    updatedAt: Timestamp.fromDate(new Date()),
  });
}

// ---------- manual assets ----------

export async function listManualAssets(): Promise<ManualAsset[]> {
  const snap = await getDocs(query(manualAssetsCol(), orderBy('createdAt', 'asc')));
  return snap.docs.map((d) => d.data()).filter((a) => !a.archivedAt);
}

export async function upsertManualAsset(input: Omit<ManualAsset, 'id' | 'createdAt' | 'updatedAt'>, id?: string): Promise<string> {
  const now = new Date();
  if (id) {
    const ref = doc(db, 'manual_assets', id).withConverter(manualAssetConverter);
    const existing = await getDoc(ref);
    const created = existing.exists() ? existing.data().createdAt : now;
    await setDoc(ref, { ...input, id, createdAt: created, updatedAt: now } as ManualAsset, { merge: true });
    return id;
  }
  const ref = await addDoc(manualAssetsCol(), { ...input, createdAt: now, updatedAt: now } as unknown as ManualAsset);
  return ref.id;
}

export async function deleteManualAsset(id: string): Promise<void> {
  await deleteDoc(doc(db, 'manual_assets', id));
}

// ---------- liabilities ----------

export async function listLiabilities(): Promise<Liability[]> {
  const snap = await getDocs(query(liabilitiesCol(), orderBy('createdAt', 'asc')));
  return snap.docs.map((d) => d.data()).filter((l) => !l.archivedAt);
}

export async function upsertLiability(input: Omit<Liability, 'id' | 'createdAt' | 'updatedAt'>, id?: string): Promise<string> {
  const now = new Date();
  if (id) {
    const ref = doc(db, 'liabilities', id).withConverter(liabilityConverter);
    const existing = await getDoc(ref);
    const created = existing.exists() ? existing.data().createdAt : now;
    await setDoc(ref, { ...input, id, createdAt: created, updatedAt: now } as Liability, { merge: true });
    return id;
  }
  const ref = await addDoc(liabilitiesCol(), { ...input, createdAt: now, updatedAt: now } as unknown as Liability);
  return ref.id;
}

export async function deleteLiability(id: string): Promise<void> {
  await deleteDoc(doc(db, 'liabilities', id));
}

// ---------- net worth snapshots ----------

export async function listNetWorthSnapshots(months = 24): Promise<NetWorthSnapshot[]> {
  const snap = await getDocs(query(netWorthSnapshotsCol(), orderBy('month', 'desc'), qLimit(months)));
  return snap.docs.map((d) => d.data()).reverse();
}

export async function upsertNetWorthSnapshot(input: Omit<NetWorthSnapshot, 'id' | 'createdAt'>): Promise<string> {
  const id = input.month;
  const ref = doc(db, 'net_worth_snapshots', id).withConverter(netWorthSnapshotConverter);
  const existing = await getDoc(ref);
  const created = existing.exists() ? existing.data().createdAt : new Date();
  await setDoc(ref, { ...input, id, createdAt: created } as NetWorthSnapshot);
  return id;
}
