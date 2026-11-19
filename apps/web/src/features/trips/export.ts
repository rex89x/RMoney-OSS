import { downloadText, toCsv } from '@/lib/csv';
import { effectiveAmountTWD, type Transaction } from '@/features/ledger/types';
import { formatTWDateInput } from '@/lib/tz';
import { computeSettlement } from './settlement';
import type { Trip } from './types';

function formatDate(d: Date): string {
  return formatTWDateInput(d);
}

export function exportTripCsv(trip: Trip, txs: Transaction[]) {
  const valid = txs.filter((t) => !t.deletedAt);
  const settlement = (trip.members && trip.members.length > 0)
    ? computeSettlement(trip.members, valid)
    : null;
  const shareByTx = new Map(
    (settlement?.transactionDetails ?? []).map((d) => [
      d.txId,
      d.shares.map((s) => `${s.memberName}: NT$${Math.round(s.amountTWD).toLocaleString()} (${s.pctOfTx.toFixed(1)}%)`).join(' | '),
    ]),
  );

  const rows = valid
    .filter((t) => !t.deletedAt)
    .map((t) => ({
      date: formatDate(t.date),
      type: t.type,
      amount: t.amount,
      currency: t.currency,
      amountTWD: t.amountTWD,
      effective: effectiveAmountTWD(t),
      category: t.category,
      paymentMethod: t.paymentMethod,
      payer: t.payerId ?? '',
      shareType: t.shareType ?? '',
      memberShares: shareByTx.get(t.id) ?? '',
      note: t.note ?? '',
    }));
  downloadText(`trip-${trip.name}-${formatDate(new Date())}.csv`, toCsv(rows));
}

export function exportTripMarkdown(trip: Trip, txs: Transaction[]) {
  const valid = txs.filter((t) => !t.deletedAt);
  const totalTWD = valid
    .filter((t) => t.type === 'expense')
    .reduce((s, t) => s + effectiveAmountTWD(t), 0);

  const settlement = (trip.members && trip.members.length > 0)
    ? computeSettlement(trip.members, valid)
    : null;

  const lines: string[] = [];
  lines.push(`# ${trip.name}`);
  lines.push(``);
  lines.push(`- **目的地**: ${trip.destination.join(' · ')}`);
  lines.push(`- **日期**: ${formatDate(trip.startDate)} ~ ${formatDate(trip.endDate)}`);
  lines.push(`- **狀態**: ${trip.status}`);
  if (trip.budget) lines.push(`- **預算**: NT$${Math.round(trip.budget).toLocaleString()}`);
  lines.push(`- **總支出**: NT$${Math.round(totalTWD).toLocaleString()}`);
  lines.push(``);

  if (settlement && settlement.balances.length > 0) {
    lines.push(`## 分攤結算`);
    lines.push('');
    lines.push('| 成員 | 代墊 | 代墊比例 | 應付 | 應付比例 | 淨額 |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const b of settlement.balances) {
      lines.push(`| ${b.name} | NT$${Math.round(b.paid).toLocaleString()} | ${b.paidPct.toFixed(1)}% | NT$${Math.round(b.share).toLocaleString()} | ${b.sharePct.toFixed(1)}% | ${b.net >= 0 ? '+' : ''}NT$${Math.round(b.net).toLocaleString()} |`);
    }
    lines.push('');

    lines.push('### 成員分類與明細');
    lines.push('');
    for (const b of settlement.balances) {
      lines.push(`#### ${b.name}`);
      lines.push('');
      if (b.categories.length > 0) {
        lines.push('| 分類 | 金額 | 個人比例 |');
        lines.push('|---|---:|---:|');
        for (const c of b.categories) {
          lines.push(`| ${c.category} | NT$${Math.round(c.amountTWD).toLocaleString()} | ${c.pctOfMemberShare.toFixed(1)}% |`);
        }
        lines.push('');
      }
      if (b.details.length > 0) {
        lines.push('| 日期 | 類別 | 應付 | 交易比例 | 付款人 | 備註 |');
        lines.push('|---|---|---:|---:|---|---|');
        for (const d of b.details) {
          lines.push(`| ${formatDate(d.date)} | ${d.category} | NT$${Math.round(d.shareTWD).toLocaleString()} | ${d.sharePctOfTx.toFixed(1)}% | ${d.payerName} | ${(d.note ?? '').replace(/\|/g, '\\|')} |`);
        }
        lines.push('');
      }
    }

    if (settlement.transfers.length > 0) {
      lines.push('### 建議結清');
      for (const t of settlement.transfers) {
        lines.push(`- **${t.fromName}** → **${t.toName}** : NT$${Math.round(t.amount).toLocaleString()}`);
      }
      lines.push('');
    }
  }

  lines.push(`## 花費明細`);
  lines.push('');
  lines.push('| 日期 | 類別 | 付款人 | 金額 | 分攤 | 備註 |');
  lines.push('|---|---|---|---:|---|---|');
  const detailByTx = new Map((settlement?.transactionDetails ?? []).map((d) => [d.txId, d]));
  for (const t of valid.sort((a, b) => a.date.getTime() - b.date.getTime())) {
    const amt = `${t.amount} ${t.currency}${t.currency !== 'TWD' ? ` ≈ NT$${Math.round(effectiveAmountTWD(t))}` : ''}`;
    const detail = detailByTx.get(t.id);
    const payer = detail?.payerName ?? t.payerId ?? t.paymentMethod;
    const shares = detail
      ? detail.shares.map((s) => `${s.memberName} NT$${Math.round(s.amountTWD).toLocaleString()} (${s.pctOfTx.toFixed(1)}%)`).join('<br>')
      : '';
    lines.push(`| ${formatDate(t.date)} | ${t.category} | ${payer} | ${amt} | ${shares} | ${(t.note ?? '').replace(/\|/g, '\\|')} |`);
  }

  downloadText(
    `trip-${trip.name}-${formatDate(new Date())}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  );
}
