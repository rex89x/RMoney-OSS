import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { cn, formatCurrency } from '@/lib/utils';
import { resolveIcon } from '@/lib/icons';
import { useCategories, useCreateTransaction, useFxRate, useUpdateTransaction } from '@/features/ledger/hooks';
import { useCurrencyOptions } from '@/features/ledger/use-currency-options';
import type { Currency } from '@/types/global';
import { HOUSEHOLD_FUND_PAYER_ID, effectiveAmountTWD, type Transaction } from '@/features/ledger/types';
import { SplitEditor, splitMismatch, type SplitState } from '@/features/ledger/components/split-editor';
import {
  buildSplitContext, initialSplitState, missingHouseholdTripMembers, reconcileSplitState, splitPatch,
} from '@/features/ledger/split-context';
import { useAccounts } from '@/features/accounts';
import { usePaymentMethods } from '@/features/ledger/payment-methods';
import { PaymentSelect, type PaymentSelection } from '@/features/ledger/components/payment-select';
import { useTrip, useTrips, useUpdateTrip } from '@/features/trips/hooks';
import { useHouseholdFundSummary } from '../hooks';
import { canEditLedgerOf, memberCan, type Household } from '../types';

interface HouseholdEntryDialogProps {
  household: Household;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 編輯既有共同支出（自己建立的，或對方開放「可編輯」給我的） */
  tx?: Transaction | null;
}

/**
 * 共同支出快速記帳（兩人都能用）。
 * - owner 會多一個支付方式 / 帳戶欄位（付款人是自己時才扣帳戶）
 * - member 沒有帳戶資料，只記金額 / 類別 / 誰付 / 怎麼分
 * - 可以同時歸入旅程：成員 = 旅程成員 ∪ 共同帳本成員，兩人之間在共同帳本結、對外旅伴在旅程結
 * - 可以選幣別：金額與分攤以原幣輸入，台幣依當下匯率（可手改）換算；公基金餘額仍以台幣比較
 * 寫進 `transactions`：userId = 建立者、paidByUid、customShares（uid → 原幣 + TWD）、myShareTWD = 建立者那份
 */
