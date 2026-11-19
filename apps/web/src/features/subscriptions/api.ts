import {
  collection, doc, getDoc, getDocs, orderBy, query, addDoc, Timestamp, writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { recurringConverter, type Recurring } from '@/features/ledger/types';
import type { Account } from '@/features/accounts';
import { subscriptionConverter, type Subscription } from './types';

export const subscriptionsCol = () =>
  collection(db, 'subscriptions').withConverter(subscriptionConverter);

export async function listSubscriptions(): Promise<Subscription[]> {
  const snap = await getDocs(query(subscriptionsCol(), orderBy('createdAt', 'asc')));
  return snap.docs.map((d) => d.data());
}

export async function upsertSubscription(input: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>, id?: string): Promise<string> {
  const now = new Date();
  if (id) {
    const ref = doc(db, 'subscriptions', id).withConverter(subscriptionConverter);
    const existing = await getDoc(ref);
    const prev = existing.exists() ? existing.data() : null;
    const created = prev?.createdAt ?? now;
    const recurringId = prev?.recurringId ?? null;
    const batch = writeBatch(db);
    batch.set(ref, { ...input, id, recurringId, createdAt: created, updatedAt: now } as Subscription, { merge: true });
    // 已連結自動入帳：金額 / 週期 / 名稱 / 啟用狀態同步到 recurring，兩邊不會各說各話
    if (recurringId) {
      batch.update(doc(db, 'recurring', recurringId), {
        label: input.name,
        frequency: input.billingCycle,
        active: input.active,
        'template.amount': input.amountTWD,
        'template.amountTWD': input.amountTWD,
        ...(input.category ? { 'template.category': input.category } : {}),
      });
    }
    await batch.commit();
    return id;
  }
  const ref = await addDoc(subscriptionsCol(), { ...input, createdAt: now, updatedAt: now } as unknown as Subscription);
  return ref.id;
}

/** 啟用 / 停用訂閱；有連結週期交易就一起切換（同一個 batch） */
export async function setSubscriptionActive(sub: Pick<Subscription, 'id' | 'recurringId'>, active: boolean): Promise<void> {
  const now = Timestamp.fromDate(new Date());
  const batch = writeBatch(db);
  batch.update(doc(db, 'subscriptions', sub.id), { active, updatedAt: now });
  if (sub.recurringId) batch.update(doc(db, 'recurring', sub.recurringId), { active });
  await batch.commit();
}

/** 刪除訂閱；連結的週期交易一起刪（已入帳的交易不受影響） */
export async function deleteSubscription(sub: Pick<Subscription, 'id' | 'recurringId'>): Promise<void> {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'subscriptions', sub.id));
  if (sub.recurringId) batch.delete(doc(db, 'recurring', sub.recurringId));
  await batch.commit();
}

export interface LinkAutoPostInput {
  subscription: Subscription;
  ownerUid: string;
  /** 扣款帳戶（選填）；有選就會同步扣該帳戶餘額 */
  account: Pick<Account, 'id' | 'name' | 'currency' | 'legacyPaymentMethod'> | null;
  firstChargeDate: Date;
}

/**
 * 訂閱 → 自動入帳：建立 recurring（Apps Script 每日 01:00 依 nextDue 入帳），訂閱記 recurringId、
 * recurring 記 subscriptionId，雙向連結讓固定支出彙整不會重複算（2026-11 稽核 Q6：以 recurring 為入帳主體）。
 */
export async function linkSubscriptionAutoPost(input: LinkAutoPostInput): Promise<string> {
  const { subscription: s, ownerUid, account, firstChargeDate } = input;
  if (s.recurringId) return s.recurringId;
  const recRef = doc(collection(db, 'recurring')).withConverter(recurringConverter);
  const recurring: Recurring = {
    id: recRef.id,
    userId: ownerUid,
    label: s.name,
    subscriptionId: s.id,
    frequency: s.billingCycle,
    nextDue: firstChargeDate,
    active: s.active,
    lastGeneratedAt: null,
    template: {
      userId: ownerUid,
      type: 'expense',
      amount: s.amountTWD,
      currency: 'TWD',
      amountTWD: s.amountTWD,
      fxRate: 1,
      category: s.category || 'subscription',
      paymentMethod: account?.legacyPaymentMethod ?? account?.name ?? s.paymentMethod ?? '信用卡',
      fromAccountId: account?.id ?? null,
      note: s.vendor ? `${s.name}（${s.vendor}）` : s.name,
      tags: ['訂閱'],
      date: firstChargeDate,
    },
  };
  const batch = writeBatch(db);
  batch.set(recRef, recurring);
  batch.update(doc(db, 'subscriptions', s.id), {
    recurringId: recRef.id,
    nextChargeDate: Timestamp.fromDate(firstChargeDate),
    updatedAt: Timestamp.fromDate(new Date()),
  });
  await batch.commit();
  return recRef.id;
}

/** 取消自動入帳：刪掉連結的 recurring、訂閱改回只追蹤 */
export async function unlinkSubscriptionAutoPost(sub: Pick<Subscription, 'id' | 'recurringId'>): Promise<void> {
  if (!sub.recurringId) return;
  const batch = writeBatch(db);
  batch.delete(doc(db, 'recurring', sub.recurringId));
  batch.update(doc(db, 'subscriptions', sub.id), { recurringId: null, updatedAt: Timestamp.fromDate(new Date()) });
  await batch.commit();
}
