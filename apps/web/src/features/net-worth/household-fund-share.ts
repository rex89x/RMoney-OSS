import type { HouseholdFundSummary } from '@/features/household/balance';

export interface HouseholdFundShare {
  /** 我的分攤比例（%） */
  ratioPct: number;
  /** 帳上可用 × 我的比例 */
  equityTWD: number;
  /** 公基金欠我的代墊（負數 = 撥還多給了我） */
  owedToMeTWD: number;
}

/** 依 household.splitRatio 算「我在公基金的份額」；比例沒設時視為均分 */
export function householdFundShare(
  summary: Pick<HouseholdFundSummary, 'balanceTWD' | 'owedToMember'>,
  splitRatio: Record<string, number>,
  uid: string,
): HouseholdFundShare {
  const entries = Object.entries(splitRatio).filter(([, v]) => Number.isFinite(v) && v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const mine = splitRatio[uid] ?? 0;
  const ratio = total > 0 ? mine / total : 0;
  return {
    ratioPct: Math.round(ratio * 1000) / 10,
    equityTWD: Math.round(summary.balanceTWD * ratio),
    owedToMeTWD: Math.round(summary.owedToMember[uid] ?? 0),
  };
}
