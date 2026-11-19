import { useMemo, useState } from 'react';
import { Archive, Banknote, Building2, CalendarClock, CreditCard, Landmark, Layers, PiggyBank, Plus, Receipt, Scale, ShieldCheck, TableProperties, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useConfirm } from '@/components/ui/confirm';
import { useFxRates } from '@/features/fx/hooks';
import { useCategories, useCreateTransaction } from '@/features/ledger/hooks';
import { useInstallmentRemainingByCard } from '@/features/installments/hooks';
import { addTWCalendarMonths, formatTW, nowTW, startOfTWDay } from '@/lib/tz';
import { currencyToTwdRate, currentAccountBalanceTWD, currentDebtBalanceTWD, longTermAccountValueTWD } from '../valuation';
import { InsuranceDetailsSchema, PensionDetailsSchema } from '../schema';
import { INSURANCE_PREMIUM_AHEAD_DAYS } from '../insurance';
import { usePayInsurancePremium } from '../insurance-pay';
import { projectPension } from '../pension';
import { ACCOUNT_TYPE_LABEL, INSURANCE_KIND_LABEL, PREMIUM_FREQUENCY_LABEL, type Account, type AccountInput, type AccountType } from '../types';
import { useAccounts, useArchiveAccount, useCreateAccount, useUpdateAccount } from '../hooks';
import { AccountSelect } from './account-select';
import { ReconcileDialog } from './reconcile-dialog';
import { AmortizationDialog } from './amortization-dialog';
import { InsuranceFields, PensionFields, defaultInsuranceDetails, defaultPensionDetails } from './account-detail-fields';
import type { Currency } from '@/types/global';

const ACCOUNT_TYPES = Object.keys(ACCOUNT_TYPE_LABEL) as AccountType[];
const CURRENCIES: Currency[] = ['TWD', 'USD', 'JPY', 'EUR', 'IDR'];
const TYPE_ICON: Record<AccountType, typeof Wallet> = {
  cash: Banknote,
  bank: Landmark,
  credit_card: CreditCard,
  e_wallet_balance: Wallet,
  investment_cash: Building2,
  loan: CreditCard,
  insurance: ShieldCheck,
  pension: PiggyBank,
};
const PAYMENT_SOURCE_TYPES: AccountType[] = ['cash', 'bank', 'e_wallet_balance'];
const formatTWD = (value: number) => `NT$${Math.round(value).toLocaleString()}`;
const PRESET_COLORS = ['#0ea5e9', '#22c55e', '#f97316', '#8b5cf6', '#ef4444', '#64748b'];

type EditingAccount = Partial<AccountInput> & { id?: string };

function createDraft(count: number): EditingAccount {
  return {
    name: '',
    type: 'bank',
    currency: 'TWD',
    active: true,
    balance: 0,
    balanceTWD: 0,
    colorKey: PRESET_COLORS[count % PRESET_COLORS.length],
  };
}

function toDraft(account: Account): EditingAccount {
  return {
    ...account,
    id: account.id,
    balance: account.balance,
    balanceTWD: account.balanceTWD,
  };
}

