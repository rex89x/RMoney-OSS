import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DatePicker } from '@/components/ui/date-picker';
import { AccountSelect, useAccounts } from '@/features/accounts';
import { formatTWMonthKey } from '@/lib/tz';
import { useRecordRentalIncome } from '../hooks';
import type { Rental } from '../types';

interface Props {
  rental: Rental | null;
  onClose: () => void;
}

export function RecordIncomeDialog({ rental, onClose }: Props) {
  const record = useRecordRentalIncome();
  const { data: accounts = [] } = useAccounts();

  const [date, setDate] = useState<Date>(() => new Date());
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [payerName, setPayerName] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!rental) return;
    setDate(new Date());
    setAmount(rental.expectedMonthlyIncome > 0 ? String(rental.expectedMonthlyIncome) : '');
    setAccountId(rental.defaultIncomeAccountId ?? accounts.find((a) => ['cash', 'bank'].includes(a.type))?.id ?? '');
    setPayerName('');
    setNote('');
  }, [rental, accounts]);

  if (!rental) return null;

  async function handleSave() {
    if (!rental) return;
    const amt = parseFloat(amount) || 0;
    if (amt <= 0) { toast.error('請填收款金額'); return; }
    if (!accountId) { toast.error('請選擇收款帳戶'); return; }
    try {
      await record.mutateAsync({
        rentalId: rental.id,
        monthKey: formatTWMonthKey(date),
        date,
        amountTWD: amt,
        toAccountId: accountId,
        payerName: payerName.trim() || null,
        note: note.trim() || null,
      });
      onClose();
    } catch (err) {
      console.error('[rentalIncomeSave]', err);
      toast.error(err instanceof Error ? err.message : '收款儲存失敗');
    }
  }

  return (
    <ResponsiveDialog
      open={Boolean(rental)}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`記錄收款 — ${rental.name}`}
      description="建立一筆 income TX 並更新該租賃的累積收款。"
      footer={
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>取消</Button>
          <Button className="flex-1" onClick={() => void handleSave()} disabled={record.isPending}>
            {record.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            確認
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>收款日</Label>
            <DatePicker value={date} onChange={(d) => d && setDate(d)} clearable={false} />
          </div>
          <div>
            <Label>金額 TWD</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={rental.expectedMonthlyIncome > 0 ? String(rental.expectedMonthlyIncome) : '例如 8000'}
            />
            {rental.expectedMonthlyIncome > 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                預期 NT${Math.round(rental.expectedMonthlyIncome).toLocaleString()}
              </p>
            ) : null}
          </div>
        </div>
        <div>
          <Label>收款帳戶</Label>
          <AccountSelect
            value={accountId}
            onValueChange={setAccountId}
            accounts={accounts}
            types={['cash', 'bank', 'e_wallet_balance']}
          />
        </div>
        <div>
          <Label>承租人 / 來源（選填）</Label>
          <Input value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="承租人姓名" />
        </div>
        <div>
          <Label>備註</Label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="例如：5 月份租金 / 含維護費" />
        </div>
      </div>
    </ResponsiveDialog>
  );
}
