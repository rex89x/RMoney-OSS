import { Coins, Database, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { claudeModelLabel, formatTokens, formatUSD } from '@/features/ai-budget';
import type { AnalysisDefinition, AnalysisEstimate } from '../types';

interface AnalysisConfirmDialogProps {
  definition: AnalysisDefinition;
  estimate: AnalysisEstimate | null;
  month?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 執行前的費用確認：沒有按「確認執行」就不會呼叫 Claude */
export function AnalysisConfirmDialog({ definition, estimate, month, onConfirm, onCancel }: AnalysisConfirmDialogProps) {
  const remaining = estimate ? Math.max(0, estimate.creditUSD - estimate.cycleSpentUSD) : 0;
  return (
    <ResponsiveDialog
      open={estimate !== null}
      onOpenChange={(open) => { if (!open) onCancel(); }}
      title={`執行「${definition.title}」？`}
      description="確認後才會呼叫 Claude，費用計入本期 Claude API 額度。"
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button onClick={onConfirm}><Sparkles className="size-4" /> 確認執行</Button>
        </div>
      )}
    >
      {estimate ? (
        <div className="space-y-4 text-sm">
          <div className="rounded-xl bg-muted p-4">
            <p className="flex items-center gap-2 text-muted-foreground"><Coins className="size-4" /> 預估費用</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatUSD(estimate.costUSDRange[0], 3)} – {formatUSD(estimate.costUSDRange[1], 3)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {claudeModelLabel(estimate.model)} · input 約 {formatTokens(estimate.inputTokensRange[0])}–
              {formatTokens(estimate.inputTokensRange[1])} tokens（依 Claude 查幾輪資料而定，最多 {estimate.maxRounds} 輪）· output 約{' '}
              {formatTokens(estimate.outputTokensRange[0])}–{formatTokens(estimate.outputTokensRange[1])} tokens（含 thinking）
              · 上限約 {formatUSD(estimate.maxCostUSD, 2)}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 rounded-xl border p-3">
              <p className="text-xs text-muted-foreground">本期已用 / 額度</p>
              <p className="mt-1 font-medium tabular-nums">
                {formatUSD(estimate.cycleSpentUSD)} / {formatUSD(estimate.creditUSD, 0)}
              </p>
            </div>
            <div className="min-w-0 rounded-xl border p-3">
              <p className="text-xs text-muted-foreground">執行後剩餘（預估）</p>
              <p className="mt-1 font-medium tabular-nums">
                約 {formatUSD(Math.max(0, remaining - estimate.costUSDRange[1]))}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-xl border p-3 text-muted-foreground">
            <Database className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0">
              Claude 會自己用唯讀工具查需要的資料，通常是：{definition.dataScope}{month ? `（${month}）` : ''}。
              只會讀取、不會修改任何資料；實際查了什麼會列在結果下方。
            </p>
          </div>
        </div>
      ) : null}
    </ResponsiveDialog>
  );
}
