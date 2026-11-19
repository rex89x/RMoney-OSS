import type { AiForecast, AiScenarioInput, AiUsageSummary, ClaudeModel } from './types';

/** USD / 1M tokens — 與 apps-script/src/Claude.gs CLAUDE_MODEL_PRICES_ 同步 */
export const CLAUDE_PRICES: Record<ClaudeModel, { input: number; output: number; longInput?: number; longOutput?: number; longThreshold?: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5, longThreshold: 100000 },
  'claude-fable-5-2': { input: 8, output: 40 },
};
export const WEB_SEARCH_USD = 0.01;

const DAY_MS = 86400000;

/**
 * 計費週期 forecast：cycleStart / cycleEnd 是後端算好的絕對時間（台北 resetDay 00:00），
 * 這裡只做線性外推，所以跟本機時區無關。
 */
export function calculateAiForecast(summary: AiUsageSummary, now = new Date()): AiForecast {
  const start = new Date(summary.cycleStart).getTime();
  const end = new Date(summary.cycleEnd).getTime();
  const totalDays = Math.max(1, Math.round((end - start) / DAY_MS));
  const clampedNow = Math.min(Math.max(now.getTime(), start), end);
  const elapsedDays = Math.min(totalDays, Math.max(1, Math.ceil((clampedNow - start) / DAY_MS)));
  const daysLeft = Math.max(0, Math.ceil((end - clampedNow) / DAY_MS));
  const spentUSD = summary.totals.costUSD;
  const credit = summary.creditUSD;
  const isCurrent = summary.cycleOffset === 0;
  const projectedUSD = isCurrent ? spentUSD / elapsedDays * totalDays : spentUSD;
  const remainingUSD = Math.max(0, credit - spentUSD);
  return {
    spentUSD,
    remainingUSD,
    projectedUSD,
    usagePercent: credit > 0 ? spentUSD / credit * 100 : 0,
    projectedUsagePercent: credit > 0 ? projectedUSD / credit * 100 : 0,
    elapsedDays,
    totalDays,
    daysLeft: isCurrent ? daysLeft : 0,
    dailyAllowanceUSD: isCurrent && daysLeft > 0 ? remainingUSD / daysLeft : 0,
  };
}

export function estimateAiScenario(input: AiScenarioInput): { costUSD: number; searchCostUSD: number; perRequestUSD: number } {
  const rates = CLAUDE_PRICES[input.model];
  const long = rates.longThreshold !== undefined && input.inputTokensPerRequest > rates.longThreshold;
  const inputRate = long && rates.longInput !== undefined ? rates.longInput : rates.input;
  const outputRate = long && rates.longOutput !== undefined ? rates.longOutput : rates.output;
  const perRequestUSD = (input.inputTokensPerRequest * inputRate + input.outputTokensPerRequest * outputRate) / 1000000;
  const searchCostUSD = input.webSearchesPerMonth * WEB_SEARCH_USD;
  return { costUSD: perRequestUSD * input.monthlyRequests + searchCostUSD, searchCostUSD, perRequestUSD };
}
