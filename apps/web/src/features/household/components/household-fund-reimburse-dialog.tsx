import { useEffect, useState } from 'react';
import { ArrowRight, Loader2, PiggyBank } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/utils';
import { useAccounts } from '@/features/accounts';
import { useCategories } from '@/features/ledger/hooks';
import { usePaymentMethods } from '@/features/ledger/payment-methods';
import { PaymentSelect, type PaymentSelection } from '@/features/ledger/components/payment-select';
import { reimburseFromFund } from '../settle';
import { useHouseholdFundSummary } from '../hooks';
import { cn } from '@/lib/utils';
import type { Household } from '../types';
import { MemberChip } from './member-chip';

interface HouseholdFundReimburseDialogProps {
  household: Household;
  open: boolean;
  /** 預設收款人（先墊付的成員）；null = 讓使用者選（預設選公基金欠最多的人） */
  toUid: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * 公基金撥還代墊：公基金 → 先墊的成員，記完就結清。
 * 待撥還卡（固定收款人）與 FAB「公基金撥還代墊」（可選收款人）共用。
 */
export function HouseholdFundReimburseDialog({ household, open, toUid: initialToUid, onOpenChange }: HouseholdFundReimburseDialogProps) {
  const { user, isOwner } = useAuth();
  const myUid = user?.uid ?? '';
  const qc = useQueryClient();
  const { data: categories = [] } = useCategories();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date());
  const [note, setNote] = useState('');
  const [recordLedger, setRecordLedger] = useState(false);
  const [payment, setPayment] = useState<PaymentSelection>({ paymentMethod: '', accountId: '' });
  const { summary, isLoading: summaryLoading } = useHouseholdFundSummary(open ? household : null);
  const [toUid, setToUid] = useState<string>('');
  /** 收款人 / 金額的預設值已經帶過了（之後 summary 即時更新不要蓋掉使用者輸入） */
  const [prefilled, setPrefilled] = useState(false);
  const owedTWD = toUid ? summary.owedToMember[toUid] ?? 0 : 0;

  useEffect(() => {
    if (!open) { setPrefilled(false); return; }
    setDate(new Date());
    setNote('');
    setRecordLedger(false);
    setPayment({ paymentMethod: '', accountId: '' });
  }, [open]);

  // 資料到了才帶預設：有指定收款人用指定的，沒有就選公基金欠最多的人；金額 = 目前待撥還
  useEffect(() => {
    if (!open || prefilled || summaryLoading) return;
    const fallback = [...household.memberIds]
      .sort((a, b) => (summary.owedToMember[b] ?? 0) - (summary.owedToMember[a] ?? 0))[0] ?? '';
    const next = initialToUid ?? fallback;
    setToUid(next);
    const owed = next ? summary.owedToMember[next] ?? 0 : 0;
    setAmount(owed > 0 ? String(Math.round(owed)) : '');
    setPrefilled(true);
  }, [open, prefilled, summaryLoading, initialToUid, household.memberIds, summary.owedToMember]);

