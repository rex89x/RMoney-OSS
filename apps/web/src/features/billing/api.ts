import {
  collection, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, where, Timestamp, limit as qLimit,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { softDeleteTransaction } from '@/features/ledger/api';
import {
  creditCardBillConverter, billDocId, cycleMonthKey,
  type CreditCardBill, type CreditCardBillInput,
} from './types';

export const billsCol = () =>
  collection(db, 'credit_card_bills').withConverter(creditCardBillConverter);

export async function getBill(paymentMethodId: string, cycleMonth: string): Promise<CreditCardBill | null> {
  const ref = doc(db, 'credit_card_bills', billDocId(paymentMethodId, cycleMonth))
    .withConverter(creditCardBillConverter);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

export async function listBillsForCard(paymentMethodId: string, max = 12): Promise<CreditCardBill[]> {
  // limit 放進 query（以前整張卡的歷史帳單全讀回來再 slice，稽核 H3）；複合索引見 firestore.indexes.json
  const q = query(billsCol(), where('paymentMethodId', '==', paymentMethodId), orderBy('dueDate', 'desc'), qLimit(max));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function listAllBills(max = 60): Promise<CreditCardBill[]> {
  const q = query(billsCol(), orderBy('dueDate', 'desc'), qLimit(max));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

/** 建立或更新某期帳單（idempotent，doc id 由 pmId + cycleMonth 決定） */
export async function upsertBill(input: CreditCardBillInput): Promise<string> {
  const id = billDocId(input.paymentMethodId, input.cycleMonth);
  const ref = doc(db, 'credit_card_bills', id).withConverter(creditCardBillConverter);
  const existing = await getDoc(ref);
  const now = new Date();
  if (existing.exists()) {
    const prev = existing.data();
    await setDoc(ref, {
      ...prev,
      ...input,
      id,
      createdAt: prev.createdAt,
      updatedAt: now,
    } as CreditCardBill, { merge: true });
  } else {
    await setDoc(ref, {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
    } as CreditCardBill);
  }
  return id;
}

/** 標記某期已繳費（建立 or 更新該期 bill 並寫入 paidAt） */
export async function markBillPaid(args: {
  paymentMethodId: string;
  accountId?: string | null;
  cycleMonth: string;
  dueDate: Date;
  statementDate?: Date | null;
  amount?: number | null;
  paidFromAccountId?: string | null;
  paidViaTransferId?: string | null;
}): Promise<void> {
  const id = billDocId(args.paymentMethodId, args.cycleMonth);
  const ref = doc(db, 'credit_card_bills', id);
  const snap = await getDoc(ref);
  const now = new Date();
  if (snap.exists()) {
    await updateDoc(ref, {
      paidAt: Timestamp.fromDate(now),
      accountId: args.accountId ?? null,
      paidFromAccountId: args.paidFromAccountId ?? null,
      paidViaTransferId: args.paidViaTransferId ?? null,
      updatedAt: Timestamp.fromDate(now),
      ...(args.amount != null ? { amount: args.amount } : {}),
    });
    return;
  }
  await upsertBill({
    paymentMethodId: args.paymentMethodId,
    accountId: args.accountId ?? null,
    cycleMonth: args.cycleMonth,
    dueDate: args.dueDate,
    statementDate: args.statementDate ?? null,
    paidAt: now,
    paidFromAccountId: args.paidFromAccountId ?? null,
    paidViaTransferId: args.paidViaTransferId ?? null,
    amount: args.amount ?? null,
    note: null,
  });
}

/** 取消「已繳費」標記 */
export async function unmarkBillPaid(paymentMethodId: string, cycleMonth: string): Promise<void> {
  const id = billDocId(paymentMethodId, cycleMonth);
  const ref = doc(db, 'credit_card_bills', id).withConverter(creditCardBillConverter);
  const snap = await getDoc(ref);
  const bill = snap.exists() ? snap.data() : null;
  if (bill?.paidViaTransferId) {
    await softDeleteTransaction(bill.paidViaTransferId);
  }
  await updateDoc(doc(db, 'credit_card_bills', id), {
    paidAt: null,
    paidFromAccountId: null,
    paidViaTransferId: null,
    updatedAt: Timestamp.fromDate(new Date()),
  });
}

/**
 * 設定本期 dueDate override（連假延期等）。
 * 不存在的 bill doc 會自動建立。override 僅作用於該期，不影響下一期。
 */
export async function setBillOverride(args: {
  paymentMethodId: string;
  cycleMonth: string;
  /** 該期原始 dueDate（pm.dueDay 推算的），需傳入以便首次建立 bill doc */
  dueDate: Date;
  statementDate?: Date | null;
  /** 新的截止日；null = 清除 override */
  dueDateOverride: Date | null;
  reason?: string | null;
}): Promise<void> {
  const id = billDocId(args.paymentMethodId, args.cycleMonth);
  const ref = doc(db, 'credit_card_bills', id);
  const snap = await getDoc(ref);
  const now = new Date();
  if (snap.exists()) {
    await updateDoc(ref, {
      dueDateOverride: args.dueDateOverride ? Timestamp.fromDate(args.dueDateOverride) : null,
      overrideReason: args.reason ?? null,
      updatedAt: Timestamp.fromDate(now),
    });
    return;
  }
  await upsertBill({
    paymentMethodId: args.paymentMethodId,
    cycleMonth: args.cycleMonth,
    dueDate: args.dueDate,
    statementDate: args.statementDate ?? null,
    dueDateOverride: args.dueDateOverride,
    overrideReason: args.reason ?? null,
    paidAt: null,
    amount: null,
    note: null,
  });
}

export async function clearBillOverride(paymentMethodId: string, cycleMonth: string): Promise<void> {
  const id = billDocId(paymentMethodId, cycleMonth);
  await updateDoc(doc(db, 'credit_card_bills', id), {
    dueDateOverride: null,
    overrideReason: null,
    updatedAt: Timestamp.fromDate(new Date()),
  });
}

export { cycleMonthKey };
