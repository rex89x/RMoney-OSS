import { Link } from 'react-router-dom';
import { ChevronRight, Users } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { cn, formatCurrency } from '@/lib/utils';
import { useActiveHousehold } from '@/features/household/hooks';
import type { Household } from '@/features/household/types';
import { pnlPct } from '../calc';
import { useJointValuation } from '../hooks';

/** 投資頁儀表板上方：共同投資帳摘要（我在共同投資帳擁有多少），點進 /shared?tab=invest */
export function JointInvestmentSummaryCard() {
  const household = useActiveHousehold();
  if (!household) return null;
  return <SummaryBody household={household} />;
}

function SummaryBody({ household }: { household: Household }) {
  const { user } = useAuth();
  const { holdings, valuation, isLoading } = useJointValuation(household);
  if (isLoading || holdings.length === 0) return null;
  const mine = valuation.byMember[user?.uid ?? ''];
  const pct = pnlPct(valuation);
  return (
    <Link to="/shared?tab=invest" className="mb-4 block">
      <Card className="transition-colors hover:bg-muted/40">
        <CardContent className="flex items-center gap-3 p-4">
          <Users className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">共同投資帳 · {household.name}</p>
            <p className="text-xs tabular-nums text-muted-foreground">
              總市值 {formatCurrency(valuation.valueTWD)}
              {mine ? ` · 我擁有 ${formatCurrency(mine.valueTWD)}` : ''}
            </p>
          </div>
          <span className={cn(
            'text-sm font-medium tabular-nums',
            valuation.unrealizedTWD > 0.5 ? 'text-success' : valuation.unrealizedTWD < -0.5 ? 'text-destructive' : 'text-muted-foreground',
          )}>
            {pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}
          </span>
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </CardContent>
      </Card>
    </Link>
  );
}
