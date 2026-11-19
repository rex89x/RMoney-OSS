import { useMemo, useState } from 'react';
import { Scale, Copy, AlertTriangle, ListTodo } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/use-auth';
import { useAccounts } from '@/features/accounts/hooks';
import { cn, formatCurrency, formatPercent } from '@/lib/utils';
import { useLatestSnapshot } from '../hooks';
import { useAddInboxTodos } from '@/features/inbox/hooks';
import { computeRebalance, type RebalancePlan } from '../rebalance';

const CASH_TYPES = ['cash', 'bank', 'investment_cash', 'e_wallet_balance'];

export function RebalanceCalculator() {
  const { profile } = useAuth();
  const { data: snapshot } = useLatestSnapshot();
  const { data: accounts = [] } = useAccounts();
  const targets = useMemo(() => profile?.preferences?.allocationTargets ?? [], [profile?.preferences?.allocationTargets]);
  const [contribution, setContribution] = useState('');
  const [sellAllowed, setSellAllowed] = useState(false);
  const addTodos = useAddInboxTodos();

  const cashTWD = useMemo(
    () => accounts.filter((a) => a.active && CASH_TYPES.includes(a.type)).reduce((s, a) => s + Math.max(0, a.balanceTWD), 0),
    [accounts],
  );
  const investCashTWD = useMemo(
    () => accounts.filter((a) => a.active && a.type === 'investment_cash').reduce((s, a) => s + Math.max(0, a.balanceTWD), 0),
    [accounts],
  );

  const plan: RebalancePlan | null = useMemo(() => {
    if (!snapshot || targets.length === 0) return null;
    return computeRebalance({
      snapshot,
      targets,
      cashTWD,
      contributionTWD: parseFloat(contribution) || 0,
      sellAllowed,
    });
  }, [snapshot, targets, cashTWD, contribution, sellAllowed]);

  if (!snapshot || targets.length === 0) return null;

  const netCashNeeded = plan ? plan.buyTotalTWD - plan.sellTotalTWD : 0;
  const cashShort = netCashNeeded > investCashTWD + (parseFloat(contribution) || 0);

  async function addPlanToInbox() {
    if (!plan) return;
    const todos = plan.groups.flatMap((g) => g.lines.map((l) => ({
      title: `${l.shares > 0 ? '買' : '賣'} ${l.symbol} ${Math.abs(l.shares).toLocaleString()} 股 ≈ ${formatCurrency(Math.abs(l.amountTWD))}`,
      detail: `再平衡：${g.label} 目標 ${g.targetPct}% / 實際 ${g.actualPct.toFixed(1)}%`,
      href: '/investments?tab=portfolio',
    })));
    if (todos.length === 0) { toast.info('目前沒有需要執行的買賣'); return; }
    await addTodos.mutateAsync(todos);
  }

  function copyPlan() {
    if (!plan) return;
    const lines: string[] = [`再平衡建議（總額 ${formatCurrency(plan.totalTWD)}）`];
    for (const g of plan.groups) {
      lines.push(`${g.label}：目標 ${g.targetPct}% / 實際 ${g.actualPct.toFixed(1)}% → ${g.deltaTWD >= 0 ? '加碼' : '減碼'} ${formatCurrency(Math.abs(g.deltaTWD))}`);
      for (const l of g.lines) lines.push(`  ${l.shares > 0 ? '買' : '賣'} ${l.symbol} ${Math.abs(l.shares)} 股 ≈ ${formatCurrency(Math.abs(l.amountTWD))}`);
    }
    void navigator.clipboard.writeText(lines.join('\n')).then(() => toast.success('已複製建議'));
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Scale className="size-4" /> 再平衡計算</span>
          <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => void addPlanToInbox()} disabled={!plan || addTodos.isPending}><ListTodo className="size-3.5" /> 加入待辦</Button>
            <Button size="sm" variant="ghost" onClick={copyPlan} disabled={!plan}><Copy className="size-3.5" /> 複製</Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label className="text-xs text-muted-foreground">額外投入 (TWD)</Label>
            <Input
              type="number" inputMode="decimal" placeholder="0"
              value={contribution} onChange={(e) => setContribution(e.target.value)}
              className="mt-1 h-9"
            />
          </div>
          <div className="flex items-end gap-2 pb-1">
            <Switch checked={sellAllowed} onCheckedChange={setSellAllowed} id="rebalance-sell" />
            <Label htmlFor="rebalance-sell" className="text-sm">允許賣出超配部位</Label>
          </div>
          <div className="text-xs text-muted-foreground sm:text-right">
            <div>投資帳戶現金 {formatCurrency(investCashTWD)}</div>
            <div>所有現金類 {formatCurrency(cashTWD)}</div>
          </div>
        </div>

        {plan ? (
          <>
            <ul className="divide-y rounded-xl border text-sm">
              {plan.groups.map((g) => (
                <li key={g.key} className="space-y-1.5 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{g.label}</span>
                    <Badge variant="outline" className="font-normal">目標 {g.targetPct}%</Badge>
                    <Badge variant={Math.abs(g.actualPct - g.targetPct) < 5 ? 'success' : 'warning'} className="font-normal">
                      實際 {formatPercent(g.actualPct, 1)}
                    </Badge>
                    <span className={cn('ml-auto tabular-nums', g.deltaTWD >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
                      {Math.abs(g.deltaTWD) < 1 ? '已平衡' : `${g.deltaTWD >= 0 ? '加碼' : '減碼'} ${formatCurrency(Math.abs(g.deltaTWD))}`}
                    </span>
                  </div>
                  {g.lines.length > 0 ? (
                    <ul className="space-y-0.5 pl-1 text-xs">
                      {g.lines.map((l) => (
                        <li key={l.symbol} className="flex items-center justify-between gap-2">
                          <span>
                            <span className={cn('mr-1 rounded px-1 py-0.5 text-[10px] font-medium', l.shares > 0 ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400')}>
                              {l.shares > 0 ? '買' : '賣'}
                            </span>
                            {l.symbol} {Math.abs(l.shares).toLocaleString()} 股
                            <span className="ml-1 text-muted-foreground">@ {l.currentPrice}{l.market === 'US' ? ' USD' : ''}</span>
                          </span>
                          <span className="tabular-nums text-muted-foreground">≈ {formatCurrency(Math.abs(l.amountTWD))}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {Math.abs(g.unallocatedTWD) >= 1 && Math.abs(g.deltaTWD) >= 1 && (g.key === 'TW' || g.key === 'US') ? (
                    <p className="text-[11px] text-muted-foreground">
                      其中 {formatCurrency(Math.abs(g.unallocatedTWD))} 因股數取整或無持倉無法拆到個股。
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>買入合計 {formatCurrency(plan.buyTotalTWD)}</span>
              <span>賣出合計 {formatCurrency(plan.sellTotalTWD)}</span>
              <span>淨需現金 {formatCurrency(Math.max(0, netCashNeeded))}</span>
              {cashShort ? (
                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3" /> 投資帳戶現金不足，需先入金 {formatCurrency(netCashNeeded - investCashTWD - (parseFloat(contribution) || 0))}
                </span>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">
              以最新投資快照的收盤價與匯率估算；台股以零股計，實際成交價、手續費與稅未計入。
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
