/** 圖表點擊 → 交易列表（記帳頁 DataTable 的 `tx_*` URL filter） */
export interface LedgerDrilldown {
  category?: string | string[];
  type?: 'expense' | 'income';
  paymentMethod?: string;
  /** yyyy-MM-dd（台北） */
  startKey?: string;
  endKey?: string;
  q?: string;
}

export function ledgerListHref(d: LedgerDrilldown): string {
  const p = new URLSearchParams();
  const cats = d.category == null ? [] : Array.isArray(d.category) ? d.category : [d.category];
  for (const c of cats) p.append('tx_category', c);
  if (d.type) p.set('tx_type', d.type);
  if (d.paymentMethod) p.append('tx_paymentMethod', d.paymentMethod);
  if (d.startKey) p.set('tx_date_start', d.startKey);
  if (d.endKey) p.set('tx_date_end', d.endKey);
  if (d.q) p.set('tx_q', d.q);
  const qs = p.toString();
  return qs ? `/ledger?${qs}` : '/ledger';
}
