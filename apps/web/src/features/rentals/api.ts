import {
  addDoc, collection, doc, getDoc, getDocs, orderBy, query, setDoc, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { rentalConverter, type Rental, type RentalIncome } from './types';
import { createTransaction, createTransactionId, softDeleteTransaction } from '@/features/ledger/api';

export const rentalsCol = () =>
  collection(db, 'rentals').withConverter(rentalConverter);

export async function listRentals(ownerId: string): Promise<Rental[]> {
  try {
    const snap = await getDocs(query(
      rentalsCol(),
      where('ownerId', '==', ownerId),
      orderBy('startDate', 'desc'),
    ));
    return snap.docs.map((d) => d.data()).filter((r) => !r.archivedAt);
  } catch (err) {
    console.warn('[listRentals] indexed query failed, falling back', err);
    const snap = await getDocs(query(rentalsCol(), where('ownerId', '==', ownerId)));
    return snap.docs
      .map((d) => d.data())
      .filter((r) => !r.archivedAt)
      .sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
  }
}

export async function getRental(id: string): Promise<Rental | null> {
  const snap = await getDoc(doc(db, 'rentals', id).withConverter(rentalConverter));
  return snap.exists() ? snap.data() : null;
}

export interface CreateRentalInput {
  ownerId: string;
  name: string;
  assetType: Rental['assetType'];
  startDate: Date;
  purchaseAmountTWD: number;
  expectedMonthlyIncome: number;
  expectedMonths?: number | null;
  defaultIncomeAccountId?: string | null;
  note?: string | null;
  /** 是否同時建立一筆 expense TX 把成本記入 ledger（從 fromAccountId 扣） */
  recordPurchaseAsExpense?: boolean;
  purchaseFromAccountId?: string | null;
  purchasePaymentMethod?: string | null;
}

export async function createRental(input: CreateRentalInput): Promise<string> {
  const now = new Date();
  const data: Rental = {
    id: '',
    ownerId: input.ownerId,
    name: input.name,
    assetType: input.assetType,
    startDate: input.startDate,
    purchaseAmountTWD: input.purchaseAmountTWD,
    expectedMonthlyIncome: input.expectedMonthlyIncome,
    expectedMonths: input.expectedMonths ?? null,
    defaultIncomeAccountId: input.defaultIncomeAccountId ?? null,
    status: 'active',
    closedAt: null,
    note: input.note ?? null,
    incomes: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  if (input.recordPurchaseAsExpense && input.purchaseFromAccountId && input.purchaseAmountTWD > 0) {
    // 購入支出與 rental 文件同一個 transaction：以前分兩次寫，支出失敗時 rental 已建好，
    // 未回收成本（pitfall #24）會算進淨值卻沒有對應的扣款
    const rentalRef = doc(rentalsCol());
    await createTransaction({
      userId: input.ownerId,
      type: 'expense',
      amount: input.purchaseAmountTWD,
      currency: 'TWD',
      amountTWD: input.purchaseAmountTWD,
      fxRate: 1,
      category: 'rental_purchase',
      paymentMethod: input.purchasePaymentMethod ?? '銀行轉帳',
      fromAccountId: input.purchaseFromAccountId,
      note: `[租賃資產] 購入 ${input.name}`,
      date: input.startDate,
    }, undefined, false, (t) => t.set(rentalRef, data));
    return rentalRef.id;
  }

  const docRef = await addDoc(rentalsCol(), data);
  return docRef.id;
}

interface UpdateInput {
  name?: string;
  assetType?: Rental['assetType'];
  startDate?: Date;
  purchaseAmountTWD?: number;
  expectedMonthlyIncome?: number;
  expectedMonths?: number | null;
  defaultIncomeAccountId?: string | null;
  status?: Rental['status'];
  closedAt?: Date | null;
  note?: string | null;
}

export async function updateRental(id: string, patch: UpdateInput): Promise<void> {
  const ref = doc(db, 'rentals', id).withConverter(rentalConverter);
  const existing = (await getDoc(ref)).data();
  if (!existing) throw new Error('rental not found');
  await setDoc(ref, { ...existing, ...patch, updatedAt: new Date() }, { merge: true });
}

export async function archiveRental(id: string): Promise<void> {
  const ref = doc(db, 'rentals', id);
  await setDoc(ref, { archivedAt: Timestamp.fromDate(new Date()), updatedAt: Timestamp.fromDate(new Date()) }, { merge: true });
}

export interface RecordRentalIncomeInput {
  rentalId: string;
  ownerId: string;
  monthKey: string;
  date: Date;
  amountTWD: number;
  toAccountId: string;
  payerName?: string | null;
  note?: string | null;
  paymentMethod?: string | null;
}

export async function recordRentalIncome(input: RecordRentalIncomeInput): Promise<string> {
  const ref = doc(db, 'rentals', input.rentalId).withConverter(rentalConverter);
  const existing = (await getDoc(ref)).data();
  if (!existing) throw new Error('rental not found');

  const incomeId = Math.random().toString(36).slice(2, 10);
  const txId = createTransactionId();
  const next: RentalIncome = {
    id: incomeId,
    monthKey: input.monthKey,
    date: input.date,
    amountTWD: input.amountTWD,
    txId,
    payerName: input.payerName ?? null,
    note: input.note ?? null,
    createdAt: new Date(),
  };
  const incomes = [...existing.incomes, next].sort((a, b) => b.date.getTime() - a.date.getTime());
  // 收入交易與 rental.incomes 同一個 transaction（以前交易失敗也照樣記一筆沒有 txId 的收款）
  await createTransaction({
      userId: input.ownerId,
      type: 'income',
      amount: input.amountTWD,
      currency: 'TWD',
      amountTWD: input.amountTWD,
      fxRate: 1,
      category: 'rental_income',
      paymentMethod: input.paymentMethod ?? '銀行轉帳',
      toAccountId: input.toAccountId,
      note: input.payerName
        ? `[租賃收入] ${existing.name} · ${input.payerName}`
        : `[租賃收入] ${existing.name}`,
      date: input.date,
  }, txId, false, (t) => t.set(ref, { ...existing, incomes, updatedAt: new Date() }, { merge: true }));
  return incomeId;
}

export async function deleteRentalIncome(rentalId: string, incomeId: string): Promise<void> {
  const ref = doc(db, 'rentals', rentalId).withConverter(rentalConverter);
  const existing = (await getDoc(ref)).data();
  if (!existing) return;
  const target = existing.incomes.find((inc) => inc.id === incomeId);
  if (target?.txId) {
    try {
      await softDeleteTransaction(target.txId);
    } catch (err) {
      console.warn('[deleteRentalIncome tx]', err);
    }
  }
  const incomes = existing.incomes.filter((inc) => inc.id !== incomeId);
  await setDoc(ref, { ...existing, incomes, updatedAt: new Date() }, { merge: true });
}
