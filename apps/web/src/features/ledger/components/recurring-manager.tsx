import { useMemo, useState } from 'react';
import { Plus, Trash2, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
import { useAuth } from '@/hooks/use-auth';
import {
  DataTablePagination, DataTableToolbar, useDataTable, type FilterDef,
} from '@/components/data-table';
import {
  useCategories, useCreateRecurring, useDeleteRecurring, useRecurring, useUpdateRecurring,
} from '../hooks';
import { DEFAULT_PAYMENT_METHODS } from '@/lib/seed-data';
import {
  addTWCalendarMonths,
  addTWCalendarYears,
  dateInputToTWDate,
  formatDateInput,
  formatTW,
  nowTW,
  parseDateInput,
} from '@/lib/tz';
import { useConfirm } from '@/components/ui/confirm';
import { AccountSelect, useAccounts } from '@/features/accounts';
import type { Recurring } from '../types';

const FREQUENCY_LABEL: Record<Recurring['frequency'], string> = {
  weekly: '每週', biweekly: '每雙週', monthly: '每月', yearly: '每年',
};

/** 週期支出可扣款的帳戶類型（與快速記帳一致） */
const RECURRING_ACCOUNT_TYPES = ['cash', 'bank', 'credit_card', 'e_wallet_balance', 'investment_cash'] as const;

export function RecurringManager() {
  const { user } = useAuth();
  const { data: recs = [] } = useRecurring();
  const { data: categories = [] } = useCategories();
  const { data: accounts = [] } = useAccounts();
  const activeAccounts = useMemo(
    () => accounts.filter((a) => a.active !== false && !a.archivedAt),
    [accounts],
  );
  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const create = useCreateRecurring();
  const update = useUpdateRecurring();
  const del = useDeleteRecurring();
  const confirm = useConfirm();

  async function handleDelete(r: Recurring) {
    const ok = await confirm({
      title: '刪除週期性交易',
      description: `${r.label ?? r.template.category}（${r.frequency}）刪除後不會再自動入帳`,
      confirmText: '刪除',
    });
    if (ok) await del.mutateAsync(r.id);
  }

  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState(categories[0]?.key ?? 'other');
  const [frequency, setFrequency] = useState<Recurring['frequency']>('monthly');
  const [nextDue, setNextDue] = useState(() => formatDateInput(nowTW()));
  // 扣款帳戶：Apps Script 入帳時會同步調整餘額；不選就只進統計、不動任何帳戶
  const [fromAccountId, setFromAccountId] = useState<string>('');

  const filters: FilterDef[] = useMemo(() => [
    {
      id: 'active',
      label: '狀態',
      kind: 'select',
      options: [
        { value: 'true', label: '啟用中' },
        { value: 'false', label: '已停用' },
      ],
    },
    {
      id: 'frequency',
      label: '週期',
      kind: 'select',
      options: [
        { value: 'weekly', label: '每週' },
        { value: 'biweekly', label: '每雙週' },
        { value: 'monthly', label: '每月' },
        { value: 'yearly', label: '每年' },
      ],
    },
    {
      id: 'category',
      label: '類別',
      kind: 'multiSelect',
      options: categories.map((c) => ({ value: c.key, label: c.name })),
    },
  ], [categories]);

  const accessor = useMemo(() => (row: Recurring, id: string) => {
    switch (id) {
      case 'active': return row.active ? 'true' : 'false';
      case 'frequency': return row.frequency;
      case 'category': return row.template?.category ?? '';
      case 'label': return row.label ?? '';
      case 'nextDue': return row.nextDue;
      default: return (row as unknown as Record<string, unknown>)[id];
    }
  }, []);

  const table = useDataTable<Recurring>({
    data: recs,
    accessor,
    searchFields: ['label', 'category'],
    filters,
    pageSize: 25,
    urlKey: 'rec',
  });

  async function handleAdd() {
    if (!user) return;
    const amt = parseFloat(amount);
    if (!amt) return;
    const parsedNextDue = dateInputToTWDate(nextDue);
    if (!parsedNextDue) return;
    const account = activeAccounts.find((a) => a.id === fromAccountId) ?? null;
    // 幣別跟帳戶走；外幣的 amountTWD / fxRate 由 Apps Script 在入帳當天用 fx_rates 重算，這裡只是佔位
    const currency = account?.currency ?? 'TWD';
    await create.mutateAsync({
      userId: user.uid,
      label: label || undefined,
      template: {
        userId: user.uid,
        type: 'expense',
        amount: amt,
        amountTWD: amt,
        currency,
        fxRate: 1,
        category,
        paymentMethod: account?.legacyPaymentMethod ?? account?.name ?? DEFAULT_PAYMENT_METHODS[0] ?? '現金',
        fromAccountId: account?.id ?? null,
        date: new Date(),
      },
      frequency,
      nextDue: parsedNextDue,
      active: true,
    });
    setAmount('');
    setLabel('');
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>新增週期性交易</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-6">
          <div className="md:col-span-2">
            <Label>描述</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="房租 / Netflix" />
          </div>
          <div>
            <Label>金額{fromAccountId && activeAccounts.find((a) => a.id === fromAccountId)?.currency !== 'TWD' ? `（${activeAccounts.find((a) => a.id === fromAccountId)?.currency}）` : ' (TWD)'}</Label>
            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <Label>扣款帳戶</Label>
            <AccountSelect
              value={fromAccountId}
              onValueChange={setFromAccountId}
              accounts={activeAccounts}
              types={[...RECURRING_ACCOUNT_TYPES]}
              placeholder="不指定（只進統計、不動餘額）"
            />
          </div>
          <div>
            <Label>類別</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {categories.map((c) => <SelectItem key={c.key} value={c.key}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>週期</Label>
            <Select value={frequency} onValueChange={(v) => setFrequency(v as Recurring['frequency'])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="weekly">每週</SelectItem>
                <SelectItem value="biweekly">每雙週</SelectItem>
                <SelectItem value="monthly">每月</SelectItem>
                <SelectItem value="yearly">每年</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>下次</Label>
            <DatePicker
              size="sm"
              value={parseDateInput(nextDue)}
              onChange={(d) => setNextDue(d ? formatDateInput(d) : '')}
              clearable={false}
            />
          </div>
          <div className="md:col-span-6">
            <Button onClick={handleAdd} disabled={create.isPending}>
              <Plus className="size-4" /> 新增
            </Button>
          </div>
        </CardContent>
      </Card>

      {recs.length === 0 ? (
        <EmptyState icon={Calendar} title="尚無週期性交易" />
      ) : (
        <Card>
          <CardContent className="space-y-3 p-3">
            <DataTableToolbar table={table} searchPlaceholder="搜尋描述或類別…" />
            {table.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">沒有符合條件的項目</p>
            ) : (
              <ul className="divide-y rounded-xl border">
                {table.rows.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 p-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">
                        {r.label ?? r.template.category}
                        {r.subscriptionId ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">訂閱</span> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {r.template.amount} {r.template.currency} · {FREQUENCY_LABEL[r.frequency] ?? r.frequency} · 下次 {formatTW(r.nextDue, 'yyyy-MM-dd')}
                        {r.template.fromAccountId
                          ? ` · ${accountName.get(r.template.fromAccountId) ?? '帳戶已刪除'}`
                          : ' · 不動帳戶餘額'}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                        {nextOccurrences(r.nextDue, r.frequency, 3).map((d, i) => (
                          <span key={i} className="rounded-md bg-muted px-1.5 py-0.5">
                            {formatTW(d, 'MM/dd')}
                          </span>
                        ))}
                      </div>
                    </div>
                    <Switch
                      checked={r.active}
                      onCheckedChange={(v) => void update.mutateAsync({ id: r.id, patch: { active: v } })}
                    />
                    <Button size="icon-sm" variant="ghost" onClick={() => void handleDelete(r)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <DataTablePagination table={table} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function nextOccurrences(from: Date, frequency: string, count: number): Date[] {
  const out: Date[] = [];
  let d = new Date(from);
  for (let i = 0; i < count; i++) {
    out.push(new Date(d));
    const next = new Date(d);
    switch (frequency) {
      case 'weekly': next.setDate(next.getDate() + 7); break;
      case 'biweekly': next.setDate(next.getDate() + 14); break;
      case 'yearly': d = addTWCalendarYears(d, 1); continue;
      case 'monthly':
      default: d = addTWCalendarMonths(d, 1); continue;
    }
    d = next;
  }
  return out;
}
