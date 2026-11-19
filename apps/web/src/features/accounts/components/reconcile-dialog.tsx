import { useEffect, useState } from 'react';
import { Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useCategories } from '@/features/ledger/hooks';
import { useFxRates } from '@/features/fx/hooks';
import { formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import { useReconcileAccount } from '../reconcile';
import { accountFxRate } from '../valuation';
import type { Account } from '../types';

interface Props {
  account: Account | null;
  onClose: () => void;
}

export function ReconcileDialog({ account, onClose }: Props) {
  const { data: categories = [] } = useCategories();
  const { data: fxRates = [] } = useFxRates();
  const reconcile = useReconcileAccount();
  const [actual, setActual] = useState('');
  const [date, setDate] = useState(() => new Date());
  const [note, setNote] = useState('');

  useEffect(() => {
    if (account) {
      setActual(String(account.balance));
      setDate(new Date());
      setNote('');
    }
  }, [account]);

  if (!account) return null;
  const isDebt = account.type === 'credit_card' || account.type === 'loan';
  const actualNum = parseFloat(actual);
  const delta = Number.isFinite(actualNum) ? Math.round((actualNum - account.balance) * 100) / 100 : null;
  const moneyIn = delta != null && (isDebt ? delta < 0 : delta > 0);

  async function submit() {
    if (!account || delta == null) return;
    await reconcile.mutateAsync({
      account,
      actualBalance: actualNum,
      date,
      fxRate: accountFxRate(account, fxRates),
      existingCategoryKeys: categories.map((c) => c.key),
      note,
    });
    onClose();
  }

  return (
    <ResponsiveDialog
      open={Boolean(account)}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`對帳 — ${account.name}`}
      description={isDebt ? '輸入銀行 app 顯示的實際欠款，差額會建一筆對帳調整交易。' : '輸入銀行 app 顯示的實際餘額，差額會建一筆對帳調整交易。'}
      footer={
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>取消</Button>
          <Button className="flex-1" onClick={() => void submit()} disabled={reconcile.isPending || delta == null}>
            <Scale className="size-4" /> 確認對帳
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg border bg-muted/40 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">帳面{isDebt ? '欠款' : '餘額'}</span>
            <span className="tabular-nums">{account.balance.toLocaleString()} {account.currency}</span>
          </div>
          {account.lastReconciledAt ? (
            <div className="mt-1 text-xs text-muted-foreground">上次對帳 {formatTW(account.lastReconciledAt, 'yyyy/MM/dd')}</div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">尚未對帳過</div>
          )}
        </div>
        <div>
          <Label>實際{isDebt ? '欠款' : '餘額'}（{account.currency}）</Label>
          <Input
            type="number" inputMode="decimal" step="0.01"
            value={actual} onChange={(e) => setActual(e.target.value)} autoFocus
          />
        </div>
        {delta != null ? (
          <p className={cn('text-sm', Math.abs(delta) < 0.01 ? 'text-muted-foreground' : moneyIn ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
            {Math.abs(delta) < 0.01
              ? '餘額相符，只會更新對帳日期。'
              : `差額 ${delta > 0 ? '+' : ''}${delta.toLocaleString()} ${account.currency} → 建立一筆${moneyIn ? '收入' : '支出'}「對帳調整」`}
          </p>
        ) : null}
        <div>
          <Label>對帳日期</Label>
          <div className="mt-1"><DatePicker value={date} onChange={(d) => d && setDate(d)} clearable={false} /></div>
        </div>
        <div>
          <Label>備註（選填）</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：漏記的手續費" />
        </div>
      </div>
    </ResponsiveDialog>
  );
}
