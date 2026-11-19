import { currentAccountBalanceTWD } from '@/features/accounts/valuation';
import type { Account } from '@/features/accounts/types';
import type { FxRate } from '@/features/fx/types';
import type { CashAccount } from './types';

const LIQUID_ACCOUNT_TYPES = ['cash', 'bank', 'e_wallet_balance', 'investment_cash'];

function normalizeAccountKey(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function legacyCashKeys(cash: CashAccount): string[] {
  return [
    cash.id,
    cash.name,
    cash.bank ? `${cash.bank}_${cash.name}` : '',
  ].map(normalizeAccountKey).filter(Boolean);
}

function accountKeys(account: Account): string[] {
  return [
    account.name,
    account.legacyPaymentMethod,
  ].map(normalizeAccountKey).filter(Boolean);
}

export function activeLiquidAccounts(accounts: Account[]): Account[] {
  return accounts.filter((account) =>
    account.active !== false && LIQUID_ACCOUNT_TYPES.includes(account.type),
  );
}

export function accountLiquidTWD(accounts: Account[], fxRates: FxRate[]): number {
  return activeLiquidAccounts(accounts)
    .reduce((sum, account) => sum + currentAccountBalanceTWD(account, fxRates), 0);
}

export function unreconciledLegacyCashAccounts(
  cashAccounts: CashAccount[],
  accounts: Account[],
): CashAccount[] {
  const liquidKeys = new Set(activeLiquidAccounts(accounts).flatMap(accountKeys));
  const representedLegacyKeys = new Set(
    activeLiquidAccounts(accounts)
      .filter((account) => account.legacySource === 'cash_accounts')
      .flatMap(accountKeys),
  );

  return cashAccounts.filter((cash) => {
    if (cash.archivedAt) return false;
    const keys = legacyCashKeys(cash);
    if (keys.length === 0) return false;
    if (keys.some((key) => representedLegacyKeys.has(key))) return false;
    return !keys.some((key) => liquidKeys.has(key));
  });
}

export function legacyCashTWD(cashAccounts: CashAccount[], accounts: Account[]): number {
  return unreconciledLegacyCashAccounts(cashAccounts, accounts)
    .reduce((sum, cash) => sum + (cash.amountTWD || cash.amount || 0), 0);
}

export function totalLiquidTWD(
  accounts: Account[],
  cashAccounts: CashAccount[],
  fxRates: FxRate[],
): number {
  return accountLiquidTWD(accounts, fxRates) + legacyCashTWD(cashAccounts, accounts);
}
