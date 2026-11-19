import {
  Timestamp,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { tsToDate } from '@/lib/converters';
import type { Currency } from '@/types/global';

export type TripStatus = 'planning' | 'active' | 'done';

export interface TripMember {
  /** 若成員是 app user (受邀用), 填 uid；否則只有名字 */
  uid?: string;
  name: string;
  email?: string;
  color?: string;
}

export interface Trip {
  id: string;
  userId: string;            // 建立者，等同 ownerId
  ownerId?: string;          // 新欄位，歷史資料 fallback userId
  name: string;
  destination: string[];
  startDate: Date;
  endDate: Date;
  baseCurrency: Currency;
  foreignCurrencies: Currency[];
  budget: number;
  coverImage?: string;
  itineraryId?: string;
  status: TripStatus;
  notes?: string;
  createdAt: Date;
  members?: TripMember[];
  /** 被分享給的 user uids */
  sharedWith?: string[];
  /** 已邀請但尚未首次登入的 email（小寫）。第一次登入時 acceptPendingInvites 會把自己 uid 加進 sharedWith */
  pendingInvites?: string[];
}

export const tripConverter: FirestoreDataConverter<Trip> = {
  toFirestore: (t) => {
    const { id: _id, ...rest } = t as Trip;
    void _id;
    return {
      ...rest,
      startDate: Timestamp.fromDate(rest.startDate),
      endDate: Timestamp.fromDate(rest.endDate),
      createdAt: Timestamp.fromDate(rest.createdAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): Trip => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      userId: d.userId ?? '',
      ownerId: d.ownerId ?? d.userId ?? '',
      name: d.name ?? '',
      destination: d.destination ?? [],
      startDate: tsToDate(d.startDate) ?? new Date(),
      endDate: tsToDate(d.endDate) ?? new Date(),
      baseCurrency: d.baseCurrency ?? 'TWD',
      foreignCurrencies: d.foreignCurrencies ?? [],
      budget: d.budget ?? 0,
      coverImage: d.coverImage,
      itineraryId: d.itineraryId,
      status: (d.status as TripStatus) ?? 'planning',
      notes: d.notes,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      members: (d.members as TripMember[] | undefined) ?? [],
      sharedWith: (d.sharedWith as string[] | undefined) ?? [],
      pendingInvites: (d.pendingInvites as string[] | undefined) ?? [],
    };
  },
};

export type TripDocumentType = 'link' | 'file';
export type TripDocumentCategory =
  | 'visa' | 'flight' | 'hotel' | 'insurance' | 'ticket' | 'other';

export interface TripDocument {
  id: string;
  type: TripDocumentType;
  title: string;
  url: string;
  storagePath?: string | null;
  driveFileId?: string | null;
  driveLink?: string | null;
  size?: number | null;
  contentType?: string | null;
  category: TripDocumentCategory;
  note?: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export const tripDocumentConverter: FirestoreDataConverter<TripDocument> = {
  toFirestore: (d) => {
    const { id: _id, ...rest } = d as TripDocument;
    void _id;
    const out: Record<string, unknown> = {
      type: rest.type,
      title: rest.title,
      url: rest.url,
      storagePath: rest.storagePath ?? null,
      driveFileId: rest.driveFileId ?? null,
      driveLink: rest.driveLink ?? null,
      size: rest.size ?? null,
      contentType: rest.contentType ?? null,
      category: rest.category,
      note: rest.note ?? null,
      createdBy: rest.createdBy,
      createdAt: Timestamp.fromDate(rest.createdAt),
      updatedAt: Timestamp.fromDate(rest.updatedAt),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  },
  fromFirestore: (snap: QueryDocumentSnapshot): TripDocument => {
    const d = snap.data() as DocumentData;
    return {
      id: snap.id,
      type: (d.type as TripDocumentType) ?? 'link',
      title: d.title ?? '',
      url: d.url ?? '',
      storagePath: d.storagePath ?? null,
      driveFileId: d.driveFileId ?? null,
      driveLink: d.driveLink ?? null,
      size: typeof d.size === 'number' ? d.size : null,
      contentType: d.contentType ?? null,
      category: (d.category as TripDocumentCategory) ?? 'other',
      note: d.note ?? null,
      createdBy: d.createdBy ?? '',
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};

// -------- Packing list（trips/{tripId}/packing/{itemId}）--------

export type PackingCategory =
  | 'documents' | 'clothes' | 'toiletries' | 'electronics' | 'health' | 'other';

export const PACKING_CATEGORIES: PackingCategory[] = [
  'documents', 'clothes', 'toiletries', 'electronics', 'health', 'other',
];

export const PACKING_CATEGORY_LABEL: Record<PackingCategory, string> = {
  documents: '證件 / 金錢',
  clothes: '衣物',
  toiletries: '盥洗 / 保養',
  electronics: '電子產品',
  health: '藥品 / 健康',
  other: '其他',
};

export interface PackingItem {
  id: string;
  name: string;
  category: PackingCategory;
  packed: boolean;
  quantity: number;
  /** 負責帶的人（共享旅程成員 uid）；null = 未指派 */
  assignee: string | null;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toPackingCategory(v: unknown): PackingCategory {
  return typeof v === 'string' && (PACKING_CATEGORIES as string[]).includes(v)
    ? (v as PackingCategory)
    : 'other';
}

export const packingItemConverter: FirestoreDataConverter<PackingItem> = {
  toFirestore: (p) => {
    const it = p as PackingItem;
    return {
      name: it.name,
      category: it.category,
      packed: it.packed,
      quantity: it.quantity,
      assignee: it.assignee ?? null,
      order: it.order,
      createdAt: Timestamp.fromDate(it.createdAt),
      updatedAt: Timestamp.fromDate(it.updatedAt),
    };
  },
  fromFirestore: (snap: QueryDocumentSnapshot): PackingItem => {
    const d = snap.data() as DocumentData;
    const qty = typeof d.quantity === 'number' && Number.isFinite(d.quantity) ? d.quantity : 1;
    return {
      id: snap.id,
      name: typeof d.name === 'string' ? d.name : '',
      category: toPackingCategory(d.category),
      packed: d.packed === true,
      quantity: Math.max(1, Math.round(qty)),
      assignee: typeof d.assignee === 'string' && d.assignee ? d.assignee : null,
      order: typeof d.order === 'number' ? d.order : 0,
      createdAt: tsToDate(d.createdAt) ?? new Date(),
      updatedAt: tsToDate(d.updatedAt) ?? new Date(),
    };
  },
};
