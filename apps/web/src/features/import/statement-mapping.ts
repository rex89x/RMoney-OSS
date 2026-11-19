import { dateInputToTWDate } from '@/lib/tz';

/**
 * 通用 CSV / 銀行對帳單欄位對應（稽核 F4）。
 *
 * 各銀行、信用卡匯出的欄名都不一樣（交易日期 / 消費日 / 入帳日、摘要 / 說明 / 商店名稱、支出 / 存入…），
 * 與其一家一家寫 parser，改成：自動猜欄位 → 使用者在 UI 微調 → 套用。
 * 本 app 自己匯出的 CSV（date / type / amount / currency / category / paymentMethod / note / tripId）會被完全猜中。
 */

export type StatementField =
  | 'date' | 'amount' | 'debit' | 'credit' | 'type' | 'currency' | 'category' | 'paymentMethod' | 'note' | 'tripId';

export type StatementMapping = Record<StatementField, string | null>;

/** 只有單一 amount 欄時，正負號代表什麼 */
export type SignConvention = 'negativeIsExpense' | 'positiveIsExpense' | 'allExpense';

export const STATEMENT_FIELD_LABEL: Record<StatementField, string> = {
  date: '日期',
  amount: '金額（單欄）',
  debit: '支出 / 提款欄',
  credit: '收入 / 存入欄',
  type: '收支類型',
  currency: '幣別',
  category: '類別',
  paymentMethod: '支付方式',
  note: '備註 / 摘要',
  tripId: '旅程 id',
};

const SYNONYMS: Record<StatementField, string[]> = {
  date: ['date', '日期', '交易日期', '交易日', '消費日', '消費日期', '入帳日', '入帳日期', '記帳日', '帳務日期', 'transaction date', 'posting date'],
  amount: ['amount', '金額', '交易金額', '消費金額', '台幣金額', '新臺幣金額', '新台幣金額', '入帳金額', 'twd'],
  debit: ['debit', '支出', '支出金額', '提款', '提款金額', '扣款', '扣款金額', '轉出', '支出(元)', 'withdrawal'],
  credit: ['credit', '收入', '收入金額', '存入', '存入金額', '轉入', '存入(元)', 'deposit'],
  type: ['type', '類型', '收支', '收支別', '借貸別'],
  currency: ['currency', '幣別', '幣值', '原幣幣別'],
  category: ['category', '類別', '分類'],
  paymentMethod: ['paymentmethod', 'payment method', '支付方式', '付款方式', '卡別', '帳戶'],
  note: ['note', '備註', '摘要', '說明', '交易說明', '交易摘要', '商店名稱', '消費明細', '特店名稱', '交易內容', 'description', 'memo'],
  tripId: ['tripid'],
};

function norm(h: string): string {
  return h.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function guessMapping(headers: readonly string[]): StatementMapping {
  const out = Object.fromEntries(Object.keys(SYNONYMS).map((k) => [k, null])) as StatementMapping;
  const used = new Set<string>();
  // 精確比對優先，再做包含比對（「交易金額(元)」也要對到 amount）
  for (const pass of ['exact', 'contains'] as const) {
    for (const field of Object.keys(SYNONYMS) as StatementField[]) {
      if (out[field]) continue;
      const hit = headers.find((h) => {
        if (used.has(h)) return false;
        const n = norm(h);
        return SYNONYMS[field].some((syn) => (pass === 'exact' ? n === syn : n.includes(syn)));
      });
      if (hit) { out[field] = hit; used.add(hit); }
    }
  }
  // 有支出 / 存入兩欄時，單欄 amount 通常是「餘額」之類的干擾欄，不要用
  if (out.debit && out.credit && out.amount && /餘額|balance/i.test(out.amount)) out.amount = null;
  return out;
}

/** 金額字串 → 數字：去千分位、貨幣符號、全形負號；括號代表負數。空白回 null。 */
export function parseStatementAmount(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[−－–]/g, '-').replace(/NT\$|NTD|TWD|\$|元|,|，|\s/gi, '');
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1); }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * 日期字串 → 台北當天 00:00（Date）。支援：
 * 2026-11-08 / 2026/11/08 / 2026.11.08 / 20261108、民國年 115/11/08 / 1151108、後面帶時間也可。
 */
