import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { calculateAiForecast, formatUSD, useAiUsageSummary } from '@/features/ai-budget';
import { ANALYSIS_DEFINITIONS } from '../definitions';
import { AnalysisCard } from './analysis-card';

export function ClaudeAnalysisPanel() {
  const usage = useAiUsageSummary(0);
  const forecast = usage.data ? calculateAiForecast(usage.data) : null;

  return (
    <div className="space-y-4">
      <div className="min-w-0 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 font-medium"><Sparkles className="size-4" /> Claude API 本期額度</p>
          <Link to="/settings?tab=ai-budget" className="text-sm text-primary underline-offset-4 hover:underline">
            用量明細與設定
          </Link>
        </div>
        <p className="mt-2 text-sm tabular-nums text-muted-foreground">
          {forecast
            ? `已用 ${formatUSD(forecast.spentUSD)} / ${formatUSD(usage.data?.creditUSD ?? 100, 0)}，剩 ${formatUSD(forecast.remainingUSD)}（${forecast.daysLeft} 天後重置）`
            : usage.isError ? '無法取得用量' : '讀取用量中…'}
        </p>
        <Progress className="mt-2" value={Math.min(100, forecast?.usagePercent ?? 0)} />
        <p className="mt-2 text-xs text-muted-foreground">
          每個分析都會先估算費用，按下「確認執行」才會呼叫 Claude；不會自動或排程執行。
        </p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {ANALYSIS_DEFINITIONS.map((definition) => (
          <AnalysisCard key={definition.kind} definition={definition} />
        ))}
      </div>
    </div>
  );
}
