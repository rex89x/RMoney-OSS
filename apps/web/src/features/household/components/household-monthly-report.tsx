import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, PiggyBank } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/utils';
import { formatTW, monthTWRange, nowTW } from '@/lib/tz';
import { resolveIcon } from '@/lib/icons';
import { useCategories } from '@/features/ledger/hooks';
import { useHouseholdFundEntries, useHouseholdTransactions, useSettlements } from '../hooks';
import { sharesOfTx, summarizeHouseholdTxs } from '../balance';
import { effectiveAmountTWD } from '@/features/ledger/types';
import { HOUSEHOLD_FUND_COLOR } from '../entries';
import { HOUSEHOLD_FUND_PAYER_ID, type Household } from '../types';
import { MemberChip } from './member-chip';

/** 月報：某個月的共同支出總額、各自付了 / 應付、類別分布、當月結算 */
export function HouseholdMonthlyReport({ household }: { household: Household }) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const [ym, setYm] = useState(() => {
    const n = nowTW();
    return { y: n.getFullYear(), m: n.getMonth() + 1 };
  });
  const range = useMemo(() => monthTWRange(ym.y, ym.m), [ym]);
  const { data: txs = [], isLoading } = useHouseholdTransactions({ startDate: range.start, endDate: range.end, limit: 2000 }, household.id);
  const { data: settlements = [] } = useSettlements(household.id);
  const { data: fundEntries = [] } = useHouseholdFundEntries(household.id);
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c])), [categories]);

  const summary = useMemo(() => summarizeHouseholdTxs(txs, household.memberIds), [txs, household.memberIds]);
  const shareByMember = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of household.memberIds) out[id] = 0;
    for (const t of txs) {
      if (t.deletedAt || t.type !== 'expense') continue;
      const shares = sharesOfTx(t, household.memberIds);
      for (const [id, v] of Object.entries(shares)) out[id] = (out[id] ?? 0) + v;
    }
    return out;
  }, [txs, household.memberIds]);
  const monthSettlements = useMemo(
    () => settlements.filter((s) => s.date >= range.start && s.date <= range.end),
    [settlements, range],
  );
  /** 本月公基金：誰存了多少 + 公基金付掉多少 */
  const fund = useMemo(() => {
    const byMember: Record<string, number> = {};
    for (const id of household.memberIds) byMember[id] = 0;
    let contributions = 0;
    for (const entry of fundEntries) {
      // 撥還給先墊的成員不是存入，不算進月報的公基金存入
      if (entry.type === 'reimbursement' || entry.date < range.start || entry.date > range.end) continue;
      contributions += entry.amountTWD;
      if (entry.contributorUid) {
        byMember[entry.contributorUid] = (byMember[entry.contributorUid] ?? 0) + entry.amountTWD;
      }
    }
    const spent = summary.byPayer[HOUSEHOLD_FUND_PAYER_ID] ?? 0;
    return { byMember, contributions, spent, net: contributions - spent };
  }, [fundEntries, range, household.memberIds, summary.byPayer]);
  const budget = household.monthlyBudgetTWD ?? null;
  const budgetPct = budget && budget > 0 ? Math.min(100, (summary.totalTWD / budget) * 100) : null;
  const isCurrent = (() => { const n = nowTW(); return n.getFullYear() === ym.y && n.getMonth() + 1 === ym.m; })();

  function shift(delta: number) {
    const d = new Date(ym.y, ym.m - 1 + delta, 1);
    setYm({ y: d.getFullYear(), m: d.getMonth() + 1 });
  }

  async function copySummary() {
    const name = (id: string) => household.members[id]?.displayName ?? id;
    const lines = [
      `${household.name} ${ym.y}/${String(ym.m).padStart(2, '0')} 月報`,
      `共同支出 ${formatCurrency(summary.totalTWD)}（${summary.count} 筆）${budget ? ` · 預算 ${formatCurrency(budget)}` : ''}`,
      ...household.memberIds.map((id) => `${name(id)}：付了 ${formatCurrency(summary.byPayer[id] ?? 0)}，應付 ${formatCurrency(shareByMember[id] ?? 0)}，差額 ${formatCurrency((summary.byPayer[id] ?? 0) - (shareByMember[id] ?? 0))}`),
      ...(fund.contributions > 0 || fund.spent > 0
        ? [
          `公基金：存入 ${formatCurrency(fund.contributions)}，支付 ${formatCurrency(fund.spent)}，淨 ${formatCurrency(fund.net)}`,
          ...household.memberIds
            .filter((id) => (fund.byMember[id] ?? 0) > 0)
            .map((id) => `  ${name(id)} 存入 ${formatCurrency(fund.byMember[id] ?? 0)}`),
        ]
        : []),
      ...(summary.byCategory.length ? ['類別：', ...summary.byCategory.slice(0, 8).map((r) => `  ${catMap[r.key]?.name ?? r.key} ${formatCurrency(r.totalTWD)}`)] : []),
      ...(monthSettlements.length ? ['結算：', ...monthSettlements.map((s) => `  ${formatTW(s.date, 'MM/dd')} ${name(s.fromUid)} → ${name(s.toUid)} ${formatCurrency(s.amountTWD)}`)] : []),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success('已複製月報');
    } catch {
      toast.error('複製失敗');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" onClick={() => shift(-1)} aria-label="上個月"><ChevronLeft className="size-4" /></Button>
          <span className="min-w-[7rem] text-center font-medium tabular-nums">{ym.y} / {String(ym.m).padStart(2, '0')}</span>
          <Button size="icon-sm" variant="ghost" onClick={() => shift(1)} disabled={isCurrent} aria-label="下個月"><ChevronRight className="size-4" /></Button>
        </div>
        <Button size="sm" variant="outline" onClick={() => void copySummary()}><Copy className="size-3.5" /> 複製月報</Button>
      </div>

      {isLoading ? <Skeleton className="h-40" /> : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-base">總覽</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="text-2xl font-semibold tabular-nums">{formatCurrency(summary.totalTWD)}</div>
              <div className="text-xs text-muted-foreground">{summary.count} 筆共同支出</div>
              {(summary.byPayer[HOUSEHOLD_FUND_PAYER_ID] ?? 0) > 0 ? (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <PiggyBank className="size-3.5" /> 公基金支付 {formatCurrency(summary.byPayer[HOUSEHOLD_FUND_PAYER_ID] ?? 0)}
                </div>
              ) : null}
              {budget && budgetPct != null ? (
                <div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>共同預算 {formatCurrency(budget)}</span>
                    <span className={budgetPct >= 100 ? 'text-destructive' : budgetPct >= 80 ? 'text-warning' : ''}>{Math.round(budgetPct)}%</span>
                  </div>
                  <Progress value={budgetPct} className="mt-1" />
                </div>
              ) : null}
              <ul className="space-y-2 text-sm">
                {household.memberIds.map((id) => {
                  const paid = summary.byPayer[id] ?? 0;
                  const share = shareByMember[id] ?? 0;
                  const diff = paid - share;
                  return (
                    <li key={id} className="rounded-md border p-2">
                      <div className="flex items-center justify-between">
                        <MemberChip member={household.members[id]} suffix={id === myUid ? '（我）' : ''} />
                        <span className={`text-xs tabular-nums ${diff > 0.5 ? 'text-success' : diff < -0.5 ? 'text-destructive' : 'text-muted-foreground'}`}>
                          {diff > 0.5 ? `多付 ${formatCurrency(diff)}` : diff < -0.5 ? `少付 ${formatCurrency(-diff)}` : '剛好'}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground tabular-nums">付了 {formatCurrency(paid)} · 應付 {formatCurrency(share)}</div>
                    </li>
                  );
                })}
              </ul>
              {monthSettlements.length > 0 ? (
                <div className="text-xs text-muted-foreground">
                  本月結算：{monthSettlements.map((s) => `${household.members[s.fromUid]?.displayName ?? '?'} → ${household.members[s.toUid]?.displayName ?? '?'} ${formatCurrency(s.amountTWD)}`).join('、')}
                </div>
              ) : null}

              <div className="rounded-md border p-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <PiggyBank className="size-4" style={{ color: HOUSEHOLD_FUND_COLOR }} /> 本月公基金
                  </span>
                  <span className={`text-xs tabular-nums ${fund.net > 0.5 ? 'text-success' : fund.net < -0.5 ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {fund.net > 0.5 ? `淨增 ${formatCurrency(fund.net)}` : fund.net < -0.5 ? `淨減 ${formatCurrency(-fund.net)}` : '持平'}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
                  <span className="text-success">存入 {formatCurrency(fund.contributions)}</span>
                  <span>支付 {formatCurrency(fund.spent)}</span>
                </div>
                {fund.contributions > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {household.memberIds.map((id) => (
                      <span key={id} className="inline-flex items-center gap-1">
                        <MemberChip member={household.members[id]} className="text-xs" />
                        存入 {formatCurrency(fund.byMember[id] ?? 0)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">類別</CardTitle></CardHeader>
            <CardContent>
              {summary.byCategory.length === 0 ? <p className="text-sm text-muted-foreground">這個月沒有共同支出</p> : (
                <ul className="space-y-2">
                  {summary.byCategory.map((row) => {
                    const cat = catMap[row.key];
                    const Icon = resolveIcon(cat?.icon);
                    const pct = summary.totalTWD > 0 ? (row.totalTWD / summary.totalTWD) * 100 : 0;
                    const count = txs.filter((t) => t.category === row.key && !t.deletedAt && t.type === 'expense').length;
                    return (
                      <li key={row.key} className="text-xs">
                        <div className="flex items-center justify-between">
                          <span className="inline-flex items-center gap-1.5"><Icon className="size-3.5" style={{ color: cat?.color }} />{cat?.name ?? row.key} <span className="text-muted-foreground">· {count} 筆</span></span>
                          <span className="tabular-nums">{formatCurrency(row.totalTWD)} <span className="text-muted-foreground">({Math.round(pct)}%)</span></span>
                        </div>
                        <Progress value={pct} className="mt-0.5 h-1" />
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                最大單筆：{(() => {
                  const top = txs.filter((t) => !t.deletedAt && t.type === 'expense').sort((a, b) => effectiveAmountTWD(b) - effectiveAmountTWD(a))[0];
                  return top ? `${catMap[top.category]?.name ?? top.category}${top.note ? ` · ${top.note}` : ''} ${formatCurrency(effectiveAmountTWD(top))}` : '—';
                })()}
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
