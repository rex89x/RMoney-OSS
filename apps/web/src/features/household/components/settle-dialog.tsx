import { useEffect, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/utils';
import { useCategories } from '@/features/ledger/hooks';
import { useAccounts } from '@/features/accounts';
import { usePaymentMethods } from '@/features/ledger/payment-methods';
import { PaymentSelect, type PaymentSelection } from '@/features/ledger/components/payment-select';
import { settleHousehold } from '../settle';
import type { Household } from '../types';
import type { PairDebt } from '../balance';
import { MemberChip } from './member-chip';

interface SettleDialogProps {
  household: Household;
  debt: PairDebt | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettleDialog({ household, debt, open, onOpenChange }: SettleDialogProps) {
  const { user, isOwner } = useAuth();
  const myUid = user?.uid ?? '';
  const qc = useQueryClient();
  const { data: categories = [] } = useCategories();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState<Date>(() => new Date());
  const [note, setNote] = useState('');
  const [recordLedger, setRecordLedger] = useState(false);
  const [payment, setPayment] = useState<PaymentSelection>({ paymentMethod: '', accountId: '' });

  useEffect(() => {
    if (!open) return;
    setAmount(debt ? String(debt.amountTWD) : '');
    setDate(new Date());
    setNote('');
    setRecordLedger(false);
    setPayment({ paymentMethod: '', accountId: '' });
  }, [open, debt]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!debt) throw new Error('目前沒有需要結算的餘額');
      return settleHousehold({
        household,
        myUid,
        fromUid: debt.fromUid,
        toUid: debt.toUid,
        amountTWD: parseFloat(amount) || 0,
        date,
        note,
        ledger: isOwner && recordLedger
          ? { accountId: payment.accountId || null, paymentMethod: payment.paymentMethod, existingCategoryKeys: categories.map((c) => c.key) }
          : null,
      });
    },
    onSuccess: () => {
      toast.success('已結算');
      void qc.invalidateQueries({ queryKey: ['household-settlements', household.id] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      onOpenChange(false);
    },
    onError: (err) => {
      console.error('[settleHousehold]', err);
      toast.error(err instanceof Error ? err.message : '結算失敗');
    },
  });

  const involvesMe = debt ? debt.fromUid === myUid || debt.toUid === myUid : false;
  const amt = parseFloat(amount) || 0;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => { if (!mutation.isPending) onOpenChange(o); }}
      title="結算"
      description="記錄一筆實際轉帳，餘額會相應減少"
      contentClassName="sm:max-w-md"
      footer={(
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" type="button" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>取消</Button>
          <Button className="flex-[2]" type="button" onClick={() => mutation.mutate()} disabled={!debt || amt <= 0 || mutation.isPending}>
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            確認結算
          </Button>
        </div>
      )}
    >
      {debt ? (
        <div className="space-y-4">
          <div className="flex items-center justify-center gap-3 rounded-xl border p-3 text-sm">
            <MemberChip member={household.members[debt.fromUid]} />
            <ArrowRight className="size-4 text-muted-foreground" />
            <MemberChip member={household.members[debt.toUid]} />
          </div>
          <div>
            <Label>金額（TWD）</Label>
            <Input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 h-12 text-xl font-semibold tabular-nums" />
            <p className="mt-1 text-xs text-muted-foreground">目前應結 {formatCurrency(debt.amountTWD, 'TWD')}，可部分結算</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label>日期</Label>
              <div className="mt-1"><DatePicker value={date} onChange={(d) => { if (d) setDate(d); }} /></div>
            </div>
            <div>
              <Label>備註</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1" placeholder="例：轉帳" />
            </div>
          </div>
          {isOwner && involvesMe ? (
            <div className="space-y-3 rounded-xl border p-3">
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium">同時記到我的帳本</span>
                  <span className="block text-xs text-muted-foreground">
                    {debt.toUid === myUid ? '記一筆「共同帳結算」收入，帳戶餘額會增加' : '記一筆「共同帳結算」支出，帳戶餘額會減少'}；月底預測會排除
                  </span>
                </span>
                <Switch checked={recordLedger} onCheckedChange={setRecordLedger} />
              </label>
              {recordLedger ? <OwnerPaymentField value={payment} onChange={setPayment} /> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">目前沒有需要結算的餘額。</p>
      )}
    </ResponsiveDialog>
  );
}

function OwnerPaymentField({ value, onChange }: { value: PaymentSelection; onChange: (next: PaymentSelection) => void }) {
  const { data: accounts = [] } = useAccounts();
  const { data: customPMs = [] } = usePaymentMethods();
  return (
    <PaymentSelect value={value} onChange={onChange} accounts={accounts} customPMs={customPMs} label="帳戶 / 支付方式" />
  );
}
