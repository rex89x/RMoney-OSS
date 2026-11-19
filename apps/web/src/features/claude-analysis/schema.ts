import { z } from 'zod';

export const ANALYSIS_FOCUS_MAX = 300;

export const AnalysisRequestSchema = z.object({
  kind: z.enum(['monthlyReview', 'subscriptionAudit', 'portfolioReview', 'transactionCleanup', 'tripReview']),
  month: z.string().regex(/^\d{4}-\d{2}$/, '月份格式 yyyy-MM').optional(),
  tripId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, '旅程 id 格式不正確').optional(),
  focus: z.string().trim().max(ANALYSIS_FOCUS_MAX, `最多 ${ANALYSIS_FOCUS_MAX} 字`).optional(),
});

export type AnalysisRequestValues = z.infer<typeof AnalysisRequestSchema>;
