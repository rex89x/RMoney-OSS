import { useMemo } from 'react';
import { Shield } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatCurrency, cn } from '@/lib/utils';
import { useTransactions } from '@/features/ledger/hooks';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import { useAuth } from '@/hooks/use-auth';
import { addTWCalendarMonths, startOfTWDay } from '@/lib/tz';
import { useEmergencyFund } from '../hooks';
import { isConsumptionExpense } from '@/features/analytics/metrics';

/**
 * 應急基金水位：以使用者偏好或近 3 個月平均月支出計算目標金額。
 */
export function EmergencyFundCard() {
  const { profile } = useAuth();
  const targetMonths = profile?.preferences?.emergencyFund?.targetMonths ?? 6;
  const presetBaseline = profile?.preferences?.emergencyFund?.monthlyBaseline ?? null;

  // 近 3 個月支出平均（自動 baseline）
  const start = useMemo(() => {
    return startOfTWDay(addTWCalendarMonths(new Date(), -3));
  }, []);
  const { data: txs = [] } = useTransactions({ startDate: start, limit: 2000 });
  const myShare = useMyExpenseShare();
  const autoBaseline = useMemo(() => {
    const expense = txs.filter(isConsumptionExpense).reduce((s, t) => s + myShare(t), 0);
    return expense / 3;
  }, [txs, myShare]);

  const baseline = presetBaseline ?? autoBaseline;
  const fund = useEmergencyFund(baseline, targetMonths);

  const status = fund.pct >= 100 ? 'covered'
    : fund.pct >= 50 ? 'progress'
      : 'warn';
  const statusColor = status === 'covered' ? 'text-emerald-500'
    : status === 'progress' ? 'text-amber-500'
      : 'text-red-500';

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Shield className="size-4" /> 應急基金</span>
          <span className={cn('text-xs font-normal', statusColor)}>
            {fund.monthsCovered.toFixed(1)} 個月 / {targetMonths} 個月
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-xl font-semibold tabular-nums">
          {formatCurrency(fund.liquidTWD)}
          <span className="ml-1 text-xs font-normal text-muted-foreground">/ {formatCurrency(fund.targetTWD)}</span>
        </div>
        <Progress value={fund.pct} className="h-2" />
        <p className="text-[11px] text-muted-foreground">
          月支出基準：{formatCurrency(baseline)} {presetBaseline == null ? '（近 3 個月平均自動計算）' : '（手動設定）'}
        </p>
        <p className="text-[11px] text-muted-foreground">
          計入所有現金與銀行帳戶餘額。目標月數可在 設定 → 應急基金 調整。
        </p>
      </CardContent>
    </Card>
  );
}
