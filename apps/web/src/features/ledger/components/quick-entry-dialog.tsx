import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TagInput } from './tag-input';
import { createPortal } from 'react-dom';
import { Loader2, X, Sparkles, ScanLine } from 'lucide-react';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useQuickEntryStore } from '@/stores/quick-entry-store';
import { useTrip, useTrips, useUpdateTrip } from '@/features/trips/hooks';
import { useCategories, useCreateTransaction, useFxRate } from '../hooks';
import {
  matchNotes, useQuickEntrySuggestions, type NoteSuggestion, type QuickEntryTemplate,
} from '../use-quick-entry-suggestions';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';
import { callAppsScript } from '@/lib/apps-script';
import { compressImage } from '@/lib/upload';
import { MAX_ATTACHMENT_IMAGE_BYTES, MAX_TX_ATTACHMENTS, type TxAttachment } from '../attachments';
import { uploadTxBlob } from '../attachments-upload';
import { AttachmentsEditor } from './attachments-editor';
import { dateInputToTWDate, nowTW, startOfTWDay } from '@/lib/tz';
import { usePaymentMethods } from '../payment-methods';
import { useAccounts } from '@/features/accounts';
import { useCreateInstallmentPlan } from '@/features/installments/hooks';
import { splitInstallmentAmounts } from '@/features/installments/schedule';
import { INSTALLMENT_PERIOD_OPTIONS } from '@/features/installments/types';
import { PaymentSelect, type PaymentSelection } from './payment-select';
import { useCurrencyOptions } from '../use-currency-options';
import { useIsDesktop } from '@/hooks/use-media-query';
import { resolveIcon } from '@/lib/icons';
import { DEFAULT_PAYMENT_METHODS } from '@/lib/seed-data';
import { cn } from '@/lib/utils';
import type { TxType } from '../types';
import type { Currency } from '@/types/global';
import { createTransactionId } from '../api';
import { useAuth } from '@/hooks/use-auth';
import { useBudgetImpact } from '@/features/analytics/use-budget-impact';
import { HOUSEHOLD_FUND_PAYER_ID, useActiveHousehold, useHouseholdFundSummary } from '@/features/household';
import { LoanSplitEditor, type LoanSplitMode } from './loan-split-editor';
import { SplitEditor, splitMismatch, type SplitState } from './split-editor';
import { buildSplitContext, missingHouseholdTripMembers, reconcileSplitState, splitPatch } from '../split-context';


