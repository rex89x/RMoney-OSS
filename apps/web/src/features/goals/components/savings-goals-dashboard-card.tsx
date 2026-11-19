import { useNavigate } from 'react-router-dom';
import { Target } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { useGoals } from '../hooks';

export function SavingsGoalsDashboardCard() {
  const { data: goals = [] } = useGoals();
  const navigate = useNavigate();

  if (goals.length === 0) {
    return (
      <Card
        className="cursor-pointer transition-colors hover:bg-muted/40"
        onClick={() => navigate('/settings?tab=goals')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') navigate('/settings?tab=goals'); }}
      >
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="size-4" /> 目標儲蓄
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">尚未建立目標</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-muted/40"
      onClick={() => navigate('/settings?tab=goals')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate('/settings?tab=goals'); }}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="size-4" /> 目標儲蓄
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {goals.slice(0, 3).map((g) => {
          const pct = g.targetTWD ? Math.min(100, (g.currentTWD / g.targetTWD) * 100) : 0;
          return (
            <div key={g.id} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate font-medium">{g.name}</span>
                <span className="text-muted-foreground">{formatPercent(pct, 0)}</span>
              </div>
              <Progress value={pct} className="h-1.5" style={{
                ['--progress-foreground' as string]: g.color ?? '#10b981',
              } as React.CSSProperties} />
              <div className="text-[10px] text-muted-foreground">
                {formatCurrency(g.currentTWD)} / {formatCurrency(g.targetTWD)}
              </div>
            </div>
          );
        })}
        {goals.length > 3 && <p className="text-[10px] text-muted-foreground">…還有 {goals.length - 3} 個</p>}
      </CardContent>
    </Card>
  );
}
