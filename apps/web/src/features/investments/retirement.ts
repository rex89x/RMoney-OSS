/**
 * 退休規劃判定（理財健檢用）。純函式，與 Apps Script Notifications.gs `isRetirementPlan_` 同規則：
 *   1. 投資計畫明確勾選 `isRetirement` → 是；明確取消（false）→ 不是
 *   2. 舊資料沒有旗標 → 退回名稱含「退休 / retire」（避免既有使用者退步）
 *   3. 有任何啟用中的 pension 帳戶（勞退個人專戶 / 自提）也算有退休規劃
 */
import type { Account } from '@/features/accounts/types';
import type { InvestmentPlan } from './types';

const RETIREMENT_NAME_RE = /退休|retire/i;

export function isRetirementPlan(plan: Pick<InvestmentPlan, 'name' | 'isRetirement'>): boolean {
  if (plan.isRetirement === true) return true;
  if (plan.isRetirement === false) return false;
  return RETIREMENT_NAME_RE.test(plan.name);
}

export function hasRetirementSetup(
  plans: Pick<InvestmentPlan, 'name' | 'isRetirement'>[],
  accounts: Pick<Account, 'type' | 'active' | 'archivedAt'>[],
): boolean {
  return accounts.some((account) => account.type === 'pension' && account.active !== false && !account.archivedAt)
    || plans.some(isRetirementPlan);
}
