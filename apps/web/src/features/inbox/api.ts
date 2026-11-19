import { doc, getDoc, updateDoc, deleteField, FieldPath, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { InboxDismissedMap, InboxTodo } from './types';

/** 略過紀錄保留 120 天；超過就清掉，避免 users doc 無限長大 */
const DISMISS_TTL_MS = 120 * 86400000;

/** Firestore field name 不能含 ~ * / [ ]；item id 可能來自使用者輸入（note），先清掉 */
export function safeInboxId(raw: string): string {
  return raw.replace(/[~*/[\]]/g, '_').slice(0, 200);
}

export async function getInboxDismissed(uid: string): Promise<InboxDismissedMap> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return {};
  const raw = snap.data()?.preferences?.inbox?.dismissed;
  if (!raw || typeof raw !== 'object') return {};
  const out: InboxDismissedMap = {};
  const cutoff = Date.now() - DISMISS_TTL_MS;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    const ts = Date.parse(v);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    out[k] = v;
  }
  return out;
}

export async function dismissInboxItem(uid: string, itemId: string): Promise<void> {
  // 用 FieldPath 避免 id 內的 "." 被當成巢狀路徑
  await updateDoc(
    doc(db, 'users', uid),
    new FieldPath('preferences', 'inbox', 'dismissed', itemId),
    new Date().toISOString(),
  );
}

export async function undismissInboxItem(uid: string, itemId: string): Promise<void> {
  await updateDoc(
    doc(db, 'users', uid),
    new FieldPath('preferences', 'inbox', 'dismissed', itemId),
    deleteField(),
  );
}

export async function getInboxTodos(uid: string): Promise<InboxTodo[]> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return [];
  const raw = snap.data()?.preferences?.inbox?.todos;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is InboxTodo => Boolean(t) && typeof t === 'object' && typeof (t as InboxTodo).id === 'string' && typeof (t as InboxTodo).title === 'string')
    .map((t) => ({ id: t.id, title: t.title, detail: t.detail ?? null, href: t.href ?? null, createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString() }));
}

export async function addInboxTodos(uid: string, todos: Omit<InboxTodo, 'id' | 'createdAt'>[]): Promise<InboxTodo[]> {
  const now = new Date().toISOString();
  const rows: InboxTodo[] = todos.map((t, i) => ({
    id: `todo-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`,
    title: t.title.trim().slice(0, 120),
    detail: t.detail?.trim() ? t.detail.trim().slice(0, 200) : null,
    href: t.href ?? null,
    createdAt: now,
  })).filter((t) => t.title);
  if (rows.length === 0) return [];
  await updateDoc(doc(db, 'users', uid), new FieldPath('preferences', 'inbox', 'todos'), arrayUnion(...rows));
  return rows;
}

export async function removeInboxTodo(uid: string, todo: InboxTodo): Promise<void> {
  // arrayRemove 需要完全相同的物件
  await updateDoc(doc(db, 'users', uid), new FieldPath('preferences', 'inbox', 'todos'), arrayRemove({
    id: todo.id, title: todo.title, detail: todo.detail ?? null, href: todo.href ?? null, createdAt: todo.createdAt,
  }));
}
