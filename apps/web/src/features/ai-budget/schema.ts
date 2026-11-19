import { z } from 'zod';
import { CLAUDE_MODELS, type ClaudeModel } from './types';

const ModelSchema = z.enum(CLAUDE_MODELS as [ClaudeModel, ...ClaudeModel[]]);

export const AiBudgetConfigSchema = z.object({
  monthlyCreditUSD: z.coerce.number().min(1, '額度至少 US$1').max(10000, '額度上限為 US$10,000'),
  cycleResetDay: z.coerce.number().int().min(1, '1–28 號').max(28, '1–28 號'),
  warningPercent: z.coerce.number().int().min(1).max(100),
  hardStopEnabled: z.boolean(),
  defaultModel: ModelSchema,
  fastModel: ModelSchema,
});

export const AiScenarioSchema = z.object({
  model: ModelSchema,
  monthlyRequests: z.coerce.number().int().min(0).max(1000000),
  inputTokensPerRequest: z.coerce.number().int().min(0).max(1000000),
  outputTokensPerRequest: z.coerce.number().int().min(0).max(128000),
  webSearchesPerMonth: z.coerce.number().int().min(0).max(1000000),
});

export type AiBudgetConfigFormValues = z.input<typeof AiBudgetConfigSchema>;
export type AiScenarioFormValues = z.input<typeof AiScenarioSchema>;
