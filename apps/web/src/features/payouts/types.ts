/**
 * 墊付團（PayoutGroup）— 我先付、跟其他人收錢的場景（下午茶、揪團、團購…）。
 *
 * collection: payout_groups/{id}
 * 跟 transactions 解耦，但建立時自動連動一筆 expense tx（splitMode='i-paid-others'）
 * 讓 ledger / dashboard 既有 myShare 邏輯能自然算到「我自己那份」。
 */
import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';

export interface PayoutParticipant {
  id: string;            // 隨機 id（避免改名失準）
  name: string;
  amountTWD: number;     // 該人實際應繳 / 應收金額（生日被分攤者為 0）
  baseAmountTWD?: number | null; // 該人原始消費金額；舊資料沒有時等同 amountTWD
  sharedByOthers?: boolean | null; // true = 該人金額由其他同仁平均分攤
  paidAt?: Date | null;  // 已收款時間；null = 未繳
  paymentMethod?: string | null; // 對方用什麼付（現金 / Line Pay…）
  note?: string | null;
}

export interface PayoutGroup {
  id: string;
  ownerId: string;
  title: string;
  date: Date;
  totalAmountTWD: number;
  note?: string | null;
  /** 連動到 ledger 的 tx id；建立時自動產生一筆 expense */
  linkedTxId?: string | null;
  participants: PayoutParticipant[];
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date | null;
}

export const PAYOUT_GROUP_CATEGORY = 'payout-group';

export const payoutGroupConverter: FirestoreDataConverter<PayoutGroup> = {
  toFirestore: (g) => {
    const { id: _id, ...rest } = g as PayoutGroup;
    void _id;
    return {
      ownerId: rest.ownerId,
      title: rest.title,
      date: Timestamp.fromDate(rest.date),
      totalAmountTWD: rest.totalAmountTWD,
      note: rest.note ?? null,
      linkedTxId: rest.linkedTxId ?? null,
      participants: (rest.participants ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        amountTWD: p.amountTWD,
        baseAmountTWD: p.baseAmountTWD ?? null,
        sharedByOthers: p.sharedByOthers ?? false,
        paidAt: p.paidAt ? Timestamp.fromDate(p.paidAt) : null,
        paymentMethod: p.paymentMethod ?? null,
        note: p.note ?? null,
      })),
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
      archivedAt: rest.archivedAt ? Timestamp.fromDate(rest.archivedAt) : null,
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): PayoutGroup => {
    const d = snap.data() as DocumentData;
    const rawParticipants: unknown = d.participants;
    return {
      id: snap.id,
      ownerId: d.ownerId ?? '',
      title: d.title ?? '',
      date: tsToDate(d.date) ?? new Date(),
      totalAmountTWD: d.totalAmountTWD ?? 0,
      note: d.note ?? null,
      linkedTxId: d.linkedTxId ?? null,
      participants: Array.isArray(rawParticipants)
        ? (rawParticipants as DocumentData[]).map((p) => ({
            id: String(p.id ?? randomId()),
            name: String(p.name ?? ''),
            amountTWD: Number(p.amountTWD ?? 0),
            baseAmountTWD: p.baseAmountTWD == null ? null : Number(p.baseAmountTWD ?? 0),
            sharedByOthers: Boolean(p.sharedByOthers ?? false),
            paidAt: tsToDate(p.paidAt),
            paymentMethod: p.paymentMethod ?? null,
            note: p.note ?? null,
          }))
        : [],
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
      archivedAt: tsToDate(d.archivedAt),
    };
  },
};

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function pendingTotalTWD(g: PayoutGroup): number {
  return g.participants
    .filter((p) => !p.paidAt)
    .reduce((s, p) => s + (p.amountTWD || 0), 0);
}

export function paidTotalTWD(g: PayoutGroup): number {
  return g.participants
    .filter((p) => !!p.paidAt)
    .reduce((s, p) => s + (p.amountTWD || 0), 0);
}

export function isFullyPaid(g: PayoutGroup): boolean {
  return g.participants.length > 0 && g.participants.every((p) => !!p.paidAt);
}

export function participantBaseAmountTWD(p: PayoutParticipant): number {
  return p.baseAmountTWD ?? p.amountTWD ?? 0;
}

export function participantSharedContributionTWD(p: PayoutParticipant): number {
  return Math.max(0, (p.amountTWD || 0) - participantBaseAmountTWD(p));
}

export function calculateSharedPayoutParticipants(participants: PayoutParticipant[]): PayoutParticipant[] {
  const sharedTotal = participants
    .filter((p) => p.sharedByOthers)
    .reduce((sum, p) => sum + participantBaseAmountTWD(p), 0);
  const payerIndexes = participants
    .map((p, index) => (p.sharedByOthers ? -1 : index))
    .filter((index) => index >= 0);

  if (sharedTotal <= 0 || payerIndexes.length === 0) {
    return participants.map((p) => ({
      ...p,
      amountTWD: round2(participantBaseAmountTWD(p)),
    }));
  }

  const perPayer = round2(sharedTotal / payerIndexes.length);
  let allocated = 0;
  const lastPayerIndex = payerIndexes[payerIndexes.length - 1];

  return participants.map((p, index) => {
    const base = participantBaseAmountTWD(p);
    if (p.sharedByOthers) return { ...p, amountTWD: 0 };
    const share = index === lastPayerIndex ? round2(sharedTotal - allocated) : perPayer;
    allocated += share;
    return { ...p, amountTWD: round2(base + share) };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
