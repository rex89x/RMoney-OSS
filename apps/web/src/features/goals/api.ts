import {
  collection, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, deleteDoc, addDoc, Timestamp, runTransaction, where, limit as qLimit,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { goalConverter, goalContributionConverter, type SavingsGoal, type GoalContribution } from './types';

export const goalsCol = () => collection(db, 'savings_goals').withConverter(goalConverter);

export async function listGoals(): Promise<SavingsGoal[]> {
  const snap = await getDocs(query(goalsCol(), orderBy('createdAt', 'asc')));
  return snap.docs.map((d) => d.data()).filter((g) => !g.archivedAt);
}

/** 共同目標（member 只能用這個查；rules 依 householdId 放行） */
export async function listHouseholdGoals(householdId: string): Promise<SavingsGoal[]> {
  const snap = await getDocs(query(goalsCol(), where('householdId', '==', householdId), orderBy('createdAt', 'asc')));
  return snap.docs.map((d) => d.data()).filter((g) => !g.archivedAt);
}

export async function upsertGoal(input: Omit<SavingsGoal, 'id' | 'createdAt' | 'updatedAt'>, id?: string): Promise<string> {
  const now = new Date();
  if (id) {
    const ref = doc(db, 'savings_goals', id).withConverter(goalConverter);
    const existing = await getDoc(ref);
    const created = existing.exists() ? existing.data().createdAt : now;
    await setDoc(ref, { ...input, id, createdAt: created, updatedAt: now } as SavingsGoal, { merge: true });
    return id;
  }
  const ref = await addDoc(goalsCol(), { ...input, createdAt: now, updatedAt: now } as unknown as SavingsGoal);
  return ref.id;
}

export async function archiveGoal(id: string): Promise<void> {
  await updateDoc(doc(db, 'savings_goals', id), {
    archivedAt: Timestamp.fromDate(new Date()),
    updatedAt: Timestamp.fromDate(new Date()),
  });
}

export async function deleteGoal(id: string): Promise<void> {
  await deleteDoc(doc(db, 'savings_goals', id));
}

export const goalContribsCol = (goalId: string) =>
  collection(db, 'savings_goals', goalId, 'contributions').withConverter(goalContributionConverter);

export async function listContribs(goalId: string): Promise<GoalContribution[]> {
  // 存入紀錄只顯示最近 200 筆（goal.currentTWD 另存合計，不依賴讀全部，稽核 H3）
  const snap = await getDocs(query(goalContribsCol(goalId), orderBy('date', 'desc'), qLimit(200)));
  return snap.docs.map((d) => d.data());
}

/** 新增一筆 contribution + 同步更新 goal.currentTWD（transaction 保證一致） */
export async function addContribution(goalId: string, input: Omit<GoalContribution, 'id'>): Promise<void> {
  await runTransaction(db, async (tx) => {
    const goalRef = doc(db, 'savings_goals', goalId).withConverter(goalConverter);
    const goalSnap = await tx.get(goalRef);
    if (!goalSnap.exists()) throw new Error('Goal not found');
    const goal = goalSnap.data();
    const newTotal = (goal.currentTWD ?? 0) + input.amountTWD;
    tx.update(doc(db, 'savings_goals', goalId), {
      currentTWD: newTotal,
      updatedAt: Timestamp.fromDate(new Date()),
    });
    const newContribRef = doc(collection(db, 'savings_goals', goalId, 'contributions'));
    tx.set(newContribRef, {
      date: Timestamp.fromDate(input.date),
      amountTWD: input.amountTWD,
      note: input.note ?? null,
      byUid: input.byUid ?? null,
    });
  });
}

export async function deleteContribution(goalId: string, contribId: string, amountTWD: number): Promise<void> {
  await runTransaction(db, async (tx) => {
    const goalRef = doc(db, 'savings_goals', goalId).withConverter(goalConverter);
    const goalSnap = await tx.get(goalRef);
    if (!goalSnap.exists()) return;
    const goal = goalSnap.data();
    tx.update(doc(db, 'savings_goals', goalId), {
      currentTWD: Math.max(0, (goal.currentTWD ?? 0) - amountTWD),
      updatedAt: Timestamp.fromDate(new Date()),
    });
    tx.delete(doc(db, 'savings_goals', goalId, 'contributions', contribId));
  });
}