export function HouseholdEntryDialog({ household, open, onOpenChange, tx = null }: HouseholdEntryDialogProps) {
  const { user, isOwner } = useAuth();
  const myUid = user?.uid ?? '';
  const { data: categories = [] } = useCategories();
  const createTx = useCreateTransaction();
  const updateTx = useUpdateTransaction();
  const updateTrip = useUpdateTrip();
  const isEdit = Boolean(tx);
  const pending = createTx.isPending || updateTx.isPending;
  const allowed = tx
    ? canEditLedgerOf(household, myUid, tx.userId)
    : memberCan(household, myUid, 'canAddExpense');
  const { summary: fundSummary } = useHouseholdFundSummary(household);
  const { data: tripList = [] } = useTrips();

  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('TWD');
  const [fxRateInput, setFxRateInput] = useState('');
  const { data: liveFxRate = 1 } = useFxRate(currency);
  const [categoryKey, setCategoryKey] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState<Date>(() => new Date());
  const [tripId, setTripId] = useState('');
  const [split, setSplit] = useState<SplitState>({ payerId: '', mode: 'ratio', custom: {} });
  const [payment, setPayment] = useState<PaymentSelection>({ paymentMethod: '', accountId: '' });
  const { data: trip } = useTrip(tripId || undefined);
  const currencyOptions = useCurrencyOptions([tx?.currency, ...(trip?.foreignCurrencies ?? [])]);

  const expenseCats = useMemo(() => categories.filter((c) => c.type === 'expense'), [categories]);
  /** 這筆交易的建立者：新增 = 我；編輯 = 原建立者（可能是對方） */
  const creatorUid = tx?.userId ?? myUid;
  const splitCtx = useMemo(() => buildSplitContext({
    trip: tripId ? trip ?? null : null,
    household,
    includeHousehold: true,
    fallback: { id: creatorUid, name: household.members[creatorUid]?.displayName ?? '我' },
  }), [tripId, trip, household, creatorUid]);
  const splitMemberKey = splitCtx.members.map((m) => m.id).join(',');

  // 開啟時重置 / 帶入編輯值（不要把 categoryKey 放進 deps，否則切類別會清掉金額）
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) { seededFor.current = null; return; }
    if (tx) {
      setAmount(String(tx.amount));
      setCurrency(tx.currency);
      setFxRateInput(tx.currency === 'TWD' ? '' : String(tx.fxRate));
      setNote(tx.note ?? '');
      setDate(tx.date);
      setCategoryKey(tx.category);
      setTripId(tx.tripId ?? '');
      setPayment({ paymentMethod: tx.paymentMethod === '共同帳' ? '' : tx.paymentMethod, accountId: tx.fromAccountId ?? '' });
      return;
    }
    setAmount('');
    setCurrency('TWD');
    setFxRateInput('');
    setNote('');
    setDate(new Date());
    setTripId('');
    setPayment({ paymentMethod: '', accountId: '' });
  }, [open, myUid, tx]);
  // 分攤狀態：開啟時從 tx 帶入（既有分攤當自訂金額），之後成員名單變了只做校正
  useEffect(() => {
    if (!open) return;
    const key = tx?.id ?? '__new__';
    if (seededFor.current !== key) {
      seededFor.current = key;
      setSplit(tx
        ? initialSplitState(tx, splitCtx.members, tx.currency, tx.fxRate)
        // 新增共同支出預設「帳本負擔（公基金）」；歸入旅程時不能用公基金，改由我付、依比例
        : {
          payerId: splitCtx.allowFund ? HOUSEHOLD_FUND_PAYER_ID : myUid,
          mode: 'ratio',
          custom: Object.fromEntries(splitCtx.members.map((m) => [m.id, ''])),
        });
      return;
    }
    setSplit((prev) => reconcileSplitState(prev, splitCtx.members.map((m) => m.id), myUid, 'ratio', splitCtx.allowFund));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在開啟 / 切換交易 / 成員名單變動時跑
  }, [open, tx?.id, splitMemberKey]);
  useEffect(() => {
    if (open && !categoryKey && expenseCats[0]) setCategoryKey(expenseCats[0].key);
  }, [open, categoryKey, expenseCats]);

  const amt = parseFloat(amount) || 0;
  /** 匯率：TWD = 1；手動輸入優先；編輯時同幣別沿用這筆存的匯率，否則用當下匯率 */
  const fxInputNum = parseFloat(fxRateInput);
  const fxRate = currency === 'TWD'
    ? 1
    : fxInputNum > 0 ? fxInputNum : (tx && currency === tx.currency ? tx.fxRate : liveFxRate);
  const amountTWD = Math.round(amt * fxRate);
  function changeCurrency(next: Currency) {
    setCurrency(next);
    setFxRateInput(next !== 'TWD' && tx && next === tx.currency ? String(tx.fxRate) : '');
  }
  const splitInput = { members: splitCtx.members, amount: amt, currency, fxRate, state: split, ratio: splitCtx.ratio };
  const mismatch = splitMismatch(splitInput);
  const fundPaid = split.payerId === HOUSEHOLD_FUND_PAYER_ID;
  const creatorPaid = split.payerId === creatorUid;
  /** 只有 owner 編自己付的那筆才能選帳戶；其他情況不碰對方的帳戶設定 */
  /** 公基金負擔但建立者自己先墊 → 錢從建立者帳戶出去，一樣可以選帳戶 */
  const creatorAdvanced = fundPaid && split.fundAdvancedBy === creatorUid;
  const canPickPayment = isOwner && creatorUid === myUid && ((creatorPaid && !fundPaid) || creatorAdvanced);
  const availableFundTWD = fundSummary.balanceTWD
    + (tx?.paidByUid === HOUSEHOLD_FUND_PAYER_ID ? effectiveAmountTWD(tx) : 0);

  /**
   * 付款方式 / 扣款帳戶：
   *  - 公基金 → '公基金'，不扣帳戶
   *  - 付款人不是建立者 → '共同帳'，不扣帳戶（對方付的錢不會動建立者的帳戶）
   *  - owner 自己付 → 用畫面上選的
   *  - 編輯對方的交易、付款人仍是建立者 → 保留原本的設定（不能替對方改帳戶）
   */
  function paymentFields(): { paymentMethod: string; fromAccountId: string | null } {
    if (fundPaid && creatorAdvanced && canPickPayment) {
      return { paymentMethod: payment.paymentMethod || '共同帳', fromAccountId: payment.accountId || null };
    }
    if (fundPaid) return { paymentMethod: '公基金', fromAccountId: null };
    if (!creatorPaid) return { paymentMethod: '共同帳', fromAccountId: null };
    if (canPickPayment) return { paymentMethod: payment.paymentMethod || '共同帳', fromAccountId: payment.accountId || null };
    if (tx && (tx.paidByUid ?? tx.payerId ?? tx.userId) === creatorUid) {
      return { paymentMethod: tx.paymentMethod, fromAccountId: tx.fromAccountId ?? null };
    }
    return { paymentMethod: '共同帳', fromAccountId: null };
  }

  async function syncTripMembers() {
    if (!tripId || !trip || (trip.ownerId ?? trip.userId) !== myUid) return;
    const missing = missingHouseholdTripMembers(trip, household);
    if (missing.length === 0) return;
    try {
      await updateTrip.mutateAsync({ id: trip.id, patch: { members: [...(trip.members ?? []), ...missing] } });
    } catch (err) {
      console.warn('[householdEntry] add household members to trip', err);
    }
  }

  async function handleSave() {
    if (amt <= 0 || !categoryKey) return;
    if (mismatch) {
      toast.error('自訂金額加總需等於總額');
      return;
    }
    if (currency !== 'TWD' && !(fxRate > 0)) {
      toast.error('請輸入匯率');
      return;
    }
    const partnerNames = household.memberIds.filter((id) => id !== myUid).map((id) => household.members[id]?.displayName ?? id);
    const sp = splitPatch({ creatorUid, input: splitInput, isHousehold: true, isTrip: Boolean(tripId) });
    try {
      if (tx) {
        await updateTx.mutateAsync({
          id: tx.id,
          patch: {
            amount: amt,
            amountTWD,
            currency,
            fxRate,
            category: categoryKey,
            ...paymentFields(),
            note: note.trim() || undefined,
            date,
            tripId: tripId || null,
            ...sp,
          },
        });
        await syncTripMembers();
        onOpenChange(false);
        return;
      }
      await createTx.mutateAsync({
        type: 'expense',
        amount: amt,
        currency,
        amountTWD,
        fxRate,
        category: categoryKey,
        ...paymentFields(),
        toAccountId: null,
        note: note.trim() || undefined,
        date,
        scope: 'household',
        householdId: household.id,
        tripId: tripId || null,
        payerId: sp.payerId ?? null,
        paidByUid: sp.paidByUid ?? null,
        fundAdvancedBy: sp.fundAdvancedBy ?? null,
        shareType: sp.shareType ?? null,
        customShares: sp.customShares ?? undefined,
        myShareTWD: sp.myShareTWD ?? null,
        tags: partnerNames.length > 0 ? ['共同'] : [],
      });
      await syncTripMembers();
      onOpenChange(false);
    } catch (err) {
      console.error('[householdEntry]', err);
    }
  }

  // 公基金餘額不足只警示、不擋：公基金是預設記帳方式，餘額可以晚點補存
  const canSave = amt > 0 && Boolean(categoryKey) && !mismatch && allowed;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => { if (!pending) onOpenChange(o); }}
      title={isEdit ? '編輯共同支出' : '新增共同支出'}
      description={household.name}
      contentClassName="sm:max-w-md"
      footer={(
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 h-12" type="button" onClick={() => onOpenChange(false)} disabled={pending}>取消</Button>
          <Button className="flex-[2] h-12" type="button" onClick={() => void handleSave()} disabled={!canSave || pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            儲存
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        {!allowed ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
            {tx ? '這筆是對方記的，對方沒有開放你編輯。' : '建立者沒有開放你新增共同支出。'}
          </p>
        ) : null}
        <div>
          <Label>金額（{currency}）</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="mt-1 h-12 text-2xl font-semibold tabular-nums"
            autoFocus
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {currencyOptions.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => changeCurrency(c)}
                className={cn(
                  'h-8 min-w-[3.25rem] flex-1 rounded-md px-2 text-xs font-medium transition-colors',
                  currency === c ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {c}
              </button>
            ))}
          </div>
          {currency !== 'TWD' ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>1 {currency} =</span>
              <Input
                type="number"
                inputMode="decimal"
                step="0.0001"
                value={fxRateInput}
                onChange={(e) => setFxRateInput(e.target.value)}
                placeholder={(tx && currency === tx.currency ? tx.fxRate : liveFxRate).toFixed(4)}
                className="h-8 w-28 text-xs tabular-nums"
                aria-label="匯率"
              />
              <span>TWD · 約 {formatCurrency(amountTWD, 'TWD')}</span>
            </div>
          ) : null}
        </div>

        <div>
          <Label>類別</Label>
          <div className="mt-1 grid grid-cols-4 gap-1.5">
            {expenseCats.map((c) => {
              const Icon = resolveIcon(c.icon);
              const active = c.key === categoryKey;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setCategoryKey(c.key)}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-lg border p-2 text-[11px] transition-colors',
                    active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
                  )}
                >
                  <Icon className="size-4" style={{ color: active ? undefined : c.color }} />
                  <span className="truncate">{c.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {tripList.length > 0 ? (
          <div>
            <Label>歸入旅程（選填）</Label>
            <Select value={tripId || '__none__'} onValueChange={(v) => setTripId(v === '__none__' ? '' : v)}>
              <SelectTrigger className="mt-1 h-11"><SelectValue placeholder="不歸入旅程" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">（不歸入旅程）</SelectItem>
                {tripList.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
                {tripId && !tripList.find((t) => t.id === tripId) ? (
                  <SelectItem value={tripId}>{tripId}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {tripId ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                會同時出現在旅程的花費與結算；兩人之間在共同帳本結，其他旅伴那份在旅程結。公基金付款不適用。
              </p>
            ) : null}
          </div>
        ) : null}

        <SplitEditor
          {...splitInput}
          onChange={setSplit}
          allowFund={splitCtx.allowFund}
          availableFundTWD={availableFundTWD}
          showRatio={splitCtx.showRatio}
          viewerId={myUid}
          creatorId={creatorUid}
        />

        {canPickPayment ? <OwnerPaymentField value={payment} onChange={setPayment} /> : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>日期</Label>
            <div className="mt-1"><DatePicker value={date} onChange={(d) => { if (d) setDate(d); }} /></div>
          </div>
          <div>
            <Label>備註</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={1} className="mt-1 min-h-10" placeholder="例：全聯採買" />
          </div>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

/** 只有 owner 才有帳戶 / 支付方式資料（rules 限 owner），拆成子元件避免 member 端打出 permission error */
function OwnerPaymentField({ value, onChange }: { value: PaymentSelection; onChange: (next: PaymentSelection) => void }) {
  const { data: accounts = [] } = useAccounts();
  const { data: customPMs = [] } = usePaymentMethods();
  return (
    <PaymentSelect
      value={value}
      onChange={onChange}
      accounts={accounts}
      customPMs={customPMs}
      label="我用什麼付（選填）"
      emptyHint="不選則不扣帳戶餘額"
    />
  );
}
