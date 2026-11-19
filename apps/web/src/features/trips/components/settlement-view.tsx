import { useMemo } from 'react';
import { ArrowRight, Calculator, Copy, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useCategories, useTransactions } from '@/features/ledger/hooks';
import { useActiveHousehold } from '@/features/household/hooks';
import { computeSettlement } from '../settlement';
import type { Trip } from '../types';

export function SettlementView({ trip }: { trip: Trip }) {
  const { data: txs = [] } = useTransactions({ tripId: trip.id, limit: 500 });
  const { data: categories = [] } = useCategories();
  const members = useMemo(() => trip.members ?? [], [trip.members]);
  const catMap = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.key, c.name])),
    [categories],
  );

  const household = useActiveHousehold();
  const householdMemberIds = household?.memberIds;
  const result = useMemo(
    () => computeSettlement(members, txs, { householdMemberIds }),
    [members, txs, householdMemberIds],
  );
  const householdCount = txs.filter((tx) => !tx.deletedAt && tx.type === 'expense' && tx.householdId).length;

  function buildReportText(): string {
    const lines: string[] = [];
    lines.push(`${trip.name} 結算明細`);
    lines.push(`期間：${formatTW(trip.startDate, 'yyyy/MM/dd')} – ${formatTW(trip.endDate, 'yyyy/MM/dd')}`);
    lines.push(`目的地：${trip.destination.join(' · ')}`);
    lines.push('');
    lines.push(`總支出：${formatCurrency(result.totalSpent)}`);
    lines.push('');

    lines.push('成員總覽：');
    for (const b of result.balances) {
      const tag = b.net > 0.5 ? '應收' : b.net < -0.5 ? '應付' : '平';
      lines.push(`- ${b.name}：代墊 ${formatCurrency(b.paid)}（${formatPercent(b.paidPct, 1)}）、應付 ${formatCurrency(b.share)}（${formatPercent(b.sharePct, 1)}）、淨 ${b.net >= 0 ? '+' : ''}${formatCurrency(b.net)}（${tag}）`);
      if (b.categories.length > 0) {
        lines.push(`  分類：${b.categories.map((c) => `${catMap[c.category] ?? c.category} ${formatCurrency(c.amountTWD)} / ${formatPercent(c.pctOfMemberShare, 1)}`).join('、')}`);
      }
    }
    lines.push('');

    if (result.transfers.length > 0) {
      lines.push('最少轉帳建議：');
      for (const t of result.transfers) {
        lines.push(`- ${t.fromName} → ${t.toName}：${formatCurrency(t.amount)}`);
      }
      lines.push('');
    }

    const expense = txs.filter((t) => !t.deletedAt && t.type === 'expense');
    if (expense.length > 0) {
      lines.push('逐筆明細：');
      for (const detail of result.transactionDetails) {
        const date = formatTW(detail.date, 'MM/dd');
        const cat = catMap[detail.category] ?? detail.category;
        const noteSuffix = detail.note ? ` · ${detail.note}` : '';
        const shares = detail.shares
          .map((s) => `${s.memberName} ${formatCurrency(s.amountTWD)} / ${formatPercent(s.pctOfTx, 1)}`)
          .join('、');
        lines.push(`- ${date} [${cat}] ${formatCurrency(detail.amountTWD)}（付：${detail.payerName}；${detail.shareLabel}；${shares}）${noteSuffix}`);
      }
    }
    return lines.join('\n');
  }

  async function copyReport() {
    const text = buildReportText();
    try {
      await navigator.clipboard.writeText(text);
      toast.success('已複製結算明細');
    } catch {
      toast.error('複製失敗，請手動選取');
    }
  }

  if (members.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          尚未設定成員。到上方「成員」區塊新增後，這裡會自動計算分攤。
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {householdCount > 0 ? (
        <p className="text-sm text-muted-foreground">
          有 {householdCount} 筆同時記在共同帳本：{household ? `${household.memberIds.map((id) => household.members[id]?.displayName ?? id).join('、')} 之間的錢在「共同」結算，這裡只列他們對其他旅伴的欠款。` : '共同帳本成員之間的錢請到「共同」結算。'}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => void copyReport()}>
          <Copy className="size-4" /> 複製結算明細
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Calculator className="size-4" /> 總覽</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="總支出" value={formatCurrency(result.totalSpent)} />
          <Stat label="已結算" value={formatCurrency(result.totalSettled)} />
          <Stat label="估算（未結算）" value={formatCurrency(result.totalEstimated)} />
          <Stat label="人均應付" value={formatCurrency(result.totalSpent / Math.max(1, members.length))} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Users className="size-4" /> 成員明細</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <ul className="divide-y rounded-md border">
            {result.balances.map((b) => (
              <li key={b.id} className="grid gap-3 p-3 text-sm md:grid-cols-[1fr,auto,auto] md:items-center">
                <div className="min-w-0">
                  <div className="font-medium">{b.name}</div>
                  <div className="text-xs text-muted-foreground">
                    代墊 {formatCurrency(b.paid)}（{formatPercent(b.paidPct, 1)}） · 應付 {formatCurrency(b.share)}（{formatPercent(b.sharePct, 1)}） · {b.txCount} 筆
                  </div>
                  <Progress value={Math.min(100, b.sharePct)} className="mt-2 h-1.5" />
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-muted-foreground">淨額</div>
                  <div className={b.net > 0.01 ? 'font-semibold text-success tabular-nums' : b.net < -0.01 ? 'font-semibold text-destructive tabular-nums' : 'tabular-nums'}>
                    {b.net > 0 ? '+' : ''}{formatCurrency(b.net)}
                  </div>
                </div>
                <Badge variant={b.net > 0.01 ? 'success' : b.net < -0.01 ? 'destructive' : 'secondary'}>
                  {b.net > 0.01 ? '應收' : b.net < -0.01 ? '應付' : '平'}
                </Badge>
              </li>
            ))}
          </ul>

          <div className="grid gap-3 lg:grid-cols-2">
            {result.balances.map((b) => (
              <section key={b.id} className="rounded-md border p-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">{b.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      個人應付 {formatCurrency(b.share)} · 佔總支出 {formatPercent(b.sharePct, 1)}
                    </p>
                  </div>
                  <Badge variant="outline">{b.txCount} 筆</Badge>
                </div>

                {b.categories.length > 0 ? (
                  <div className="mb-3 space-y-1.5">
                    {b.categories.map((c) => (
                      <div key={c.category} className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate">{catMap[c.category] ?? c.category}</span>
                          <span className="shrink-0 tabular-nums">
                            {formatCurrency(c.amountTWD)} · {formatPercent(c.pctOfMemberShare, 1)}
                          </span>
                        </div>
                        <Progress value={Math.min(100, c.pctOfMemberShare)} className="h-1" />
                      </div>
                    ))}
                  </div>
                ) : null}

                <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                  {b.details.map((d) => (
                    <li key={`${b.id}-${d.txId}`} className="rounded-md bg-muted/40 p-2 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium">
                            {formatTW(d.date, 'MM/dd')} · {catMap[d.category] ?? d.category}
                          </div>
                          <div className="truncate text-muted-foreground">
                            付：{d.payerName} · {d.shareLabel}{d.note ? ` · ${d.note}` : ''}
                          </div>
                        </div>
                        <div className="shrink-0 text-right tabular-nums">
                          <div className="font-semibold">{formatCurrency(d.shareTWD)}</div>
                          <div className="text-muted-foreground">{formatPercent(d.sharePctOfTx, 1)}</div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">建議結清（最少轉帳）</CardTitle></CardHeader>
        <CardContent>
          {result.transfers.length === 0 ? (
            <p className="text-sm text-muted-foreground">所有人淨額為零，不需要結算。</p>
          ) : (
            <ul className="space-y-1.5">
              {result.transfers.map((t, i) => (
                <li key={i} className="flex items-center gap-3 rounded-md border bg-card p-3 text-sm">
                  <span className="font-medium">{t.fromName}</span>
                  <ArrowRight className="size-4 text-muted-foreground" />
                  <span className="font-medium">{t.toName}</span>
                  <span className="ml-auto font-semibold tabular-nums">{formatCurrency(t.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">逐筆明細（含分攤）</CardTitle></CardHeader>
        <CardContent className="px-0 pb-2">
          <ul className="divide-y">
            {result.transactionDetails.map((t) => (
              <li key={t.txId} className="px-4 py-2.5 text-sm">
                <div className="flex items-start gap-2">
                  <div className="w-12 shrink-0 text-xs text-muted-foreground">
                    {formatTW(t.date, 'MM/dd')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{catMap[t.category] ?? t.category}</span>
                      {t.note ? <span className="truncate text-xs text-muted-foreground">{t.note}</span> : null}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      付：{t.payerName}；{t.shareLabel}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {t.shares.map((share) => (
                        <Badge key={`${t.txId}-${share.memberId}`} variant="secondary" className="font-normal">
                          {share.memberName} {formatCurrency(share.amountTWD)} / {formatPercent(share.pctOfTx, 0)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-sm font-medium tabular-nums">
                    {formatCurrency(t.amountTWD)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