export function QuickEntryDialog() {
  const { open, kind, tripId: presetTripId, closeDialog } = useQuickEntryStore();
  const isDesktop = useIsDesktop();
  // 從旅程頁 FAB 進來會帶 presetTripId；一般記帳也可以在表單裡挑旅程（只有支出）
  const [pickedTripId, setPickedTripId] = useState('');
  const { data: tripList = [] } = useTrips();
  const [type, setType] = useState<TxType>(kind === 'income' ? 'income' : 'expense');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('TWD');
  const [categoryKey, setCategoryKey] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState(DEFAULT_PAYMENT_METHODS[0] ?? '現金');
  const [fromAccountId, setFromAccountId] = useState<string>('');
  const [toAccountId, setToAccountId] = useState<string>('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [date, setDate] = useState(() => new Date());
  const tripId = presetTripId ?? (type === 'expense' && pickedTripId ? pickedTripId : null);

  const { data: categories = [] } = useCategories();
  const { data: fxRate = 1 } = useFxRate(currency);
  const createTx = useCreateTransaction({ silentSuccess: true });
  const budgetImpact = useBudgetImpact(open);
  const { data: trip } = useTrip(tripId ?? undefined);
  // 幣別：預設五種 + owner 追蹤的匯率 + 這趟旅程的外幣
  const CURRENCIES = useCurrencyOptions(trip?.foreignCurrencies ?? []);
  // 從旅程頁進來、還沒動過幣別時，預設帶該旅程的第一個外幣
  const currencyTouched = useRef(false);
  useEffect(() => {
    if (!open || !presetTripId || !trip || currencyTouched.current) return;
    const first = trip.foreignCurrencies?.[0];
    if (first && first !== 'TWD') setCurrency(first);
  }, [open, presetTripId, trip]);
  const updateTrip = useUpdateTrip();
  const tripMembers = useMemo(() => trip?.members ?? [], [trip?.members]);

  // 常用範本 + 備註補完（只在 dialog 開啟且非 trip 記帳時載入）
  const { templates, noteIndex } = useQuickEntrySuggestions(type, open && !tripId);
  const [noteFocused, setNoteFocused] = useState(false);
  const [noteSuggestDismissed, setNoteSuggestDismissed] = useState(false);
  const noteMatches = useMemo(
    () => (noteFocused && !noteSuggestDismissed ? matchNotes(noteIndex, note) : []),
    [noteIndex, note, noteFocused, noteSuggestDismissed],
  );

  // 一般記帳的代墊 / 借貸（不限 trip）
  const [splitMode, setSplitMode] = useState<LoanSplitMode>('self');
  const [counterpartyName, setCounterpartyName] = useState('');
  const [myShare, setMyShare] = useState('');
  const [prepaid, setPrepaid] = useState(false);
  // 信用卡分期：0 = 不分期；> 1 = 存檔時改建 installment_plans（每期由 Apps Script 入帳）
  const [installmentPeriods, setInstallmentPeriods] = useState(0);
  const createInstallment = useCreateInstallmentPlan();
  // 共同帳本分攤（有兩人以上的 household 才顯示；與代墊互斥）
  const household = useActiveHousehold();
  const { user: me, isOwner } = useAuth();
  const [sharedOn, setSharedOn] = useState(false);
  // 勾了共同分攤才訂閱共同帳本資料（公基金餘額），避免這個全域 dialog 一掛上就常駐一條 24 個月的 listener
  const { summary: fundSummary } = useHouseholdFundSummary(sharedOn ? household : null);
  // 旅程 / 共同帳本共用一份分攤狀態；成員 = 旅程成員 ∪（勾了共同分攤時）共同帳本成員
  const splitCtx = useMemo(() => buildSplitContext({
    trip: tripId ? trip ?? null : null,
    household,
    includeHousehold: sharedOn,
    fallback: { id: me?.uid ?? '', name: '我' },
  }), [tripId, trip, household, sharedOn, me?.uid]);
  const [split, setSplit] = useState<SplitState>({ payerId: '', mode: 'equal', custom: {} });
  const splitMemberKey = splitCtx.members.map((m) => m.id).join(',');
  useEffect(() => {
    // 共同分攤且沒有歸入旅程 → 預設「帳本負擔（公基金）」
    const preferred = splitCtx.allowFund ? HOUSEHOLD_FUND_PAYER_ID : me?.uid ?? '';
    setSplit((prev) => reconcileSplitState(prev, splitCtx.members.map((m) => m.id), preferred, sharedOn ? 'ratio' : 'equal', splitCtx.allowFund));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 成員名單或模式來源變了才校正，不要每次 render 重置
  }, [splitMemberKey, sharedOn, me?.uid, splitCtx.allowFund]);
  const splitActive = type === 'expense' && (sharedOn || (Boolean(tripId) && tripMembers.length > 0));
  // 分期只給 owner 的一般台幣刷卡支出（分攤 / 代墊 / 旅程有各自的結算邏輯，不混用）
  const installmentAllowed = isOwner && type === 'expense' && currency === 'TWD'
    && !splitActive && splitMode === 'self' && !tripId;
  const [clientRequestId, setClientRequestId] = useState(() => createTransactionId());
  const [isTakingLong, setIsTakingLong] = useState(false);
  // 收據掃描（Claude 辨識）
  const receiptInputRef = useRef<HTMLInputElement | null>(null);
  const [scanning, setScanning] = useState(false);
  const [attachments, setAttachments] = useState<TxAttachment[]>([]);

  useEffect(() => {
    if (open) {
      setType(kind === 'income' ? 'income' : 'expense');
      setAmount('');
      setNote('');
      setTags([]);
      setCurrency('TWD');
      currencyTouched.current = false;
      setFromAccountId('');
      setToAccountId('');
      setDate(new Date());
      setSplit({ payerId: '', mode: 'equal', custom: {} });
      setSplitMode('self');
      setCounterpartyName('');
      setMyShare('');
      setNoteSuggestDismissed(false);
      setAttachments([]);
      setSharedOn(false);
      setPickedTripId('');
      setPrepaid(false);
      setInstallmentPeriods(0);
      setClientRequestId(createTransactionId());
    }
  }, [open, kind]);

  useEffect(() => {
    if (!createTx.isPending) {
      setIsTakingLong(false);
      return;
    }
    const timer = window.setTimeout(() => setIsTakingLong(true), 6_000);
    return () => window.clearTimeout(timer);
  }, [createTx.isPending]);

  useEffect(() => {
    if (type === 'expense') setToAccountId('');
    else if (type === 'income') setFromAccountId('');
  }, [type]);

  const handlePaymentChange = useCallback(
    (next: PaymentSelection) => {
      setPaymentMethod(next.paymentMethod);
      if (type === 'income') {
        setToAccountId(next.accountId);
        setFromAccountId('');
      } else {
        setFromAccountId(next.accountId);
        setToAccountId('');
      }
    },
    [type],
  );

  const filteredCategories = useMemo(
    () => categories.filter((c) => c.type === type),
    [categories, type],
  );

  useEffect(() => {
    const first = filteredCategories[0];
    if (!categoryKey && first) setCategoryKey(first.key);
    else if (categoryKey && !filteredCategories.find((c) => c.key === categoryKey)) {
      setCategoryKey(first?.key ?? '');
    }
  }, [filteredCategories, categoryKey]);

  function applySuggestion(sug: Pick<NoteSuggestion, 'note' | 'category' | 'paymentMethod' | 'fromAccountId' | 'toAccountId' | 'currency'> & { amount: number | null }) {
    setNote(sug.note);
    setCurrency(sug.currency);
    setCategoryKey(sug.category);
    setPaymentMethod(sug.paymentMethod);
    setFromAccountId(type === 'expense' ? (sug.fromAccountId ?? '') : '');
    setToAccountId(type === 'income' ? (sug.toAccountId ?? '') : '');
    if (sug.amount != null && !amount) setAmount(String(sug.amount));
    setNoteSuggestDismissed(true);
    if ('vibrate' in navigator) navigator.vibrate?.(8);
  }

  interface ReceiptResult {
    receipt?: { amount: number; currency: string; date: string; merchant: string; category: string; items: string[]; confidence: number | null };
  }

  async function handleReceiptFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setScanning(true);
    try {
      const blob = await compressImage(file, 1280, 0.72);
      const base64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result ?? '').split(',')[1] ?? '');
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      const res = await callAppsScript<ReceiptResult>('parseReceipt', undefined, { imageBase64: base64, mimeType: blob.type || 'image/jpeg' });
      const r = res.ok ? (res as ReceiptResult).receipt : undefined;
      if (!res.ok || !r) throw new Error(typeof res.error === 'string' ? res.error : '辨識失敗');
      setType('expense');
      if (r.amount > 0) setAmount(String(r.amount));
      if (CURRENCIES.includes(r.currency as Currency)) setCurrency(r.currency as Currency);
      const d = dateInputToTWDate(r.date);
      if (d) setDate(d);
      const noteText = [r.merchant, r.items.length > 0 ? r.items.slice(0, 3).join('、') : ''].filter(Boolean).join(' · ');
      if (noteText) setNote(noteText);
      if (categories.some((c) => c.key === r.category && c.type === 'expense')) setCategoryKey(r.category);
      setNoteSuggestDismissed(true);
      toast.success(r.confidence != null && r.confidence < 0.6 ? '已帶入，但辨識信心較低，請檢查金額' : '已從收據帶入');
      // 收據照片加成附件（儲存交易時一起寫入 attachments / photoUrl；上傳失敗不影響記帳）。
      // OCR 用的是 1280px / 0.72 的壓縮圖，通常 < 500KB；超過就不附（pitfall #20）
      if (blob.size <= MAX_ATTACHMENT_IMAGE_BYTES && attachments.length < MAX_TX_ATTACHMENTS) {
        try {
          const contentType = blob.type || 'image/webp';
          const att = await uploadTxBlob(blob, clientRequestId, contentType === 'image/jpeg' ? 'receipt.jpg' : 'receipt.webp', contentType);
          setAttachments((prev) => [...prev, att].slice(0, MAX_TX_ATTACHMENTS));
        } catch (err) {
          console.warn('[receiptUpload]', err);
        }
      }
    } catch (err) {
      console.error('[parseReceipt]', err);
      toast.error(err instanceof Error ? err.message : '收據辨識失敗');
    } finally {
      setScanning(false);
    }
  }

  function applyTemplate(tpl: QuickEntryTemplate) {
    applySuggestion(tpl);
    if (tpl.amount != null) setAmount(String(tpl.amount));
  }

  async function handleSave() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    const amountTWD = currency === 'TWD' ? amt : amt * fxRate;
    if ('vibrate' in navigator) navigator.vibrate?.(15);
    const myShareNum = myShare.trim() === '' ? null : parseFloat(myShare);
    if (!me) return;
    // 分攤（旅程 / 共同帳本共用）：付款人不是我 → 不扣我的帳戶；公基金付 → 不形成誰欠誰
    const useShared = Boolean(sharedOn && household && type === 'expense');
    const splitInput = { members: splitCtx.members, amount: amt, currency, fxRate, state: split, ratio: splitCtx.ratio };
    if (splitActive && splitMismatch(splitInput)) {
      toast.error('自訂金額加總需等於總額');
      return;
    }
    const sp = splitActive ? splitPatch({ creatorUid: me.uid, input: splitInput, isHousehold: useShared, isTrip: Boolean(tripId) }) : null;
    const payer = splitActive ? split.payerId : me.uid;
    const fundPaid = payer === HOUSEHOLD_FUND_PAYER_ID;
    // 公基金負擔但我先墊：錢是從我的帳戶出去的，照樣扣帳戶（公基金撥還時再記收入）
    const iAdvanced = fundPaid && sp?.fundAdvancedBy === me.uid;
    const iPaid = payer === me.uid || iAdvanced;
    // 分攤時的代墊 / 借貸不另外記（互斥）
    const useLoan = !splitActive && splitMode !== 'self';
    if (installmentAllowed && installmentPeriods > 1 && fromAccountId) {
      // 分期：不建單筆支出，改建計畫；第 1 期（消費日）起每月由 Apps Script 入帳到這張卡
      const categoryName = categories.find((c) => c.key === categoryKey)?.name;
      try {
        await createInstallment.mutateAsync({
          title: note.trim() || categoryName || '分期消費',
          totalAmountTWD: Math.round(amt),
          periods: installmentPeriods,
          feeTWD: 0,
          cardAccountId: fromAccountId,
          category: categoryKey,
          startDate: date,
          note: null,
        });
        closeDialog();
      } catch (err) {
        // toast 已在 mutation onError 處理
        console.error('[quickEntryInstallment]', err);
      }
      return;
    }
    try {
      await createTx.mutateAsync({
        type,
        amount: amt,
        currency,
        amountTWD,
        fxRate,
        category: categoryKey,
        paymentMethod: fundPaid && !iAdvanced ? '公基金' : !iPaid ? (useShared ? '共同帳' : '旅伴代付') : paymentMethod,
        fromAccountId: type === 'expense' && iPaid ? (fromAccountId || null) : null,
        toAccountId: type === 'income' ? (toAccountId || null) : null,
        note: note || undefined,
        ...(tags.length ? { tags } : {}),
        attachments: attachments.length ? attachments : undefined,
        date,
        tripId: tripId ?? null,
        payerId: sp?.payerId ?? null,
        shareType: sp?.shareType ?? null,
        splitMode: useLoan ? splitMode : null,
        counterpartyName: useLoan ? (counterpartyName.trim() || null) : null,
        myShareTWD: sp ? sp.myShareTWD : (useLoan ? myShareNum : null),
        prepaid: tripId ? prepaid : false,
        scope: useShared ? 'household' : null,
        householdId: useShared && household ? household.id : null,
        paidByUid: sp?.paidByUid ?? null,
        fundAdvancedBy: sp?.fundAdvancedBy ?? null,
        customShares: sp?.customShares ?? undefined,
        clientRequestId,
      });
      // 存檔成功：附上這筆對本月預算的影響（以「我負擔」計）
      const myAmountTWD = sp ? sp.myShareTWD ?? amountTWD : (useLoan && myShareNum != null ? myShareNum : amountTWD);
      const impact = budgetImpact({ type, category: categoryKey, date, myAmountTWD });
      toast.success('已新增', impact ? { description: impact } : undefined);
      // 共同支出歸入旅程：把共同帳本成員補進旅程成員（只有旅程擁有者能改 trip）
      if (useShared && household && trip && (trip.ownerId ?? trip.userId) === me.uid) {
        const missing = missingHouseholdTripMembers(trip, household);
        if (missing.length > 0) {
          try {
            await updateTrip.mutateAsync({ id: trip.id, patch: { members: [...(trip.members ?? []), ...missing] } });
          } catch (err) {
            console.warn('[quickEntry] add household members to trip', err);
          }
        }
      }
      closeDialog();
    } catch (err) {
      console.error('[quickEntrySave]', err);
    }
  }

  const splitPreviewInput = { members: splitCtx.members, amount: parseFloat(amount) || 0, currency, fxRate, state: split, ratio: splitCtx.ratio };
  const splitPreview = splitActive
    ? {
        mismatch: splitMismatch(splitPreviewInput),
        insufficientFund: split.payerId === HOUSEHOLD_FUND_PAYER_ID
          && (parseFloat(amount) || 0) * (currency === 'TWD' ? 1 : fxRate) > fundSummary.balanceTWD,
      }
    : null;
  // 公基金餘額不足只在編輯器裡警示，不擋存檔
  const canSave = parseFloat(amount) > 0 && Boolean(categoryKey) && !(splitPreview?.mismatch);
  const todayTW = startOfTWDay(nowTW()).getTime();

  const requestClose = () => {
    if (!createTx.isPending) closeDialog();
  };

  const footer = (
    <div className="space-y-2">
      {isTakingLong ? (
        <p className="text-center text-xs text-muted-foreground" role="status">
          連線較慢，仍在確認是否寫入完成。請先不要關閉或重複送出。
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button variant="outline" onClick={requestClose} disabled={createTx.isPending} type="button" className="flex-1 h-12">
          取消
        </Button>
        <Button
          onClick={handleSave}
          disabled={!canSave || createTx.isPending || createInstallment.isPending}
          type="button"
          className="flex-[2] h-12"
        >
          {createTx.isPending || createInstallment.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {createTx.isPending ? '正在確認寫入…' : installmentAllowed && installmentPeriods > 1 ? `建立 ${installmentPeriods} 期分期` : '儲存'}
        </Button>
      </div>
    </div>
  );

  const content = (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 rounded-full bg-muted p-1">
        <button
          type="button"
          onClick={() => setType('expense')}
          className={cn(
            'h-10 rounded-full text-sm font-medium transition-colors',
            type === 'expense'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground',
          )}
        >
          支出
        </button>
        <button
          type="button"
          onClick={() => setType('income')}
          className={cn(
            'h-10 rounded-full text-sm font-medium transition-colors',
            type === 'income'
              ? 'bg-success text-success-foreground shadow-sm'
              : 'text-muted-foreground',
          )}
        >
          收入
        </button>
      </div>

      {type === 'expense' ? (
        <div className="flex items-center gap-2">
          <input
            ref={receiptInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => void handleReceiptFile(e)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => receiptInputRef.current?.click()}
            disabled={scanning}
          >
            {scanning ? <Loader2 className="size-4 animate-spin" /> : <ScanLine className="size-4" />}
            {scanning ? '辨識中…' : '掃描收據'}
          </Button>
          <span className="text-xs text-muted-foreground">拍照或選圖，自動帶入金額 / 店名 / 日期（照片會加到附件）</span>
        </div>
      ) : null}

      {templates.length > 0 ? (
        <div>
          <Label className="flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="size-3" /> 常用
          </Label>
          <div className="-mx-1 mt-1.5 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {templates.map((tpl) => {
              const cat = categories.find((c) => c.key === tpl.category);
              const Icon = resolveIcon(cat?.icon ?? 'MoreHorizontal');
              return (
                <button
                  key={tpl.key}
                  type="button"
                  onClick={() => applyTemplate(tpl)}
                  className="flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1.5 text-xs transition-colors hover:bg-muted active:scale-95"
                  title={`${tpl.note} · ${cat?.name ?? tpl.category} · ${tpl.paymentMethod}（${tpl.count} 次）`}
                >
                  <span
                    className="flex size-5 items-center justify-center rounded-full"
                    style={{ backgroundColor: (cat?.color ?? '#6B7280') + '20', color: cat?.color ?? '#6B7280' }}
                  >
                    <Icon className="size-3" />
                  </span>
                  <span className="max-w-[7rem] truncate font-medium">{tpl.note}</span>
                  {tpl.amount != null ? (
                    <span className="tabular-nums text-muted-foreground">
                      {tpl.currency === 'TWD' ? formatCurrency(tpl.amount) : `${tpl.currency} ${tpl.amount}`}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Amount display (big) */}
      <div className="rounded-2xl border bg-card p-4">
        <Label className="text-xs text-muted-foreground">金額</Label>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-sm text-muted-foreground">{currency}</span>
          <input
            type="number"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-transparent font-semibold tabular-nums outline-none placeholder:text-muted-foreground/40"
            style={{ fontSize: '1.875rem', lineHeight: '2.25rem' }}
          />
        </div>
        {currency !== 'TWD' ? (
          <p className="mt-1 text-xs text-muted-foreground">
            1 {currency} = {fxRate.toFixed(4)} TWD · 約 NT${' '}
            {amount ? ((parseFloat(amount) || 0) * fxRate).toFixed(0) : '0'}
          </p>
        ) : null}
      </div>

      {/* Currency selector */}
      <div className="flex flex-wrap gap-1.5">
        {CURRENCIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => { currencyTouched.current = true; setCurrency(c); }}
            className={cn(
              'h-9 min-w-[3.5rem] flex-1 rounded-md px-2 text-xs font-medium transition-colors',
              currency === c ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Category grid */}
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
                onClick={() => {
                  setCategoryKey(c.key);
                  if ('vibrate' in navigator) navigator.vibrate?.(8);
                }}
                className={cn(
                  'flex flex-col items-center justify-center gap-1 rounded-xl border p-2.5 text-xs transition-colors',
                  selected
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted',
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

      {isOwner ? (
        <OwnerPaymentSelect
          type={type}
          paymentMethod={paymentMethod}
          accountId={type === 'income' ? toAccountId : fromAccountId}
          onChange={handlePaymentChange}
        />
      ) : null}

      {installmentAllowed ? (
        <OwnerInstallmentSelect
          accountId={fromAccountId}
          amount={parseFloat(amount) || 0}
          value={installmentPeriods}
          onChange={setInstallmentPeriods}
        />
      ) : null}

      {/* Date */}
      <div>
        <Label className="text-xs text-muted-foreground">日期</Label>
        <div className="mt-1">
          <DatePicker value={date} onChange={(d) => d && setDate(d)} clearable={false} />
        </div>
      </div>

      {/* 歸入旅程：從旅程頁進來已帶 tripId 就不再顯示；只有支出能歸入旅程 */}
      {!presetTripId && type === 'expense' && tripList.length > 0 ? (
        <div>
          <Label className="text-xs text-muted-foreground">歸入旅程</Label>
          <Select value={pickedTripId || '__none__'} onValueChange={(v) => setPickedTripId(v === '__none__' ? '' : v)}>
            <SelectTrigger className="mt-1 h-11"><SelectValue placeholder="不歸入旅程" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">（不歸入旅程）</SelectItem>
              {tripList.map((t) => {
                const ongoing = startOfTWDay(t.startDate).getTime() <= todayTW && todayTW <= startOfTWDay(t.endDate).getTime();
                return (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}{ongoing ? '（進行中）' : ''}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {pickedTripId ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              歸入旅程後會出現在該旅程的花費與結算；也可以同時勾「共同分攤」，兩人之間的錢在共同帳本結。
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Note */}
      <div>
        <Label className="text-xs text-muted-foreground">備註</Label>
        <Textarea
          placeholder="選填（輸入會帶出之前記過的類別與支付方式）"
          value={note}
          onChange={(e) => { setNote(e.target.value); setNoteSuggestDismissed(false); }}
          onFocus={() => setNoteFocused(true)}
          onBlur={() => window.setTimeout(() => setNoteFocused(false), 150)}
          rows={2}
          className="mt-1"
        />
        {noteMatches.length > 0 ? (
          <ul className="mt-1 divide-y rounded-lg border bg-card text-sm shadow-sm">
            {noteMatches.map((sug) => {
              const cat = categories.find((c) => c.key === sug.category);
              return (
                <li key={sug.note}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applySuggestion(sug)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{sug.note}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {cat?.name ?? sug.category} · {sug.paymentMethod}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                      {sug.currency === 'TWD' ? formatCurrency(sug.amount) : `${sug.currency} ${sug.amount}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {/* 標籤（選填，記帳頁可依標籤篩選） */}
      <div>
        <Label className="text-xs text-muted-foreground">標籤</Label>
        <TagInput value={tags} onChange={setTags} className="mt-1" placeholder="選填，例如 報帳、禮物（Enter 新增）" />
      </div>

      {/* 附件（收據 / 發票 / PDF，選填；掃描收據的照片也會出現在這裡） */}
      <AttachmentsEditor
        value={attachments}
        onChange={setAttachments}
        txId={clientRequestId}
        deleteOnRemove
        busy={scanning}
      />

      {tripId ? (
        <label className="flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm">
          <input
            type="checkbox"
            checked={prepaid}
            onChange={(e) => setPrepaid(e.target.checked)}
            className="mt-0.5 size-4 accent-primary"
          />
          <span className="flex-1">
            <span className="font-medium">這是預付款</span>
            <span className="ml-1 text-xs text-muted-foreground">
              出發前先付的款項（機票 / 簽證 / 接送…）。如果是幫朋友墊付，請另外在「代墊 / 借貸」設定。
            </span>
          </span>
        </label>
      ) : null}

      {/* 共同帳本分攤（有 household 且是支出時；可以和旅程同時存在） */}
      {household && me && type === 'expense' && (
        <div className="rounded-xl border p-3">
          <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
            <span>
              <span className="font-medium">共同分攤</span>
              <span className="ml-1 text-xs text-muted-foreground">
                記進「{household.name}」{tripId ? '，兩人之間在共同帳本結' : '，預設由公基金負擔'}
              </span>
            </span>
            <input type="checkbox" checked={sharedOn} onChange={(e) => {
              setSharedOn(e.target.checked);
              if (e.target.checked) {
                setSplitMode('self');
                // 清掉付款人，讓校正邏輯套用共同帳本的預設（公基金）
                setSplit({ payerId: '', mode: 'ratio', custom: {} });
              }
            }} className="size-4 accent-primary" />
          </label>
        </div>
      )}

      {/* 分攤設定：旅程成員 / 共同帳本成員共用一個編輯器（原幣輸入） */}
      {splitActive && me ? (
        <div className="rounded-xl border p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            {tripId && sharedOn ? '出遊分攤（含共同帳本）' : tripId ? '出遊分攤' : '共同分攤'}
          </div>
          <SplitEditor
            {...splitPreviewInput}
            onChange={setSplit}
            allowFund={splitCtx.allowFund}
            availableFundTWD={sharedOn ? fundSummary.balanceTWD : null}
            showRatio={splitCtx.showRatio}
            viewerId={me.uid}
            creatorId={me.uid}
          />
        </div>
      ) : null}

      {/* 一般代墊 / 借貸（沒有旅程 / 共同分攤時才顯示，避免重疊） */}
      {!splitActive && !tripId && (
        <LoanSplitEditor
          mode={splitMode}
          onModeChange={setSplitMode}
          counterpartyName={counterpartyName}
          onCounterpartyNameChange={setCounterpartyName}
          myShare={myShare}
          onMyShareChange={setMyShare}
          totalTWD={(parseFloat(amount) || 0) * (currency === 'TWD' ? 1 : fxRate)}
        />
      )}

    </div>
  );

  if (!isDesktop) {
    return (
      <QuickEntryMobilePanel
        open={open}
        onClose={requestClose}
        title="快速記帳"
        description={tripId ? `記錄至出遊：${trip?.name ?? tripId}` : undefined}
        footer={footer}
      >
        {content}
      </QuickEntryMobilePanel>
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => (o ? null : requestClose())}
      title="快速記帳"
      description={tripId ? `記錄至出遊：${trip?.name ?? tripId}` : undefined}
      footer={footer}
      contentClassName="sm:max-w-md"
    >
      {content}
    </ResponsiveDialog>
  );
}

interface QuickEntryMobilePanelProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}

function QuickEntryMobilePanel({
  open, title, description, children, footer, onClose,
}: QuickEntryMobilePanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState({ height: 0, top: 0 });

  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    const original = {
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.position = original.position;
      document.body.style.top = original.top;
      document.body.style.width = original.width;
      document.body.style.overflow = original.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const sync = () => {
      setFrame({
        height: Math.floor(viewport?.height ?? window.innerHeight),
        top: Math.floor(viewport?.offsetTop ?? 0),
      });
    };
    sync();
    viewport?.addEventListener('resize', sync);
    viewport?.addEventListener('scroll', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      viewport?.removeEventListener('resize', sync);
      viewport?.removeEventListener('scroll', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, [open]);

  function keepFocusedControlVisible(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    window.setTimeout(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const bottomLimit = scrollerRect.bottom - 24;
      const topLimit = scrollerRect.top + 24;
      if (targetRect.bottom > bottomLimit) {
        scroller.scrollTop += targetRect.bottom - bottomLimit;
      } else if (targetRect.top < topLimit) {
        scroller.scrollTop -= topLimit - targetRect.top;
      }
    }, 320);
  }

  if (!open) return null;

  const height = frame.height || window.innerHeight;
  const node = (
    <div className="fixed inset-0 z-50 bg-black/60">
      <div
        className="fixed inset-x-0 flex flex-col bg-background text-foreground"
        style={{
          top: frame.top,
          height,
        }}
      >
        <header className="shrink-0 border-b bg-background px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold leading-tight">{title}</h2>
              {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="關閉">
              <X className="size-5" />
            </Button>
          </div>
        </header>
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
          onFocusCapture={(event) => keepFocusedControlVisible(event.target)}
        >
          {children}
        </div>
        <div className="shrink-0 border-t bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3">
          {footer}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

/**
 * 帳戶 / 支付方式欄位：`accounts` / `payment_methods` 的 rules 限 owner，
 * 拆成子元件只在 owner 掛上，member（伴侶）記旅程 / 共同支出時不會打出 permission error。
 */
function OwnerPaymentSelect({
  type, paymentMethod, accountId, onChange,
}: {
  type: TxType;
  paymentMethod: string;
  accountId: string;
  onChange: (next: PaymentSelection) => void;
}) {
  const { data: customPMs = [] } = usePaymentMethods();
  const { data: accounts = [] } = useAccounts();
  return (
    <PaymentSelect
      value={{ paymentMethod, accountId }}
      onChange={onChange}
      accounts={accounts}
      customPMs={customPMs}
      allowedAccountTypes={
        type === 'income'
          ? ['cash', 'bank', 'investment_cash', 'e_wallet_balance']
          : ['cash', 'bank', 'credit_card', 'e_wallet_balance', 'investment_cash']
      }
      showAccountLabel={type === 'income' ? '收款帳戶' : '扣款帳戶'}
      emptyHint="尚未設定對應帳戶。可在「設定 → 帳戶」連結這個支付方式到帳戶。"
    />
  );
}


/**
 * 刷信用卡時可選「分 N 期」。只在扣款帳戶是 credit_card 時顯示；換成其他帳戶自動回到不分期。
 * 與 OwnerPaymentSelect 一樣只給 owner（accounts / installment_plans 的 rules 限 owner）。
 */
function OwnerInstallmentSelect({
  accountId, amount, value, onChange,
}: {
  accountId: string;
  amount: number;
  value: number;
  onChange: (periods: number) => void;
}) {
  const { data: accounts = [] } = useAccounts();
  const isCard = accounts.find((a) => a.id === accountId)?.type === 'credit_card';
  useEffect(() => {
    if (!isCard && value !== 0) onChange(0);
  }, [isCard, value, onChange]);
  if (!isCard) return null;
  const amounts = value > 1 && amount > 0 ? splitInstallmentAmounts(amount, value) : [];
  return (
    <div>
      <Label className="text-xs text-muted-foreground">分期</Label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className="mt-1 h-11"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="0">不分期（一次付清）</SelectItem>
          {INSTALLMENT_PERIOD_OPTIONS.map((n) => (
            <SelectItem key={n} value={String(n)}>分 {n} 期（0 利率）</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {amounts.length > 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          每期 {formatCurrency(amounts[0] ?? 0)}
          {amounts[amounts.length - 1] !== amounts[0] ? `，最後一期 ${formatCurrency(amounts[amounts.length - 1] ?? 0)}` : ''}
          ；第 1 期記在消費日，之後每月同日自動入帳。有手續費請到「記帳 → 分期」建立。
        </p>
      ) : null}
    </div>
  );
}
