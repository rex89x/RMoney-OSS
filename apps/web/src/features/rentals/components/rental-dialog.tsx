import { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DatePicker } from '@/components/ui/date-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfirm } from '@/components/ui/confirm';
import { AccountSelect, useAccounts } from '@/features/accounts';
import { useArchiveRental, useCreateRental, useUpdateRental } from '../hooks';
import { RENTAL_ASSET_TYPE_LABEL, type Rental, type RentalAssetType } from '../types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rental?: Rental | null;
}

const TYPES: RentalAssetType[] = ['equipment', 'vehicle', 'real_estate', 'other'];

export function RentalDialog({ open, onOpenChange, rental }: Props) {
  const create = useCreateRental();
  const update = useUpdateRental();
  const archive = useArchiveRental();
  const confirm = useConfirm();
  const { data: accounts = [] } = useAccounts();

  const [name, setName] = useState('');
  const [assetType, setAssetType] = useState<RentalAssetType>('equipment');
  const [startDate, setStartDate] = useState<Date>(() => new Date());
  const [purchaseAmount, setPurchaseAmount] = useState('');
  const [expectedMonthly, setExpectedMonthly] = useState('');
  const [expectedMonths, setExpectedMonths] = useState('');
  const [defaultIncomeAccountId, setDefaultIncomeAccountId] = useState('');
  const [purchaseFromAccountId, setPurchaseFromAccountId] = useState('');
  const [recordPurchase, setRecordPurchase] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    if (rental) {
      setName(rental.name);
      setAssetType(rental.assetType);
      setStartDate(rental.startDate);
      setPurchaseAmount(String(rental.purchaseAmountTWD));
      setExpectedMonthly(String(rental.expectedMonthlyIncome));
      setExpectedMonths(rental.expectedMonths != null ? String(rental.expectedMonths) : '');
      setDefaultIncomeAccountId(rental.defaultIncomeAccountId ?? '');
      setPurchaseFromAccountId('');
      setRecordPurchase(false);
      setNote(rental.note ?? '');
    } else {
      setName('');
      setAssetType('equipment');
      setStartDate(new Date());
      setPurchaseAmount('');
      setExpectedMonthly('');
      setExpectedMonths('');
      const firstBank = accounts.find((a) => ['cash', 'bank'].includes(a.type));
      setDefaultIncomeAccountId(firstBank?.id ?? '');
      setPurchaseFromAccountId(firstBank?.id ?? '');
      setRecordPurchase(false);
      setNote('');
    }
  }, [open, rental, accounts]);

  async function handleSave() {
    if (!name.trim()) { toast.error('請輸入名稱'); return; }
    const purchase = parseFloat(purchaseAmount) || 0;
    const expected = parseFloat(expectedMonthly) || 0;
    if (purchase <= 0) { toast.error('請填購入金額'); return; }
    try {
      if (rental) {
        await update.mutateAsync({
          id: rental.id,
          patch: {
            name: name.trim(),
            assetType,
            startDate,
            purchaseAmountTWD: purchase,
            expectedMonthlyIncome: expected,
            expectedMonths: expectedMonths.trim() ? parseFloat(expectedMonths) : null,
            defaultIncomeAccountId: defaultIncomeAccountId || null,
            note: note.trim() || null,
          },
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          assetType,
          startDate,
          purchaseAmountTWD: purchase,
          expectedMonthlyIncome: expected,
          expectedMonths: expectedMonths.trim() ? parseFloat(expectedMonths) : null,
          defaultIncomeAccountId: defaultIncomeAccountId || null,
          note: note.trim() || null,
          recordPurchaseAsExpense: recordPurchase,
          purchaseFromAccountId: recordPurchase ? (purchaseFromAccountId || null) : null,
        });
      }
      onOpenChange(false);
    } catch (err) {
      console.error('[rentalSave]', err);
      toast.error(err instanceof Error ? err.message : '租賃資產儲存失敗');
    }
  }

  async function handleArchive() {
    if (!rental) return;
    const ok = await confirm({
      title: '封存這筆租賃資產？',
      description: `${rental.name} — 既有的收款紀錄會保留，但不再出現在列表。`,
      confirmText: '封存',
    });
    if (!ok) return;
    try {
      await archive.mutateAsync(rental.id);
      onOpenChange(false);
    } catch (err) {
      console.error('[rentalArchive]', err);
      toast.error(err instanceof Error ? err.message : '租賃資產封存失敗');
    }
  }

  const pending = create.isPending || update.isPending;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={rental ? '編輯租賃資產' : '新增租賃資產'}
      description="先有大筆支出買入，後續每月收回變動金額。"
      contentClassName="sm:max-w-xl"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {rental ? (
            <Button variant="ghost" onClick={() => void handleArchive()} disabled={archive.isPending}>
              <Trash2 className="size-4" /> 封存
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button onClick={() => void handleSave()} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              儲存
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>名稱</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：A 機台 / 套房 / 出租車" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>類型</Label>
            <Select value={assetType} onValueChange={(v) => setAssetType(v as RentalAssetType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{RENTAL_ASSET_TYPE_LABEL[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>取得日</Label>
            <DatePicker value={startDate} onChange={(d) => d && setStartDate(d)} clearable={false} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>購入金額 TWD</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={purchaseAmount}
              onChange={(e) => setPurchaseAmount(e.target.value)}
              placeholder="100000"
            />
          </div>
          <div>
            <Label>預計每月收入 TWD</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={expectedMonthly}
              onChange={(e) => setExpectedMonthly(e.target.value)}
              placeholder="8000"
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>預期租期月數（選填）</Label>
            <Input
              type="number"
              inputMode="numeric"
              value={expectedMonths}
              onChange={(e) => setExpectedMonths(e.target.value)}
              placeholder="例如 24"
            />
          </div>
          <div>
            <Label>預設收款帳戶</Label>
            <AccountSelect
              value={defaultIncomeAccountId}
              onValueChange={setDefaultIncomeAccountId}
              accounts={accounts}
              types={['cash', 'bank', 'e_wallet_balance']}
              placeholder="收款進到哪個帳戶"
            />
          </div>
        </div>
        {!rental ? (
          <div className="rounded-md border p-3 space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={recordPurchase}
                onChange={(e) => setRecordPurchase(e.target.checked)}
                className="size-4 accent-primary"
              />
              <span>同步建立購入支出（僅限尚未反映在帳戶餘額時）</span>
            </label>
            <p className="text-xs text-muted-foreground">
              如果這個案件已經付出，且目前銀行餘額已是現況，請保持不勾，避免重複扣款。
            </p>
            {recordPurchase ? (
              <AccountSelect
                value={purchaseFromAccountId}
                onValueChange={setPurchaseFromAccountId}
                accounts={accounts}
                types={['cash', 'bank']}
                placeholder="購入時的扣款帳戶"
              />
            ) : null}
          </div>
        ) : null}
        <div>
          <Label>備註</Label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="承租人、合約期、地點…" />
        </div>
      </div>
    </ResponsiveDialog>
  );
}
