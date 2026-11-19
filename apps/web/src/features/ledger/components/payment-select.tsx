import { useEffect, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ACCOUNT_TYPE_LABEL, type Account, type AccountType } from '@/features/accounts';
import { DEFAULT_PAYMENT_METHODS } from '@/lib/seed-data';
import { paymentMethodLabel, type PaymentMethod } from '../payment-methods';

export interface PaymentSelection {
  paymentMethod: string;
  accountId: string;
}

interface PaymentSelectProps {
  value: PaymentSelection;
  onChange: (next: PaymentSelection) => void;
  accounts: Account[];
  customPMs: PaymentMethod[];
  /** 限制可選 account types（income 通常只能選 cash/bank/e-wallet/investment_cash） */
  allowedAccountTypes?: AccountType[];
  label?: string;
  showAccountLabel?: string;
  emptyHint?: string;
}

interface OptionRow {
  value: string;
  label: string;
}

function dedupe(rows: OptionRow[]): OptionRow[] {
  const seen = new Set<string>();
  const out: OptionRow[] = [];
  for (const row of rows) {
    if (!row.value) continue;
    if (seen.has(row.value)) continue;
    seen.add(row.value);
    out.push(row);
  }
  return out;
}

function matchAccountsByPM(
  accounts: Account[],
  paymentMethod: string,
  allowedTypes?: AccountType[],
): Account[] {
  if (!paymentMethod) return [];
  return accounts.filter((account) => {
    if (!account.active) return false;
    if (allowedTypes && !allowedTypes.includes(account.type)) return false;
    const pm = account.legacyPaymentMethod ?? account.name;
    return pm === paymentMethod || account.name === paymentMethod;
  });
}

export function PaymentSelect({
  value,
  onChange,
  accounts,
  customPMs,
  allowedAccountTypes,
  label = '支付方式',
  showAccountLabel = '帳戶',
  emptyHint,
}: PaymentSelectProps) {
  const paymentOptions = useMemo<OptionRow[]>(() => {
    const customRows = customPMs.map((pm) => ({ value: pm.name, label: paymentMethodLabel(pm) }));
    const accountRows = accounts
      .filter((account) => account.active)
      .filter((account) => !allowedAccountTypes || allowedAccountTypes.includes(account.type))
      .map((account) => {
        const pm = account.legacyPaymentMethod ?? account.name;
        return {
          value: pm,
          label: pm === account.name ? `${pm} · ${ACCOUNT_TYPE_LABEL[account.type]}` : pm,
        };
      });
    const defaultRows = DEFAULT_PAYMENT_METHODS.map((pm) => ({ value: pm, label: pm }));
    const merged = dedupe([...customRows, ...accountRows, ...defaultRows]);
    if (value.paymentMethod && !merged.find((row) => row.value === value.paymentMethod)) {
      merged.push({ value: value.paymentMethod, label: value.paymentMethod });
    }
    return merged;
  }, [accounts, customPMs, allowedAccountTypes, value.paymentMethod]);

  const matchingAccounts = useMemo(
    () => matchAccountsByPM(accounts, value.paymentMethod, allowedAccountTypes),
    [accounts, value.paymentMethod, allowedAccountTypes],
  );

  useEffect(() => {
    if (matchingAccounts.length === 1) {
      const only = matchingAccounts[0]!; // 非空：索引已做邊界 / 長度檢查
      if (value.accountId !== only.id) {
        onChange({ paymentMethod: value.paymentMethod, accountId: only.id });
      }
      return;
    }
    if (matchingAccounts.length === 0 && value.accountId) {
      onChange({ paymentMethod: value.paymentMethod, accountId: '' });
      return;
    }
    if (
      matchingAccounts.length >= 2
      && value.accountId
      && !matchingAccounts.find((account) => account.id === value.accountId)
    ) {
      onChange({ paymentMethod: value.paymentMethod, accountId: '' });
    }
  }, [matchingAccounts, value.accountId, value.paymentMethod, onChange]);

  function handlePMChange(next: string) {
    const candidates = matchAccountsByPM(accounts, next, allowedAccountTypes);
    onChange({
      paymentMethod: next,
      accountId: candidates.length === 1 ? candidates[0]!.id : '', // 非空：索引已做邊界 / 長度檢查
    });
  }

  function handleAccountChange(nextId: string) {
    onChange({ paymentMethod: value.paymentMethod, accountId: nextId });
  }

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <Select value={value.paymentMethod} onValueChange={handlePMChange}>
          <SelectTrigger className="mt-1 h-11"><SelectValue placeholder="選擇支付方式" /></SelectTrigger>
          <SelectContent>
            {paymentOptions.map((row) => (
              <SelectItem key={row.value} value={row.value}>{row.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {matchingAccounts.length >= 2 ? (
        <div>
          <Label className="text-xs text-muted-foreground">{showAccountLabel}</Label>
          <Select value={value.accountId || ''} onValueChange={handleAccountChange}>
            <SelectTrigger className="mt-1 h-11"><SelectValue placeholder="選擇帳戶" /></SelectTrigger>
            <SelectContent>
              {matchingAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name} · {ACCOUNT_TYPE_LABEL[account.type]} · {account.currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {matchingAccounts.length === 0 && accounts.length > 0 && emptyHint ? (
        <p className="text-[11px] text-muted-foreground">{emptyHint}</p>
      ) : null}
    </div>
  );
}
