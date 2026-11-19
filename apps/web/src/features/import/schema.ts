import { z } from 'zod';
import { repairJson } from './json-repair';

/**
 * RMoney 通用匯入格式（AI Import JSON v1）。
 *
 * 任何 LLM / 工具（ChatGPT、Claude、Gemini、自己寫的腳本）只要產出這個 JSON，就能貼進 app 匯入。
 * 這份 schema 是唯一的契約：`buildImportPrompt()` 會把它寫進提示詞、Apps Script `parseImport` 也照它回傳、
 * `normalizeImport()` 照它驗證。改欄位請三處一起改並更新 docs/AI_IMPORT_FORMAT.md。
 */
export const IMPORT_FORMAT_VERSION = 1;

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期要是 yyyy-MM-dd');
/** 數字也接受字串（"1,280"、"NT$ 120"）：LLM 常把金額當字串回 */
const cleanNumber = (v: unknown) => (typeof v === 'string' ? v.replace(/[^\d.eE+-]/g, '') : v);
const PositiveMoney = (message?: string) => z.preprocess(cleanNumber, z.coerce.number().finite().positive(message));
const NonNegativeMoney = z.preprocess(cleanNumber, z.coerce.number().finite().nonnegative());
const Text = z.string().trim().max(200);
/** 選填欄位：LLM 沒資料時常回 null 而不是省略，一律接受並轉成 undefined */
const opt = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((v) => (v ?? undefined) as z.output<T> | undefined);

export const LedgerImportItemSchema = z.object({
  kind: z.enum(['expense', 'income']),
  date: DateString,
  /** 原幣金額（正數） */
  amount: PositiveMoney('金額需大於 0'),
  /** ISO 4217，預設 TWD */
  currency: z.string().trim().toUpperCase().min(3).max(5).nullish().transform((v) => v || 'TWD'),
  /** 類別 key 或名稱（會模糊比對）；沒給或對不到 → other */
  category: opt(Text),
  /** 備註 / 店名 */
  note: opt(Text),
  merchant: opt(Text),
  /** 帳戶名稱 / 支付方式（模糊比對 accounts 與 payment_methods）；對不到就只記支付方式文字 */
  account: opt(Text),
  paymentMethod: opt(Text),
  tags: opt(z.array(z.string().trim().max(30)).max(10)),
  /** 指定匯率（1 單位原幣 = ? TWD）；沒給用當下匯率 */
  fxRate: opt(PositiveMoney()),
  /** 來源的穩定 id（例如券商 / 發票號碼）；給了就用它去重 */
  id: opt(Text),
});

export const TradeImportItemSchema = z.object({
  kind: z.literal('trade'),
  date: DateString,
  /** 'TW' 台股（4 位數字代號）/ 'US' 美股；沒給就從代號判斷 */
  market: opt(z.enum(['TW', 'US'])),
  symbol: z.string().trim().min(1, '缺股票代號').max(12),
  side: z.enum(['buy', 'sell']),
  shares: PositiveMoney('股數需大於 0'),
  /** 成交單價（原幣） */
  price: PositiveMoney('單價需大於 0'),
  currency: opt(z.enum(['TWD', 'USD'])),
  /** 手續費 / 交易稅（原幣），會算進成本或從賣出所得扣除 */
  fee: opt(NonNegativeMoney),
  tax: opt(NonNegativeMoney),
  /** 交割帳戶名稱（模糊比對 accounts） */
  account: opt(Text),
  note: opt(Text),
  fxRate: opt(PositiveMoney()),
  id: opt(Text),
});

export const ImportItemSchema = z.discriminatedUnion('kind', [LedgerImportItemSchema, TradeImportItemSchema]);

export const ImportEnvelopeSchema = z.object({
  version: z.coerce.number().int().default(IMPORT_FORMAT_VERSION),
  /** 產生這份 JSON 的工具（chatgpt / claude / gemini / manual…），只做紀錄 */
  source: z.string().trim().max(40).optional(),
  items: z.array(ImportItemSchema).min(1, '沒有任何項目').max(500, '一次最多 500 筆'),
});

export type LedgerImportItem = z.infer<typeof LedgerImportItemSchema>;
export type TradeImportItem = z.infer<typeof TradeImportItemSchema>;
export type ImportItem = z.infer<typeof ImportItemSchema>;
export type ImportEnvelope = z.infer<typeof ImportEnvelopeSchema>;

export interface ParseEnvelopeResult {
  envelope: ImportEnvelope | null;
  /** 整份無法解析的錯誤（JSON 壞掉、不是陣列…） */
  error: string | null;
  /** 單筆被丟掉的原因（index → message） */
  rejected: { index: number; message: string; raw: unknown }[];
  /** 原文不是合法 JSON（彎引號 / 單引號 / 尾逗號…），是修復後才解析成功 */
  repaired: boolean;
  /** 括號沒收完，像是訊息被截斷；最後幾筆可能沒進來 */
  truncated: boolean;
}