export function AccountsPanel() {
  const { data: accounts = [], isLoading } = useAccounts();
  const { data: fxRates = [] } = useFxRates();
  const create = useCreateAccount();
  const update = useUpdateAccount();
  const archive = useArchiveAccount();
  const createTx = useCreateTransaction();
  const payPremium = usePayInsurancePremium();
  const { data: categories = [] } = useCategories();
  const confirm = useConfirm();
  const installmentByCard = useInstallmentRemainingByCard();
  const [editing, setEditing] = useState<EditingAccount | null>(null);
  const [payingLoan, setPayingLoan] = useState<Account | null>(null);
  const [reconciling, setReconciling] = useState<Account | null>(null);
  const [amortizing, setAmortizing] = useState<Account | null>(null);
  const [loanPaidFromAccountId, setLoanPaidFromAccountId] = useState('');
  const [loanPaymentAmount, setLoanPaymentAmount] = useState('');
  const [payingPremium, setPayingPremium] = useState<Account | null>(null);
  const [premiumSourceId, setPremiumSourceId] = useState('');
  const [premiumAmount, setPremiumAmount] = useState('');
  const [premiumDate, setPremiumDate] = useState<Date>(() => new Date());
  const twToday = useMemo(() => {
    const tw = nowTW();
    return { twYear: tw.getFullYear(), twMonth: tw.getMonth() + 1 };
  }, []);

  const totals = useMemo(() => {
    const assetTypes: AccountType[] = ['cash', 'bank', 'e_wallet_balance', 'investment_cash'];
    const debtTypes: AccountType[] = ['credit_card', 'loan'];
    return accounts.reduce(
      (acc, account) => {
        if (assetTypes.includes(account.type)) acc.assets += currentAccountBalanceTWD(account, fxRates);
        // 保險只計解約金、退休帳戶以餘額計（與 useNetWorthNow 同口徑）
        acc.assets += longTermAccountValueTWD(account, fxRates);
        if (debtTypes.includes(account.type)) acc.debts += currentDebtBalanceTWD(account, fxRates);
        return acc;
      },
      { assets: 0, debts: 0 },
    );
  }, [accounts, fxRates]);

  const editingBalanceTWD = useMemo(() => {
    if (!editing) return 0;
    const currency = editing.currency ?? 'TWD';
    const balance = Number(editing.balance ?? 0);
    return balance * currencyToTwdRate(currency, fxRates);
  }, [editing, fxRates]);

  function startNew() {
    setEditing(createDraft(accounts.length));
  }

  async function handleSave() {
    if (!editing) return;
    const name = editing.name?.trim();
    if (!name) {
      toast.error('請輸入帳戶名稱');
      return;
    }
    const type = editing.type ?? 'bank';
    // 保單沒有「餘額」：淨值只看 insurance.cashValueTWD
    const balance = type === 'insurance' ? 0 : Number(editing.balance ?? 0);
    let insurance: AccountInput['insurance'];
    let pension: AccountInput['pension'];
    if (type === 'insurance') {
      const parsed = InsuranceDetailsSchema.safeParse(editing.insurance ?? defaultInsuranceDetails());
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? '保單資料不完整');
        return;
      }
      insurance = parsed.data;
    }
    if (type === 'pension') {
      const parsed = PensionDetailsSchema.safeParse(editing.pension ?? defaultPensionDetails());
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? '退休帳戶資料不完整');
        return;
      }
      pension = parsed.data;
    }
    const balanceTWD = balance * currencyToTwdRate(editing.currency ?? 'TWD', fxRates);
    const input: Omit<AccountInput, 'ownerId'> = {
      name,
      type,
      currency: editing.currency ?? 'TWD',
      active: editing.active !== false,
      archivedAt: editing.archivedAt ?? null,
      iconKey: editing.iconKey,
      colorKey: editing.colorKey,
      note: editing.note?.trim() || undefined,
      balance,
      balanceTWD,
      creditCard: type === 'credit_card'
        ? {
            closingDay: editing.creditCard?.closingDay ?? 1,
            dueDay: editing.creditCard?.dueDay ?? 15,
            cardLast4: editing.creditCard?.cardLast4,
            creditLimit: editing.creditCard?.creditLimit,
            linkedSettlementAccountId: editing.creditCard?.linkedSettlementAccountId,
          }
        : undefined,
      loan: type === 'loan'
        ? {
            principalTWD: editing.loan?.principalTWD ?? Math.abs(balanceTWD),
            monthlyPayment: editing.loan?.monthlyPayment ?? 1,
            nextDueDate: editing.loan?.nextDueDate ?? new Date(),
            interestRate: editing.loan?.interestRate,
            termMonths: editing.loan?.termMonths,
            linkedSettlementAccountId: editing.loan?.linkedSettlementAccountId,
          }
        : undefined,
      eWallet: editing.eWallet,
      insurance,
      pension,
      legacyPaymentMethod: editing.legacyPaymentMethod ?? null,
      legacySource: editing.legacySource ?? 'manual',
    };
    try {
      if (editing.id) {
        await update.mutateAsync({ id: editing.id, patch: input });
      } else {
        await create.mutateAsync(input);
      }
      setEditing(null);
    } catch (err) {
      console.error('[accountSave]', err);
      toast.error(err instanceof Error ? err.message : '帳戶儲存失敗');
    }
  }

  async function handleArchive(account: Account) {
    const ok = await confirm({
      title: '封存此帳戶？',
      description: `${account.name} 封存後不會再出現在新增交易選單，既有交易仍保留關聯。`,
      confirmText: '封存',
    });
    if (!ok) return;
    try {
      await archive.mutateAsync(account.id);
    } catch (err) {
      console.error('[accountArchive]', err);
      toast.error(err instanceof Error ? err.message : '帳戶封存失敗');
    }
  }

  function startLoanPayment(account: Account) {
    const firstSource = accounts.find((row) => ['cash', 'bank', 'e_wallet_balance'].includes(row.type));
    setPayingLoan(account);
    setLoanPaidFromAccountId(account.loan?.linkedSettlementAccountId ?? firstSource?.id ?? '');
    setLoanPaymentAmount(account.loan?.monthlyPayment ? String(account.loan.monthlyPayment) : '');
  }

  async function handleLoanPayment() {
    if (!payingLoan) return;
    const amount = Number(loanPaymentAmount);
    if (!loanPaidFromAccountId) {
      toast.error('請選擇扣款帳戶');
      return;
    }
    if (!amount || amount <= 0) {
      toast.error('請輸入繳款金額');
      return;
    }
    try {
      await createTx.mutateAsync({
        type: 'transfer',
        amount,
        currency: 'TWD',
        amountTWD: amount,
        fxRate: 1,
        category: 'loan_payment',
        paymentMethod: `貸款繳款：${payingLoan.name}`,
        fromAccountId: loanPaidFromAccountId,
        toAccountId: payingLoan.id,
        note: `${payingLoan.name} 繳款`,
        date: new Date(),
      });

      if (payingLoan.loan) {
        const newNextDueDate = addTWCalendarMonths(payingLoan.loan.nextDueDate, 1);
        await update.mutateAsync({
          id: payingLoan.id,
          patch: {
            loan: { ...payingLoan.loan, nextDueDate: newNextDueDate },
          },
        });
      }
      setPayingLoan(null);
    } catch (err) {
      console.error('[loanPayment]', err);
      toast.error(err instanceof Error ? err.message : '繳款失敗');
    }
  }

  function startPremiumPayment(account: Account) {
    const firstSource = accounts.find((row) => PAYMENT_SOURCE_TYPES.includes(row.type));
    setPayingPremium(account);
    setPremiumSourceId(firstSource?.id ?? '');
    setPremiumAmount(account.insurance?.premiumTWD ? String(account.insurance.premiumTWD) : '');
    setPremiumDate(new Date());
  }

  async function handlePremiumPayment() {
    if (!payingPremium) return;
    const source = accounts.find((row) => row.id === premiumSourceId);
    if (!source) {
      toast.error('請選擇扣款帳戶');
      return;
    }
    const amount = Number(premiumAmount);
    if (!(amount > 0)) {
      toast.error('請輸入保費金額');
      return;
    }
    try {
      await payPremium.mutateAsync({
        account: payingPremium,
        sourceAccount: source,
        amountTWD: amount,
        date: premiumDate,
        existingCategoryKeys: categories.map((c) => c.key),
      });
      setPayingPremium(null);
    } catch (err) {
      // 使用者可見的 toast 已在 mutation onError 處理
      console.error('[premiumPayment]', err);
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="size-4" /> 帳戶管理
            </CardTitle>
            <div className="mt-1 text-xs text-muted-foreground">
              資產 NT${Math.round(totals.assets).toLocaleString()} · 負債 NT${Math.round(totals.debts).toLocaleString()}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={startNew}>
            <Plus className="size-4" /> 新增
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中…</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              尚未建立帳戶。先建立現金、銀行、信用卡或電子錢包，之後交易會同步保留 legacy paymentMethod 與 accountId。
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {accounts.map((account) => {
                const Icon = TYPE_ICON[account.type] ?? Wallet;
                const today = startOfTWDay();
                const dueWarning = account.type === 'loan' && account.loan?.nextDueDate
                  && account.loan.nextDueDate.getTime() <= today.getTime() + 7 * 86400000;
                return (
                  <li key={account.id} className="flex items-center gap-3 p-3 text-sm">
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: `${account.colorKey ?? '#94a3b8'}20`, color: account.colorKey ?? '#94a3b8' }}
                    >
                      <Icon className="size-4" />
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditing(toDraft(account))}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate font-medium">{account.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {ACCOUNT_TYPE_LABEL[account.type]} · {Math.round(account.balance).toLocaleString()} {account.currency}
                        {' · 約 NT$'}{Math.round(currentAccountBalanceTWD(account, fxRates)).toLocaleString()}
                      </div>
                      {account.type === 'loan' && account.loan ? (
                        <div className={`mt-1 flex items-center gap-1 text-xs ${dueWarning ? 'text-destructive' : 'text-muted-foreground'}`}>
                          <CalendarClock className="size-3" />
                          每期 NT${Math.round(account.loan.monthlyPayment).toLocaleString()}
                          {' · 下期 '}{formatTW(account.loan.nextDueDate, 'yyyy/MM/dd')}
                          {account.loan.interestRate ? ` · ${account.loan.interestRate}%` : ''}
                        </div>
                      ) : null}
                      {account.type === 'insurance' && account.insurance ? (() => {
                        const ins = account.insurance;
                        const premiumDue = ins.nextPremiumDate.getTime() <= today.getTime() + INSURANCE_PREMIUM_AHEAD_DAYS * 86400000;
                        return (
                          <>
                            <div className={`mt-1 flex items-center gap-1 text-xs ${premiumDue ? 'text-destructive' : 'text-muted-foreground'}`}>
                              <CalendarClock className="size-3" />
                              {INSURANCE_KIND_LABEL[ins.kind]} · {PREMIUM_FREQUENCY_LABEL[ins.premiumFrequency]} {formatTWD(ins.premiumTWD)}
                              {' · 下次 '}{formatTW(ins.nextPremiumDate, 'yyyy/MM/dd')}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                              {ins.insurer}
                              {ins.coverageTWD ? ` · 保額 ${formatTWD(ins.coverageTWD)}` : ''}
                              {ins.cashValueTWD ? ` · 解約金 ${formatTWD(ins.cashValueTWD)}` : ' · 純保障（不計淨值）'}
                              {ins.maturityDate ? ` · 滿期 ${formatTW(ins.maturityDate, 'yyyy/MM/dd')}` : ''}
                            </div>
                          </>
                        );
                      })() : null}
                      {account.type === 'pension' ? (() => {
                        const projection = projectPension(currentAccountBalanceTWD(account, fxRates), account.pension, twToday);
                        return (
                          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                            <PiggyBank className="size-3" />
                            {projection
                              ? `${projection.retirementYear} 年退休預估 ${formatTWD(projection.projectedTWD)}（月提繳 ${formatTWD(projection.monthlyContributionTWD)} · 年報酬 ${projection.expectedReturnPct}%）`
                              : '填出生年即可試算退休時金額'}
                          </div>
                        );
                      })() : null}
                      {account.type === 'credit_card' && account.creditCard ? (
                        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                          <CalendarClock className="size-3" />
                          結帳 {account.creditCard.closingDay} 日 · 繳款 {account.creditCard.dueDay} 日
                        </div>
                      ) : null}
                      {account.type === 'credit_card' && (installmentByCard.get(account.id) ?? 0) > 0 ? (
                        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                          <Layers className="size-3" />
                          分期未到期 NT${Math.round(installmentByCard.get(account.id) ?? 0).toLocaleString()}
                        </div>
                      ) : null}
                      {account.lastReconciledAt ? (
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Scale className="size-3" /> 上次對帳 {formatTW(account.lastReconciledAt, 'MM/dd')}
                        </div>
                      ) : null}
                    </button>
                    <Badge variant="outline">{ACCOUNT_TYPE_LABEL[account.type]}</Badge>
                    {account.type === 'loan' ? (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setAmortizing(account)} aria-label="攤還表">
                          <TableProperties className="size-4" /> <span className="hidden sm:inline">攤還表</span>
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => startLoanPayment(account)}>
                          <Receipt className="size-4" /> 繳款
                        </Button>
                      </>
                    ) : account.type === 'insurance' ? (
                      <Button size="sm" variant="outline" onClick={() => startPremiumPayment(account)}>
                        <Receipt className="size-4" /> 已繳保費
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setReconciling(account)} aria-label="對帳">
                        <Scale className="size-4" /> 對帳
                      </Button>
                    )}
                    <Button size="icon-sm" variant="ghost" onClick={() => void handleArchive(account)} aria-label="封存帳戶">
                      <Archive className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={Boolean(editing)}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        title={editing?.id ? '編輯帳戶' : '新增帳戶'}
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setEditing(null)}>取消</Button>
            <Button className="flex-1" onClick={() => void handleSave()} disabled={create.isPending || update.isPending}>
              儲存
            </Button>
          </div>
        }
      >
        {editing ? (
          <div className="space-y-3">
            <div>
              <Label>名稱</Label>
              <Input
                value={editing.name ?? ''}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="台新 CUBE / 玉山交割戶 / 悠遊卡"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>類型</Label>
                <Select
                  value={editing.type ?? 'bank'}
                  onValueChange={(value) => {
                    const type = value as AccountType;
                    setEditing({
                      ...editing,
                      type,
                      insurance: type === 'insurance' ? editing.insurance ?? defaultInsuranceDetails() : editing.insurance,
                      pension: type === 'pension' ? editing.pension ?? defaultPensionDetails() : editing.pension,
                    });
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>{ACCOUNT_TYPE_LABEL[type]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>幣別</Label>
                <Select
                  value={editing.currency ?? 'TWD'}
                  onValueChange={(value) => setEditing({ ...editing, currency: value })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((currency) => (
                      <SelectItem key={currency} value={currency}>{currency}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {editing.type !== 'insurance' ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{editing.type === 'pension' ? '目前累積金額（原幣）' : '餘額（原幣）'}</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={editing.balance ?? 0}
                  onChange={(e) => setEditing({ ...editing, balance: Number(e.target.value) })}
                />
              </div>
              <div>
                <Label>等值 TWD（自動換算）</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={Math.round(editingBalanceTWD)}
                  readOnly
                  className="bg-muted/40"
                />
              </div>
            </div>
            ) : null}
            {editing.type === 'insurance' ? (
              <InsuranceFields
                value={editing.insurance ?? defaultInsuranceDetails()}
                onChange={(insurance) => setEditing({ ...editing, insurance })}
              />
            ) : null}
            {editing.type === 'pension' ? (
              <PensionFields
                value={editing.pension ?? defaultPensionDetails()}
                onChange={(pension) => setEditing({ ...editing, pension })}
              />
            ) : null}
            {editing.type === 'credit_card' ? (
              <div className="space-y-3 rounded-lg border p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>結帳日</Label>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={editing.creditCard?.closingDay ?? 1}
                      onChange={(e) => setEditing({
                        ...editing,
                        creditCard: {
                          closingDay: Math.max(1, Math.min(31, Number(e.target.value))),
                          dueDay: editing.creditCard?.dueDay ?? 15,
                          cardLast4: editing.creditCard?.cardLast4,
                          creditLimit: editing.creditCard?.creditLimit,
                          linkedSettlementAccountId: editing.creditCard?.linkedSettlementAccountId,
                        },
                      })}
                    />
                  </div>
                  <div>
                    <Label>繳款日</Label>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={editing.creditCard?.dueDay ?? 15}
                      onChange={(e) => setEditing({
                        ...editing,
                        creditCard: {
                          closingDay: editing.creditCard?.closingDay ?? 1,
                          dueDay: Math.max(1, Math.min(31, Number(e.target.value))),
                          cardLast4: editing.creditCard?.cardLast4,
                          creditLimit: editing.creditCard?.creditLimit,
                          linkedSettlementAccountId: editing.creditCard?.linkedSettlementAccountId,
                        },
                      })}
                    />
                  </div>
                </div>
                <div>
                  <Label>歸屬銀行帳戶（繳卡費的扣款帳戶）</Label>
                  <AccountSelect
                    value={editing.creditCard?.linkedSettlementAccountId ?? ''}
                    onValueChange={(value) => setEditing({
                      ...editing,
                      creditCard: {
                        closingDay: editing.creditCard?.closingDay ?? 1,
                        dueDay: editing.creditCard?.dueDay ?? 15,
                        cardLast4: editing.creditCard?.cardLast4,
                        creditLimit: editing.creditCard?.creditLimit,
                        linkedSettlementAccountId: value || undefined,
                      },
                    })}
                    accounts={accounts.filter((row) => row.id !== editing.id)}
                    types={['cash', 'bank']}
                    placeholder="選擇繳卡費扣款帳戶"
                  />
                </div>
              </div>
            ) : null}
            {editing.type === 'loan' ? (
              <div className="space-y-3 rounded-lg border p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>剩餘本金 TWD</Label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={editing.loan?.principalTWD ?? 0}
                      onChange={(e) => setEditing({
                        ...editing,
                        loan: {
                          principalTWD: Number(e.target.value),
                          monthlyPayment: editing.loan?.monthlyPayment ?? 0,
                          nextDueDate: editing.loan?.nextDueDate ?? new Date(),
                          interestRate: editing.loan?.interestRate,
                          termMonths: editing.loan?.termMonths,
                          linkedSettlementAccountId: editing.loan?.linkedSettlementAccountId,
                        },
                      })}
                    />
                  </div>
                  <div>
                    <Label>每期應繳 TWD</Label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={editing.loan?.monthlyPayment ?? 0}
                      onChange={(e) => setEditing({
                        ...editing,
                        loan: {
                          principalTWD: editing.loan?.principalTWD ?? 0,
                          monthlyPayment: Number(e.target.value),
                          nextDueDate: editing.loan?.nextDueDate ?? new Date(),
                          interestRate: editing.loan?.interestRate,
                          termMonths: editing.loan?.termMonths,
                          linkedSettlementAccountId: editing.loan?.linkedSettlementAccountId,
                        },
                      })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>下期繳款日</Label>
                    <DatePicker
                      value={editing.loan?.nextDueDate ?? null}
                      onChange={(date) => setEditing({
                        ...editing,
                        loan: {
                          principalTWD: editing.loan?.principalTWD ?? 0,
                          monthlyPayment: editing.loan?.monthlyPayment ?? 0,
                          nextDueDate: date ?? new Date(),
                          interestRate: editing.loan?.interestRate,
                          termMonths: editing.loan?.termMonths,
                          linkedSettlementAccountId: editing.loan?.linkedSettlementAccountId,
                        },
                      })}
                      clearable={false}
                    />
                  </div>
                  <div>
                    <Label>年利率（%）</Label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={editing.loan?.interestRate ?? ''}
                      onChange={(e) => setEditing({
                        ...editing,
                        loan: {
                          principalTWD: editing.loan?.principalTWD ?? 0,
                          monthlyPayment: editing.loan?.monthlyPayment ?? 0,
                          nextDueDate: editing.loan?.nextDueDate ?? new Date(),
                          interestRate: e.target.value === '' ? undefined : Number(e.target.value),
                          termMonths: editing.loan?.termMonths,
                          linkedSettlementAccountId: editing.loan?.linkedSettlementAccountId,
                        },
                      })}
                    />
                  </div>
                </div>
                <div>
                  <Label>預設扣款帳戶</Label>
                  <AccountSelect
                    value={editing.loan?.linkedSettlementAccountId ?? ''}
                    onValueChange={(value) => setEditing({
                      ...editing,
                      loan: {
                        principalTWD: editing.loan?.principalTWD ?? 0,
                        monthlyPayment: editing.loan?.monthlyPayment ?? 0,
                        nextDueDate: editing.loan?.nextDueDate ?? new Date(),
                        interestRate: editing.loan?.interestRate,
                        termMonths: editing.loan?.termMonths,
                        linkedSettlementAccountId: value || undefined,
                      },
                    })}
                    accounts={accounts.filter((row) => row.id !== editing.id)}
                    types={['cash', 'bank']}
                    placeholder="選擇預設扣款帳戶"
                  />
                </div>
              </div>
            ) : null}
            <div>
              <Label>備註</Label>
              <Textarea
                value={editing.note ?? ''}
                onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                rows={2}
              />
            </div>
            <div>
              <Label>顏色</Label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setEditing({ ...editing, colorKey: color })}
                    className="size-7 rounded-full border-2 border-background ring-offset-background transition-transform data-[selected=true]:scale-110 data-[selected=true]:ring-2"
                    style={{ backgroundColor: color }}
                    data-selected={editing.colorKey === color}
                    aria-label={color}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </ResponsiveDialog>

      <ResponsiveDialog
        open={Boolean(payingLoan)}
        onOpenChange={(open) => { if (!open) setPayingLoan(null); }}
        title={payingLoan ? `貸款繳款 — ${payingLoan.name}` : '貸款繳款'}
        description="建立 transfer 扣來源帳戶並降低貸款餘額，不會列入月支出。"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setPayingLoan(null)}>取消</Button>
            <Button className="flex-1" onClick={() => void handleLoanPayment()} disabled={createTx.isPending}>
              確認繳款
            </Button>
          </div>
        }
      >
        {payingLoan ? (
          <div className="space-y-3">
            <div>
              <Label>扣款帳戶</Label>
              <AccountSelect
                value={loanPaidFromAccountId}
                onValueChange={setLoanPaidFromAccountId}
                accounts={accounts}
                types={['cash', 'bank', 'e_wallet_balance']}
              />
            </div>
            <div>
              <Label>繳款金額</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={loanPaymentAmount}
                onChange={(e) => setLoanPaymentAmount(e.target.value)}
              />
            </div>
          </div>
        ) : null}
      </ResponsiveDialog>

      <ResponsiveDialog
        open={Boolean(payingPremium)}
        onOpenChange={(open) => { if (!open) setPayingPremium(null); }}
        title={payingPremium ? `繳保費 — ${payingPremium.name}` : '繳保費'}
        description="建立一筆「保險」支出扣來源帳戶，並把下次繳費日往後推一期。"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setPayingPremium(null)}>取消</Button>
            <Button className="flex-1" onClick={() => void handlePremiumPayment()} disabled={payPremium.isPending}>
              確認已繳
            </Button>
          </div>
        }
      >
        {payingPremium?.insurance ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              本期 {formatTW(payingPremium.insurance.nextPremiumDate, 'yyyy/MM/dd')}
              {' · '}{PREMIUM_FREQUENCY_LABEL[payingPremium.insurance.premiumFrequency]}
            </p>
            <div>
              <Label>扣款帳戶</Label>
              <AccountSelect
                value={premiumSourceId}
                onValueChange={setPremiumSourceId}
                accounts={accounts}
                types={[...PAYMENT_SOURCE_TYPES, 'credit_card']}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>金額 TWD</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={premiumAmount}
                  onChange={(e) => setPremiumAmount(e.target.value)}
                />
              </div>
              <div>
                <Label>繳費日</Label>
                <DatePicker value={premiumDate} onChange={(date) => setPremiumDate(date ?? new Date())} clearable={false} />
              </div>
            </div>
          </div>
        ) : null}
      </ResponsiveDialog>

      <ReconcileDialog account={reconciling} onClose={() => setReconciling(null)} />
      <AmortizationDialog account={amortizing} onOpenChange={(open) => { if (!open) setAmortizing(null); }} />
    </>
  );
}