export function parseStatementDate(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  let y: number | null = null;
  let m: number | null = null;
  let d: number | null = null;
  let match = /^(\d{2,4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(s);
  if (match) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{3,4})(\d{2})(\d{2})(?:\D|$)/.exec(s))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  }
  if (y == null || m == null || d == null) return null;
  if (y < 1911) y += 1911; // 民國年
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const date = dateInputToTWDate(key);
  // 2026-02-31 這類不存在的日期會被 Date 進位到下個月，擋掉
  return date && Number.isFinite(date.getTime()) ? date : null;
}

export interface NormalizedStatementRow {
  date: Date;
  type: 'expense' | 'income';
  amount: number;
  currency: string;
  category: string | null;
  paymentMethod: string | null;
  note: string | null;
  tripId: string | null;
}

export interface MapResult {
  rows: NormalizedStatementRow[];
  errors: string[];
}

function typeFromText(raw: string | undefined): 'expense' | 'income' | null {
  const t = norm(raw ?? '');
  if (!t) return null;
  if (['expense', '支出', '支', '借', '扣款', 'debit'].includes(t)) return 'expense';
  if (['income', '收入', '收', '貸', '存入', 'credit'].includes(t)) return 'income';
  return null;
}

export function mapStatementRows(
  rows: ReadonlyArray<Record<string, string | undefined>>,
  mapping: StatementMapping,
  sign: SignConvention = 'negativeIsExpense',
): MapResult {
  const out: NormalizedStatementRow[] = [];
  const errors: string[] = [];
  const cell = (r: Record<string, string | undefined>, f: StatementField) => (mapping[f] ? r[mapping[f] as string] : undefined);
  rows.forEach((r, i) => {
    const line = i + 2; // 第 1 列是 header
    const date = parseStatementDate(cell(r, 'date'));
    if (!date) { errors.push(`第 ${line} 列：日期無法辨識（${cell(r, 'date') ?? '空白'}）`); return; }

    let type: 'expense' | 'income' | null = null;
    let amount: number | null = null;
    const debit = parseStatementAmount(cell(r, 'debit'));
    const credit = parseStatementAmount(cell(r, 'credit'));
    if ((mapping.debit || mapping.credit) && (debit || credit)) {
      if (debit && Math.abs(debit) > 0) { type = 'expense'; amount = Math.abs(debit); }
      else if (credit && Math.abs(credit) > 0) { type = 'income'; amount = Math.abs(credit); }
    } else {
      const raw = parseStatementAmount(cell(r, 'amount'));
      if (raw != null && raw !== 0) {
        const explicit = typeFromText(cell(r, 'type'));
        if (explicit) type = explicit;
        else if (sign === 'allExpense') type = 'expense';
        else if (sign === 'negativeIsExpense') type = raw < 0 ? 'expense' : 'income';
        else type = raw > 0 ? 'expense' : 'income';
        amount = Math.abs(raw);
      }
    }
    if (!type || amount == null) { errors.push(`第 ${line} 列：沒有金額`); return; }

    const text = (f: StatementField) => {
      const v = cell(r, f);
      return v && v.trim() ? v.trim() : null;
    };
    out.push({
      date,
      type,
      amount,
      currency: (text('currency') ?? 'TWD').toUpperCase(),
      category: text('category'),
      paymentMethod: text('paymentMethod'),
      note: text('note'),
      tripId: text('tripId'),
    });
  });
  return { rows: out, errors };
}

/** 檔案常見是 Big5（台灣銀行 / 財政部）：先試 UTF-8，替代字元太多再用 Big5 */
export async function decodeStatementFile(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad === 0 || bad < utf8.length / 200) return utf8;
  try {
    return new TextDecoder('big5').decode(buf);
  } catch {
    return utf8;
  }
}
