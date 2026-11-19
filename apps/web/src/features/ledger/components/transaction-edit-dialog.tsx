import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TagInput } from './tag-input';
import { sameTags } from '../tags';
import { Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { LineItemsEditor } from './line-items-editor';
import { AttachmentsEditor } from './attachments-editor';
import { legacyPhotoUrlFor, removedAttachments, sameAttachments, type TxAttachment } from '../attachments';
import { deleteTxAttachmentObjects } from '../attachments-upload';
import { useTrip, useTrips, useUpdateTrip } from '@/features/trips/hooks';
import { LoanSplitEditor, type LoanSplitMode } from './loan-split-editor';
import { SplitEditor, splitMismatch, type SplitState } from './split-editor';
import { buildSplitContext, initialSplitState, missingHouseholdTripMembers, reconcileSplitState, splitPatch } from '../split-context';
import type { TxLineItem } from '../types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import { resolveIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useCategories, useCreateTransaction, useFxRate, useUpdateTransaction, useSoftDeleteTransaction } from '../hooks';
import { usePaymentMethods } from '../payment-methods';
import { useAccounts } from '@/features/accounts';
import { PaymentSelect, type PaymentSelection } from './payment-select';
import { useConfirm } from '@/components/ui/confirm';
// 直接指到檔案，不走 household/index（index 會 re-export SharedLedgerPanel，而它又 import 本檔 → 循環）
import { useActiveHousehold, useHouseholdFundSummary } from '@/features/household/hooks';
import { HOUSEHOLD_FUND_PAYER_ID, effectiveAmountTWD, type Transaction } from '../types';
import { useCurrencyOptions } from '../use-currency-options';
import type { Currency } from '@/types/global';
import type { TransactionPatch } from '../api';

interface Props {
  tx: Transaction | null;
  onClose: () => void;
}

/**
 * 編輯交易。
 *  - 歸入旅程 / 共同分攤可以同時存在：同一個 SplitEditor，成員 = 旅程成員 ∪ 共同帳本成員，
 *    兩人之間的錢在共同帳本結、對外旅伴的錢在旅程結（settlement.ts / balance.ts）
 *  - 代墊 / 借貸（LoanSplitEditor）只在沒有上面兩種分攤時顯示
 * 可能是在編「別人的」交易（對方開放「可編輯」給我）：帳戶 / 支付方式只有 owner 編自己的才能改。
 */
export function TransactionEditDialog({ tx, onClose }: Props) {
  const { user: me, isOwner } = useAuth();
  const myUid = me?.uid ?? '';
  const { data: categories = [] } = useCategories();
  const update = useUpdateTransaction();
  const softDelete = useSoftDeleteTransaction();
  const create = useCreateTransaction();
  const confirm = useConfirm();
  const household = useActiveHousehold();
  const updateTrip = useUpdateTrip();

  const [amount, setAmount] = useState('');
  // 幣別可以切換；換幣別時匯率預設帶當下 fx_rates，也可以手動改（空白 = 用預設）
  const [currency, setCurrency] = useState<Currency>('TWD');
  const [fxRateInput, setFxRateInput] = useState('');
  const { data: liveFxRate = 1 } = useFxRate(currency);
  const [categoryKey, setCategoryKey] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [date, setDate] = useState(() => new Date());
  const [settledAmount, setSettledAmount] = useState('');
  const [settledAt, setSettledAt] = useState<Date | null>(null);
  const [attachments, setAttachments] = useState<TxAttachment[]>([]);
  const [lineItems, setLineItems] = useState<TxLineItem[]>([]);
  const [tripIdValue, setTripIdValue] = useState<string>('');
  const [prepaid, setPrepaid] = useState(false);
  // 代墊 / 借貸
  const [splitMode, setSplitMode] = useState<LoanSplitMode>('self');
  const [counterpartyName, setCounterpartyName] = useState('');
  const [myShare, setMyShare] = useState('');
  const [loanSettled, setLoanSettled] = useState(false);
  // 共同分攤開關 + 旅程 / 共同共用的分攤狀態
  const [sharedOn, setSharedOn] = useState(false);
  const [split, setSplit] = useState<SplitState>({ payerId: '', mode: 'equal', custom: {} });
  const [isTakingLong, setIsTakingLong] = useState(false);
  const { data: trip } = useTrip(tripIdValue || undefined);
  const tripMembers = useMemo(() => trip?.members ?? [], [trip?.members]);
  const { data: tripList = [] } = useTrips();
  // 幣別：預設五種 + owner 追蹤的匯率 + 旅程外幣 + 這筆原本的幣別
  const currencyOptions = useCurrencyOptions([tx?.currency, ...(trip?.foreignCurrencies ?? [])]);
  // 勾了共同分攤才訂閱共同帳本資料（公基金餘額）
  const { summary: fundSummary } = useHouseholdFundSummary(sharedOn ? household : null);
  const creatorUid = tx?.userId ?? '';
  const canUseHousehold = Boolean(household && tx?.type === 'expense' && household.memberIds.includes(creatorUid));
  const splitCtx = useMemo(() => buildSplitContext({
    trip: tripIdValue ? trip ?? null : null,
    household: canUseHousehold ? household : null,
    includeHousehold: sharedOn && canUseHousehold,
    fallback: { id: creatorUid, name: household?.members[creatorUid]?.displayName ?? '記錄者' },
  }), [tripIdValue, trip, household, canUseHousehold, sharedOn, creatorUid]);
  const splitMemberKey = splitCtx.members.map((m) => m.id).join(',');
  // 開啟交易時從 tx 帶入；之後成員名單變（切旅程 / 勾共同）只做校正，不重置使用者改到一半的值
  const splitSeededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!tx) { splitSeededFor.current = null; return; }
    if (splitSeededFor.current !== tx.id) {
      splitSeededFor.current = tx.id;
      setSplit(initialSplitState(tx, splitCtx.members, tx.currency, tx.fxRate));
      return;
    }
    setSplit((prev) => reconcileSplitState(prev, splitCtx.members.map((m) => m.id), creatorUid, 'equal', splitCtx.allowFund));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在交易切換或成員名單變動時跑
  }, [tx?.id, splitMemberKey]);

  useEffect(() => {
    if (tx) {
      setAmount(String(tx.amount));
      setCurrency(tx.currency);
      setFxRateInput(tx.currency === 'TWD' ? '' : String(tx.fxRate));
      setCategoryKey(tx.category);
      setPaymentMethod(tx.paymentMethod);
      setFromAccountId(tx.fromAccountId ?? '');
      setToAccountId(tx.toAccountId ?? '');
      setNote(tx.note ?? '');
      setTags(tx.tags ?? []);
      setDate(tx.date);
      setSettledAmount(tx.settledAmountTWD != null ? String(tx.settledAmountTWD) : '');
      setSettledAt(tx.settledAt ?? null);
      setAttachments(tx.attachments ?? []);
      setLineItems(tx.lineItems ?? []);
      setTripIdValue(tx.tripId ?? '');
      setPrepaid(tx.prepaid === true);
      setSplitMode(tx.splitMode ?? 'self');
      setCounterpartyName(tx.counterpartyName ?? '');
      setMyShare(tx.splitMode && tx.splitMode !== 'self' && tx.myShareTWD != null ? String(tx.myShareTWD) : '');
      setLoanSettled(Boolean(tx.loanSettledAt));
      setSharedOn(Boolean(tx.householdId));
    }
  }, [tx]);

  useEffect(() => {
    if (!update.isPending) {
      setIsTakingLong(false);
      return;
    }
    const timer = window.setTimeout(() => setIsTakingLong(true), 6_000);
    return () => window.clearTimeout(timer);
  }, [update.isPending]);

  const filteredCategories = useMemo(
    () => categories.filter((c) => c.type === (tx?.type ?? 'expense')),
    [categories, tx],
  );

  const handleFromChange = useCallback((next: PaymentSelection) => {
    setPaymentMethod(next.paymentMethod);
    setFromAccountId(next.accountId);
  }, []);

  const handleToChange = useCallback((next: PaymentSelection) => {
    setPaymentMethod(next.paymentMethod);
    setToAccountId(next.accountId);
  }, []);

  if (!tx) return null;

  const isMine = tx.userId === myUid;
  const amountNum = parseFloat(amount) || 0;
  /** 匯率：TWD = 1；手動輸入優先；沒輸入時原幣別沿用這筆存的歷史匯率、換幣別用當下匯率 */
  const fxInputNum = parseFloat(fxRateInput);
  const effectiveFxRate = currency === 'TWD'
    ? 1
    : fxInputNum > 0 ? fxInputNum : currency === tx.currency ? tx.fxRate : liveFxRate;
  const amountTWDNow = amountNum * effectiveFxRate;
  function changeCurrency(next: Currency) {
    setCurrency(next);
    setFxRateInput(next !== 'TWD' && next === tx?.currency ? String(tx.fxRate) : '');
  }
  const isHouseholdTx = Boolean(canUseHousehold && sharedOn && household);
  const isTripSplit = Boolean(tripIdValue && tx.type === 'expense' && tripMembers.length > 0);
  /** 有任何一種「多人分攤」在作用（旅程成員 / 共同帳本） */
  const splitActive = isHouseholdTx || isTripSplit;
  const splitInput = { members: splitCtx.members, amount: amountNum, currency, fxRate: effectiveFxRate, state: split, ratio: splitCtx.ratio };
  const sharedMismatch = splitActive && splitMismatch(splitInput);
  const splitPayer = splitActive ? split.payerId : creatorUid;
  const sharedFundPaid = splitPayer === HOUSEHOLD_FUND_PAYER_ID;
  const sharedCreatorPaid = splitPayer === creatorUid;
  const availableFundTWD = fundSummary.balanceTWD + (tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID ? effectiveAmountTWD(tx) : 0);
  const sharedInsufficientFund = sharedFundPaid && amountTWDNow > availableFundTWD;
  /** 帳戶 / 支付方式只有 owner 編自己的交易才能改；編對方的就原樣保留 */
  const canEditPayment = isOwner && isMine;
  /** 付款人不是建立者（旅伴 / 伴侶 / 公基金）→ 不扣建立者帳戶 */
  const paymentOverridden = splitActive && !sharedCreatorPaid;
  const showLoan = !splitActive && !tripIdValue && !sharedOn && tx.type === 'expense';

  async function handleSave() {
    if (!tx) return;
    const amt = parseFloat(amount);
    if (!amt) return;
    const amountTWD = amt * effectiveFxRate;
    if (currency !== 'TWD' && !(effectiveFxRate > 0)) { toast.error('請輸入匯率'); return; }
    if (sharedMismatch) { toast.error('自訂金額加總需等於總額'); return; }
    if (sharedInsufficientFund) { toast.error('公基金餘額不足，請先存入'); return; }

    const settledAmt = settledAmount.trim() === '' ? null : parseFloat(settledAmount);
    const settledFxRate = settledAmt != null && amt > 0 ? settledAmt / amt : null;

    const useLoan = showLoan && splitMode !== 'self';
    const myShareNum = myShare.trim() === '' ? null : parseFloat(myShare);
    const sp = splitActive
      ? splitPatch({ creatorUid, input: splitInput, isHousehold: isHouseholdTx, isTrip: Boolean(tripIdValue) })
      : null;

    // 付款方式 / 扣款帳戶
    let nextPaymentMethod = paymentMethod;
    let nextFromAccountId: string | null = fromAccountId || null;
    if (splitActive) {
      if (sharedFundPaid && sp?.fundAdvancedBy === creatorUid && canEditPayment) {
        // 公基金負擔、建立者自己先墊：保留畫面上選的帳戶（錢是從他的帳戶出去的）
      } else if (sharedFundPaid) { nextPaymentMethod = '公基金'; nextFromAccountId = null; }
      else if (!sharedCreatorPaid) { nextPaymentMethod = isHouseholdTx ? '共同帳' : '旅伴代付'; nextFromAccountId = null; }
      else if (!canEditPayment) {
        // 編對方的交易：付款人仍是建立者就保留原設定；原本是別人 / 公基金付的就只能標成共同帳
        const wasCreatorPaid = (tx.paidByUid ?? tx.payerId ?? tx.userId) === creatorUid;
        nextPaymentMethod = wasCreatorPaid ? tx.paymentMethod : (isHouseholdTx ? '共同帳' : '旅伴代付');
        nextFromAccountId = wasCreatorPaid ? (tx.fromAccountId ?? null) : null;
      }
    } else if (!canEditPayment) {
      nextPaymentMethod = tx.paymentMethod;
      nextFromAccountId = tx.fromAccountId ?? null;
    }

    const patch: TransactionPatch = {
      amount: amt,
      currency,
      fxRate: effectiveFxRate,
      amountTWD,
      category: categoryKey,
      paymentMethod: nextPaymentMethod,
      fromAccountId: tx.type === 'expense' || tx.type === 'transfer' ? nextFromAccountId : null,
      toAccountId: tx.type === 'income' || tx.type === 'transfer' ? (canEditPayment ? (toAccountId || null) : (tx.toAccountId ?? null)) : null,
      note: note || undefined,
      // 只有真的改了才寫 tags：伴侶「只改分攤」的 rules 不允許多出其他欄位的變動
      ...(sameTags(tags, tx.tags) ? {} : { tags }),
      date,
      // 附件只有真的改了才寫（同 tags：伴侶「只改分攤」的 rules 不允許多出其他欄位的變動）；
      // photoUrl 同步成第一張圖片，給只認舊欄位的程式碼用
      ...(sameAttachments(attachments, tx.attachments) ? {} : { attachments, photoUrl: legacyPhotoUrlFor(attachments) }),
      settledAmountTWD: settledAmt,
      settledFxRate,
      settledAt: settledAmt != null ? (settledAt ?? new Date()) : null,
      lineItems: lineItems.length > 0 ? lineItems : null,
      tripId: tripIdValue ? tripIdValue : null,
      prepaid: tripIdValue ? prepaid : false,
      // 旅程 / 共同帳本共用一份分攤；代墊只在沒有多人分攤時存在
      payerId: sp?.payerId ?? null,
      shareType: sp?.shareType ?? null,
      customShares: sp?.customShares ?? null,
      scope: isHouseholdTx ? 'household' : null,
      householdId: isHouseholdTx && household ? household.id : null,
      paidByUid: sp?.paidByUid ?? null,
      fundAdvancedBy: sp?.fundAdvancedBy ?? null,
      splitMode: useLoan ? splitMode : null,
      counterpartyName: useLoan ? (counterpartyName.trim() || null) : null,
      myShareTWD: sp ? sp.myShareTWD : (useLoan ? myShareNum : null),
      loanSettledAt: useLoan && loanSettled ? (tx.loanSettledAt ?? new Date()) : null,
    };
    try {
      await update.mutateAsync({ id: tx.id, patch });
      // 存檔成功才刪被移除的附件檔（best-effort；別人的檔案 Storage rules 會擋，只記 warn）
      const removed = removedAttachments(tx.attachments, attachments);
      if (removed.length) void deleteTxAttachmentObjects(removed);
      // 共同支出歸入旅程：把共同帳本成員補進旅程成員（只有旅程擁有者能改 trip）
      if (isHouseholdTx && household && trip && tripIdValue && (trip.ownerId ?? trip.userId) === myUid) {
        const missing = missingHouseholdTripMembers(trip, household);
        if (missing.length > 0) {
          try {
            await updateTrip.mutateAsync({ id: trip.id, patch: { members: [...(trip.members ?? []), ...missing] } });
          } catch (err) {
            console.warn('[transactionSave] add household members to trip', err);
          }
        }
      }
      onClose();
    } catch (err) {
      console.error('[transactionSave]', err);
    }
  }

  async function handleDelete() {
    if (!tx) return;
    const ok = await confirm({
      title: '刪除這筆交易？',
      description: `${tx.category} ${tx.type === 'income' ? '+' : '-'}${Math.round(tx.amountTWD)} TWD${tx.note ? ` · ${tx.note}` : ''} — 可在「回收筒」7 天內復原`,
      confirmText: '刪除',
    });
    if (!ok) return;
    if ('vibrate' in navigator) navigator.vibrate?.([30, 20, 30]);
    try {
      await softDelete.mutateAsync(tx.id);
      onClose();
    } catch (err) {
      console.error('[transactionDelete]', err);
      toast.error(err instanceof Error ? err.message : '刪除失敗');
    }
  }

  async function handleDuplicate() {
    if (!tx) return;
    try {
      await create.mutateAsync({
        type: tx.type,
        amount: tx.amount,
        currency: tx.currency,
        amountTWD: tx.amountTWD,
        fxRate: tx.fxRate,
        category: tx.category,
        paymentMethod: tx.paymentMethod,
        fromAccountId: tx.fromAccountId ?? null,
        toAccountId: tx.toAccountId ?? null,
        transferGroup: tx.transferGroup ?? null,
        note: tx.note ?? undefined,
        date: new Date(),
        tripId: tx.tripId ?? null,
      });
      toast.success('已複製為新交易');
      onClose();
    } catch (err) {
      console.error('[transactionDuplicate]', err);
      toast.error(err instanceof Error ? err.message : '複製失敗');
    }
  }

  const mutationPending = update.isPending || softDelete.isPending || create.isPending;
  const requestClose = () => {
    if (!mutationPending) onClose();
  };

  const footer = (
    <div className="space-y-2">
      {isTakingLong ? (
        <p className="text-center text-xs text-muted-foreground" role="status">
          連線較慢，仍在確認是否寫入完成。請先不要關閉或重複送出。
        </p>
      ) : null}
      <div className="flex gap-2">
        {isMine ? (
          <Button variant="outline" className="h-12 px-3" onClick={() => void handleDuplicate()} disabled={mutationPending} title="複製這筆">
            <Copy className="size-4" />
          </Button>
        ) : null}
        <Button variant="destructive" className="h-12 px-3" onClick={handleDelete} disabled={mutationPending}>刪除</Button>
        <Button className="flex-[2] h-12" onClick={handleSave} disabled={mutationPending || sharedMismatch || sharedInsufficientFund}>
          {update.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {update.isPending ? '正在確認寫入…' : '儲存'}
        </Button>
      </div>
    </div>
  );

  return (
    <ResponsiveDialog
      open={Boolean(tx)}
      onOpenChange={(o) => (o ? null : requestClose())}
      title={isMine ? '編輯交易' : '編輯對方的交易'}
      description={isMine ? undefined : '對方已開放你編輯這筆支出；帳戶與支付方式會維持原樣。'}
      footer={footer}
    >
      <div className="space-y-4">
        <div className="rounded-2xl border bg-card p-4">
          <Label className="text-xs text-muted-foreground">金額</Label>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-sm text-muted-foreground">{currency}</span>
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full bg-transparent text-3xl font-semibold tabular-nums outline-none"
            />
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
                placeholder={(currency === tx.currency ? tx.fxRate : liveFxRate).toFixed(4)}
                className="h-8 w-28 text-xs tabular-nums"
                aria-label="匯率"
              />
              <span>TWD · 約 NT$ {Math.round(amountTWDNow).toLocaleString()}</span>
              {currency !== tx.currency ? <span>（換幣別，預設帶當下匯率）</span> : null}
            </div>
          ) : null}
        </div>

        {/* 幣別 */}
        <div className="flex flex-wrap gap-1.5">
          {currencyOptions.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => changeCurrency(c)}
              className={cn(
                'h-9 min-w-[3.5rem] flex-1 rounded-md px-2 text-xs font-medium transition-colors',
                currency === c ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              {c}
            </button>
          ))}
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">類別</Label>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {filteredCategories.map((c) => {
              const Icon = resolveIcon(c.icon);
              const selected = categoryKey === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setCategoryKey(c.key)}
                  className={cn(
                    'flex flex-col items-center justify-center gap-1 rounded-xl border p-2.5 text-xs transition-colors',
                    selected
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-card text-muted-foreground',
                  )}
                >
                  <div
                    className="flex size-8 items-center justify-center rounded-full"
                    style={{
                      backgroundColor: selected ? c.color : c.color + '20',
                      color: selected ? '#fff' : c.color,
                    }}
                  >
                    <Icon className="size-4" />
                  </div>
                  <span className="leading-tight">{c.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">歸納至旅程</Label>
          <Select value={tripIdValue || '__none__'} onValueChange={(v) => setTripIdValue(v === '__none__' ? '' : v)}>
            <SelectTrigger className="mt-1 h-11"><SelectValue placeholder="不歸入旅程" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">（不歸入旅程）</SelectItem>
              {tripList.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
              {tripIdValue && !tripList.find((t) => t.id === tripIdValue) ? (
                <SelectItem value={tripIdValue}>{tripIdValue}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
          {tripIdValue ? (
            <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={prepaid}
                onChange={(e) => setPrepaid(e.target.checked)}
              />
              <span className="flex-1">標記為預付款（機票 / 簽證 / 接送…）</span>
            </label>
          ) : null}
          {tripIdValue && tx.splitMode ? (
            <p className="mt-1 text-[11px] text-muted-foreground">歸入旅程後，原本的代墊設定會取消，改用分攤。</p>
          ) : null}
        </div>

        {/* 共同帳本分攤開關（有 household、是支出；可以和旅程同時存在） */}
        {canUseHousehold && household ? (
          <div className="rounded-xl border p-3">
            <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
              <span>
                <span className="font-medium">共同分攤</span>
                <span className="ml-1 text-xs text-muted-foreground">
                  記進「{household.name}」{tripIdValue ? '，兩人之間在共同帳本結' : '，兩人分'}
                </span>
              </span>
              <input
                type="checkbox"
                checked={sharedOn}
                onChange={(e) => {
                  setSharedOn(e.target.checked);
                  if (e.target.checked) setSplitMode('self');
                }}
                className="size-4 accent-primary"
              />
            </label>
            {!sharedOn && tx.householdId ? (
              <p className="mt-2 text-[11px] text-muted-foreground">取消勾選並儲存後，這筆會變回個人支出，從共同帳本移除。</p>
            ) : null}
          </div>
        ) : null}

        {/* 分攤設定：旅程成員 / 共同帳本成員共用一個編輯器（原幣輸入） */}
        {splitActive ? (
          <div className="rounded-xl border p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              {isTripSplit && isHouseholdTx ? '出遊分攤（含共同帳本）' : isTripSplit ? '出遊分攤' : '共同分攤'}
            </div>
            <SplitEditor
              {...splitInput}
              onChange={setSplit}
              allowFund={splitCtx.allowFund}
              availableFundTWD={isHouseholdTx ? availableFundTWD : null}
              showRatio={splitCtx.showRatio}
              viewerId={myUid}
              creatorId={creatorUid}
            />
            {isTripSplit && isHouseholdTx ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                共同帳本成員之間的錢在「共同」結算；其他旅伴的份在旅程「分攤結算」。
              </p>
            ) : null}
          </div>
        ) : tripIdValue && tx.type === 'expense' && !isHouseholdTx ? (
          <p className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
            這趟旅程還沒設定成員，無法分攤；先到旅程「成員」頁加成員，或勾「共同分攤」。
          </p>
        ) : null}

        {paymentOverridden ? (
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            {sharedFundPaid ? '由公基金支付' : '由對方付款'}，不會扣{isMine ? '你' : '記錄者'}的帳戶。
          </p>
        ) : canEditPayment ? (
          <OwnerPaymentSection
            tx={tx}
            paymentMethod={paymentMethod}
            fromAccountId={fromAccountId}
            toAccountId={toAccountId}
            onFromChange={handleFromChange}
            onToChange={handleToChange}
          />
        ) : (
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            付款方式：{tx.paymentMethod || '—'}（只有帳本主人能改帳戶與支付方式）
          </p>
        )}

        <div>
          <Label className="text-xs text-muted-foreground">日期</Label>
          <div className="mt-1">
            <DatePicker value={date} onChange={(d) => d && setDate(d)} clearable={false} />
          </div>
        </div>


        {/* 一般代墊 / 借貸（不屬於 trip、也不是共同分攤時） */}
        {showLoan ? (
          <LoanSplitEditor
            mode={splitMode}
            onModeChange={setSplitMode}
            counterpartyName={counterpartyName}
            onCounterpartyNameChange={setCounterpartyName}
            myShare={myShare}
            onMyShareChange={setMyShare}
            totalTWD={amountTWDNow}
            settled={loanSettled}
            onSettledChange={setLoanSettled}
          />
        ) : null}

        <div>
          <Label className="text-xs text-muted-foreground">備註</Label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1"
          />
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">標籤</Label>
          <TagInput value={tags} onChange={setTags} className="mt-1" />
        </div>

        <AttachmentsEditor value={attachments} onChange={setAttachments} txId={tx.id} />

        {/* 明細品項 — 任何 tx 都可加，trip 內 tx 額外顯示分攤對象 chip */}
        <details className="rounded-xl border p-3" open={lineItems.length > 0}>
          <summary className="cursor-pointer text-sm font-medium">
            消費明細
            {lineItems.length > 0 && (
              <span className="ml-2 text-xs text-muted-foreground">
                （{lineItems.length} 項{tx.tripId ? ' · 可分項分攤' : ''}）
              </span>
            )}
          </summary>
          <div className="mt-3">
            <LineItemsEditor
              value={lineItems}
              onChange={setLineItems}
              members={tx.tripId ? tripMembers.map((m) => ({ id: m.uid ?? m.name, name: m.name })) : []}
              totalTWD={tx.amountTWD}
            />
          </div>
        </details>

        <details className="rounded-xl border p-3" open={tx.settledAmountTWD != null}>
          <summary className="cursor-pointer text-sm font-medium">
            結算資訊
            {tx.settledAmountTWD != null ? (
              <span className="ml-2 text-xs text-success">（已結算 NT${Math.round(tx.settledAmountTWD)}）</span>
            ) : (
              <span className="ml-2 text-xs text-muted-foreground">（估算值，未結算）</span>
            )}
          </summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <Label className="text-xs text-muted-foreground">實際入帳金額 (TWD)</Label>
              <Input
                type="number"
                inputMode="decimal"
                placeholder={`估算 ${Math.round(tx.amountTWD)}`}
                value={settledAmount}
                onChange={(e) => setSettledAmount(e.target.value)}
                className="mt-1"
              />
              {settledAmount && parseFloat(settledAmount) > 0 && tx.amount > 0 ? (
                <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  等效匯率 {(parseFloat(settledAmount) / tx.amount).toFixed(4)} · 差額 {(parseFloat(settledAmount) - tx.amountTWD).toFixed(2)}
                </p>
              ) : null}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">結算日</Label>
              <div className="mt-1">
                <DatePicker value={settledAt} onChange={setSettledAt} placeholder="選結算日期" />
              </div>
            </div>
          </div>
          {settledAmount && (
            <button
              type="button"
              onClick={() => { setSettledAmount(''); setSettledAt(null); }}
              className="mt-2 text-xs text-muted-foreground hover:underline"
            >
              清除結算（恢復估算）
            </button>
          )}
        </details>
      </div>
    </ResponsiveDialog>
  );
}

/**
 * 帳戶 / 支付方式欄位。`accounts` / `payment_methods` 的 rules 限 owner，
 * 所以只在 owner 編自己的交易時才掛這個子元件，member 端不會打出 permission error。
 */
function OwnerPaymentSection({
  tx, paymentMethod, fromAccountId, toAccountId, onFromChange, onToChange,
}: {
  tx: Transaction;
  paymentMethod: string;
  fromAccountId: string;
  toAccountId: string;
  onFromChange: (next: PaymentSelection) => void;
  onToChange: (next: PaymentSelection) => void;
}) {
  const { data: customPMs = [] } = usePaymentMethods();
  const { data: accounts = [] } = useAccounts();
  if (tx.type === 'transfer') {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <PaymentSelect
          value={{ paymentMethod, accountId: fromAccountId }}
          onChange={onFromChange}
          accounts={accounts}
          customPMs={customPMs}
          label="來源支付方式"
          showAccountLabel="來源帳戶"
        />
        <PaymentSelect
          value={{ paymentMethod, accountId: toAccountId }}
          onChange={onToChange}
          accounts={accounts}
          customPMs={customPMs}
          allowedAccountTypes={['cash', 'bank', 'investment_cash', 'e_wallet_balance', 'credit_card', 'loan']}
          label="目標支付方式"
          showAccountLabel="目標帳戶"
        />
      </div>
    );
  }
  return (
    <PaymentSelect
      value={{
        paymentMethod,
        accountId: tx.type === 'income' ? toAccountId : fromAccountId,
      }}
      onChange={tx.type === 'income' ? onToChange : onFromChange}
      accounts={accounts}
      customPMs={customPMs}
      allowedAccountTypes={
        tx.type === 'income'
          ? ['cash', 'bank', 'investment_cash', 'e_wallet_balance']
          : ['cash', 'bank', 'credit_card', 'e_wallet_balance', 'investment_cash']
      }
      showAccountLabel={tx.type === 'income' ? '收款帳戶' : '扣款帳戶'}
      emptyHint="尚未設定對應帳戶。可在「設定 → 帳戶」連結這個支付方式到帳戶。"
    />
  );
}
