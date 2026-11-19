import { useState } from 'react';
import { ChevronDown, ChevronUp, Copy, Database } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import { claudeModelLabel, formatUSD } from '@/features/ai-budget';
import { formatTW } from '@/lib/tz';
import { toolLabel } from '../definitions';
import type { AnalysisResult } from '../types';

interface AnalysisResultViewProps {
  result: AnalysisResult;
}

export function AnalysisResultView({ result }: AnalysisResultViewProps) {
  const [expanded, setExpanded] = useState(true);
  const toolNames = Array.from(new Set((result.toolCalls ?? []).map((call) => call.name)));

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.markdown);
      toast.success('已複製 Markdown');
    } catch (err) {
      console.error('[copyAnalysis]', err);
      toast.error('複製失敗');
    }
  }

  return (
    <div className="min-w-0 rounded-xl border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <span className="min-w-0">
          {formatTW(result.generatedAt, 'yyyy/MM/dd HH:mm')}
          {result.month ? ` · ${result.month}` : ''} · {claudeModelLabel(result.model)} · {formatUSD(result.costUSD, 3)}
        </span>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => void copy()} aria-label="複製">
            <Copy className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} aria-label={expanded ? '收合' : '展開'}>
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        </div>
      </div>
      {expanded ? (
        <div className="max-h-[70vh] overflow-y-auto p-3">
          {result.truncated ? (
            <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">回應達長度上限，內容可能不完整。</p>
          ) : null}
          <Markdown>{result.markdown}</Markdown>
          {toolNames.length > 0 ? (
            <p className="mt-3 flex items-start gap-1.5 border-t pt-2 text-xs text-muted-foreground">
              <Database className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">
                Claude 查了 {result.toolCalls?.length ?? 0} 次資料：{toolNames.map(toolLabel).join('、')}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
