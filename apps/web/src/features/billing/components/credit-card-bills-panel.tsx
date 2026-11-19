import { useMemo, useState } from 'react';
import { CheckCircle2, CreditCard, History, Layers, ListTree, RotateCcw, AlertTriangle, Calendar, CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useConfirm } from '@/components/ui/confirm';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AccountSelect, useAccounts, useUpdateAccount, type Account } from '@/features/accounts';
import { useCreateTransaction } from '@/features/ledger/hooks';
import { useInstallmentRemainingByCard } from '@/features/installments/hooks';
import { dateInputToTWDate, daysBetweenTWDates, formatDateInput, formatTW, fromTW, startOfTWDay, toTW } from '@/lib/tz';
import { cn, formatCurrency } from '@/lib/utils';
import {
  paymentMethodLabel, usePaymentMethods, type PaymentMethod,
} from '@/features/ledger/payment-methods';
import {
  clampDayToMonth, currentDueDate, cycleMonthKey, deriveStatementDate, effectiveDueDate,
  type CreditCardBill,
} from '../types';
import {
  useAllBills, useBillsForCard, useClearBillOverride, useMarkBillPaid,
  useSetBillOverride, useUnmarkBillPaid,
} from '../hooks';
import { BillDetailsDialog, deriveCycleRange } from './bill-details-dialog';

export interface CycleView {
  pm: PaymentMethod;
  cycleMonth: string;
  /** 該期原始截止日（pm.dueDay 推算） */
  dueDate: Date;
  /** 實際生效截止日（override 優先，否則 = dueDate） */
  effectiveDue: Date;
  /** override 是否啟用 */
  hasOverride: boolean;
  overrideReason: string | null;
  statementDate: Date | null;
  bill: CreditCardBill | null;
  /** 距離今天的天數：正值=尚未到期、0=今日到期、負值=已逾期 */
  daysToDue: number;
  /** UI 狀態 */
  status: 'paid' | 'today' | 'overdue' | 'upcoming';
}

function startOfDay(d: Date): Date {
  return startOfTWDay(d);
}

function nextDueDate(dueDay: number, baseDate: Date = new Date()): Date {
  const tw = toTW(baseDate);
  const y = tw.getFullYear();
  const m = tw.getMonth();
  const d = tw.getDate();
  const thisMonthDue = clampDayToMonth(y, m, dueDay);
  if (d < thisMonthDue) return fromTW(new Date(y, m, thisMonthDue));
  // 已過本月繳款日 → 下個月
  const next = new Date(y, m + 1, 1);
  const nextDue = clampDayToMonth(next.getFullYear(), next.getMonth(), dueDay);
  return fromTW(new Date(next.getFullYear(), next.getMonth(), nextDue));
}

export function buildCycleView(pm: PaymentMethod, billsByKey: Map<string, CreditCardBill>): CycleView | null {
  if (!pm.billingEnabled || pm.dueDay == null || pm.archivedAt) return null;
  const today0 = startOfDay(new Date());

  const currDue = currentDueDate(pm.dueDay, today0);
  const currKey = `${pm.id}__${cycleMonthKey(currDue)}`;
  const currBill = billsByKey.get(currKey) ?? null;

  // 若上期未繳 → 顯示上期（逾期或今日到期）
  if (!currBill || !currBill.paidAt) {
    const eff = currBill ? effectiveDueDate(currBill) : currDue;
    const days = daysBetweenTWDates(today0, eff);
    const status: CycleView['status'] = days === 0 ? 'today' : days < 0 ? 'overdue' : 'upcoming';
    return {
      pm,
      cycleMonth: cycleMonthKey(currDue),
      dueDate: currDue,
      effectiveDue: eff,
      hasOverride: !!currBill?.dueDateOverride,
      overrideReason: currBill?.overrideReason ?? null,
      statementDate: deriveStatementDate(currDue, pm.statementDay ?? null),
      bill: currBill,
      daysToDue: days,
      status,
    };
  }

  // 上期已繳 → 顯示下期（upcoming）
  // 重要：下期 dueDate 永遠用 pm.dueDay 推算，不受上期 override 影響（override 是一次性的）
  const nextDue = nextDueDate(pm.dueDay, today0);
  const nextKey = `${pm.id}__${cycleMonthKey(nextDue)}`;
  const nextBill = billsByKey.get(nextKey) ?? null;
  const eff = nextBill ? effectiveDueDate(nextBill) : nextDue;
  const days = daysBetweenTWDates(today0, eff);
  return {
    pm,
    cycleMonth: cycleMonthKey(nextDue),
    dueDate: nextDue,
    effectiveDue: eff,
    hasOverride: !!nextBill?.dueDateOverride,
    overrideReason: nextBill?.overrideReason ?? null,
    statementDate: deriveStatementDate(nextDue, pm.statementDay ?? null),
    bill: nextBill,
    daysToDue: days,
    status: nextBill?.paidAt ? 'paid' : 'upcoming',
  };
}

