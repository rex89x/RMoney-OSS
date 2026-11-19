import { CircleDollarSign, Gauge, Landmark, PiggyBank, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { GoalsPanel } from '@/features/goals';
import { AllocationVsTarget, InvestmentPlanner } from '@/features/investments';
import { EmergencyFundCard } from '@/features/net-worth';
import { cn, formatCurrency, formatPercent } from '@/lib/utils';
import { useFinancialHealth } from '../use-financial-health';

export function FinancialPlanningPanel() {
  const health = useFinancialHealth();

  if (health.isLoading) {
    return <div className="grid gap-3 sm:grid-cols-2"><Skeleton className="h-32" /><Skeleton className="h-32" /></div>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4" /> 理財健檢
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <HealthMetric
              label="近3月儲蓄率"
              value={health.savingsRatePct === null ? '資料不足' : formatPercent(health.savingsRatePct, 1)}
              icon={PiggyBank}
              tone={health.savingsRatePct !== null && health.savingsRatePct < 0 ? 'bad' : 'neutral'}
            />
            <HealthMetric
              label="每月平均結餘"
              value={formatCurrency(health.averageMonthlySurplusTWD)}
              icon={CircleDollarSign}
              tone={health.averageMonthlySurplusTWD < 0 ? 'bad' : 'good'}
            />
            <HealthMetric
              label="緊急預備金"
              value={`${health.emergencyMonths.toFixed(1)} 個月`}
              icon={ShieldCheck}
              tone={health.emergencyMonths < 3 ? 'bad' : 'good'}
            />
            <HealthMetric
              label="每月投資規劃"
              value={formatCurrency(health.plannedMonthlyInvestmentTWD)}
              icon={Landmark}
            />
          </div>
          <div className="rounded-md border bg-muted/40 p-3">
            <div className="text-sm font-medium">本月檢查重點</div>
            <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {health.recommendations.map((item) => (
                <li key={item} className="flex gap-2">
                  <span aria-hidden="true">–</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[11px] text-muted-foreground">
            收支採近 3 個完整月份平均；這是個人規劃輔助，不替代持牌財務顧問的個別建議。
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <EmergencyFundCard />
        <GoalsPanel />
      </div>

      <InvestmentPlanner />
      <AllocationVsTarget />
    </div>
  );
}

function HealthMetric({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  icon: typeof PiggyBank;
  tone?: 'good' | 'bad' | 'neutral';
}) {
  return (
    <div className="min-w-0 rounded-md border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className={cn(
        'mt-1 truncate font-semibold tabular-nums',
        tone === 'good' && 'text-emerald-500',
        tone === 'bad' && 'text-red-500',
      )}>
        {value}
      </div>
    </div>
  );
}
