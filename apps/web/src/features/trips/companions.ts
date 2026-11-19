import type { Trip, TripMember } from './types';

/**
 * 常用旅伴：共同帳本成員（帶 uid）+ 之前任何一趟旅程加過的人，給「新增成員」一鍵帶入。
 * 同一個人以 uid 優先、否則用名字去重；共同帳本成員永遠排最前面。
 */
export interface KnownCompanion extends TripMember {
  /** uid ?? name */
  id: string;
  source: 'household' | 'trip';
  /** 出現在幾趟旅程 */
  tripCount: number;
  /** 最近一趟的名稱 */
  lastTripName: string | null;
}

export function collectKnownCompanions(params: {
  trips: Trip[];
  household: { memberIds: string[]; members: Record<string, { displayName: string; email?: string | null; color?: string | null }> } | null | undefined;
  myUid: string | null | undefined;
}): KnownCompanion[] {
  const { trips, household, myUid } = params;
  const out = new Map<string, KnownCompanion>();
  if (household) {
    for (const uid of household.memberIds) {
      if (uid === myUid) continue;
      const m = household.members[uid];
      out.set(uid, {
        id: uid,
        uid,
        name: m?.displayName ?? uid,
        ...(m?.email ? { email: m.email } : {}),
        ...(m?.color ? { color: m.color } : {}),
        source: 'household',
        tripCount: 0,
        lastTripName: null,
      });
    }
  }
  const sorted = [...trips].sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
  for (const trip of sorted) {
    for (const m of trip.members ?? []) {
      if (m.uid && m.uid === myUid) continue;
      const id = m.uid ?? m.name;
      const existing = out.get(id);
      if (existing) {
        existing.tripCount += 1;
        if (!existing.lastTripName) existing.lastTripName = trip.name;
        if (!existing.email && m.email) existing.email = m.email;
        if (!existing.color && m.color) existing.color = m.color;
        continue;
      }
      out.set(id, {
        id,
        name: m.name,
        ...(m.uid ? { uid: m.uid } : {}),
        ...(m.email ? { email: m.email } : {}),
        ...(m.color ? { color: m.color } : {}),
        source: 'trip',
        tripCount: 1,
        lastTripName: trip.name,
      });
    }
  }
  return Array.from(out.values()).sort((a, b) => {
    if (a.source !== b.source) return a.source === 'household' ? -1 : 1;
    return b.tripCount - a.tripCount;
  });
}

/** 把一位常用旅伴轉成 TripMember（不帶 source / 統計欄位） */
export function companionToMember(c: KnownCompanion, color?: string): TripMember {
  const m: TripMember = { name: c.name };
  if (c.uid) m.uid = c.uid;
  if (c.email) m.email = c.email;
  const col = c.color ?? color;
  if (col) m.color = col;
  return m;
}

/** 共同帳本成員（含自己）轉成旅程成員，建立旅程 / 分享給伴侶時用 */
export function householdTripMembers(
  household: { memberIds: string[]; members: Record<string, { displayName: string; email?: string | null; color?: string | null }> },
  existing: TripMember[] = [],
): TripMember[] {
  const seen = new Set(existing.map((m) => m.uid ?? m.name));
  const added: TripMember[] = [];
  for (const uid of household.memberIds) {
    if (seen.has(uid)) continue;
    const m = household.members[uid];
    const member: TripMember = { uid, name: m?.displayName ?? uid };
    if (m?.email) member.email = m.email;
    if (m?.color) member.color = m.color;
    added.push(member);
  }
  return added;
}
