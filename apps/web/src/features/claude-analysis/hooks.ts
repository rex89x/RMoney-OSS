import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { estimateAnalysis, loadLastResult, runAnalysis, saveLastResult } from './api';
import type { AnalysisEstimate, AnalysisKind, AnalysisRequest, AnalysisResult } from './types';

export function useEstimateAnalysis() {
  return useMutation({
    mutationFn: estimateAnalysis,
    onError: (error) => {
      console.error('[estimateAnalysis]', error);
      toast.error(error instanceof Error ? error.message : '估價失敗');
    },
  });
}

export function useRunAnalysis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: runAnalysis,
    onSuccess: (result) => {
      saveLastResult(result);
      // 用量即時反映在 設定 → AI 額度
      void queryClient.invalidateQueries({ queryKey: ['ai-usage-summary'] });
      toast.success(`${result.title}完成`);
    },
    onError: (error) => {
      console.error('[runAnalysis]', error);
      toast.error(error instanceof Error ? error.message : '分析失敗');
    },
  });
}

/**
 * 一張分析卡片的流程：估價 → 使用者確認 → 執行。
 * 只有 confirm() 會真的呼叫 Claude；估價只跑免費的 count_tokens。
 */
export function useAnalysisFlow(kind: AnalysisKind) {
  const estimate = useEstimateAnalysis();
  const run = useRunAnalysis();
  const [pending, setPending] = useState<{ request: AnalysisRequest; estimate: AnalysisEstimate } | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(() => loadLastResult(kind));

  async function requestEstimate(request: AnalysisRequest) {
    try {
      const data = await estimate.mutateAsync(request);
      setPending({ request, estimate: data });
    } catch {
      // 錯誤已由 useEstimateAnalysis toast
    }
  }

  async function confirm() {
    if (!pending) return;
    const { request } = pending;
    setPending(null);
    try {
      setResult(await run.mutateAsync(request));
    } catch {
      // 錯誤已由 useRunAnalysis toast
    }
  }

  return {
    pending,
    result,
    estimating: estimate.isPending,
    running: run.isPending,
    requestEstimate,
    confirm,
    cancel: () => setPending(null),
  };
}