  function pickRecipient(uid: string) {
    setToUid(uid);
    const owed = summary.owedToMember[uid] ?? 0;
    setAmount(owed > 0 ? String(Math.round(owed)) : '');
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!toUid) throw new Error('請選擇收款人');
      return reimburseFromFund({
        household,
        myUid,
        toUid,
        amountTWD: Number(amount) || 0,
        date,
        note,
        ledger: isOwner && recordLedger && toUid === myUid
          ? { accountId: payment.accountId || null, paymentMethod: payment.paymentMethod, existingCategoryKeys: categories.map((c) => c.key) }
          : null,
      });
    },
    onSuccess: () => {
      toast.success('已記錄撥還');
      void qc.invalidateQueries({ queryKey: ['household-fund-entries', household.id] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      onOpenChange(false);
    },
    onError: (error) => {
      console.error('[reimburseFromFund]', error);
      toast.error(error instanceof Error ? error.message : '撥還失敗');
    },
  });

  const amt = Number(amount) || 0;
  const recipient = toUid ? household.members[toUid] : undefined;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => { if (!mutation.isPending) onOpenChange(next); }}
      title="公基金撥還代墊"
      description="從公基金把代墊的錢轉給先付的人，記錄後就結清"
      contentClassName="sm:max-w-md"
      footer={(
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>取消</Button>
          <Button type="button" className="h-12 flex-[2]" onClick={() => mutation.mutate()} disabled={amt <= 0 || mutation.isPending}>
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            確認撥還
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-3 rounded-xl border p-3 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium"><PiggyBank className="size-4" /> 公基金</span>
          <ArrowRight className="size-4 text-muted-foreground" />
          <MemberChip member={recipient} suffix={toUid === myUid ? '（我）' : ''} />
        </div>
        {initialToUid ? null : (
          <div>
            <Label>補給誰（誰先墊了錢）</Label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {household.memberIds.map((uid) => {
                const owed = Math.round(summary.owedToMember[uid] ?? 0);
                return (
                  <button
                    key={uid}
                    type="button"
                    onClick={() => pickRecipient(uid)}
                    className={cn(
                      'rounded-lg border p-2 text-left text-sm transition-colors',
                      toUid === uid ? 'border-primary bg-primary/10' : 'hover:bg-muted',
                    )}
                  >
                    <span className="block font-medium">
                      {household.members[uid]?.displayName ?? '成員'}{uid === myUid ? '（我）' : ''}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {owed > 0 ? `待撥還 ${formatCurrency(owed, 'TWD')}` : '目前沒有待撥還'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div>
          <Label htmlFor="reimburse-amount">金額（TWD）</Label>
          <Input
            id="reimburse-amount"
            type="number"
            inputMode="numeric"
            min={1}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="mt-1 h-12 text-xl font-semibold tabular-nums"
          />
          {owedTWD > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              公基金目前欠 {formatCurrency(owedTWD, 'TWD')}，可以部分撥還
              {amt > owedTWD ? `；多撥的 ${formatCurrency(amt - owedTWD, 'TWD')} 會記成對方欠公基金` : ''}
            </p>
          ) : (
            <p className="mt-1 text-xs text-warning">
              公基金目前沒有欠{recipient?.displayName ?? '對方'}。先到那筆共同支出把記帳方式設成「帳本負擔」、實際由「{recipient?.displayName ?? '對方'}先墊」，
              撥還才會剛好結清；否則這筆會記成對方欠公基金。
            </p>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>日期</Label>
            <div className="mt-1"><DatePicker value={date} onChange={(value) => { if (value) setDate(value); }} /></div>
          </div>
          <div>
            <Label htmlFor="reimburse-note">備註</Label>
            <Input id="reimburse-note" value={note} onChange={(event) => setNote(event.target.value)} className="mt-1" placeholder="例：網銀轉帳" />
          </div>
        </div>
        {isOwner && toUid === myUid ? (
          <div className="space-y-3 rounded-xl border p-3">
            <label className="flex items-center justify-between gap-2 text-sm">
              <span>
                <span className="font-medium">同時記到我的帳本</span>
                <span className="block text-xs text-muted-foreground">
                  記一筆「共同帳結算」收入，帳戶餘額增加，抵銷先墊時扣掉的錢；收支統計會排除
                </span>
              </span>
              <Switch checked={recordLedger} onCheckedChange={setRecordLedger} aria-label="同時記到我的帳本" />
            </label>
            {recordLedger ? <OwnerPaymentField value={payment} onChange={setPayment} /> : null}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          撥還只把錢從公基金轉給先墊的人：公基金「帳上可用」不變（記支出時已經扣過），「實際現金」會減少。
        </p>
      </div>
    </ResponsiveDialog>
  );
}

function OwnerPaymentField({ value, onChange }: { value: PaymentSelection; onChange: (next: PaymentSelection) => void }) {
  const { data: accounts = [] } = useAccounts();
  const { data: customPMs = [] } = usePaymentMethods();
  return <PaymentSelect value={value} onChange={onChange} accounts={accounts} customPMs={customPMs} label="收到哪個帳戶" />;
}
