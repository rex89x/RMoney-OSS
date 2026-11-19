/**
 * 支付方式管理：使用者可自訂的付款方式（信用卡 / 行動支付 / 現金 / ...）。
 *
 * 結構：
 *   payment_methods/{key}  e.g. "cube" / "ctbc-line" / "cash"
 *     name      顯示名稱（例如 "玉山 Pi 卡"）
 *     type      cash | credit | debit | mobile | other
 *     bank?     發卡銀行（信用卡用）
 *     last4?    卡號末四碼（信用卡）
 *     color?    顯示色（hex）
 *     icon?     lucide 圖標 key
 *     order?    排序
 *     archivedAt? Date | null
 */

import {
  collection, doc, getDocs, orderBy, query, setDoc, updateDoc, Timestamp,
  type DocumentData, type FirestoreDataConverter, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/firebase';
import { tsToDate } from '@/lib/converters';
import type { PaymentMethod, PaymentMethodType } from './payment-method-types';

// 型別與標籤放在 payment-method-types.ts（純模組），這裡 re-export 讓既有 import 路徑不變
export { TYPE_LABEL, paymentMethodLabel } from './payment-method-types';
export type { PaymentMethod, PaymentMethodType } from './payment-method-types';

export const paymentMethodConverter: FirestoreDataConverter<PaymentMethod> = {
  toFirestore: (p) => {
    const { id: _id, ...rest } = p as PaymentMethod;
    void _id;
    const out: Record<string, unknown> = {
      ...rest,
      archivedAt: rest.archivedAt ? Timestamp.fromDate(rest.archivedAt) : null,
      billingEnabled: rest.billingEnabled ?? false,
      statementDay: rest.statementDay ?? null,
      dueDay: rest.dueDay ?? null,
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): PaymentMethod => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      key: d.key ?? snap.id,
      name: d.name ?? snap.id,
      type: (d.type as PaymentMethodType) ?? 'other',
      bank: d.bank ?? undefined,
      last4: d.last4 ?? undefined,
      color: d.color ?? undefined,
      icon: d.icon ?? undefined,
      order: d.order ?? 999,
      archivedAt: tsToDate(d.archivedAt),
      billingEnabled: d.billingEnabled === true,
      statementDay: typeof d.statementDay === 'number' ? d.statementDay : null,
      dueDay: typeof d.dueDay === 'number' ? d.dueDay : null,
    };
  },
};

export const paymentMethodsCol = () =>
  collection(db, 'payment_methods').withConverter(paymentMethodConverter);

export async function listPaymentMethods(): Promise<PaymentMethod[]> {
  const snap = await getDocs(query(paymentMethodsCol(), orderBy('order', 'asc')));
  return snap.docs.map((d) => d.data()).filter((p) => !p.archivedAt);
}

export async function upsertPaymentMethod(input: Omit<PaymentMethod, 'id'>): Promise<string> {
  await setDoc(doc(db, 'payment_methods', input.key).withConverter(paymentMethodConverter),
    { ...input, id: input.key } as PaymentMethod, { merge: true });
  return input.key;
}

export async function archivePaymentMethod(id: string): Promise<void> {
  await updateDoc(doc(db, 'payment_methods', id), { archivedAt: Timestamp.fromDate(new Date()) });
}

// hooks

export function usePaymentMethods() {
  return useQuery({
    queryKey: ['payment-methods'],
    queryFn: listPaymentMethods,
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpsertPaymentMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: upsertPaymentMethod,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['payment-methods'] }),
  });
}

export function useArchivePaymentMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: archivePaymentMethod,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['payment-methods'] }),
  });
}

