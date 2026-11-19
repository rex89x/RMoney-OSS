import { HeartHandshake } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useActiveHousehold, useHouseholdFundSummary } from '@/features/household/hooks';
import { householdFundShare } from '../household-fund-share';

/**
 * 共同公基金：顯示公基金餘額與「我的份額」，但不計入淨值總額。
 *
 * 2026-09-21 owner 決議：公基金存入不扣個人帳戶、公基金不計入淨值（features/household/README.md）。
 * 存入時個人帳戶沒有扣款，若再把份額加進淨值，存進去的錢會被算兩次，所以這裡只做資訊揭露。
 */
export function HouseholdFundShareCard() {
  const { user } = useAuth();
  const household = useActiveHousehold();
  const { summary, isLoading } = useHouseholdFundSummary(household);
  if (!household || !user || isLoading) return null;
  if (summary.contributionsTWD === 0 && summary.expensesTWD === 0) return null;
  const share = householdFundShare(summary, household.splitRatio, user.uid);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <HeartHandshake className="size-4" /> 共同公基金（不計入淨值）
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">公基金帳上可用</span><span className="tabular-nums">{formatCurrency(summary.balanceTWD)}</span></div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">你的份額（分攤比例 {share.ratioPct}%）</span>
          <span className="tabular-nums">{formatCurrency(share.equityTWD)}</span>
        </div>
        {share.owedToMeTWD !== 0 ? (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{share.owedToMeTWD > 0 ? '公基金還欠你（代墊未撥還）' : '你多收的撥還'}</span>
            <span className="tabular-nums">{formatCurrency(Math.abs(share.owedToMeTWD))}</span>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          公基金存入不會扣你的個人帳戶，所以份額不加進上面的淨值，避免同一筆錢算兩次。
          明細見 <Link to="/shared" className="underline underline-offset-2">共同帳本</Link>。
        </p>
      </CardContent>
    </Card>
  );
}