export function CreditCardBillsPanel() {
  const { data: methods = [], isLoading: pmLoading } = usePaymentMethods();
  const { data: bills = [], isLoading: billsLoading } = useAllBills();
  const markPaid = useMarkBillPaid();
  const unmarkPaid = useUnmarkBillPaid();
  const setOverride = useSetBillOverride();
  const clearOverride = useClearBillOverride();
  const createTx = useCreateTransaction();
  const { data: accounts = [] } = useAccounts();
  const confirm = useConfirm();
  const [historyFor, setHistoryFor] = useState<PaymentMethod | null>(null);
  const [detailsFor, setDetailsFor] = useState<CycleView | null>(null);
  const [overrideFor, setOverrideFor] = useState<CycleView | null>(null);
  const [payFor, setPayFor] = useState<CycleView | null>(null);
  const [paidFromAccountId, setPaidFromAccountId] = useState('');
  // 自動對不到信用卡帳戶時，讓使用者手動指定（以前只標記已繳、不建 transfer，餘額不會減少，稽核 D8）
  const [manualCardAccountId, setManualCardAccountId] = useState('');
  const updateAccount = useUpdateAccount();
  const creditCardAccounts = useMemo(
    () => accounts.filter((a) => a.type === 'credit_card' && a.active !== false && !a.archivedAt),
    [accounts],
  );
  const installmentByCard = useInstallmentRemainingByCard();
  const [paidAmount, setPaidAmount] = useState('');
  const [overrideDate, setOverrideDate] = useState<Date | null>(null);
  const [overrideReason, setOverrideReason] = useState('');

  const billsByKey = useMemo(() => {
    const m = new Map<string, CreditCardBill>();
    for (const b of bills) m.set(`${b.paymentMethodId}__${b.cycleMonth}`, b);
    return m;
  }, [bills]);

  const enabledCards = useMemo(
    () => methods.filter((m) => m.type === 'credit' && m.billingEnabled && m.dueDay != null && !m.archivedAt),
    [methods],
  );

  const cycles = useMemo(
    () => enabledCards
      .map((pm) => buildCycleView(pm, billsByKey))
      .filter((c): c is CycleView => c !== null)
      .sort((a, b) => a.daysToDue - b.daysToDue),
    [enabledCards, billsByKey],
  );

  function findCardAccount(pm: PaymentMethod): Account | null {
    return accounts.find((account) =>
      account.type === 'credit_card' &&
      (account.legacyPaymentMethod === pm.name ||
        account.legacyPaymentMethod === pm.key ||
        account.name === pm.name ||
        account.name === paymentMethodLabel(pm))) ?? null;
  }

  /** 繳費用：自動對應優先，對不到就用手動指定的那張 */
  function resolvePayCardAccount(pm: PaymentMethod): Account | null {
    return findCardAccount(pm) ?? creditCardAccounts.find((a) => a.id === manualCardAccountId) ?? null;
  }

  function startPay(c: CycleView) {
    setManualCardAccountId('');
    const cardAccount = findCardAccount(c.pm);
    const linkedSource = cardAccount?.creditCard?.linkedSettlementAccountId
      ? accounts.find((account) => account.id === cardAccount.creditCard?.linkedSettlementAccountId)
      : null;
    const firstSource = linkedSource ?? accounts.find((account) => ['cash', 'bank', 'e_wallet_balance'].includes(account.type));
    setPayFor(c);
    setPaidFromAccountId(firstSource?.id ?? '');
    setPaidAmount(c.bill?.amount != null
      ? String(c.bill.amount)
      : cardAccount && cardAccount.balanceTWD > 0
        ? String(Math.round(cardAccount.balanceTWD))
        : '');
  }

  async function handleMarkPaid(c: CycleView, paidFromId?: string, amountInput?: number) {
    const cardAccount = resolvePayCardAccount(c.pm);
    let transferId: string | null = null;
    if (cardAccount && paidFromId && amountInput && amountInput > 0) {
      transferId = await createTx.mutateAsync({
        type: 'transfer',
        amount: amountInput,
        currency: 'TWD',
        amountTWD: amountInput,
        fxRate: 1,
        category: 'credit_card_payment',
        paymentMethod: `繳卡費：${paymentMethodLabel(c.pm)}`,
        fromAccountId: paidFromId,
        toAccountId: cardAccount.id,
        note: `${c.cycleMonth} 信用卡繳費`,
        date: new Date(),
      });
    }
    await markPaid.mutateAsync({
      paymentMethodId: c.pm.id,
      accountId: cardAccount?.id ?? null,
      cycleMonth: c.cycleMonth,
      dueDate: c.dueDate,
      statementDate: c.statementDate,
      amount: amountInput ?? c.bill?.amount ?? null,
      paidFromAccountId: paidFromId ?? null,
      paidViaTransferId: transferId,
    });
    toast.success(`已標記 ${paymentMethodLabel(c.pm)} ${c.cycleMonth} 為已繳費`);
  }

  async function handleConfirmPay() {
    if (!payFor) return;
    const amount = paidAmount.trim() === '' ? null : Number(paidAmount);
    const autoMatched = findCardAccount(payFor.pm);
    const cardAccount = resolvePayCardAccount(payFor.pm);
    if (cardAccount && !paidFromAccountId) {
      toast.error('請選擇扣款帳戶');
      return;
    }
    if (cardAccount && (!amount || amount <= 0)) {
      toast.error('請輸入繳款金額');
      return;
    }
    await handleMarkPaid(payFor, paidFromAccountId || undefined, amount ?? undefined);
    // 手動指定的對應記到帳戶的 legacyPaymentMethod，下次就能自動對上
    if (!autoMatched && cardAccount && !cardAccount.legacyPaymentMethod) {
      updateAccount.mutate({ id: cardAccount.id, patch: { legacyPaymentMethod: payFor.pm.name } });
    }
    setPayFor(null);
  }

  async function handleUnmark(c: CycleView) {
    if (!c.bill) return;
    const ok = await confirm({
      title: '取消已繳費標記？',
      description: `${paymentMethodLabel(c.pm)} ${c.cycleMonth} 將被視為未繳，提醒會恢復。`,
      confirmText: '取消標記',
    });
    if (!ok) return;
    await unmarkPaid.mutateAsync({ paymentMethodId: c.pm.id, cycleMonth: c.cycleMonth });
    toast.success('已取消標記');
  }

  function startOverride(c: CycleView) {
    setOverrideFor(c);
    setOverrideDate(c.hasOverride ? c.effectiveDue : c.dueDate);
    setOverrideReason(c.overrideReason ?? '');
  }

  async function handleSaveOverride() {
    if (!overrideFor || !overrideDate) return;
    const normalizedOverrideDate = dateInputToTWDate(formatDateInput(overrideDate)) ?? overrideDate;
    const sameAsOriginal = startOfTWDay(normalizedOverrideDate).getTime() === startOfTWDay(overrideFor.dueDate).getTime();
    await setOverride.mutateAsync({
      paymentMethodId: overrideFor.pm.id,
      cycleMonth: overrideFor.cycleMonth,
      dueDate: overrideFor.dueDate,
      statementDate: overrideFor.statementDate,
      dueDateOverride: sameAsOriginal ? null : normalizedOverrideDate,
      reason: sameAsOriginal ? null : overrideReason.trim() || null,
    });
    toast.success(sameAsOriginal ? '已清除本期調整' : '已調整本期截止日');
    setOverrideFor(null);
  }

  async function handleClearOverride() {
    if (!overrideFor) return;
    await clearOverride.mutateAsync({
      paymentMethodId: overrideFor.pm.id,
      cycleMonth: overrideFor.cycleMonth,
    });
    toast.success('已清除本期調整');
    setOverrideFor(null);
  }

  const isLoading = pmLoading || billsLoading;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="size-4" /> 信用卡帳單
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            列出所有「啟用帳單提醒」的信用卡。標記已繳費後，Telegram 提醒會停止；下期到期日當天起再次自動提醒，直到下次標記。
          </p>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中…</p>
          ) : cycles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              尚未啟用任何信用卡的帳單提醒 — 到「支付」分頁編輯卡片，開啟「帳單提醒」並填入繳款截止日。
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {cycles.map((c) => <BillRow
                key={`${c.pm.id}-${c.cycleMonth}`}
                cycle={c}
                installmentRemainingTWD={installmentByCard.get(findCardAccount(c.pm)?.id ?? '') ?? 0}
                onMarkPaid={() => startPay(c)}
                onUnmarkPaid={() => void handleUnmark(c)}
                onShowHistory={() => setHistoryFor(c.pm)}
                onShowDetails={() => setDetailsFor(c)}
                onAdjust={() => startOverride(c)}
                isPending={markPaid.isPending || unmarkPaid.isPending || setOverride.isPending || clearOverride.isPending}
              />)}
            </ul>
          )}
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={!!payFor}
        onOpenChange={(o) => { if (!o) setPayFor(null); }}
        title={payFor ? `繳卡費 — ${paymentMethodLabel(payFor.pm)}` : '繳卡費'}
        description="建立 transfer 扣來源帳戶並沖信用卡帳戶，不會新增支出。"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setPayFor(null)}>取消</Button>
            <Button
              className="flex-1"
              onClick={() => void handleConfirmPay()}
              disabled={markPaid.isPending || createTx.isPending}
            >
              確認繳費
            </Button>
          </div>
        }
      >
        {payFor ? (
          <div className="space-y-3">
            {!findCardAccount(payFor.pm) && creditCardAccounts.length > 0 ? (
              <div>
                <Label>對應的信用卡帳戶</Label>
                <AccountSelect
                  value={manualCardAccountId}
                  onValueChange={setManualCardAccountId}
                  accounts={creditCardAccounts}
                  placeholder="自動對不到，請選擇這張卡對應的帳戶"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">選過一次會記住，之後自動對應。</p>
              </div>
            ) : null}
            {resolvePayCardAccount(payFor.pm) ? (
              <>
                <div>
                  <Label>扣款帳戶</Label>
                  <AccountSelect
                    value={paidFromAccountId}
                    onValueChange={setPaidFromAccountId}
                    accounts={accounts}
                    types={['cash', 'bank', 'e_wallet_balance']}
                  />
                </div>
                <div>
                  <Label>繳款金額</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={paidAmount}
                    onChange={(e) => setPaidAmount(e.target.value)}
                    placeholder="本期實繳金額"
                  />
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {creditCardAccounts.length > 0
                  ? '選擇對應的信用卡帳戶後，會建立 transfer 扣款並沖銷卡費；不選的話只標記已繳、不動帳戶餘額。'
                  : '還沒有信用卡帳戶，這次只標記帳單已繳、不動帳戶餘額。到「帳戶」建立信用卡帳戶後即可自動建立 transfer。'}
              </p>
            )}
          </div>
        ) : null}
      </ResponsiveDialog>

      <ResponsiveDialog
        open={!!historyFor}
        onOpenChange={(o) => { if (!o) setHistoryFor(null); }}
        title={historyFor ? `${paymentMethodLabel(historyFor)} — 帳單歷史` : '帳單歷史'}
        description="近 12 期"
      >
        {historyFor && <BillHistory pm={historyFor} />}
      </ResponsiveDialog>

      {detailsFor ? (() => {
        const range = deriveCycleRange({
          effectiveDue: detailsFor.effectiveDue,
          statementDay: detailsFor.pm.statementDay,
        });
        return (
          <BillDetailsDialog
            open={true}
            onOpenChange={(open) => { if (!open) setDetailsFor(null); }}
            pm={detailsFor.pm}
            cardAccount={findCardAccount(detailsFor.pm)}
            cycleMonth={detailsFor.cycleMonth}
            cycleStart={range.start}
            cycleEnd={range.end}
            bill={detailsFor.bill}
          />
        );
      })() : null}

      <ResponsiveDialog
        open={!!overrideFor}
        onOpenChange={(o) => { if (!o) setOverrideFor(null); }}
        title={overrideFor ? `調整本期截止日 — ${paymentMethodLabel(overrideFor.pm)}` : '調整截止日'}
        description="連假延期等臨時調整。僅作用於本期，不影響下期。"
        footer={
          <div className="flex gap-2">
            {overrideFor?.hasOverride ? (
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => void handleClearOverride()}
                disabled={setOverride.isPending || clearOverride.isPending}
              >
                清除調整
              </Button>
            ) : (
              <Button variant="outline" className="flex-1" onClick={() => setOverrideFor(null)}>取消</Button>
            )}
            <Button
              className="flex-1"
              onClick={() => void handleSaveOverride()}
              disabled={!overrideDate || setOverride.isPending || clearOverride.isPending}
            >
              儲存
            </Button>
          </div>
        }
      >
        {overrideFor && (
          <div className="space-y-3">
            <div className="rounded-lg border p-3 text-xs text-muted-foreground">
              原始截止日：{formatTW(overrideFor.dueDate, 'yyyy/MM/dd (eee)')}
            </div>
            <div>
              <Label>調整後截止日</Label>
              <DatePicker
                value={overrideDate}
                onChange={setOverrideDate}
                clearable={false}
              />
            </div>
            <div>
              <Label>原因（選填）</Label>
              <Input
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="連假 / 出差 / 其他"
                maxLength={40}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              調整後 Telegram 會以新的截止日為基準提醒。標記已繳費後，下期會回到 pm 設定的繳款日，不受本次調整影響。
            </p>
          </div>
        )}
      </ResponsiveDialog>
    </>
  );
}

