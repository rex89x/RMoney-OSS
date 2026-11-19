/**
 * 保單（account type = insurance）純函式：繳費日推進、淨值貢獻、到期提醒。
 * 不 import firebase，tests/insurance-pension.test.cjs 直接 bundle 這個檔。
 *
 * 與 Apps Script 同步的規則：
 *   - 淨值：只計 `insurance.cashValueTWD`（NetWorth.gs `insuranceCashValueTWD_`）
 *   - 提醒視窗：保費 14 天內（含逾期）、滿期 30 天內（Notifications.gs `insuranceDueItems_`）
 */
import { addTWCalendarMonths, daysBetweenTWDates } from '@/lib/tz';
import type { Account, InsuranceAccountDetails, PremiumFrequency } from './types';

export const INSURANCE_PREMIUM_AHEAD_DAYS = 14;
export const INSURANCE_MATURITY_AHEAD_DAYS = 30;

export const PREMIUM_FREQUENCY_MONTHS: Record<PremiumFrequency, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

/** 繳完一期後的下次繳費日（月底 clamp，pitfall #23） */
export function advancePremiumDate(current: Date, frequency: PremiumFrequency): Date {
  return addTWCalendarMonths(current, PREMIUM_FREQUENCY_MONTHS[frequency] ?? 12);
}

/** 年化保費（月繳 × 12、季繳 × 4…） */
export function annualPremiumTWD(details: Pick<InsuranceAccountDetails, 'premiumTWD' | 'premiumFrequency'>): number {
  const months = PREMIUM_FREQUENCY_MONTHS[details.premiumFrequency] ?? 12;
  return (details.premiumTWD || 0) * (12 / months);
}

/** 保單對淨值的貢獻：只有解約金 / 保單價值；純保障型（沒填）= 0 */
export function insuranceCashValueTWD(account: Pick<Account, 'type' | 'insurance'>): number {
  if (account.type !== 'insurance') return 0;
  const value = account.insurance?.cashValueTWD;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export type InsuranceReminderKind = 'premium' | 'maturity';

export interface InsuranceReminder {
  accountId: string;
  accountName: string;
  kind: InsuranceReminderKind;
  date: Date;
  /** date − today（台北日曆天）；負值 = 已逾期 */
  days: number;
  premiumTWD?: number;
}

/**
 * 需要提醒的保單事件：
 *   - premium：nextPremiumDate 在 14 天內或已逾期（還沒按「已繳」就持續提醒）
 *   - maturity：maturityDate 在 0–30 天內（滿期日過了就不再提醒）
 * 封存 / 停用的帳戶略過。
 */
export function insuranceReminders(
  accounts: Pick<Account, 'id' | 'name' | 'type' | 'active' | 'archivedAt' | 'insurance'>[],
  today: Date,
): InsuranceReminder[] {
  const out: InsuranceReminder[] = [];
  for (const account of accounts) {
    if (account.type !== 'insurance' || account.active === false || account.archivedAt) continue;
    const details = account.insurance;
    if (!details) continue;
    const premiumDays = daysBetweenTWDates(today, details.nextPremiumDate);
    if (details.premiumTWD > 0 && premiumDays <= INSURANCE_PREMIUM_AHEAD_DAYS) {
      out.push({
        accountId: account.id,
        accountName: account.name,
        kind: 'premium',
        date: details.nextPremiumDate,
        days: premiumDays,
        premiumTWD: details.premiumTWD,
      });
    }
    if (details.maturityDate) {
      const maturityDays = daysBetweenTWDates(today, details.maturityDate);
      if (maturityDays >= 0 && maturityDays <= INSURANCE_MATURITY_AHEAD_DAYS) {
        out.push({
          accountId: account.id,
          accountName: account.name,
          kind: 'maturity',
          date: details.maturityDate,
          days: maturityDays,
        });
      }
    }
  }
  return out.sort((a, b) => a.days - b.days);
}
