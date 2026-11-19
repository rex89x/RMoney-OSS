/** 交易標籤（transactions.tags）的共用規則 */
export const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 30;

export function normalizeTag(raw: string): string {
  return raw.replace(/^#/, '').replace(/[,，]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
}

/** 兩組 tag 內容是否相同（不管順序；undefined 視為空） */
export function sameTags(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/** 依出現次數排序的 tag 清單（給篩選選項 / 輸入建議） */
export function collectTags(rows: ReadonlyArray<{ tags?: string[] | null }>): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}
