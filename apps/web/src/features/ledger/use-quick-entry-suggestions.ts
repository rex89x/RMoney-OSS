/**
 * 快速記帳的「常用交易範本」與「備註自動補完」。
 *
 * 純前端從近 90 天 transactions 推導，不另存資料：
 *   - 範本：同 (type, note, category, paymentMethod, currency) 出現 ≥ 2 次，依「次數 × 近期加權」排序取前 N
 *   - 備註補完：每個 note 取最近一筆 tx 當代表，輸入時做 prefix / includes 比對
 */
import { useMemo } from 'react';
import { useTransactions } from './hooks';
import { startOfTWDay } from '@/lib/tz';
import type { Currency } from '@/types/global';
import type { Transaction, TxType } from './types';

const LOOKBACK_DAYS = 90;
const MAX_TEMPLATES = 8;
const MAX_NOTE_MATCHES = 5;

export interface QuickEntryTemplate {
  key: string;
  type: TxType;
  note: string;
  category: string;
  paymentMethod: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  currency: Currency;
  /** 最常出現的金額（原幣）；金額不固定時為 null */
  amount: number | null;
  count: number;
}

export interface NoteSuggestion {
  note: string;
  type: TxType;
  category: string;
  paymentMethod: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  currency: Currency;
  amount: number;
  lastDate: Date;
}

function normNote(note: string | undefined): string {
  return (note ?? '').replace(/\s+/g, ' ').trim();
}

function modeOrNull(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  counts.forEach((c, v) => { if (c > bestCount) { best = v; bestCount = c; } });
  // 至少一半的交易金額相同才算「固定金額」
  return best != null && bestCount * 2 >= values.length ? best : null;
}

export function buildTemplates(txs: Transaction[], type: TxType, now = Date.now()): QuickEntryTemplate[] {
  const groups = new Map<string, { txs: Transaction[]; score: number }>();
  for (const t of txs) {
    if (t.deletedAt || t.type !== type || t.tripId || t.recurringId) continue;
    const note = normNote(t.note);
    if (!note) continue;
    const key = `${note}|${t.category}|${t.paymentMethod}|${t.currency}`;
    const ageDays = Math.max(0, (now - t.date.getTime()) / 86400000);
    const weight = 1 + Math.max(0, 1 - ageDays / LOOKBACK_DAYS); // 1..2，越近越重
    const g = groups.get(key) ?? { txs: [], score: 0 };
    g.txs.push(t);
    g.score += weight;
    groups.set(key, g);
  }
  const scored: { tpl: QuickEntryTemplate; score: number }[] = [];
  groups.forEach((g, key) => {
    if (g.txs.length < 2) return;
    const latest = g.txs.reduce((a, b) => (a.date > b.date ? a : b));
    scored.push({
      score: g.score,
      tpl: {
        key,
        type,
        note: normNote(latest.note),
        category: latest.category,
        paymentMethod: latest.paymentMethod,
        fromAccountId: latest.fromAccountId ?? null,
        toAccountId: latest.toAccountId ?? null,
        currency: latest.currency,
        amount: modeOrNull(g.txs.map((t) => t.amount)),
        count: g.txs.length,
      },
    });
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TEMPLATES)
    .map((s) => s.tpl);
}

export function buildNoteIndex(txs: Transaction[], type: TxType): NoteSuggestion[] {
  const byNote = new Map<string, NoteSuggestion>();
  for (const t of txs) {
    if (t.deletedAt || t.type !== type || t.tripId) continue;
    const note = normNote(t.note);
    if (!note) continue;
    const prev = byNote.get(note.toLowerCase());
    if (prev && prev.lastDate >= t.date) continue;
    byNote.set(note.toLowerCase(), {
      note,
      type,
      category: t.category,
      paymentMethod: t.paymentMethod,
      fromAccountId: t.fromAccountId ?? null,
      toAccountId: t.toAccountId ?? null,
      currency: t.currency,
      amount: t.amount,
      lastDate: t.date,
    });
  }
  return Array.from(byNote.values()).sort((a, b) => b.lastDate.getTime() - a.lastDate.getTime());
}

export function matchNotes(index: NoteSuggestion[], input: string): NoteSuggestion[] {
  const q = normNote(input).toLowerCase();
  if (!q) return [];
  const prefix: NoteSuggestion[] = [];
  const includes: NoteSuggestion[] = [];
  for (const s of index) {
    const n = s.note.toLowerCase();
    if (n === q) continue; // 已經一樣就不用提示
    if (n.startsWith(q)) prefix.push(s);
    else if (n.includes(q)) includes.push(s);
    if (prefix.length >= MAX_NOTE_MATCHES) break;
  }
  return [...prefix, ...includes].slice(0, MAX_NOTE_MATCHES);
}

export function useQuickEntrySuggestions(type: TxType, enabled: boolean) {
  const start = useMemo(() => startOfTWDay(new Date(Date.now() - LOOKBACK_DAYS * 86400000)), []);
  const { data: txs = [] } = useTransactions({ startDate: start, limit: 2000 }, { enabled });
  const templates = useMemo(() => buildTemplates(txs, type), [txs, type]);
  const noteIndex = useMemo(() => buildNoteIndex(txs, type), [txs, type]);
  return { templates, noteIndex };
}
