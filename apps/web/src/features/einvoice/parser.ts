/**
 * 電子發票檔案解析。
 *
 * 支援兩種來源：
 *   1. 財政部電子發票整合服務平台「載具消費紀錄」下載檔：以 | 分隔，
 *      M 列 = 發票主檔、D 列 = 明細
 *        M|載具名稱|載具號碼|發票日期|商店統編|商店店名|發票號碼|總金額|發票狀態
 *        D|發票號碼|小計|品項名稱
 *      日期常見格式：20260901 / 2026/09/01 / 2026-09-01
 *   2. 有 header 的 CSV（發票存摺 / 各 app 匯出）：用欄名關鍵字對應
 *        發票號碼、日期、金額、店名 / 賣方、狀態、品項
 *
 * 編碼：財政部檔案多為 Big5；先試 UTF-8，若出現大量替代字元再用 big5 重新解碼。
 */
import Papa from 'papaparse';
import { fromTW } from '@/lib/tz';

export interface EInvoiceRecord {
  invoiceNumber: string;
  /** 台北時間當天 12:00（避免跨日） */
  date: Date;
  /** yyyy-MM-dd（台北） */
  dateKey: string;
  sellerName: string;
  sellerId?: string;
  amount: number;
  status: 'issued' | 'void';
  items: string[];
  carrier?: string;
}

export interface ParseResult {
  records: EInvoiceRecord[];
  errors: string[];
  format: 'mof-pipe' | 'csv-header' | 'unknown';
}

export async function decodeInvoiceFile(file: File): Promise<string> {
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

function normalizeInvoiceNumber(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function parseDateKey(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[/-]?(\d{2})[/-]?(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // 民國年：1130901 / 113/09/01
  m = /^(\d{3})[/-]?(\d{2})[/-]?(\d{2})$/.exec(s);
  if (m) return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
  return null;
}

function dateKeyToNoonTW(key: string): Date {
  const [y, mo, d] = key.split('-').map(Number);
  return fromTW(new Date(y ?? 1970, (mo ?? 1) - 1, d ?? 1, 12, 0, 0, 0));
}

function parseAmount(raw: string): number {
  const n = parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function parseStatus(raw: string): EInvoiceRecord['status'] {
  return /作廢|註銷|void|cancel/i.test(raw) ? 'void' : 'issued';
}

export function parseEInvoiceText(text: string): ParseResult {
  const trimmed = text.replace(/^\uFEFF/, '');
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { records: [], errors: ['檔案是空的'], format: 'unknown' };

  const pipeLines = lines.filter((l) => /^[MD]\|/.test(l));
  if (pipeLines.length >= Math.max(1, lines.length / 2)) return parseMofPipe(lines);
  return parseHeaderCsv(trimmed);
}

function parseMofPipe(lines: string[]): ParseResult {
  const errors: string[] = [];
  const byNo = new Map<string, EInvoiceRecord>();
  lines.forEach((line, i) => {
    const cols = line.split('|').map((c) => c.trim());
    if (cols[0] === 'M') {
      const dateKey = parseDateKey(cols[3] ?? '');
      const invoiceNumber = normalizeInvoiceNumber(cols[6] ?? '');
      if (!dateKey || !invoiceNumber) { errors.push(`第 ${i + 1} 行：缺少日期或發票號碼`); return; }
      byNo.set(invoiceNumber, {
        invoiceNumber,
        date: dateKeyToNoonTW(dateKey),
        dateKey,
        sellerName: cols[5] ?? '',
        sellerId: cols[4] || undefined,
        amount: parseAmount(cols[7] ?? ''),
        status: parseStatus(cols[8] ?? ''),
        items: [],
        carrier: cols[1] || undefined,
      });
    } else if (cols[0] === 'D') {
      const invoiceNumber = normalizeInvoiceNumber(cols[1] ?? '');
      const rec = byNo.get(invoiceNumber);
      const name = (cols[3] ?? '').trim();
      if (rec && name) rec.items.push(name);
    }
  });
  return { records: Array.from(byNo.values()), errors, format: 'mof-pipe' };
}

function findKey(headers: string[], patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const hit = headers.find((h) => p.test(h));
    if (hit) return hit;
  }
  return null;
}

function parseHeaderCsv(text: string): ParseResult {
  const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const headers = (res.meta.fields ?? []).map((h) => h.trim());
  const rows = res.data;
  const errors = (res.errors ?? []).map((e) => `row ${e.row}: ${e.message}`);
  const kNo = findKey(headers, [/發票號碼/, /invoice.*(no|number)/i, /^號碼$/]);
  const kDate = findKey(headers, [/發票日期/, /日期/, /date/i]);
  const kAmt = findKey(headers, [/總金額/, /金額/, /amount|total/i]);
  const kSeller = findKey(headers, [/店名|商店|賣方名稱|賣方|商家|店家/, /seller|store|merchant/i]);
  const kSellerId = findKey(headers, [/統編|統一編號/, /ban/i]);
  const kStatus = findKey(headers, [/狀態/, /status/i]);
  const kItem = findKey(headers, [/品項|品名|明細/, /item|description/i]);
  const kCarrier = findKey(headers, [/載具/, /carrier/i]);
  if (!kNo || !kDate || !kAmt) {
    return { records: [], errors: [`看不懂欄位：${headers.join(', ')}（需要發票號碼 / 日期 / 金額）`], format: 'unknown' };
  }
  const byNo = new Map<string, EInvoiceRecord>();
  rows.forEach((r, i) => {
    const raw = (k: string | null) => (k ? String(r[k] ?? '').trim() : '');
    const invoiceNumber = normalizeInvoiceNumber(raw(kNo));
    const dateKey = parseDateKey(raw(kDate));
    if (!invoiceNumber || !dateKey) { errors.push(`第 ${i + 2} 行：缺少日期或發票號碼`); return; }
    const existing = byNo.get(invoiceNumber);
    const item = raw(kItem);
    if (existing) {
      // 同號多列 = 明細列
      if (item) existing.items.push(item);
      return;
    }
    byNo.set(invoiceNumber, {
      invoiceNumber,
      date: dateKeyToNoonTW(dateKey),
      dateKey,
      sellerName: raw(kSeller),
      sellerId: raw(kSellerId) || undefined,
      amount: parseAmount(raw(kAmt)),
      status: parseStatus(raw(kStatus)),
      items: item ? [item] : [],
      carrier: raw(kCarrier) || undefined,
    });
  });
  return { records: Array.from(byNo.values()), errors, format: 'csv-header' };
}
