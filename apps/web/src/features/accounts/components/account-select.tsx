import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ACCOUNT_TYPE_LABEL, type Account, type AccountType } from '../types';

interface AccountSelectProps {
  value?: string | null;
  onValueChange: (value: string) => void;
  accounts: Account[];
  types?: AccountType[];
  placeholder?: string;
}

export function AccountSelect({
  value,
  onValueChange,
  accounts,
  types,
  placeholder = '選擇帳戶',
}: AccountSelectProps) {
  const rows = types ? accounts.filter((account) => types.includes(account.type)) : accounts;

  return (
    <Select value={value ?? ''} onValueChange={onValueChange}>
      <SelectTrigger className="mt-1 h-11">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {rows.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.name} · {ACCOUNT_TYPE_LABEL[account.type]} · {account.currency}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
