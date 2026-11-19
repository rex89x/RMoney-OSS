/**
 * 取代 `user!.uid`（CLAUDE.md §4 禁止沒有保證的非空斷言）。
 * TanStack query 都有 `enabled: !!user`，正常不會走到 throw；萬一走到，丟出看得懂的錯誤，
 * 而不是在 Firestore 路徑裡塞進 undefined。
 */
export function requireUid(user: { uid: string } | null | undefined): string {
  if (!user?.uid) throw new Error('尚未登入');
  return user.uid;
}
