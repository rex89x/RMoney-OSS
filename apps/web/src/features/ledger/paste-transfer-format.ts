import { z } from 'zod';

const personSchema = z.enum(['chiau', 'ming']);
const shareSchema = z.object({ personId: personSchema, amount: z.number().finite().nonnegative() }).strict();
const contentSchema = z.object({
  sourceId: z.string().min(10).max(300).regex(/^chiauming-100:[^\s]+$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().min(1).max(200).refine((value) => value.trim().length > 0),
  amount: z.number().finite().positive().max(100_000_000),
  currency: z.literal('TWD'),
  categoryHint: z.enum(['transport', 'food', 'stay', 'ticket', 'shopping', 'other']),
  paidByHint: personSchema,
  splitHint: z.object({
    participants: z.array(personSchema).min(1).max(2),
    shares: z.array(shareSchema).max(2),
  }).strict(),
  target: z.object({
    kind: z.enum(['trip', 'general']),
    sourceTripKey: z.string().min(1).max(160),
    nameHint: z.string().max(160),
  }).strict(),
}).strict();

const itemSchema = contentSchema.extend({ sourceHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const transferSchema = z.object({
  format: z.literal('chiauming-expenses'),
  version: z.literal(1),
  batchId: z.string().min(1).max(100),
  // 巧明日常可以一次複製多趟旅程；上限與它的 MAX_TRANSFER_ITEMS 一致。
  items: z.array(itemSchema).min(1).max(300),
}).strict();

export type PasteTransferItem = z.infer<typeof itemSchema>;
export type PasteTransfer = z.infer<typeof transferSchema>;

export function parsePasteTransfer(text: string): PasteTransfer {
  if (text.length > 400_000) throw new Error('匯入內容過大（最多 400 KB）。');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('請貼上本站複製的完整 JSON。'); }
  const result = transferSchema.safeParse(raw);
  if (!result.success) throw new Error('匯入格式或版本不正確，請重新從巧明日常複製。');
  const transfer = result.data;
  const ids = new Set<string>();
  for (const item of transfer.items) {
    const date = new Date(`${item.date}T12:00:00+08:00`);
    const isoDate = Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
    // 台北中午換成 UTC 仍是同一天；拒絕 2/30 這類會被 JS 自動進位的日期。
    if (isoDate !== item.date || !Number.isInteger(item.amount) || item.amount <= 0) {
      throw new Error(`「${item.note}」的日期或金額不正確。`);
    }
    if (!item.sourceId.startsWith(`chiauming-100:${item.target.sourceTripKey}:`)) throw new Error('來源 ID 與旅程不一致。');
    if (ids.has(item.sourceId)) throw new Error('匯入資料含重複的來源 ID。');
    ids.add(item.sourceId);
    if (new Set(item.splitHint.participants).size !== item.splitHint.participants.length ||
      new Set(item.splitHint.shares.map((share) => share.personId)).size !== item.splitHint.shares.length) {
      throw new Error(`「${item.note}」的分攤名單重複。`);
    }
  }
  return transfer;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyTransferItem(item: PasteTransferItem): Promise<void> {
  const { sourceHash, ...content } = item;
  const stable = { ...content, target: { kind: content.target.kind, sourceTripKey: content.target.sourceTripKey } };
  if (await sha256Hex(JSON.stringify(stable)) !== sourceHash) throw new Error(`「${item.note}」內容與來源摘要不符。`);
}

export async function importedTransactionId(sourceId: string): Promise<string> {
  return `cm100_${(await sha256Hex(sourceId)).slice(0, 40)}`;
}