/**
 * 把使用者貼進來的文字變成 envelope：
 * - 容許 ```json 圍欄、前後雜訊（找第一個 { 或 [ 到最後一個 } 或 ]）
 * - 容許直接貼 items 陣列、或單一物件
 * - 單筆格式錯誤只丟那一筆，不要整份失敗（LLM 常有一兩筆缺欄位）
 */
export function parseImportEnvelope(text: string): ParseEnvelopeResult {
  const raw = extractJson(text);
  const fail = (error: string, extra?: Partial<ParseEnvelopeResult>): ParseEnvelopeResult =>
    ({ envelope: null, error, rejected: [], repaired: false, truncated: false, ...extra });
  if (raw == null) return fail('找不到 JSON（要以 { 或 [ 開頭）');
  const parsed = parseJsonLoosely(raw.full, raw.cut);
  if (!parsed.ok) return fail(`JSON 格式錯誤：${parsed.error}`, { truncated: parsed.truncated });
  const data = parsed.data;
  let itemsRaw: unknown[];
  let version: unknown = IMPORT_FORMAT_VERSION;
  let source: unknown;
  if (Array.isArray(data)) itemsRaw = data;
  else if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    itemsRaw = (data as { items: unknown[] }).items;
    version = (data as { version?: unknown }).version ?? IMPORT_FORMAT_VERSION;
    source = (data as { source?: unknown }).source;
  } else if (data && typeof data === 'object' && 'kind' in (data as object)) {
    itemsRaw = [data];
  } else {
    return fail('不是 RMoney 匯入格式（需要 items 陣列）', { repaired: parsed.repaired, truncated: parsed.truncated });
  }

  const items: ImportItem[] = [];
  const rejected: ParseEnvelopeResult['rejected'] = [];
  // 被截斷的內容：最後一筆通常只剩一半（金額少一位、備註斷掉），寧可不要
  if (parsed.truncated && itemsRaw.length > 0) {
    const dropped = itemsRaw.pop();
    rejected.push({ index: itemsRaw.length, message: '內容被截斷，最後一筆不完整（請補貼後面的部分）', raw: dropped });
  }
  itemsRaw.forEach((entry, index) => {
    const result = ImportItemSchema.safeParse(entry);
    if (result.success) items.push(result.data);
    else rejected.push({ index, message: result.error.issues.map((i) => `${i.path.join('.') || 'item'}: ${i.message}`).join('；'), raw: entry });
  });
  const meta = { rejected, repaired: parsed.repaired, truncated: parsed.truncated };
  if (items.length === 0) {
    return { envelope: null, error: rejected.length > 0 ? '每一筆都有格式問題' : '沒有任何項目', ...meta };
  }
  const env = ImportEnvelopeSchema.safeParse({ version, source, items });
  if (!env.success) return { envelope: null, error: env.error.issues.map((i) => i.message).join('；'), ...meta };
  return { envelope: env.data, error: null, ...meta };
}

type LooseParse =
  | { ok: true; data: unknown; repaired: boolean; truncated: boolean }
  | { ok: false; error: string; truncated: boolean };

/**
 * 先照標準 JSON 解析；失敗才走 repairJson（彎引號、單引號、尾逗號、字串內引號…）。
 * `cut` 是切到最後一個結尾括號的版本（正常輸出），`full` 保留到結尾（截斷時 repairJson 才知道少了什麼）。
 */
export function parseJsonLoosely(full: string, cut: string = full): LooseParse {
  try {
    return { ok: true, data: JSON.parse(cut), repaired: false, truncated: false };
  } catch (firstErr) {
    const fixed = repairJson(full);
    try {
      return { ok: true, data: JSON.parse(fixed.text), repaired: true, truncated: fixed.truncated };
    } catch {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      return { ok: false, error: fixed.truncated ? `${msg}（內容似乎被截斷，括號沒有收完）` : msg, truncated: fixed.truncated };
    }
  }
}

function extractJson(text: string): { full: string; cut: string } | null {
  // 全形括號（有些輸入法 / 聊天軟體會轉）先換回半形，字串內的全形括號極少見
  const trimmed = text.replace(/[｛]/g, '{').replace(/[｝]/g, '}').replace(/[［]/g, '[').replace(/[］]/g, ']').trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  // 圍欄沒收尾（被截斷）→ 從 ``` 之後開始
  const openFence = !fenced ? trimmed.match(/```(?:json)?\s*([\s\S]*)$/i) : null;
  const body = fenced?.[1]?.trim() ?? openFence?.[1]?.trim() ?? trimmed;
  const firstObj = body.indexOf('{');
  const firstArr = body.indexOf('[');
  const starts = [firstObj, firstArr].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  const full = body.slice(start);
  // cut：切到最後一個結尾括號（去掉後面的說明文字）；full：截斷時 repairJson 才看得到最後一筆不完整
  return { full, cut: end <= start ? full : body.slice(start, end + 1) };
}
