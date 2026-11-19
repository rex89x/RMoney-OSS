import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * 樂觀更新小工具（稽核 F5）：先改 TanStack Query cache 讓畫面立刻反應，失敗時還原。
 * 用法：在 useMutation 的 onMutate 呼叫 optimisticUpdate，回傳的 rollback 放進 context，onError 呼叫它。
 * onSettled 仍要 invalidate，讓 cache 最後回到伺服器真實狀態。
 */
export async function optimisticUpdate<T>(
  qc: QueryClient,
  queryKey: QueryKey,
  updater: (old: T) => T,
): Promise<() => void> {
  await qc.cancelQueries({ queryKey });
  const snapshots = qc.getQueriesData<T>({ queryKey });
  for (const [key, data] of snapshots) {
    if (data !== undefined) qc.setQueryData<T>(key, updater(data));
  }
  return () => {
    for (const [key, data] of snapshots) qc.setQueryData<T>(key, data);
  };
}

/** 依 id 改陣列裡的一列（找不到就原樣回傳） */
export function patchById<R extends { id: string }>(rows: R[], id: string, patch: Partial<R>): R[] {
  let hit = false;
  const next = rows.map((r) => {
    if (r.id !== id) return r;
    hit = true;
    return { ...r, ...patch };
  });
  return hit ? next : rows;
}

/** 移除 patch 裡值為 undefined 的欄位（不要把 cache 裡原本的值蓋成 undefined） */
export function definedOnly<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
