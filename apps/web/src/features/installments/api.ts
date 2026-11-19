import {
  addDoc, collection, doc, getDocs, limit, orderBy, query, Timestamp, updateDoc, where,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { callAppsScript } from '@/lib/apps-script';
import { installmentPlanConverter, type InstallmentPlan, type InstallmentPlanInput } from './types';
import { installmentPerPeriodTWD } from './schedule';

/** 一個人的分期計畫不會很多；200 筆上限足夠，不做 cursor 分頁（CLAUDE.md §5.6 limit） */
export const INSTALLMENT_LIST_LIMIT = 200;

export const installmentPlansCol = () =>
  collection(db, 'installment_plans').withConverter(installmentPlanConverter);

export async function listInstallmentPlans(ownerId: string): Promise<InstallmentPlan[]> {
  // composite index: installment_plans (ownerId ASC, startDate DESC)
  const snap = await getDocs(query(
    installmentPlansCol(),
    where('ownerId', '==', ownerId),
    orderBy('startDate', 'desc'),
    limit(INSTALLMENT_LIST_LIMIT),
  ));
  return snap.docs.map((d) => d.data());
}

export async function createInstallmentPlan(input: InstallmentPlanInput): Promise<string> {
  const now = new Date();
  const totalAmountTWD = Math.round(input.totalAmountTWD);
  const feeTWD = Math.round(input.feeTWD || 0);
  const periods = Math.round(input.periods);
  const plan: InstallmentPlan = {
    id: '',
    ownerId: input.ownerId,
    title: input.title.trim(),
    totalAmountTWD,
    periods,
    perPeriodTWD: installmentPerPeriodTWD(totalAmountTWD + feeTWD, periods),
    feeTWD,
    cardAccountId: input.cardAccountId,
    category: input.category,
    startDate: input.startDate,
    paidPeriods: 0,
    status: 'active',
    note: input.note?.trim() || null,
    lastPostedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const ref = await addDoc(installmentPlansCol(), plan);
  return ref.id;
}

/** 取消：之後不再入帳；已入帳的交易保留（要退款另外記） */
export async function cancelInstallmentPlan(id: string): Promise<void> {
  const now = Timestamp.fromDate(new Date());
  await updateDoc(doc(db, 'installment_plans', id), {
    status: 'cancelled',
    cancelledAt: now,
    updatedAt: now,
  });
}

/** 請 Apps Script 立即把已到期的期數入帳（與每日 01:00 排程同一套冪等邏輯） */
export async function postDueInstallments(): Promise<number> {
  const res = await callAppsScript('runInstallments');
  if (!res.ok) throw new Error(res.error ?? '分期入帳失敗');
  return typeof res.created === 'number' ? res.created : 0;
}
