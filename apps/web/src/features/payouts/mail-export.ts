import { formatTW } from '@/lib/tz';
import {
  paidTotalTWD,
  participantBaseAmountTWD,
  participantSharedContributionTWD,
  pendingTotalTWD,
  type PayoutGroup,
  type PayoutParticipant,
} from './types';

export interface PayoutMailContent {
  subject: string;
  plainText: string;
  htmlFragment: string;
  htmlDocument: string;
  outlookUrl: string;
  fileName: string;
}

const FONT_FAMILY = 'Arial, "Microsoft JhengHei", "Noto Sans TC", sans-serif';

export function buildPayoutMailContent(g: PayoutGroup): PayoutMailContent {
  const subject = `[墊付明細] ${g.title}`;
  const plainText = buildPayoutMailPlainText(g);
  const htmlFragment = buildPayoutMailHtmlFragment(g);
  const htmlDocument = buildPayoutMailHtmlDocument(g, htmlFragment);
  const outlookUrl = buildOutlookComposeUrl(subject, htmlFragment);
  const fileName = `payout-${formatTW(g.date, 'yyyyMMdd')}-${slugify(g.title)}.html`;

  return { subject, plainText, htmlFragment, htmlDocument, outlookUrl, fileName };
}

export function buildPayoutMailPlainText(g: PayoutGroup): string {
  const lines: string[] = [];
  lines.push('大家好，以下是本次墊付明細，請依「應繳金額」轉帳給我；已繳的同仁可忽略，謝謝！');
  lines.push('');
  lines.push(`活動：${g.title}`);
  lines.push(`日期：${formatTW(g.date, 'yyyy/MM/dd')}`);
  lines.push(`總額：NT$${formatNum(g.totalAmountTWD)}`);
  if (g.note) lines.push(`備註：${g.note}`);
  lines.push('');
  lines.push('姓名 | 原始金額 | 分攤說明 | 應繳金額 | 狀態');
  lines.push('--- | ---: | --- | ---: | ---');
  g.participants.forEach((p) => {
    const status = p.paidAt ? '已繳' : p.amountTWD <= 0 ? '免繳' : '待繳';
    lines.push([
      p.name,
      `NT$${formatNum(participantBaseAmountTWD(p))}`,
      participantMailSplitNote(p),
      `NT$${formatNum(p.amountTWD)}`,
      status,
    ].join(' | '));
  });
  lines.push('');
  lines.push(`已收：NT$${formatNum(paidTotalTWD(g))}`);
  lines.push(`待收：NT$${formatNum(pendingTotalTWD(g))}`);
  lines.push('');
  lines.push('謝謝大家。');
  return lines.join('\n');
}

function buildPayoutMailHtmlFragment(g: PayoutGroup): string {
  const rows = g.participants.map((p, index) => buildParticipantRow(p, index)).join('');
  const noteRow = g.note
    ? `
      <tr>
        <td style="width:72px;padding:6px 0;color:#8a7a65;font-weight:700;">備註</td>
        <td style="padding:6px 0;color:#2f2a24;font-weight:700;">${escapeHtml(g.note)}</td>
      </tr>`
    : '';

  return `
<div style="margin:0;background:#f8f1e8;color:#2f2a24;font-family:${FONT_FAMILY};font-size:16px;line-height:1.6;">
  <div style="max-width:920px;margin:0 auto;padding:24px;">
    <p style="margin:0 0 22px;font-size:22px;font-weight:700;color:#5a4c3c;">
      大家好，以下是本次墊付明細，請依 <span style="color:#b66a14;">「應繳金額」</span> 轉帳給我；已繳的同仁可忽略，謝謝！
    </p>

    <section style="overflow:hidden;margin:0 0 26px;border-radius:14px;background:#ffffff;">
      <div style="background:#684724;color:#ffffff;padding:22px 36px;font-size:26px;font-weight:800;">
        ${escapeHtml(g.title)}
      </div>
      <div style="padding:26px 36px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:20px;">
          <tbody>
            <tr>
              <td style="width:72px;padding:6px 0;color:#8a7a65;font-weight:700;">日期</td>
              <td style="padding:6px 0;color:#2f2a24;font-weight:800;">${formatTW(g.date, 'yyyy/MM/dd')}</td>
            </tr>
            <tr>
              <td style="width:72px;padding:6px 0;color:#8a7a65;font-weight:700;">總額</td>
              <td style="padding:6px 0;color:#b66a14;font-weight:800;">NT$${formatNum(g.totalAmountTWD)}</td>
            </tr>
            ${noteRow}
          </tbody>
        </table>
      </div>
    </section>

    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;overflow:hidden;border-radius:14px;background:#ffffff;font-size:19px;">
      <thead>
        <tr>
          <th align="left" style="padding:18px 24px;background:#f0e5cf;border-bottom:3px solid #dccaa5;color:#5a3f22;font-weight:800;">姓名</th>
          <th align="right" style="padding:18px 24px;background:#f0e5cf;border-bottom:3px solid #dccaa5;color:#5a3f22;font-weight:800;">原始金額</th>
          <th align="left" style="padding:18px 24px;background:#f0e5cf;border-bottom:3px solid #dccaa5;color:#5a3f22;font-weight:800;">分攤說明</th>
          <th align="right" style="padding:18px 24px;background:#f0e5cf;border-bottom:3px solid #dccaa5;color:#5a3f22;font-weight:800;">應繳金額</th>
          <th align="center" style="padding:18px 24px;background:#f0e5cf;border-bottom:3px solid #dccaa5;color:#5a3f22;font-weight:800;">狀態</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:16px;margin:18px -16px 8px;">
      <tr>
        <td style="width:50%;padding:22px 30px;border-radius:14px;background:#e6f4e9;color:#238552;">
          <div style="font-size:18px;color:#5f7567;">已收</div>
          <div style="margin-top:8px;font-size:30px;font-weight:900;">NT$${formatNum(paidTotalTWD(g))}</div>
        </td>
        <td style="width:50%;padding:22px 30px;border-radius:14px;background:#fff2d8;color:#b66a14;">
          <div style="font-size:18px;color:#907854;">待收</div>
          <div style="margin-top:8px;font-size:30px;font-weight:900;">NT$${formatNum(pendingTotalTWD(g))}</div>
        </td>
      </tr>
    </table>

    <p style="margin:22px 0 0;color:#8a7a65;font-size:20px;font-weight:700;">謝謝大家</p>
  </div>
</div>`.trim();
}

