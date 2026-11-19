import {
  addDoc, collection, doc, getDoc, getDocs, orderBy, query, setDoc, Timestamp, updateDoc, where,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  PAYOUT_GROUP_CATEGORY,
  isFullyPaid,
  payoutGroupConverter,
  type PayoutGroup,
  type PayoutParticipant,
} from './types';
import { createTransaction, updateTransaction } from '@/features/ledger/api';

export const payoutGroupsCol = () =>
  collection(db, 'payout_groups').withConverter(payoutGroupConverter);

export async function listPayoutGroups(ownerId: string): Promise<PayoutGroup[]> {
  try {
    const snap = await getDocs(query(
      payoutGroupsCol(),
      where('ownerId', '==', ownerId),
      orderBy('date', 'desc'),
    ));
    return snap.docs.map((d) => d.data()).filter((g) => !g.archivedAt);
  } catch (err) {
    console.warn('[listPayoutGroups] indexed query failed, falling back to client sort', err);
    const snap = await getDocs(query(payoutGroupsCol(), where('ownerId', '==', ownerId)));
    return snap.docs
      .map((d) => d.data())
      .filter((g) => !g.archivedAt)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  }
}

export async function getPayoutGroup(id: string): Promise<PayoutGroup | null> {
  const snap = await getDoc(doc(db, 'payout_groups', id).withConverter(payoutGroupConverter));
  return snap.exists() ? snap.data() : null;
}

interface CreateInput {
  ownerId: string;
  title: string;
  date: Date;
  totalAmountTWD: number;
  note?: string | null;
  participants: PayoutParticipant[];
  /** 我自己在參與者中的 id（若有），用來算「我自己那份」寫進 tx.myShareTWD */
  selfParticipantId?: string | null;
  /** tx 用的 paymentMethod；預設 '現金' */
  paymentMethod?: string;
}

/** 建立 PayoutGroup → 同步建一筆 expense tx (splitMode='i-paid-others') 並回填 linkedTxId */
export async function createPayoutGroup(input: CreateInput): Promise<string> {
  const now = new Date();
  // 1. 先建 group（沒 linkedTxId）拿 id
  const docRef = await addDoc(payoutGroupsCol(), {
    ...input,
    note: input.note ?? null,
    linkedTxId: null,
    createdAt: now,
    updatedAt: now,
  } as PayoutGroup);
  const id = docRef.id;

  // 2. 建連動 tx：splitMode='i-paid-others'、myShareTWD = 我自己那份
  let myShareTWD = 0;
  if (input.selfParticipantId) {
    const me = input.participants.find((p) => p.id === input.selfParticipantId);
    if (me) myShareTWD = me.amountTWD;
  }
  try {
    const txId = await createTransaction({
      userId: input.ownerId,
      type: 'expense',
      amount: input.totalAmountTWD,
      currency: 'TWD',
      amountTWD: input.totalAmountTWD,
      fxRate: 1,
      category: PAYOUT_GROUP_CATEGORY,
      paymentMethod: input.paymentMethod ?? '現金',
      note: `[墊付團] ${input.title}`,
      date: input.date,
      splitMode: 'i-paid-others',
      counterpartyName: input.title,
      myShareTWD,
    });
    await setDoc(
      doc(db, 'payout_groups', id),
      { linkedTxId: txId, updatedAt: new Date() },
      { merge: true },
    );
  } catch (err) {
    console.warn('[createPayoutGroup tx]', err);
  }

  return id;
}

interface UpdateInput {
  title?: string;
  date?: Date;
  totalAmountTWD?: number;
  note?: string | null;
  participants?: PayoutParticipant[];
  selfParticipantId?: string | null;
}

/** 更新 PayoutGroup + 同步 patch 連動 tx；若全員已繳 → 自動標 loanSettledAt */
export async function updatePayoutGroup(id: string, patch: UpdateInput): Promise<void> {
  const ref = doc(db, 'payout_groups', id).withConverter(payoutGroupConverter);
  const existing = (await getDoc(ref)).data();
  if (!existing) throw new Error('payout group not found');

  const next: PayoutGroup = {
    ...existing,
    ...patch,
    note: patch.note ?? existing.note,
    participants: patch.participants ?? existing.participants,
    updatedAt: new Date(),
  };
  await setDoc(ref, next, { merge: true });

  // 同步連動 tx
  if (existing.linkedTxId) {
    let myShareTWD: number | undefined;
    if (patch.selfParticipantId !== undefined && patch.participants) {
      if (patch.selfParticipantId) {
        const me = patch.participants.find((p) => p.id === patch.selfParticipantId);
        myShareTWD = me?.amountTWD ?? 0;
      } else {
        myShareTWD = 0;
      }
    }
    try {
      await updateTransaction(existing.linkedTxId, {
        amount: next.totalAmountTWD,
        amountTWD: next.totalAmountTWD,
        date: next.date,
        note: `[墊付團] ${next.title}`,
        counterpartyName: next.title,
        ...(myShareTWD !== undefined ? { myShareTWD } : {}),
        // 全員已繳 → 自動標已結清；否則確保是未結清
        loanSettledAt: isFullyPaid(next) ? new Date() : null,
      });
    } catch (err) {
      console.warn('[updatePayoutGroup tx]', err);
    }
  }
}

export async function deletePayoutGroup(id: string): Promise<void> {
  const ref = doc(db, 'payout_groups', id).withConverter(payoutGroupConverter);
  const existing = (await getDoc(ref)).data();
  // soft-delete：archive；同時把連動 tx 的 deletedAt 設為 now（沿用既有 7 天 trash 機制）
  await setDoc(ref, { archivedAt: new Date(), updatedAt: new Date() }, { merge: true });
  if (existing?.linkedTxId) {
    try {
      await updateDoc(doc(db, 'transactions', existing.linkedTxId), {
        deletedAt: Timestamp.fromDate(new Date()),
        updatedAt: Timestamp.fromDate(new Date()),
      });
    } catch (err) {
      console.warn('[deletePayoutGroup tx]', err);
    }
  }
}