function BillRow({
  cycle, installmentRemainingTWD, onMarkPaid, onUnmarkPaid, onShowHistory, onShowDetails, onAdjust, isPending,
}: {
  cycle: CycleView;
  /** 這張卡「分期未到期」（尚未入帳到卡片）的金額 */
  installmentRemainingTWD: number;
  onMarkPaid: () => void;
  onUnmarkPaid: () => void;
  onShowHistory: () => void;
  onShowDetails: () => void;
  onAdjust: () => void;
  isPending: boolean;
}) {
  const { pm, dueDate, effectiveDue, hasOverride, overrideReason, statementDate, status, daysToDue, bill } = cycle;

  const statusLabel = status === 'paid'
    ? '已繳費'
    : status === 'today'
      ? '今日到期'
      : status === 'overdue'
        ? `已逾期 ${Math.abs(daysToDue)} 天`
        : `${daysToDue} 天後到期`;

  const statusVariant = status === 'paid'
    ? 'secondary' as const
    : status === 'today' || status === 'overdue'
      ? 'destructive' as const
      : 'outline' as const;

  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: (pm.color ?? '#94a3b8') + '20', color: pm.color ?? '#94a3b8' }}
      >
        <CreditCard className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{paymentMethodLabel(pm)}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Calendar className="size-3" />
            {hasOverride ? (
              <>
                繳款 <span className="line-through opacity-60">{formatTW(dueDate, 'MM/dd')}</span> → <span className="font-medium text-foreground">{formatTW(effectiveDue, 'MM/dd')}</span>
              </>
            ) : (
              <>繳款 {formatTW(dueDate, 'MM/dd')}</>
            )}
            {statementDate ? ` · 結帳 ${formatTW(statementDate, 'MM/dd')}` : ''}
          </span>
          <span>·</span>
          <span>{cycle.cycleMonth}</span>
          {hasOverride && overrideReason ? (
            <Badge variant="outline" className="text-[10px]">{overrideReason}</Badge>
          ) : null}
          {installmentRemainingTWD > 0 ? (
            <span className="inline-flex items-center gap-1" title="分期尚未入帳到這張卡的金額，之後每期會自動入帳">
              <Layers className="size-3" /> 分期未到期 {formatCurrency(installmentRemainingTWD)}
            </span>
          ) : null}
        </div>
      </div>
      <Badge variant={statusVariant} className={cn(status === 'overdue' && 'gap-1')}>
        {status === 'overdue' ? <AlertTriangle className="size-3" /> : null}
        {statusLabel}
      </Badge>
      <div className="flex items-center gap-1">
        {status === 'paid' && bill ? (
          <Button size="sm" variant="ghost" onClick={onUnmarkPaid} disabled={isPending}>
            <RotateCcw className="size-4" />
            <span className="hidden sm:inline">取消標記</span>
          </Button>
        ) : (
          <Button size="sm" variant="default" onClick={onMarkPaid} disabled={isPending}>
            <CheckCircle2 className="size-4" />
            標記已繳費
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" onClick={onShowDetails} aria-label="本期明細" title="本期明細">
          <ListTree className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant={hasOverride ? 'secondary' : 'ghost'}
          onClick={onAdjust}
          aria-label="調整本期"
          title="調整本期截止日"
        >
          <CalendarClock className="size-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onShowHistory} aria-label="歷史">
          <History className="size-4" />
        </Button>
      </div>
    </li>
  );
}

