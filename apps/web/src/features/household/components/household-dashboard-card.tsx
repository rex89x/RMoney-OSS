import { useNavigate } from 'react-router-dom';
import { HeartHandshake, PiggyBank } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/utils';
import { buildCategoryBudgetRows, forecastMonth } from '../analytics';
import { useActiveHousehold, useHouseholdBalance, useHouseholdFundSummary, useHouseholdMonthSummary } from '../hooks';

/** 首頁「共同帳」卡：誰欠誰 + 本月共同支出（有啟用 household 才顯示） */
export function HouseholdDashboardCard() {
  const household = useActiveHousehold();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { debts } = useHouseholdBalance(household);
  const { summary } = useHouseholdMonthSummary(household);
  const { summary: fund } = useHouseholdFundSummary(household);
  if (!household) return null;
  const myUid = user?.uid ?? '';
  const debt = debts[0] ?? null;
  const budget = household.monthlyBudgetTWD ?? null;
  const pct = budget && budget > 0 ? Math.min(100, (summary.totalTWD / budget) * 100) : null;
  const forecast = forecastMonth(summary.totalTWD, budget);
  const overCategories = buildCategoryBudgetRows(summary.byCategory, household.categoryBudgets ?? {})
    .filter((row) => row.state === 'over').length;
  const otherName = (uid: string) => household.members[uid]?.displayName ?? '對方';

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-muted/40"
      onClick={() => navigate('/shared')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate('/shared'); }}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><HeartHandshake className="size-4" /> {household.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-sm">
          {debt ? (
            debt.toUid === myUid
              ? <><span className="font-medium">{otherName(debt.fromUid)}</span> 還要付你 <span className="font-semibold tabular-nums">{formatCurrency(debt.amountTWD)}</span></>
              : debt.fromUid === myUid
                ? <>你還要付 <span className="font-medium">{otherName(debt.toUid)}</span> <span className="font-semibold tabular-nums">{formatCurrency(debt.amountTWD)}</span></>
                : <>待結算 {formatCurrency(debt.amountTWD)}</>
          ) : <span className="text-muted-foreground">兩不相欠</span>}
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>本月共同支出</span>
          <span className="tabular-nums">{formatCurrency(summary.totalTWD)}{budget ? ` / ${formatCurrency(budget)}` : ''}</span>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><PiggyBank className="size-3.5" /> 公基金</span>
          <span className={`tabular-nums ${fund.balanceTWD < 0 ? 'text-destructive' : ''}`}>{formatCurrency(fund.balanceTWD)}</span>
        </div>
        {fund.outstandingTWD > 0 ? (
          <div className="flex items-center justify-between text-xs text-warning">
            <span>{household.fundKeeperUid === myUid ? '你要從公基金轉出' : (fund.owedToMember[myUid] ?? 0) > 0 ? '公基金還要轉給你' : '公基金待撥還'}</span>
            <span className="tabular-nums">
              {formatCurrency(household.fundKeeperUid !== myUid && (fund.owedToMember[myUid] ?? 0) > 0 ? fund.owedToMember[myUid] ?? 0 : fund.outstandingTWD)}
            </span>
          </div>
        ) : null}
        {budget ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>月底推估</span>
            <span className={`tabular-nums ${forecast.projectedOverBudget ? 'text-warning' : ''}`}>{formatCurrency(forecast.projectedTWD)}</span>
          </div>
        ) : null}
        {overCategories > 0 ? (
          <div className="text-xs text-destructive">{overCategories} 個類別超出預算</div>
        ) : null}
        {pct != null ? (
          <div>
            <Progress value={pct} className="h-1.5" />
            <div className={`mt-0.5 text-right text-[10px] ${pct >= 100 ? 'text-destructive' : pct >= 80 ? 'text-warning' : 'text-muted-foreground'}`}>
              {Math.round(pct)}%
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