function buildPayoutMailHtmlDocument(g: PayoutGroup, fragment: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(g.title)} 墊付明細</title>
</head>
<body style="margin:0;background:#f8f1e8;">
${fragment}
</body>
</html>`;
}

function buildParticipantRow(p: PayoutParticipant, index: number): string {
  const base = participantBaseAmountTWD(p);
  const amount = p.amountTWD || 0;
  const isWaived = amount <= 0;
  const isPaid = Boolean(p.paidAt);
  const status = isPaid ? '已繳' : isWaived ? '免繳' : '待繳';
  const statusStyle = isPaid
    ? 'background:#dff2e6;color:#238552;'
    : isWaived
      ? 'background:#efebe4;color:#8a7a65;'
      : 'background:#fff0d3;color:#b66a14;';
  const amountColor = isPaid || isWaived ? '#238552' : '#2f2a24';
  const bg = index % 2 === 1 ? '#fff8ef' : '#ffffff';
  const birthdayLabel = p.sharedByOthers ? ' <span style="margin-left:8px;color:#b66a14;font-size:15px;">(壽星)</span>' : '';

  return `
        <tr>
          <td style="padding:18px 24px;border-bottom:1px solid #eadcc7;background:${bg};color:#2f2a24;font-weight:800;">${escapeHtml(p.name)}${birthdayLabel}</td>
          <td align="right" style="padding:18px 24px;border-bottom:1px solid #eadcc7;background:${bg};color:#8a7a65;font-weight:700;">NT$${formatNum(base)}</td>
          <td style="padding:18px 24px;border-bottom:1px solid #eadcc7;background:${bg};color:#6d5f4e;font-weight:700;">${escapeHtml(participantMailSplitNote(p))}</td>
          <td align="right" style="padding:18px 24px;border-bottom:1px solid #eadcc7;background:${bg};color:${amountColor};font-weight:900;">NT$${formatNum(amount)}</td>
          <td align="center" style="padding:18px 24px;border-bottom:1px solid #eadcc7;background:${bg};">
            <span style="display:inline-block;min-width:54px;border-radius:999px;padding:6px 14px;font-size:16px;font-weight:800;${statusStyle}">${status}</span>
          </td>
        </tr>`;
}

function participantMailSplitNote(p: PayoutParticipant): string {
  const contribution = participantSharedContributionTWD(p);
  if (p.sharedByOthers) return '由其他同仁分攤';
  if (contribution > 0) return `含分攤 +NT$${formatNum(contribution)}`;
  return '-';
}

function buildOutlookComposeUrl(subject: string, htmlBody: string): string {
  const params = new URLSearchParams({
    subject,
    body: htmlBody,
  });
  return `https://outlook.office.com/mail/deeplink/compose?${params.toString()}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatNum(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'detail';
}