function BillHistory({ pm }: { pm: PaymentMethod }) {
  const { data: bills = [], isLoading } = useBillsForCard(pm.id);
  if (isLoading) return <p className="text-sm text-muted-foreground">載入中…</p>;
  if (bills.length === 0) return <p className="text-sm text-muted-foreground">尚無紀錄</p>;
  return (
    <ul className="divide-y rounded-md border">
      {bills.map((b) => {
        const eff = b.dueDateOverride ?? b.dueDate;
        return (
          <li key={b.id} className="flex items-center gap-3 p-3 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{b.cycleMonth}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                繳款 {b.dueDateOverride ? (
                  <>
                    <span className="line-through opacity-60">{formatTW(b.dueDate, 'MM/dd')}</span>
                    {' → '}
                    {formatTW(eff, 'yyyy/MM/dd')}
                    {b.overrideReason ? ` (${b.overrideReason})` : ''}
                  </>
                ) : formatTW(b.dueDate, 'yyyy/MM/dd')}
                {b.amount != null ? ` · NT$${Math.round(b.amount).toLocaleString('en-US')}` : ''}
              </span>
            </span>
            {b.paidAt ? (
              <Badge variant="secondary">已繳 {formatTW(b.paidAt, 'MM/dd')}</Badge>
            ) : (
              <Badge variant="destructive">未繳</Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}
