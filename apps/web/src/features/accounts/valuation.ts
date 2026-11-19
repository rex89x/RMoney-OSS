import type { FxRate } from '@/features/fx/types';
import type { Currency } from '@/types/global';
import { insuranceCashValueTWD } from './insurance';
import type { Account } from './types';

const MAIN_CURRENCY = 'TWD';

function isUsableRate(rate: number | undefined): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
}

function usableNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function currencyToTwdRate(currency: Currency, rates: FxRate[]): number {
  if (currency === MAIN_CURRENCY) return 1;
  const direct = rates.find((rate) =>
    (rate.id === `${currency}_${MAIN_CURRENCY}` || (rate.base === currency && rate.quote === MAIN_CURRENCY))
    && isUsableRate(rate.rate),
  );
  if (direct) return direct.rate;

  const inverse = rates.find((rate) =>
    (rate.id === `${MAIN_CURRENCY}_${currency}` || (rate.base === MAIN_CURRENCY && rate.quote === currency))
    && isUsableRate(rate.rate),
  );
  if (inverse) return 1 / inverse.rate;

  return 1;
}

export function accountFxRate(account: Pick<Account, 'currency'>, rates: FxRate[]): number {
  return currencyToTwdRate(account.currency, rates);
}

export function currentAccountBalanceTWD(
  account: Pick<Account, 'currency' | 'balance' | 'balanceTWD'>,
  rates: FxRate[],
): number {
  const nativeBalance = usableNumber(account.balance);
  const storedBalanceTWD = usableNumber(account.balanceTWD);
  if (account.currency === MAIN_CURRENCY) return storedBalanceTWD ?? nativeBalance ?? 0;
  const rate = currencyToTwdRate(account.currency, rates);
  if (rate !== 1 || account.currency === MAIN_CURRENCY) return (nativeBalance ?? 0) * rate;
  return storedBalanceTWD ?? nativeBalance ?? 0;
}

export function currentDebtBalanceTWD(
  account: Pick<Account, 'currency' | 'balance' | 'balanceTWD'>,
  rates: FxRate[],
): number {
  return Math.max(0, currentAccountBalanceTWD(account, rates));
}

/**
 * 保險 / 退休帳戶對淨值的貢獻（前端 useNetWorthNow 與 NetWorth.gs 同口徑）：
 *   - insurance：只計 `insurance.cashValueTWD`（解約金 / 保單價值），純保障型 = 0
 *   - pension：帳戶餘額現值（外幣同樣以當日匯率重估）
 * 封存 / 停用的帳戶不計。
 */
export function longTermAccountValueTWD(
  account: Pick<Account, 'type' | 'currency' | 'balance' | 'balanceTWD' | 'insurance'>,
  rates: FxRate[],
): number {
  if (account.type === 'insurance') return insuranceCashValueTWD(account);
  if (account.type === 'pension') return currentAccountBalanceTWD(account, rates);
  return 0;
}

export function totalInsurancePensionTWD(
  accounts: Pick<Account, 'type' | 'currency' | 'balance' | 'balanceTWD' | 'insurance' | 'active' | 'archivedAt'>[],
  rates: FxRate[],
): number {
  return accounts
    .filter((account) => account.active !== false && !account.archivedAt)
    .reduce((sum, account) => sum + longTermAccountValueTWD(account, rates), 0);
}
